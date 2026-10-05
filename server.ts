// bb-plugin-airbender — backend entry.
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
//   and changing an issue's type, priority, title, description, parent or
//   category (`bd update`); nothing here deletes an issue or edits its design,
//   acceptance criteria, notes or comments.
// - "Define" runs as a background agent: a hidden worker thread that is
//   not shown in the sidebar and is archived and stopped when it finishes,
//   so the thread the user is working in is not interrupted (bead-bb-4la).
// - The play button asks the thread's agent to clarify requirements, then
//   agree an implementation plan, then build; the agent may skip either of
//   the first two when it is obvious, and must say so (bead-bb-avf).
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
// - Issues can sit inside other issues, to any depth. beads stores one
//   `parent` per issue; this backend passes it through as `parentId` and the
//   tab builds the tree. Play on an issue with sub-issues asks the agent to
//   work on all of them, and "Close & commit" on it closes all of them
//   (bead-bb-5qt).
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

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { programExists, runBd, shellQuote } from "./server/bd.ts";
import type { BdRun } from "./server/bd.ts";
import { rpcContract } from "./server/contract.ts";
import type {
  Issue,
  IssueComment,
  IssuesResult,
  SetupStatus,
} from "./server/contract.ts";
import {
  CATEGORY_PREFIX,
  RELATES_TO,
  bdIssueSchema,
  cleanCategory,
  descendantsOf,
  toIssues,
} from "./server/issues.ts";
import type { BdIssue } from "./server/issues.ts";
import {
  AIRBENDER_RULES,
  RULES_START,
  claudeFileFor,
  definePrompt,
  workRequest,
} from "./server/prompts.ts";
import {
  BEAD_ID_PATTERN,
  CHANGED_CHANNEL,
  CLOSED_STATUS,
  ISSUE_TYPES,
  QUICK_REPLIES,
  SETUP_AGENTS,
} from "./shared/constants.ts";
import type { SetupAction } from "./shared/constants.ts";

/**
 * The ways of installing beads the tab can offer, each with the program it
 * needs on the machine. The script, Homebrew and npm commands are the ones
 * in beads' own README; the mise one is how beads is installed on the
 * owner's machine. Only those whose program is present are offered.
 */
const INSTALL_METHODS = [
  {
    id: "script",
    label: "Beads' install script",
    needs: "curl",
    command:
      "curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash",
  },
  {
    id: "mise",
    label: "mise",
    needs: "mise",
    command: "mise use -g github:gastownhall/beads",
  },
  {
    id: "brew",
    label: "Homebrew",
    needs: "brew",
    command: "brew install beads",
  },
  {
    id: "npm",
    label: "npm",
    needs: "npm",
    command: "npm install -g @beads/bd",
  },
] as const;

/** How often a running setup terminal is checked, and for how long at most. */
const SETUP_POLL_MS = 1500;

const SETUP_TIMEOUT_MS = 15 * 60_000;

/**
 * The id this plugin had before it was renamed to "airbender". BB keeps a
 * plugin's per-thread data under the plugin's id, so each thread's current
 * bead from before the rename is still stored under this one; it is read as
 * a fallback (see readCurrentBead) and never written.
 */
const LEGACY_PLUGIN_ID = "beads";

/** Key under which a thread's current bead id is stored in thread metadata. */
const CURRENT_BEAD_KEY = "currentBead";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    bdCommand: {
      type: "string",
      label: "bd command",
      description:
        "Name or full path of the beads command-line tool. Leave as bd unless BB cannot find it.",
      default: "bd",
    },
    defineModel: {
      type: "string",
      label: "Define model",
      description:
        "Model the background agent uses when you press Define, as a model id such as claude-fable-5-1. Leave empty to use the project's default model.",
      default: "claude-fable-5-1",
    },
  });
  const { bdCommand, defineModel } = await settings.get();

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
              "This thread works on another machine. The Airbender tab can only read folders on the machine BB itself runs on.",
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

  /** Longest a define run is shown as running before the mark is dropped. */
  const DEFINE_TIMEOUT_MS = 20 * 60_000;

  /** Running define runs: folder + issue id -> the thread doing the work. */
  const defining = new Map<string, string>();
  const defineKey = (path: string, beadId: string) => `${path}\n${beadId}`;

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

  /** The setup action running in a terminal, per folder. */
  const setupRunning = new Map<
    string,
    { action: SetupAction; title: string }
  >();
  /**
   * The setup conditions already found met, per folder: the working beads
   * program, the folder set up, the agents configured, the rules present.
   * Kept only while the plugin runs; a reload checks everything once more.
   */
  const setupMet = new Map<
    string,
    { bd: string | null; folder: boolean; agents: string[]; rules: boolean }
  >();
  /** How the last setup terminal ended, per folder. */
  const setupLastRun = new Map<string, NonNullable<SetupStatus["lastRun"]>>();

  /**
   * The beads program that works on this machine: the first of the known
   * locations that runs, or null. Used where the program's own path is
   * needed (to put it in a terminal command), not just its output.
   */
  async function findBd(cwd: string): Promise<string | null> {
    for (const candidate of bdCandidates) {
      const run = await runBd(candidate, ["--version"], cwd);
      if (run.kind !== "not-found") return candidate;
    }
    return null;
  }

  /**
   * Works out what is in place for a folder (see SetupStatus).
   *
   * Side effects: for each condition not yet known to be met, one check (bd
   * version, bd list, one bd check per agent, a read of AGENTS.md); none for
   * conditions already met. Changes nothing on disk.
   */
  async function setupStatus(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<SetupStatus> {
    const nothing = {
      bdInstalled: false,
      installMethods: [],
      folderReady: false,
      agents: [],
      rulesPresent: false,
      running: null,
      lastRun: null,
    };
    const folder = await resolveFolder(input);
    if ("reason" in folder) {
      return { path: null, unavailable: folder.reason, ...nothing };
    }
    const { path } = folder;
    if (!existsSync(path)) {
      return {
        path,
        unavailable: `The folder ${path} does not exist on the machine BB runs on.`,
        ...nothing,
      };
    }
    // A condition that was found met is not checked again (the user's
    // rule): setup only ever moves forward in practice, and detecting that
    // something was taken away again is not worth a check on every refresh.
    // What is still unmet is checked every time. So a folder that is fully
    // set up costs no bd runs here at all.
    const met = setupMet.get(path) ?? { bd: null, folder: false, agents: [], rules: false };
    setupMet.set(path, met);
    met.bd ??= await findBd(path);
    const bd = met.bd;
    if (bd !== null && !met.folder) {
      // "Set up" means what listing issues means by it, so the panel and
      // the list agree: bd finds a database from this folder upward.
      met.folder = (await listIssues(input)).state === "ok";
    }
    const folderReady = met.folder;
    const agents = [];
    if (bd !== null && folderReady) {
      for (const agent of SETUP_AGENTS) {
        if (!met.agents.includes(agent.id)) {
          // bd's own check: it exits 0 when its files for that agent are
          // in place, and non-zero otherwise.
          const check = await runBd(bd, ["setup", agent.id, "--check"], path);
          if (check.kind === "ok") met.agents.push(agent.id);
        }
        agents.push({ ...agent, configured: met.agents.includes(agent.id) });
      }
    }
    if (!met.rules) {
      try {
        // Both halves must hold: the rules in AGENTS.md, and a CLAUDE.md,
        // where there is one, that needs no change (see claudeFileFor).
        const claudeFile = join(path, "CLAUDE.md");
        met.rules =
          readFileSync(join(path, "AGENTS.md"), "utf8").includes(RULES_START) &&
          claudeFileFor(
            existsSync(claudeFile) ? readFileSync(claudeFile, "utf8") : null,
          ) === null;
      } catch {
        // A file is missing (or unreadable): the step is not done.
      }
    }
    const rulesPresent = met.rules;
    return {
      path,
      unavailable: null,
      bdInstalled: bd !== null,
      installMethods: INSTALL_METHODS.filter((method) =>
        programExists(method.needs),
      ).map(({ id, label, command }) => ({ id, label, command })),
      folderReady,
      agents,
      rulesPresent,
      running: setupRunning.get(path) ?? null,
      lastRun: setupLastRun.get(path) ?? null,
    };
  }

  /**
   * Runs one setup command in a BB terminal the user can watch and type
   * into, and tells the tab when it ends.
   *
   * A terminal and not a hidden child process: an install may ask for a
   * password, folder setup asks questions, and the user should see what is
   * done to their machine. A terminal that belongs to the thread is used
   * when there is one, so it shows up beside that thread; otherwise one on
   * this machine in the folder.
   *
   * @returns Once the terminal is started. The wait for its end goes on in
   *   the background: when it exits (or after SETUP_TIMEOUT_MS) the exit
   *   code and the last lines of output are kept in setupLastRun and every
   *   open tab is told to reload.
   * @throws When BB cannot open the terminal.
   */
  async function runInTerminal(input: {
    threadId: string | null;
    path: string;
    action: SetupAction;
    title: string;
    command: string;
  }): Promise<void> {
    const { threadId, path, action, title } = input;
    const { primaryHostId } = await bb.sdk.system.config();
    if (threadId === null && primaryHostId === null) {
      throw new Error("BB did not say which machine it runs on.");
    }
    const session = await bb.sdk.terminals.create({
      cols: 100,
      rows: 30,
      title,
      scope:
        threadId !== null
          ? { kind: "thread", threadId }
          : { kind: "host_path", hostId: primaryHostId!, cwd: path },
      // The command goes through a shell (checked with a test terminal),
      // so the cd and the pipe in the install script work as written.
      start: {
        mode: "command",
        command: `cd ${shellQuote(path)} && ${input.command}`,
      },
    });
    setupRunning.set(path, { action, title });
    setupLastRun.delete(path);
    bb.realtime.publish(CHANGED_CHANNEL, { path });
    const startedAt = Date.now();
    const watchTerminal = async () => {
      let exitCode: number | null = null;
      try {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_MS));
          const now = await bb.sdk.terminals.get({ terminalId: session.id });
          if (now.status === "exited" || now.status === "disconnected") {
            exitCode = now.exitCode;
            break;
          }
          if (Date.now() - startedAt > SETUP_TIMEOUT_MS) break;
        }
      } catch (cause) {
        bb.log.warn("watching setup terminal failed: " + cause);
      }
      let tail = "";
      try {
        const output = await bb.sdk.terminals.output({
          terminalId: session.id,
          tailBytes: 4000,
        });
        tail = output.chunks
          .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
          .join("")
          // Colour and cursor codes mean nothing outside a terminal.
          .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
          .replace(/\r/gu, "")
          .trim()
          .split("\n")
          .slice(-12)
          .join("\n");
      } catch {
        // The output is a convenience; the exit code is what matters.
      }
      setupRunning.delete(path);
      setupLastRun.set(path, { action, title, exitCode, tail });
      bb.realtime.publish(CHANGED_CHANNEL, { path });
    };
    void watchTerminal();
  }

  /**
   * Shared checks for adding and removing a link: both ids look like beads
   * ids, are different, and are in the folder's list.
   *
   * @returns The folder to run bd in, or `{ message }` saying in plain words
   *   why the link cannot be touched.
   */
  async function linkEnds(input: {
    threadId: string | null;
    projectId: string | null;
    fromId: string;
    toId: string;
  }): Promise<{ path: string } | { message: string }> {
    for (const id of [input.fromId, input.toId]) {
      if (!BEAD_ID_PATTERN.test(id)) {
        return { message: `"${id}" is not a beads issue id.` };
      }
    }
    if (input.fromId === input.toId) {
      return { message: "An issue cannot be linked to itself." };
    }
    const listed = await listIssues({
      threadId: input.threadId,
      projectId: input.projectId,
    });
    if (listed.state !== "ok" || listed.path === null) {
      return { message: listed.message ?? "The issues could not be read." };
    }
    for (const id of [input.fromId, input.toId]) {
      if (!listed.issues.some((issue) => issue.id === id)) {
        return { message: `Issue ${id} is no longer in the list.` };
      }
    }
    return { path: listed.path };
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
    const asBeadId = (value: unknown) =>
      typeof value === "string" && BEAD_ID_PATTERN.test(value) ? value : null;
    const own = (await bb.sdk.threads.getPluginMetadata({
      threadId,
    })) as Record<string, unknown>;
    // Anything stored under this plugin's own id decides, including a
    // stored "none" (see writeCurrentBead).
    if (CURRENT_BEAD_KEY in own) return asBeadId(own[CURRENT_BEAD_KEY]);
    // Nothing under our own id: the thread may have its choice from before
    // the plugin was renamed, stored under the old id. Reading it here is
    // what keeps that data across the rename. A failure to read it is not
    // worth failing the whole list for.
    const legacy = (await bb.sdk.threads
      .getPluginMetadata({ threadId, pluginId: LEGACY_PLUGIN_ID })
      .catch(() => ({}))) as Record<string, unknown>;
    return asBeadId(legacy[CURRENT_BEAD_KEY]);
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
    // "None" is stored as an explicit null, not by removing the key: with
    // the key gone, readCurrentBead would fall back to what the thread had
    // under the plugin's old id, and a cleared choice would come back.
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [CURRENT_BEAD_KEY]: beadId },
    });
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
      return { state: "no-bd", path, message: BD_NOT_FOUND_MESSAGE, ...empty };
    }
    if (run.kind === "failed") {
      if (/no beads database found/iu.test(run.message)) {
        return {
          state: "no-beads",
          path,
          message:
            "This folder does not use beads yet. Set it up to start tracking issues here.",
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
      defineThreadId: defining.get(defineKey(path, issue.id)) ?? null,
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
      // Stored as an explicit null, for the reason given in
      // writeCurrentBead.
      await bb.sdk.threads.updatePluginMetadata({
        threadId: input.threadId,
        set: { [CURRENT_BEAD_KEY]: null },
      });
      return { state: "ok", path, message: null, issues, currentBeadId: null };
    }
    return { state: "ok", path, message: null, issues, currentBeadId };
  }

  /**
   * Sets or clears one issue's category.
   *
   * Every category label the issue has is removed first, so an issue never
   * ends up with two, even if one was added by hand with bd.
   *
   * @returns `{ message: null }` on success, else the reason in plain words.
   * Side effects: one `bd update`, which writes to the beads database;
   *   publishes CHANGED_CHANNEL on success.
   */
  async function setCategory(input: {
    threadId: string | null;
    projectId: string | null;
    beadId: string;
    category: string | null;
  }): Promise<{ message: string | null }> {
    if (!BEAD_ID_PATTERN.test(input.beadId)) {
      return { message: `"${input.beadId}" is not a beads issue id.` };
    }
    const listed = await listIssues(input);
    if (listed.state !== "ok" || listed.path === null) {
      return { message: listed.message ?? "The issues could not be read." };
    }
    if (!listed.issues.some((issue) => issue.id === input.beadId)) {
      return { message: `Issue ${input.beadId} is no longer in the list.` };
    }
    let next: string | null = null;
    if (input.category !== null) {
      const cleaned = cleanCategory(input.category);
      if ("reason" in cleaned) return { message: cleaned.reason };
      next = cleaned.name;
    }
    // The list this plugin returns has the category labels taken out, so the
    // raw labels are read again here to know exactly which ones to remove.
    const raw = await runBdIn(listed.path, [
      "--readonly",
      "label",
      "list",
      input.beadId,
      "--json",
    ]);
    if (raw.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (raw.kind === "failed") return { message: raw.message };
    let present: string[];
    try {
      present = z
        .array(z.string())
        .nullable()
        .transform((labels) => labels ?? [])
        .parse(JSON.parse(raw.stdout))
        .filter((label) => label.startsWith(CATEGORY_PREFIX));
    } catch {
      return {
        message: "bd answered in a format this plugin does not understand.",
      };
    }
    const wanted = next === null ? null : CATEGORY_PREFIX + next;
    const args = ["update", input.beadId, "--json"];
    for (const label of present) {
      if (label !== wanted) args.push("--remove-label", label);
    }
    if (wanted !== null && !present.includes(wanted)) {
      args.push("--add-label", wanted);
    }
    if (args.length === 3) return { message: null }; // Nothing to change.
    const run = await runBdIn(listed.path, args);
    if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (run.kind === "failed") {
      bb.log.warn("bd update (category) failed in " + listed.path + ": " + run.message);
      return { message: run.message };
    }
    bb.realtime.publish(CHANGED_CHANNEL, { threadId: input.threadId });
    return { message: null };
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
    parentId: string | null;
    category: string | null;
  }): Promise<{ id: string | null; message: string | null }> {
    if (input.parentId !== null && !BEAD_ID_PATTERN.test(input.parentId)) {
      return {
        id: null,
        message: `"${input.parentId}" is not a beads issue id.`,
      };
    }
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
    if (input.parentId !== null) args.push("--parent", input.parentId);
    // The category: the one chosen, else the parent's (a new sub-issue
    // inherits its parent's category; this happens once, here, and later
    // changes to the parent do not follow).
    if (input.category !== null || input.parentId !== null) {
      const listed = await listIssues(input);
      let category: string | null = null;
      if (input.category !== null) {
        const cleaned = cleanCategory(input.category);
        if ("reason" in cleaned) return { id: null, message: cleaned.reason };
        category = cleaned.name;
      } else {
        category =
          listed.issues.find((issue) => issue.id === input.parentId)
            ?.category ?? null;
      }
      // Safe as a flag value: it always starts with "category:", never a
      // dash, and cleanCategory has ruled out commas.
      if (category !== null) args.push("--labels", CATEGORY_PREFIX + category);
    }
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

  /**
   * Starts a background agent that defines one issue (see
   * issue_define in the contract).
   *
   * @returns The worker thread's id, or the reason nothing was started. If
   *   one is already running for the issue, its id is returned and no second
   *   one is started.
   */
  async function startDefine({
    threadId,
    projectId,
    beadId,
  }: {
    threadId: string | null;
    projectId: string | null;
    beadId: string;
  }): Promise<{ threadId: string | null; message: string | null }> {
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
    const key = defineKey(listed.path, beadId);
    const running = defining.get(key);
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
        title: `Define ${issue.id}: ${issue.title}`.slice(0, 120),
        visibility: "hidden",
        // Defining is reading code and making design judgments, and it
        // runs in the background, so a stronger, slower model is worth it.
        // The model is a setting; empty means "whatever the project uses".
        ...(defineModel.trim() === ""
          ? {}
          : { model: defineModel.trim() }),
        prompt: definePrompt(issue.id, issue.title),
      });
    } catch (cause) {
      return fail(
        `Could not start a background agent to define the issue: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    defining.set(key, worker.id);
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });
    // Not awaited: the answer goes back now, and the mark is cleared when
    // the new thread's agent goes idle (finished, or waiting for the user),
    // fails, or runs past the time limit.
    void bb.sdk.threads
      .wait({
        threadId: worker.id,
        status: "idle",
        timeoutMs: DEFINE_TIMEOUT_MS,
      })
      .catch((cause) => bb.log.warn("define wait ended: " + cause))
      .finally(async () => {
        if (defining.get(key) === worker.id) defining.delete(key);
        bb.realtime.publish(CHANGED_CHANNEL, { threadId });
        // A hidden worker is not cleaned up by anyone else: archive it so
        // it leaves the active lists, then stop it so its agent process is
        // released. Each step is attempted even if the other fails.
        await bb.sdk.threads
          .archive({ threadId: worker.id })
          .catch((cause) => bb.log.warn("define archive failed: " + cause));
        await bb.sdk.threads
          .stop({ threadId: worker.id })
          .catch((cause) => bb.log.warn("define stop failed: " + cause));
      });
    return { threadId: worker.id, message: null };

  }

  bb.rpc.register(rpcContract, {
    issues_list: (input) => listIssues(input),
    issue_comments: (input) => listComments(input),
    issue_create: (input) => createIssue(input),
    issue_close: async ({ commit, ...input }) => {
      // Read the issue before closing: its title goes into the message to
      // the agent, and its open sub-issues have to be closed first.
      const before =
        commit && input.threadId !== null ? await listIssues(input) : null;
      const title =
        before?.issues.find((issue) => issue.id === input.beadId)?.title ??
        null;
      // "Close & commit" on an epic closes everything still open inside it
      // (the user's decision, bead-bb-5qt). Deepest first, because beads
      // refuses to close an issue that still has open sub-issues. A plain
      // close (commit false) does not do this: it is the "drop this issue"
      // action, and dropping a whole tree by one click would be too easy.
      const closedSubIssues: Issue[] = [];
      if (before !== null) {
        const open = descendantsOf(input.beadId, before.issues).filter(
          (issue) => issue.status !== CLOSED_STATUS,
        );
        for (const subIssue of open.reverse()) {
          const closedOne = await setIssueOpen("close", {
            ...input,
            beadId: subIssue.id,
          });
          if (closedOne.message !== null) {
            return {
              message: `Could not close sub-issue ${subIssue.id}, so ${input.beadId} was left open: ${closedOne.message}`,
            };
          }
          closedSubIssues.push(subIssue);
        }
      }
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
              text:
                `The user closed beads issue ${input.beadId}${title === null ? "" : `: ${JSON.stringify(title)}`} from the Airbender tab and asked for its work to be committed.` +
                (closedSubIssues.length === 0
                  ? " Commit the changes that belong to this issue, following the commit rules in AGENTS.md: only this issue's files, and the issue's id and title in the subject line. The repository's hook pushes each commit by itself; tell the user if that push fails. If there is nothing to commit for it, say so."
                  : ` Its sub-issues were closed with it: ${closedSubIssues
                      .map((issue) => `${issue.id} (${JSON.stringify(issue.title)})`)
                      .join(
                        ", ",
                      )}. Commit the changes that belong to this issue and those sub-issues, following the commit rules in AGENTS.md: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title; only these issues' files; and the issue's id and title in the subject line. The repository's hook pushes each commit by itself; tell the user if that push fails. If there is nothing to commit, say so.`),
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
    issue_define: (input) => startDefine(input),
    issue_set_category: (input) => setCategory(input),
    issue_link: async ({ threadId, projectId, fromId, toId, kind }) => {
      const checked = await linkEnds({ threadId, projectId, fromId, toId });
      if ("message" in checked) return checked;
      // "related" goes through beads' own see-also command, which links both
      // issues to each other; every other kind is a one-way dependency.
      // Cycles and duplicates are left to bd, whose message is passed on.
      const run = await runBdIn(
        checked.path,
        kind === "related"
          ? ["dep", "relate", fromId, toId, "--json"]
          : ["dep", "add", fromId, toId, "--type", kind, "--json"],
      );
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn("bd dep add failed in " + checked.path + ": " + run.message);
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    issue_unlink: async ({ threadId, projectId, fromId, toId, kind }) => {
      const checked = await linkEnds({ threadId, projectId, fromId, toId });
      if ("message" in checked) return checked;
      // A two-way link is undone with the command that made it, so both
      // halves go; `dep remove` would leave the other issue's half behind.
      const run = await runBdIn(
        checked.path,
        kind === RELATES_TO
          ? ["dep", "unrelate", fromId, toId, "--json"]
          : ["dep", "remove", fromId, toId, "--json"],
      );
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn(
          "bd dep remove failed in " + checked.path + ": " + run.message,
        );
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    issue_set_parent: async ({ threadId, projectId, beadId, parentId }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return { message: `"${beadId}" is not a beads issue id.` };
      }
      if (parentId !== null && !BEAD_ID_PATTERN.test(parentId)) {
        return { message: `"${parentId}" is not a beads issue id.` };
      }
      const listed = await listIssues({ threadId, projectId });
      if (listed.state !== "ok" || listed.path === null) {
        return { message: listed.message ?? "The issues could not be read." };
      }
      if (!listed.issues.some((issue) => issue.id === beadId)) {
        return { message: `Issue ${beadId} is no longer in the list.` };
      }
      if (parentId !== null) {
        if (!listed.issues.some((issue) => issue.id === parentId)) {
          return { message: `Issue ${parentId} is no longer in the list.` };
        }
        // Checked here and not left to bd: an issue inside itself would
        // disappear from every view that walks the tree from the top.
        if (
          parentId === beadId ||
          descendantsOf(beadId, listed.issues).some(
            (issue) => issue.id === parentId,
          )
        ) {
          return {
            message:
              "An issue cannot be moved inside itself or inside one of its own sub-issues.",
          };
        }
      }
      // An empty --parent is how bd takes an issue out of its parent.
      const run = await runBdIn(listed.path, [
        "update",
        beadId,
        "--json",
        "--parent",
        parentId ?? "",
      ]);
      if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
      if (run.kind === "failed") {
        bb.log.warn("bd update --parent failed in " + listed.path + ": " + run.message);
        return { message: run.message };
      }
      bb.realtime.publish(CHANGED_CHANNEL, { threadId });
      return { message: null };
    },
    issue_update: async ({
      threadId,
      projectId,
      beadId,
      type,
      priority,
      title,
      description,
    }) => {
      if (!BEAD_ID_PATTERN.test(beadId)) {
        return { message: `"${beadId}" is not a beads issue id.` };
      }
      if (
        type === null &&
        priority === null &&
        title === null &&
        description === null
      ) {
        return { message: null };
      }
      const folder = await resolveFolder({ threadId, projectId });
      if ("reason" in folder) return { message: folder.reason };
      if (!existsSync(folder.path)) {
        return {
          message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
        };
      }
      // Type comes from a fixed list and priority is a checked number. Title
      // and description are free text, so each is passed as the value of a
      // named flag: text that starts with a dash can then never be read by
      // bd as an option. No shell is involved (see runBd).
      const args = ["update", beadId, "--json"];
      if (type !== null) args.push("--type", type);
      if (priority !== null) args.push("--priority", `${priority}`);
      if (title !== null) args.push("--title", title);
      if (description !== null) args.push("--description", description);
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
            text: workRequest(
              issue.id,
              issue.title,
              descendantsOf(issue.id, listed.issues).filter(
                (candidate) => candidate.status !== CLOSED_STATUS,
              ),
            ),
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
    // Sent from the server, like the play message, rather than through the
    // message box: that way whatever the user has typed there is left alone.
    setup_status: (input) => setupStatus(input),
    setup_run: async ({ threadId, projectId, action, option }) => {
      const status = await setupStatus({ threadId, projectId });
      if (status.path === null || status.unavailable !== null) {
        return { message: status.unavailable ?? "There is no folder to set up." };
      }
      const { path } = status;
      if (status.running !== null) {
        return { message: `"${status.running.title}" is still running.` };
      }
      // Each action is refused when it is already done or cannot be done
      // yet. The tab greys those out; this is the same rule on the side
      // that actually runs things.
      if (action === "rules") {
        if (status.rulesPresent) {
          return { message: "Airbender's rules are already in place." };
        }
        const file = join(path, "AGENTS.md");
        try {
          const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
          // Added at the end, after whatever is there; nothing is replaced.
          // Skipped when only the CLAUDE.md half was missing.
          if (!existing.includes(RULES_START)) {
            writeFileSync(
              file,
              existing === ""
                ? AIRBENDER_RULES
                : `${existing.replace(/\n*$/u, "")}\n\n${AIRBENDER_RULES}`,
            );
          }
        } catch (cause) {
          return { message: `AGENTS.md could not be written: ${cause}` };
        }
        const claudeFile = join(path, "CLAUDE.md");
        try {
          const next = claudeFileFor(
            existsSync(claudeFile) ? readFileSync(claudeFile, "utf8") : null,
          );
          if (next !== null) writeFileSync(claudeFile, next);
        } catch (cause) {
          return { message: `CLAUDE.md could not be written: ${cause}` };
        }
        bb.realtime.publish(CHANGED_CHANNEL, { path });
        return { message: null };
      }
      let title: string;
      let command: string;
      if (action === "install") {
        if (status.bdInstalled) return { message: "Beads is already installed." };
        const method = status.installMethods.find(
          (candidate) => candidate.id === option,
        );
        if (method === undefined) {
          return { message: "That way of installing is not available here." };
        }
        title = `Install beads (${method.label})`;
        command = method.command;
      } else {
        const bd = await findBd(path);
        if (bd === null) return { message: "Install beads first." };
        if (action === "init") {
          if (status.folderReady) {
            return { message: "Beads is already set up in this folder." };
          }
          title = "Set up beads in this folder";
          command = `${shellQuote(bd)} init`;
        } else {
          if (!status.folderReady) {
            return { message: "Set up beads in this folder first." };
          }
          const agent = status.agents.find(
            (candidate) => candidate.id === option,
          );
          if (agent === undefined) return { message: "Unknown agent." };
          if (agent.configured) {
            return { message: `Beads is already configured for ${agent.label}.` };
          }
          title = `Configure beads for ${agent.label}`;
          command = `${shellQuote(bd)} setup ${agent.id}`;
        }
      }
      try {
        await runInTerminal({ threadId, path, action, title, command });
      } catch (cause) {
        return {
          message: `The terminal could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      return { message: null };
    },
    thread_reply: async ({ threadId, kind }) => {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", mentions: [], text: QUICK_REPLIES[kind] }],
      });
      return { sent: true as const };
    },
  });

  // The agent's way to say which issue its thread is working on. A native
  // tool rather than a `bb` command because agent sandboxes on Linux can block
  // the local connection a `bb` command needs, which would turn every update
  // into a permission prompt.
  bb.agents.registerTool({
    name: "beads_set_current",
    description:
      "Tell BB which beads issue this thread is working on, so the user sees it highlighted in the Airbender tab. Pass an empty id to clear it.",
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
