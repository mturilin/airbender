// bb-plugin-beads — backend entry.
//
// What: the data behind the Beads tab. Lists the beads issues of the folder a
// thread (or project) works in, creates new ones, and remembers which issue
// each thread is working on — all by running the `bd` command-line tool.
//
// Why: beads keeps a repo's issues in a database inside the repo, and the only
// supported way to read it is the `bd` tool. The browser cannot run a program,
// so the tab asks this backend over RPC.
//
// Design notes:
// - Reading runs `bd --readonly`. The writes to the issue database are
//   creating (`bd create`), closing (`bd close`), reopening (`bd reopen`)
//   and changing an issue's type or priority (`bd update`); nothing here
//   edits an issue's text or deletes one.
// - "Flesh out" runs as a background agent: a hidden worker thread that is
//   not shown in the sidebar and is archived and stopped when it finishes,
//   so the thread the user is working in is not interrupted (bead-bb-4la).
// - The plugin speaks to the current thread's agent in two places, both by
//   sending the thread a message: the play button ("work on this issue") and, when the user
//   picks it, closing an issue ("commit this issue's work"). The plugin never
//   runs git itself.
// - "Current bead" is BB's knowledge, not beads': which issue a given thread
//   is working on. It is stored on the thread (BB's per-plugin thread
//   metadata), set either by the user in the tab or by the thread's agent
//   through the `beads_set_current` tool. Beads itself is not changed by it.
// - One `bd list --all` per request. "Blocked" is worked out here from each
//   issue's dependency list instead of a second `bd blocked` call, so the tab
//   always shows one consistent snapshot.
// - `bd` runs on the machine the BB server runs on. A thread whose folder is
//   on another enrolled machine gets an explicit "unavailable" answer instead
//   of a wrong list (tracked as bead-bb-hl3).
// - Problems the user can act on (no beads here, bd not installed, folder on
//   another machine) are returned as data with a `state`, not thrown, so the
//   tab can explain them in plain words.
//
// - Changes made outside the plugin (an agent or a terminal running bd) reach
//   open tabs through a file watcher, not a timer: bd rewrites
//   `.beads/last-touched` on every write, and this backend watches that one
//   file in each folder a tab has listed, then signals the tabs to reload.
//   The plugin's own reads (`bd --readonly list` / `comments`) do not touch
//   that file, so a reload never triggers another reload.
//
// Gotchas:
// - `bd delete` does not rewrite `.beads/last-touched`, so an issue deleted
//   outside the plugin stays on screen until the next refresh.
// - `bd show` also rewrites `.beads/last-touched`, so an agent merely reading
//   an issue causes one harmless reload of open tabs.
// - The BB server may have a shorter PATH than your shell. If `bd` is not
//   found by name, a few common install locations are tried; the "bd command"
//   setting overrides all of that.
// - Settings are read once per load: reload the plugin after changing one.
import { execFile } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Issue types offered when creating an issue (beads' built-in set). */
export const ISSUE_TYPES = [
  "task",
  "feature",
  "bug",
  "chore",
  "epic",
  "decision",
] as const;

/** Statuses beads ships with; anything else (custom statuses) is kept as-is. */
const CLOSED_STATUS = "closed";

/** Longest we wait for one `bd` run before giving up. */
const BD_TIMEOUT_MS = 20_000;

/** Upper bound on `bd` output we are willing to buffer (16 MiB). */
const BD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * One row of `bd list --json`, limited to the fields the tab uses. Parsed
 * loosely: unknown fields are ignored and optional ones may be missing,
 * because bd omits empty fields and adds new ones between versions.
 */
const bdIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  design: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  notes: z.string().optional(),
  close_reason: z.string().optional(),
  comment_count: z.number().optional(),
  status: z.string(),
  priority: z.number().optional(),
  issue_type: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  dependencies: z
    .array(z.object({ depends_on_id: z.string(), type: z.string() }))
    .nullish(),
});
type BdIssue = z.infer<typeof bdIssueSchema>;

const issueRefSchema = z.object({ id: z.string(), title: z.string() });

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  /** How the issue is to be built and why; "" when beads has none. */
  design: z.string(),
  /** What "done" means; "" when beads has none. */
  acceptance: z.string(),
  /** Free-text notes appended over time; "" when beads has none. */
  notes: z.string(),
  /** Why the issue was closed; "" for open issues or when none was given. */
  closeReason: z.string(),
  /**
   * How many comments the issue has. The comments themselves are fetched
   * separately (issue_comments), because bd lists only their count.
   */
  commentCount: z.number(),
  /**
   * Id of the hidden worker thread that is fleshing this issue out right now,
   * or null. Known only to the running plugin: it is forgotten when the
   * plugin reloads, which costs the "in progress" mark, not the work.
   */
  fleshOutThreadId: z.string().nullable(),
  status: z.string(),
  /** 0 (most urgent) to 4; null when bd reported none. */
  priority: z.number().nullable(),
  type: z.string().nullable(),
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  updatedAt: z.string().nullable(),
  /** Unfinished issues this one waits on. Empty for closed issues. */
  blockedBy: z.array(issueRefSchema),
  /** Unfinished issues waiting on this one. */
  blocks: z.array(issueRefSchema),
});
export type Issue = z.infer<typeof issueSchema>;

/** One comment on an issue, oldest first in every list. */
const commentSchema = z.object({
  id: z.string(),
  author: z.string(),
  /** ISO timestamp, or "" when bd reported none. */
  createdAt: z.string(),
  text: z.string(),
});
export type IssueComment = z.infer<typeof commentSchema>;

const issuesResultSchema = z.object({
  /**
   * ok — `issues` is the full list for `path`.
   * no-beads — the folder exists but has no beads database.
   * unavailable — there is no folder on this machine to look in.
   * error — bd is missing or failed; `message` says why.
   */
  state: z.enum(["ok", "no-beads", "unavailable", "error"]),
  /** Folder bd ran in; null when none could be resolved. */
  path: z.string().nullable(),
  /** Plain-language explanation for every state except "ok". */
  message: z.string().nullable(),
  issues: z.array(issueSchema),
  /**
   * Id of the issue this thread is working on, or null when none was chosen
   * (always null without a thread). Never names a closed issue: closing an
   * issue ends its time as current. May name an issue that no longer exists.
   */
  currentBeadId: z.string().nullable(),
});
export type IssuesResult = z.infer<typeof issuesResultSchema>;

// Both schemas run at the wire boundary; app.tsx imports only the types.
export const rpcContract = defineRpcContract({
  issues_list: {
    // The tab passes whichever it has: a thread tab knows its thread, the
    // new-thread screen only knows the selected project.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: issuesResultSchema,
  },
  issue_create: {
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      title: z.string().trim().min(1).max(500),
      description: z.string().max(20_000),
      /** One of beads' issue types; null uses beads' default (task). */
      type: z.enum(ISSUE_TYPES).nullable(),
      /** 0 (most urgent) to 4; null uses beads' default (2). */
      priority: z.number().int().min(0).max(4).nullable(),
    }),
    // `id` is set on success; `message` explains a failure in plain words.
    output: z.object({ id: z.string().nullable(), message: z.string().nullable() }),
  },
  issue_comments: {
    // Fetched per issue, when it is opened: bd needs one run per issue for
    // comments, which would be too slow to do for the whole list.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({
      comments: z.array(commentSchema),
      message: z.string().nullable(),
    }),
  },
  issue_close: {
    // Closes the issue in beads. If it was the thread's current bead, that
    // choice is cleared too, since a finished issue is no longer worked on.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      /**
       * Also ask the thread's agent to commit this issue's work. Ignored
       * without a thread, since there is then no agent to ask.
       */
      commit: z.boolean(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_flesh_out: {
    // Starts a background agent (a hidden worker thread) that fleshes the
    // issue out, so the thread the user is working in is not interrupted.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    // `threadId` is the new thread on success; `message` the reason if not.
    output: z.object({
      threadId: z.string().nullable(),
      message: z.string().nullable(),
    }),
  },
  issue_update: {
    // Changes an issue's type and/or priority; a null field is left as is.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      type: z.enum(ISSUE_TYPES).nullable(),
      priority: z.number().int().min(0).max(4).nullable(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_reopen: {
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    output: z.object({ message: z.string().nullable() }),
  },
  current_start: {
    // Marks the bead as the thread's current one AND sends the thread's agent
    // a message telling it to start on it.
    input: z.object({ threadId: z.string(), beadId: z.string() }),
    output: z.object({ currentBeadId: z.string() }),
  },
  current_set: {
    // beadId null clears the thread's current bead.
    input: z.object({ threadId: z.string(), beadId: z.string().nullable() }),
    output: z.object({ currentBeadId: z.string().nullable() }),
  },
});

/**
 * Realtime channel the tab listens on. Published after an issue is created or
 * a thread's current bead changes, so every open tab reloads.
 */
export const CHANGED_CHANNEL = "beads-changed";

/** Key under which a thread's current bead id is stored in thread metadata. */
const CURRENT_BEAD_KEY = "currentBead";

/** Shape every beads issue id has; also keeps ids safe to pass to bd. */
const BEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Outcome of one `bd` run: its standard output, or why it did not run. */
type BdRun =
  | { kind: "ok"; stdout: string }
  | { kind: "not-found" }
  | { kind: "failed"; message: string };

/**
 * Runs one `bd` command.
 *
 * @param command Program name or absolute path to try.
 * @param args Arguments, passed without a shell so nothing is interpreted.
 * @param cwd Folder to run in; bd finds the beads database from here upward.
 * @returns "ok" with stdout, "not-found" when the program does not exist
 *   (so the caller can try another location), or "failed" with bd's own
 *   error text. Never throws.
 * Side effects: spawns a short-lived child process; none on disk, because
 *   callers pass `--readonly`.
 */
function runBd(command: string, args: string[], cwd: string): Promise<BdRun> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: BD_TIMEOUT_MS, maxBuffer: BD_MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: "ok", stdout });
          return;
        }
        // ENOENT is reported both for a missing program and a missing cwd;
        // callers check the folder separately, so here it means the program.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ kind: "not-found" });
          return;
        }
        // With --json, bd may report its error on standard output instead.
        let detail = stderr.trim() || stdout.trim() || error.message;
        try {
          // ...as `{ "error": "..." }`; show the sentence, not the JSON.
          const parsed: unknown = JSON.parse(detail);
          const reported = (parsed as { error?: unknown } | null)?.error;
          if (typeof reported === "string") detail = reported;
        } catch {
          // Not JSON: the text is already the message.
        }
        resolve({ kind: "failed", message: detail });
      },
    );
  });
}

/**
 * Turns bd's rows into the tab's issue shape and works out who blocks whom.
 *
 * An issue is blocked by another when it has a "blocks"-type dependency on it
 * and that other issue is not closed. Closed issues are never shown as blocked.
 * Other dependency types (parent-child, discovered-from, related) do not stop
 * work in beads, so they are ignored here.
 */
function toIssues(rows: BdIssue[]): Issue[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const isOpen = (row: BdIssue) => row.status !== CLOSED_STATUS;
  const blocks = new Map<string, { id: string; title: string }[]>();
  const blockedBy = new Map<string, { id: string; title: string }[]>();
  for (const row of rows) {
    if (!isOpen(row)) continue;
    for (const dependency of row.dependencies ?? []) {
      if (dependency.type !== "blocks") continue;
      const blocker = byId.get(dependency.depends_on_id);
      if (blocker === undefined || !isOpen(blocker)) continue;
      const waiting = blockedBy.get(row.id) ?? [];
      waiting.push({ id: blocker.id, title: blocker.title });
      blockedBy.set(row.id, waiting);
      const held = blocks.get(blocker.id) ?? [];
      held.push({ id: row.id, title: row.title });
      blocks.set(blocker.id, held);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    design: row.design ?? "",
    acceptance: row.acceptance_criteria ?? "",
    notes: row.notes ?? "",
    closeReason: row.close_reason ?? "",
    commentCount: row.comment_count ?? 0,
    fleshOutThreadId: null,
    status: row.status,
    priority: row.priority ?? null,
    type: row.issue_type ?? null,
    assignee: row.assignee ?? null,
    labels: row.labels ?? [],
    updatedAt: row.updated_at ?? row.created_at ?? null,
    blockedBy: blockedBy.get(row.id) ?? [],
    blocks: blocks.get(row.id) ?? [],
  }));
}

/**
 * The instruction given to the background agent that fleshes an issue out.
 *
 * Wording notes, from reviewing the first real run (bead-bb-5nz): the result
 * was accurate but about 1,500 words for a one-line request, used capital
 * letters instead of Markdown for headings (the tab renders Markdown), asked
 * five questions, widened the request, and its comments were recorded under
 * the user's own name because bd signs with the git user by default. Each
 * rule below answers one of those.
 */
function fleshOutPrompt(beadId: string, title: string): string {
  return [
    `Flesh out beads issue ${beadId} (${JSON.stringify(title)}). Start with \`bd show ${beadId}\`, then read the code it touches.`,
    "",
    "Write these onto the issue with `bd update`:",
    "- Description: what is wanted and why, how things work today (name the files and functions), and what is out of scope. Keep the user's original wording as a quote. At most about 200 words.",
    "- Acceptance criteria: at most 8 short checks a person can verify.",
    "- Design: the approach you propose, step by step, with the files to change and any gotcha you found in the code. Mention an alternative only if you rejected it for a reason worth knowing. At most about 300 words.",
    "- Type and priority, and links to issues it depends on or relates to.",
    "",
    "Rules:",
    "- Be proportionate. A one-line request gets a short write-up; someone should be able to read all of it in two minutes.",
    "- Stay inside the request. If you think of an extension, give it one line under out of scope; do not design it.",
    "- Format with Markdown: `##` headings and `-` bullets, not capital-letter headings. The text is shown rendered.",
    "- Check every claim about the code against the code before you write it.",
    "- Open questions: at most 3, only ones whose answer changes what gets built. Put them in one comment titled \"Open questions\", each with the answer you would assume, so work can start without waiting.",
    "- Add one more comment saying which decisions were yours and what you could not verify.",
    `- Add \`--actor "flesh-out agent"\` to every bd command that writes, so your changes and comments are not recorded under the user's name.`,
    "- Do not start the work, do not change any file, do not close the issue, do not commit, and do not make it this thread's current bead.",
    "",
    "Finish with three lines at most: what you set, and the open questions.",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    bdCommand: {
      type: "string",
      label: "bd command",
      description:
        "Name or full path of the beads command-line tool. Leave as bd unless BB cannot find it.",
      default: "bd",
    },
    fleshOutModel: {
      type: "string",
      label: "Flesh-out model",
      description:
        "Model the background agent uses when you press Flesh out, as a model id such as claude-fable-5-1. Leave empty to use the project's default model.",
      default: "claude-fable-5-1",
    },
  });
  const { bdCommand, fleshOutModel } = await settings.get();

  // Tried in order until one exists. The extra locations cover installs that
  // are on a login shell's PATH but not on the BB server's.
  const bdCandidates = [
    bdCommand.trim() || "bd",
    join(homedir(), ".local", "share", "mise", "shims", "bd"),
    join(homedir(), ".local", "bin", "bd"),
    join(homedir(), "go", "bin", "bd"),
    "/usr/local/bin/bd",
    "/opt/homebrew/bin/bd",
  ];

  /**
   * Finds the folder on the BB server machine that a thread or project works
   * in.
   *
   * A thread's own checkout wins (it may be a worktree); otherwise the
   * project's default folder is used.
   *
   * @returns `{ path }`, or `{ reason }` in plain language when there is no
   *   folder on this machine to look in.
   */
  async function resolveFolder(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<{ path: string } | { reason: string }> {
    const { primaryHostId } = await bb.sdk.system.config();
    let projectId = input.projectId;
    if (input.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      projectId = thread.projectId;
      if (thread.environmentId !== null) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        if (environment.hostId !== primaryHostId) {
          return {
            reason:
              "This thread works on another machine. The Beads tab can only read folders on the machine BB itself runs on.",
          };
        }
        if (environment.path !== null) return { path: environment.path };
      }
    }
    if (projectId === null) {
      return { reason: "Pick a project to see its beads issues." };
    }
    const project = await bb.sdk.projects.get({ projectId });
    const local = project.sources.filter(
      (source) => source.hostId === primaryHostId,
    );
    const source = local.find((candidate) => candidate.isDefault) ?? local[0];
    if (source === undefined) {
      return {
        reason:
          "This project has no folder on the machine BB itself runs on, so there is nowhere to look for beads issues.",
      };
    }
    return { path: source.path };
  }

  /** Longest a flesh-out is shown as running before the mark is dropped. */
  const FLESH_OUT_TIMEOUT_MS = 20 * 60_000;

  /** Running flesh-outs: folder + issue id -> the thread doing the work. */
  const fleshingOut = new Map<string, string>();
  const fleshOutKey = (path: string, beadId: string) => `${path}\n${beadId}`;

  const BD_NOT_FOUND_MESSAGE =
    "BB could not find the bd command. Install beads, or set its full path under this plugin's settings (bd command) and reload the plugin.";

  /**
   * Runs `bd` in a folder, trying each known install location until one
   * exists.
   *
   * @returns The first run that found a program, or "not-found" if none did.
   */
  async function runBdIn(path: string, args: string[]): Promise<BdRun> {
    let run: BdRun = { kind: "not-found" };
    for (const candidate of bdCandidates) {
      run = await runBd(candidate, args, path);
      if (run.kind !== "not-found") break;
    }
    return run;
  }

  /**
   * Reads which issue a thread is working on.
   *
   * @returns The stored id, or null when none is stored or the stored value is
   *   not a plausible id. Thread metadata can be written by anything with
   *   access to the thread, so the value is checked, not trusted.
   */
  async function readCurrentBead(threadId: string | null): Promise<string | null> {
    if (threadId === null) return null;
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    const value = (metadata as Record<string, unknown>)[CURRENT_BEAD_KEY];
    return typeof value === "string" && BEAD_ID_PATTERN.test(value)
      ? value
      : null;
  }

  /**
   * Records (or, with null, clears) the issue a thread is working on and tells
   * every open tab to reload.
   *
   * Pre-condition: `beadId`, when given, already matches BEAD_ID_PATTERN.
   * Side effects: writes this plugin's metadata on the thread; publishes
   *   CHANGED_CHANNEL. Beads' own database is not touched.
   */
  async function writeCurrentBead(
    threadId: string,
    beadId: string | null,
  ): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata(
      beadId === null
        ? { threadId, remove: [CURRENT_BEAD_KEY] }
        : { threadId, set: { [CURRENT_BEAD_KEY]: beadId } },
    );
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });
  }

  /** Most folders watched at once; the oldest is dropped beyond this. */
  const MAX_WATCHED_FOLDERS = 32;

  /** How long to wait after a change before signalling, to merge bursts. */
  const WATCH_SETTLE_MS = 400;

  /** Storage key for the list of watched folders, kept across reloads. */
  const WATCHED_FOLDERS_KEY = "watchedFolders";

  /** Live watchers by folder path, in the order they were started. */
  const watchers = new Map<string, FSWatcher>();

  /**
   * Starts telling open tabs about beads changes made outside this plugin in
   * one folder. Safe to call on every list: a folder already watched is left
   * alone.
   *
   * Watches the `.beads` directory rather than the `last-touched` file
   * itself, because a file that is replaced (written to a temporary name and
   * renamed) would silently end a watch placed on the old file.
   *
   * Side effects: holds one operating-system file watch per folder until the
   *   plugin is reloaded or disabled (see the dispose hook below), or until
   *   the watch fails, in which case it is dropped and restarted by the next
   *   list.
   */
  function watchFolder(path: string): void {
    if (watchers.has(path)) return;
    const beadsDir = join(path, ".beads");
    if (!existsSync(beadsDir)) return;
    let timer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher;
    try {
      watcher = watch(beadsDir, (_event, filename) => {
        if (filename !== "last-touched") return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          bb.log.info("beads changed in " + path + "; telling open tabs");
          bb.realtime.publish(CHANGED_CHANNEL, { path });
        }, WATCH_SETTLE_MS);
      });
    } catch (cause) {
      bb.log.warn("could not watch " + beadsDir + ": " + cause);
      return;
    }
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      watcher.close();
      if (watchers.get(path) === watcher) watchers.delete(path);
    };
    watcher.on("error", stop);
    watcher.on("close", () => {
      if (timer !== null) clearTimeout(timer);
    });
    watchers.set(path, watcher);
    if (watchers.size > MAX_WATCHED_FOLDERS) {
      const oldest = watchers.keys().next().value;
      if (oldest !== undefined) {
        watchers.get(oldest)?.close();
        watchers.delete(oldest);
      }
    }
    // Remember the folder so the watch comes back after the plugin is
    // reloaded or BB restarts. Not awaited: a failed save only costs the
    // watch until some tab next lists this folder.
    bb.storage.kv
      .set(WATCHED_FOLDERS_KEY, [...watchers.keys()])
      .catch((cause) => bb.log.warn("could not save watched folders: " + cause));
  }

  // Watches live in memory, so a reload of the plugin (or a restart of BB)
  // would otherwise leave tabs that are already open deaf to outside changes
  // until something made them list again. Start them again from the saved
  // list; folders that no longer use beads are skipped by watchFolder.
  const savedFolders = await bb.storage.kv
    .get<unknown>(WATCHED_FOLDERS_KEY)
    .catch(() => undefined);
  if (Array.isArray(savedFolders)) {
    for (const folder of savedFolders.slice(-MAX_WATCHED_FOLDERS)) {
      if (typeof folder === "string") watchFolder(folder);
    }
  }

  // Release every file watch when the plugin is reloaded or disabled.
  bb.onDispose(() => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  });

  /**
   * Lists every beads issue for the folder behind a thread or project.
   *
   * @returns An `IssuesResult`; see its `state` for the possible outcomes.
   *   Never throws for expected problems.
   * Side effects: runs `bd --readonly list` once (more only while searching
   *   for where bd is installed).
   */
  async function listIssues(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<IssuesResult> {
    const currentBeadId = await readCurrentBead(input.threadId);
    const folder = await resolveFolder(input);
    const empty = { issues: [], currentBeadId };
    if ("reason" in folder) {
      return {
        state: "unavailable",
        path: null,
        message: folder.reason,
        ...empty,
      };
    }
    const { path } = folder;
    // Checked first because a missing folder and a missing program produce
    // the same error from the operating system, and would otherwise be
    // reported as "bd not found".
    if (!existsSync(path)) {
      return {
        state: "unavailable",
        path,
        message: `The folder ${path} does not exist on the machine BB runs on.`,
        ...empty,
      };
    }
    // --limit 0 lifts bd's default cap of 50 rows; --all includes closed.
    const run = await runBdIn(path, [
      "--readonly",
      "list",
      "--all",
      "--json",
      "--limit",
      "0",
    ]);
    if (run.kind === "not-found") {
      return { state: "error", path, message: BD_NOT_FOUND_MESSAGE, ...empty };
    }
    if (run.kind === "failed") {
      if (/no beads database found/iu.test(run.message)) {
        return {
          state: "no-beads",
          path,
          message:
            "This folder does not use beads yet. Run bd init there to start tracking issues.",
          ...empty,
        };
      }
      bb.log.warn("bd list failed in " + path + ": " + run.message);
      return { state: "error", path, message: run.message, ...empty };
    }
    let rows: BdIssue[];
    try {
      rows = z.array(bdIssueSchema).parse(JSON.parse(run.stdout));
    } catch (cause) {
      bb.log.warn("bd list output not understood in " + path + ": " + cause);
      return {
        state: "error",
        path,
        message:
          "bd answered in a format this plugin does not understand. It may be a newer or older bd than the plugin was written for.",
        ...empty,
      };
    }
    watchFolder(path);
    const issues = toIssues(rows).map((issue) => ({
      ...issue,
      fleshOutThreadId: fleshingOut.get(fleshOutKey(path, issue.id)) ?? null,
    }));
    // A closed issue is finished, so it is no longer what the thread works
    // on. The tab's own close button clears it directly, but an issue can
    // also be closed outside the plugin (an agent or the user running
    // `bd close`), which this plugin never hears about. Catching it here, on
    // the next read, covers every route. The stored choice is removed as
    // well as hidden so it does not come back if the issue is reopened.
    // No change signal is published: the caller is already getting the
    // corrected answer, and publishing would make every tab reload again.
    const current = issues.find((issue) => issue.id === currentBeadId);
    if (
      input.threadId !== null &&
      current !== undefined &&
      current.status === CLOSED_STATUS
    ) {
      await bb.sdk.threads.updatePluginMetadata({
        threadId: input.threadId,
        remove: [CURRENT_BEAD_KEY],
      });
      return { state: "ok", path, message: null, issues, currentBeadId: null };
    }
    return { state: "ok", path, message: null, issues, currentBeadId };
  }

  /**
   * Creates one issue in the folder behind a thread or project.
   *
   * @returns `{ id }` of the new issue, or `{ message }` saying in plain words
   *   why it was not created. Never throws for expected problems.
   * Side effects: runs `bd create` once, which writes to the beads database;
   *   publishes CHANGED_CHANNEL on success.
   */
  async function createIssue(input: {
    threadId: string | null;
    projectId: string | null;
    title: string;
    description: string;
    type: (typeof ISSUE_TYPES)[number] | null;
    priority: number | null;
  }): Promise<{ id: string | null; message: string | null }> {
    const folder = await resolveFolder(input);
    if ("reason" in folder) return { id: null, message: folder.reason };
    if (!existsSync(folder.path)) {
      return {
        id: null,
        message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
      };
    }
    // Every free-text value is passed as the value of a named flag, so text
    // that starts with a dash can never be read by bd as an option.
    const args = ["create", "--json", "--title", input.title];
    if (input.description.trim() !== "") {
      args.push("--description", input.description);
    }
    if (input.type !== null) args.push("--type", input.type);
    if (input.priority !== null) args.push("--priority", `${input.priority}`);
    const run = await runBdIn(folder.path, args);
    if (run.kind === "not-found") {
      return { id: null, message: BD_NOT_FOUND_MESSAGE };
    }
    if (run.kind === "failed") {
      bb.log.warn("bd create failed in " + folder.path + ": " + run.message);
      return { id: null, message: run.message };
    }
    let id: string;
    try {
      id = z.object({ id: z.string() }).parse(JSON.parse(run.stdout)).id;
    } catch {
      // bd exited successfully, so the issue most likely exists; the tab's
      // reload will show it even though we could not read its id.
      bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
      return {
        id: null,
        message:
          "bd reported success but its answer could not be read. Refresh to check whether the issue was created.",
      };
    }
    bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
    return { id, message: null };
  }

  /**
   * Closes or reopens one issue in the folder behind a thread or project.
   *
   * @param command "close" or "reopen", passed to bd as its subcommand.
   * @returns `{ message: null }` on success, else the reason in plain words.
   *   Never throws for expected problems.
   * Side effects: runs `bd close` / `bd reopen` once, which writes to the
   *   beads database; on close, clears the thread's current bead if it was
   *   this issue; publishes CHANGED_CHANNEL on success.
   */
  async function setIssueOpen(
    command: "close" | "reopen",
    input: { threadId: string | null; projectId: string | null; beadId: string },
  ): Promise<{ message: string | null }> {
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return { message: `"${input.beadId}" is not a beads issue id.` };
    }
    const folder = await resolveFolder(input);
    if ("reason" in folder) return { message: folder.reason };
    if (!existsSync(folder.path)) {
      return {
        message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
      };
    }
    const run = await runBdIn(folder.path, [command, input.beadId, "--json"]);
    if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (run.kind === "failed") {
      bb.log.warn(`bd ${command} failed in ` + folder.path + ": " + run.message);
      return { message: run.message };
    }
    if (
      command === "close" &&
      input.threadId !== null &&
      (await readCurrentBead(input.threadId)) === input.beadId
    ) {
      // Publishes CHANGED_CHANNEL itself.
      await writeCurrentBead(input.threadId, null);
    } else {
      bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
    }
    return { message: null };
  }

  /**
   * Reads the comments of one issue, oldest first.
   *
   * @returns `{ comments, message: null }`, or an empty list with the reason
   *   in plain words. Never throws for expected problems.
   * Side effects: runs `bd --readonly comments` once; nothing is written.
   */
  async function listComments(input: {
    threadId: string | null;
    projectId: string | null;
    beadId: string;
  }): Promise<{ comments: IssueComment[]; message: string | null }> {
    const fail = (message: string) => ({ comments: [], message });
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return fail(`"${input.beadId}" is not a beads issue id.`);
    }
    const folder = await resolveFolder(input);
    if ("reason" in folder) return fail(folder.reason);
    if (!existsSync(folder.path)) {
      return fail(
        `The folder ${folder.path} does not exist on the machine BB runs on.`,
      );
    }
    const run = await runBdIn(folder.path, [
      "--readonly",
      "comments",
      input.beadId,
      "--json",
    ]);
    if (run.kind === "not-found") return fail(BD_NOT_FOUND_MESSAGE);
    if (run.kind === "failed") return fail(run.message);
    try {
      // bd prints `null` rather than `[]` for an issue without comments.
      const rows = z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]),
            author: z.string().optional(),
            text: z.string().optional(),
            created_at: z.string().optional(),
          }),
        )
        .nullable()
        .parse(JSON.parse(run.stdout));
      const comments = (rows ?? []).map((row) => ({
        id: `${row.id}`,
        author: row.author ?? "",
        createdAt: row.created_at ?? "",
        text: row.text ?? "",
      }));
      comments.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      return { comments, message: null };
    } catch {
      return fail("bd answered in a format this plugin does not understand.");
    }
  }

  bb.rpc.register(rpcContract, {
    issues_list: (input) => listIssues(input),
    issue_comments: (input) => listComments(input),
    issue_create: (input) => createIssue(input),
    issue_close: async ({ commit, ...input }) => {
      // Read the title before closing: it goes into the message to the agent
      // and is not part of bd close's answer.
      const title =
        commit && input.threadId !== null
          ? ((await listIssues(input)).issues.find(
              (issue) => issue.id === input.beadId,
            )?.title ?? null)
          : null;
      const outcome = await setIssueOpen("close", input);
      // Only after bd close succeeded: a failed close (for example a blocked
      // issue) must not leave the agent committing work that is not accepted.
      if (outcome.message !== null || !commit || input.threadId === null) {
        return outcome;
      }
      try {
        // "auto" starts a turn when the agent is idle and queues behind the
        // running turn otherwise. The plugin never runs git itself; the agent
        // commits under its own rules, including any need to ask first.
        await bb.sdk.threads.send({
          threadId: input.threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              mentions: [],
              text: `The user closed beads issue ${input.beadId}${title === null ? "" : `: ${JSON.stringify(title)}`} from the Beads tab and asked for its work to be committed. Commit the changes that belong to this issue, following the commit rules in AGENTS.md: only this issue's files, the issue's id and title in the subject line, and no push. If there is nothing to commit for it, say so.`,
            },
          ],
        });
      } catch (cause) {
        return {
          message: `The issue was closed, but the agent could not be asked to commit: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      return outcome;
    },
    issue_reopen: (input) => setIssueOpen("reopen", input),
    issue_flesh_out: async ({ threadId, projectId, beadId }) => {
      const fail = (message: string) => ({ threadId: null, message });
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return fail(`"${beadId}" is not a beads issue id.`);
      }
      const listed = await listIssues({ threadId, projectId });
      const issue = listed.issues.find((candidate) => candidate.id === beadId);
      if (listed.state !== "ok" || listed.path === null) {
        return fail(listed.message ?? "The issues could not be read.");
      }
      if (issue === undefined) {
        return fail(`Issue ${beadId} is no longer in the list.`);
      }
      const key = fleshOutKey(listed.path, beadId);
      const running = fleshingOut.get(key);
      if (running !== undefined) return { threadId: running, message: null };
      // Run in the same folder as the thread the user is in (it may be a
      // worktree); from the New thread screen, in the project's default one.
      let spawnProjectId = projectId;
      let environment:
        | { type: "reuse"; environmentId: string }
        | { type: "project-default" } = { type: "project-default" };
      if (threadId !== null) {
        const thread = await bb.sdk.threads.get({ threadId });
        spawnProjectId = thread.projectId;
        if (thread.environmentId !== null) {
          environment = { type: "reuse", environmentId: thread.environmentId };
        }
      }
      if (spawnProjectId === null) return fail("Pick a project first.");
      // A hidden worker: a background agent that does not show up in the
      // sidebar. The user asked for exactly this ("no separate thread, a
      // background agent is fine"). It is deliberately not made a child of
      // the user's thread, so nothing about it is reported into that thread.
      // Cost of hiding it: if its agent stops to ask for permission, nobody
      // sees that in the sidebar; the row's "open" link is the way in, and
      // the time limit below cleans up a worker that never finishes.
      let worker;
      try {
        worker = await bb.sdk.threads.spawn({
          projectId: spawnProjectId,
          environment,
          title: `Flesh out ${issue.id}: ${issue.title}`.slice(0, 120),
          visibility: "hidden",
          // Fleshing out is reading code and making design judgments, and it
          // runs in the background, so a stronger, slower model is worth it.
          // The model is a setting; empty means "whatever the project uses".
          ...(fleshOutModel.trim() === ""
            ? {}
            : { model: fleshOutModel.trim() }),
          prompt: fleshOutPrompt(issue.id, issue.title),
        });
      } catch (cause) {
        return fail(
          `Could not start a background agent to flesh the issue out: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      fleshingOut.set(key, worker.id);
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      // Not awaited: the answer goes back now, and the mark is cleared when
      // the new thread's agent goes idle (finished, or waiting for the user),
      // fails, or runs past the time limit.
      void bb.sdk.threads
        .wait({
          threadId: worker.id,
          status: "idle",
          timeoutMs: FLESH_OUT_TIMEOUT_MS,
        })
        .catch((cause) => bb.log.warn("flesh-out wait ended: " + cause))
        .finally(async () => {
          if (fleshingOut.get(key) === worker.id) fleshingOut.delete(key);
          bb.realtime.publish(CHANGED_CHANNEL, { threadId });
          // A hidden worker is not cleaned up by anyone else: archive it so
          // it leaves the active lists, then stop it so its agent process is
          // released. Each step is attempted even if the other fails.
          await bb.sdk.threads
            .archive({ threadId: worker.id })
            .catch((cause) => bb.log.warn("flesh-out archive failed: " + cause));
          await bb.sdk.threads
            .stop({ threadId: worker.id })
            .catch((cause) => bb.log.warn("flesh-out stop failed: " + cause));
        });
      return { threadId: worker.id, message: null };
    },
    issue_update: async ({ threadId, projectId, beadId, type, priority }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return { message: `"${beadId}" is not a beads issue id.` };
      }
      if (type === null && priority === null) return { message: null };
      const folder = await resolveFolder({ threadId, projectId });
      if ("reason" in folder) return { message: folder.reason };
      if (!existsSync(folder.path)) {
        return {
          message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
        };
      }
      // Values come from a fixed list (type) or a checked number (priority),
      // so nothing free-form reaches bd's command line here.
      const args = ["update", beadId, "--json"];
      if (type !== null) args.push("--type", type);
      if (priority !== null) args.push("--priority", `${priority}`);
      const run = await runBdIn(folder.path, args);
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn("bd update failed in " + folder.path + ": " + run.message);
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    current_start: async ({ threadId, beadId }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        throw new Error(`"${beadId}" is not a beads issue id.`);
      }
      // Look the issue up so the message can carry its title, and so a stale
      // row (issue deleted since the tab loaded) fails before anything is sent.
      const listed = await listIssues({ threadId, projectId: null });
      const issue = listed.issues.find((candidate) => candidate.id === beadId);
      if (issue?.status === CLOSED_STATUS) {
        throw new Error(`Issue ${beadId} is closed. Reopen it before starting work on it.`);
      }
      if (issue === undefined) {
        throw new Error(`Issue ${beadId} is no longer in the list. Refresh and try again.`);
      }
      await writeCurrentBead(threadId, beadId);
      // "auto" starts a turn when the agent is idle and queues behind the
      // running turn otherwise, so pressing play never interrupts work.
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            mentions: [],
            // The agent is told NOT to close: the user validates the work
            // and closes the issue themselves (bead-bb-e1d).
            text: `Work on beads issue ${issue.id}: ${JSON.stringify(issue.title)}. Run \`bd show ${issue.id}\` for the details, mark it in progress, and do the work. When you are finished, do not close the issue: add a comment to it saying what you did and how you checked it, leave it in progress, and tell the user it is ready for them to validate. The user closes it.`,
          },
        ],
      });
      return { currentBeadId: beadId };
    },
    current_set: async ({ threadId, beadId }) => {
      if (beadId !== null && !BEAD_ID_PATTERN.test(beadId)) {
        throw new Error(`"${beadId}" is not a beads issue id.`);
      }
      await writeCurrentBead(threadId, beadId);
      return { currentBeadId: beadId };
    },
  });

  // The agent's way to say which issue its thread is working on. A native
  // tool rather than a `bb` command because agent sandboxes on Linux can block
  // the local connection a `bb` command needs, which would turn every update
  // into a permission prompt.
  bb.agents.registerTool({
    name: "beads_set_current",
    description:
      "Tell BB which beads issue this thread is working on, so the user sees it highlighted in the Beads tab. Pass an empty id to clear it.",
    instructions:
      "This repository tracks work in beads. When you start working on a beads issue, or switch to another one, call beads_set_current with its id so the user can see what this thread is working on. Call it with an empty id when the thread is no longer working on any issue. It does not change the issue itself: still claim issues with bd. Do not close an issue when you finish it; the user validates the work and closes it.",
    presentation: {
      label: { pending: "Setting current bead", completed: "Set current bead" },
    },
    parameters: z.object({
      id: z
        .string()
        .describe("Beads issue id, e.g. proj-a1b. Empty string clears it."),
    }),
    async execute({ id }, { threadId }) {
      const beadId = id.trim();
      if (beadId === "") {
        await writeCurrentBead(threadId, null);
        return "Cleared this thread's current bead.";
      }
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return {
          content: [{ type: "text", text: `"${beadId}" is not a beads issue id.` }],
          isError: true,
        };
      }
      // Reject ids that do not exist, so a typo is reported to the agent
      // instead of showing the user a highlight that points nowhere.
      const listed = await listIssues({ threadId, projectId: null });
      const target = listed.issues.find((issue) => issue.id === beadId);
      if (target?.status === CLOSED_STATUS) {
        return {
          content: [
            {
              type: "text",
              text: `${beadId} is closed, so it cannot be this thread's current bead. Reopen it first if work on it continues.`,
            },
          ],
          isError: true,
        };
      }
      if (listed.state === "ok" && target === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `No beads issue with id ${beadId} in ${listed.path}. Run bd list to see ids.`,
            },
          ],
          isError: true,
        };
      }
      await writeCurrentBead(threadId, beadId);
      return `This thread's current bead is now ${beadId}.`;
    },
  });

  // Offer the tool only to threads whose folder uses beads, so threads in
  // other repositories get no extra tool or instructions. The callback must be
  // synchronous, hence the direct look for a .beads folder; a thread on
  // another machine simply does not get the tool.
  bb.agents.configure((context) => {
    const path = context.environment.path;
    const usesBeads = path !== null && existsSync(join(path, ".beads"));
    return { tools: usesBeads ? ["beads_set_current"] : [], skills: [] };
  });
}
