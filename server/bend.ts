// server/bend.ts — the tab's door to issues: it runs the `bend` program.
//
// What: runs bend (the Go program in bend/) for every read and change of an
// issue, reads its JSON, gives the tracker for each folder, and turns each
// kind of failure into one of the tab's own outcomes.
//
// Why: bend is the one implementation of "read and change a repository's
// issues, whatever tracker holds them" (bead-bb-c9l.4, by the decision in
// bead-bb-c9l.7): agents use it from a terminal, and the tab uses the very
// same program, so the two cannot drift apart. Before, the tab imported the
// tracker code as TypeScript; that code is gone.
//
// Design notes:
// - One run of bend per operation, without a shell. Free text never stands
//   where bend could read it as an option: ids and titles go after `--`,
//   long texts on standard input.
// - bend reports a failure with --json as `{ok: false, kind, error}`; the
//   kind is what decides the tab's state, never the words.
// - The tab is told the beads program it found (BEND_BD), so the plugin's
//   "bd command" setting keeps working. It takes whatever tracker bend
//   finds for the folder (bead-bb-c9l.6): bend answers reads from its copy,
//   so a hosted tracker is as quick as beads.
// - bend is asked what the folder has first; the beads program is needed
//   only where the tracker is beads, so a repository on GitHub issues opens
//   on a machine that has no beads. A folder with no tracker says so
//   whether or not beads is installed: choosing the tracker comes first in
//   setup, and installing beads only after beads was chosen.
// - bend answers reads from a copy of the issues it keeps on this machine
//   (bead-bb-c9l.14), so asking for the list is cheap and nothing is kept
//   here. `list(true)` has bend reread that copy first.
// - What was found for a folder is remembered. It is forgotten when a run
//   reports a program missing, so installing or building one is picked up
//   without reloading the plugin. A folder with no tracker is not
//   remembered: setting it up must show on the next read.
// - The shape of bend's JSON is written down here once, as types. bend
//   counts the changes to that shape (`bend version`); a bend older than
//   NEEDED_VERSION is treated as missing, with words that say to build it
//   again, instead of failing on an option it does not know.
//
// Gotchas:
// - No BB import here, so it can be tested with plain node; the plugin's
//   log and its searches for the programs are handed in.
// - A missing folder and a missing program look the same to the operating
//   system; callers check the folder first (folders.folderFor).

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** The bend this plugin needs at least; see `Version` in bend's cli. */
export const NEEDED_VERSION = 6;

/** How long one run of bend may take. */
const BEND_TIMEOUT_MS = 60_000;
/**
 * How long a run that may read a whole repository from a hosted tracker
 * may take: a sync, and a list, whose first read fills bend's copy. Cut off
 * at a minute, a large repository would never get its first list.
 */
const BEND_LONG_TIMEOUT_MS = 5 * 60_000;
/** The commands that get the longer time. */
const LONG_COMMANDS = ["sync", "list"];
/** Upper bound on bend's output we are willing to buffer (64 MiB). */
const BEND_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** A short pointer to another issue. */
export interface IssueRef {
  id: string;
  title: string;
  status: string;
}

/** One link of an issue; see bend/internal/tracker/types.go. */
export interface Link extends IssueRef {
  kind: string;
  direction: "out" | "in";
}

/** An issue as bend prints it with --json --with-body. */
export interface TrackerIssue {
  id: string;
  title: string;
  status: string;
  type: string | null;
  priority: number | null;
  category: string | null;
  assignee: string | null;
  parentId: string | null;
  description: string;
  requirements: string;
  done: string;
  plan: string;
  notes: string;
  closeReason: string;
  labels: string[];
  links: Link[];
  subIssues: IssueRef[];
  blockedBy: IssueRef[];
  commentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
  externalRef: string | null;
  /** The description and the requirements as one text. */
  body: string;
  /**
   * How many changes to this issue made here are not on the tracker yet;
   * always 0 where changes are written straight through (beads).
   */
  unsent: number;
}

/** What is known about a folder's tracker without asking it anything. */
export interface About {
  /** "beads" or "github". */
  tracker: string;
  /** "owner/name" for GitHub issues; null where there is none. */
  repository: string | null;
  /** The kinds of link the tracker has. */
  linkKinds: string[];
  /**
   * Whether changes are queued in bend's copy and sent to the tracker
   * afterwards (a hosted tracker), not written straight through (beads).
   */
  queued: boolean;
}

/** What one `bend sync` did; see SyncResult in bend/internal/kept. */
export interface BendSync {
  busy: boolean;
  sent: number;
  refused: number;
  waiting: number;
  broughtIn: number;
  full: boolean;
  problem: string;
  sentIssues: string[];
  broughtInIssues: string[];
}

/** A change the tracker refused for good, as `bend refused` gives it. */
export interface RefusedChange {
  seq: number;
  at: string;
  issue: string;
  what: string;
  text: string;
  reason: string;
}

/** One comment as bend prints it. */
export interface TrackerComment {
  id: string;
  author: string;
  createdAt: string;
  text: string;
}

/** What a new issue is created from. */
export interface Draft {
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  parentId?: string;
  category?: string;
}

/** What `edit` can change; a field left out is left as it is. */
export interface Changes {
  title?: string;
  type?: string;
  priority?: number;
  /** null removes the category. */
  category?: string | null;
  addLabels?: string[];
  removeLabels?: string[];
  /** Free-form data to keep with the issue, by key; null removes a key. */
  metadata?: Record<string, string | null>;
}

/**
 * The kinds of failure: bend's own (bend/internal/tracker/types.go), and
 * two of this file's: bend itself is missing or too old, and bend answered
 * with something that is not its JSON.
 */
export type FailureKind =
  | "refused"
  | "no-program"
  | "not-set-up"
  | "not-signed-in"
  | "usage"
  | "unsupported"
  | "no-bend"
  | "not-understood";

/** A run of bend that failed, with its kind and the reason in plain words. */
export class BendFailure extends Error {
  override name = "BendFailure";
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Runs bend once and gives what it printed, parsed.
 *
 * @param args The command and its options and arguments; `--json` is added.
 * @param input Text for bend's standard input.
 * @throws BendFailure, always: bend's own failure with its kind, "no-bend"
 *   when the program is not there, "not-understood" for anything else.
 */
export type Run = (args: string[], input?: string) => Promise<unknown>;

/**
 * Builds the runner of one bend program for one folder.
 *
 * @param command The bend program.
 * @param path The folder bend is to work in (passed as -C).
 * @param env Added to the environment of every run.
 * Side effects: none until it is called; then one child process per call.
 */
export function createRun(
  command: string,
  path: string,
  env: Record<string, string> = {},
): Run {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        command,
        ["-C", path, "--json", ...args],
        {
          timeout: LONG_COMMANDS.includes(args[0] ?? "")
            ? BEND_LONG_TIMEOUT_MS
            : BEND_TIMEOUT_MS,
          maxBuffer: BEND_MAX_OUTPUT_BYTES,
          env: { ...process.env, ...env },
        },
        (error, stdout, stderr) => {
          if (error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(
              new BendFailure("no-bend", `The bend program (${command}) was not found.`),
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            return reject(
              new BendFailure(
                "not-understood",
                stderr.trim() || stdout.trim() || error?.message || "bend printed nothing.",
              ),
            );
          }
          if (error === null) return resolve(parsed);
          const failed = parsed as { kind?: unknown; error?: unknown } | null;
          if (
            typeof failed === "object" &&
            failed !== null &&
            typeof failed.kind === "string" &&
            typeof failed.error === "string"
          ) {
            return reject(new BendFailure(failed.kind as FailureKind, failed.error));
          }
          reject(new BendFailure("not-understood", stdout.trim()));
        },
      );
      // Always closed, so that bend never waits for input it was not sent.
      child.stdin?.end(input ?? "");
    });
}

/** The operations the tab's store asks of a folder's tracker. */
export interface Tracker {
  /**
   * Every issue, closed ones too.
   *
   * @param fresh Have bend reread its copy of the issues from the tracker
   *   first, for when something changed that bend cannot know of.
   */
  list(fresh?: boolean): Promise<TrackerIssue[]>;
  show(id: string): Promise<TrackerIssue>;
  comments(id: string): Promise<TrackerComment[]>;
  /** @returns The new issue's id. */
  create(draft: Draft): Promise<string>;
  edit(id: string, changes: Changes): Promise<void>;
  /**
   * Replaces the description and the requirements from one text holding
   * both; a half that has not changed is not written.
   */
  writeBody(id: string, body: string): Promise<void>;
  /** @param author Who the comment is by; the tracker's default when left out. */
  comment(id: string, text: string, author?: string): Promise<void>;
  close(id: string): Promise<void>;
  reopen(id: string): Promise<void>;
  /** Puts an issue under a parent, or with null back at the top level. */
  move(id: string, parentId: string | null): Promise<void>;
  link(id: string, otherId: string, kind: string): Promise<void>;
  /**
   * Removes the link between the two.
   *
   * @param onlyFrom Only the link recorded on `id`, leaving one recorded
   *   the other way round.
   * @param kind Only the link of this kind. GitHub can hold two links
   *   between the same two issues (a "blocked by" and one kept in the
   *   text); without the kind, removing one would remove both.
   */
  unlink(id: string, otherId: string, onlyFrom?: boolean, kind?: string): Promise<void>;
  /**
   * Sends the waiting changes to a hosted tracker and brings in what
   * changed there. Never asked of a tracker that queues nothing.
   */
  sync(): Promise<BendSync>;
  /** The changes the tracker refused for good, oldest first. */
  refused(): Promise<RefusedChange[]>;
  /** Takes a refused change off the list, or puts it back to be sent again. */
  settleRefused(seq: number, again: boolean): Promise<void>;
}

/**
 * The tracker of a folder, as calls on bend.
 *
 * Pure wiring: each method is one run, and says nothing about which
 * tracker is underneath.
 */
export function trackerOver(run: Run): Tracker {
  /** `--name value` for a value that was given. */
  const option = (name: string, value: string | number | undefined) =>
    value === undefined ? [] : [`--${name}`, `${value}`];
  return {
    async list(fresh = false) {
      return (await run([
        "list",
        "--status",
        "all",
        "--with-body",
        ...(fresh ? ["--fresh"] : []),
      ])) as TrackerIssue[];
    },
    async show(id) {
      return (await run(["show", "--with-body", "--", id])) as TrackerIssue;
    },
    async comments(id) {
      return (await run(["comments", "--", id])) as TrackerComment[];
    },
    async create(draft) {
      const made = (await run([
        "create",
        ...option("description", draft.description),
        ...option("type", draft.type),
        ...option("priority", draft.priority),
        ...option("parent", draft.parentId),
        ...option("category", draft.category),
        "--",
        draft.title,
      ])) as { id?: unknown };
      if (typeof made.id !== "string") {
        throw new BendFailure("not-understood", "bend did not say which issue it created.");
      }
      return made.id;
    },
    async edit(id, changes) {
      const args = [
        ...option("title", changes.title),
        ...option("type", changes.type),
        ...option("priority", changes.priority),
        ...(changes.category === null
          ? ["--no-category"]
          : option("category", changes.category)),
        ...(changes.addLabels ?? []).flatMap((label) => ["--add-label", label]),
        ...(changes.removeLabels ?? []).flatMap((label) => ["--remove-label", label]),
        ...Object.entries(changes.metadata ?? {}).flatMap(([key, value]) =>
          value === null ? ["--unset-data", key] : ["--set-data", `${key}=${value}`],
        ),
      ];
      // Nothing to change: bend would call that a wrong request.
      if (args.length === 0) return;
      await run(["edit", ...args, "--", id]);
    },
    async writeBody(id, body) {
      await run(["write", "--text-file", "-", "--", id, "body"], body);
    },
    async comment(id, text, author) {
      await run(["comment", ...option("as", author), "--text-file", "-", "--", id], text);
    },
    async close(id) {
      await run(["close", "--", id]);
    },
    async reopen(id) {
      await run(["reopen", "--", id]);
    },
    async move(id, parentId) {
      await run(["move", ...(parentId === null ? ["--top"] : ["--under", parentId]), "--", id]);
    },
    async link(id, otherId, kind) {
      await run(["link", "--kind", kind, "--", id, otherId]);
    },
    async unlink(id, otherId, onlyFrom = false, kind) {
      await run([
        "unlink",
        ...(onlyFrom ? ["--from-first"] : []),
        ...option("kind", kind),
        "--",
        id,
        otherId,
      ]);
    },
    async sync() {
      return (await run(["sync"])) as BendSync;
    },
    async refused() {
      return (await run(["refused"])) as RefusedChange[];
    },
    async settleRefused(seq, again) {
      await run(["refused", again ? "--again" : "--dismiss", `${seq}`]);
    },
  };
}

/**
 * What changes when a folder's issues do, as `bend status --quick` says.
 */
export interface Watched {
  /** The folder bend keeps its copy of the issues in; null when none. */
  copy: string | null;
  /**
   * The tracker's own file that changes with its data (beads' "last
   * touched", in the repository's main folder); null when it has none.
   */
  sign: string | null;
}

/** One saved fact, as bend's `recall` prints it. */
export interface Fact {
  key: string;
  text: string;
}

/** Why a folder's issues cannot be read or changed. */
export interface Problem {
  /**
   * no-bd: the beads program is not on this machine, and the folder's
   * tracker is beads. no-bend: the bend program is not, or is too old.
   * no-beads: the folder has no tracker chosen or set up. no-login: the
   * tracker needs a sign-in there is none of (GitHub). error: anything
   * else; the message says what.
   */
  state: "no-bd" | "no-bend" | "no-beads" | "no-login" | "error";
  /** The reason in plain words, for the tab to show. */
  message: string;
}

/** What the tab says about a folder that has no tracker in it. */
const NOT_SET_UP_MESSAGE =
  "This folder has no issue tracker set up yet. Set it up to start tracking issues here.";

/** What the tab says when bend's answer could not be read. */
const NOT_UNDERSTOOD_MESSAGE =
  "bend answered in a format this plugin does not understand. It may be a newer or older bend than the plugin was written for.";

/**
 * The bend program that works on this machine: the first of the candidates
 * that runs and is new enough.
 *
 * @returns Its name or path; or why none can be used: "missing" when none
 *   of them is there, "old" when one is but none is new enough.
 * Side effects: one short-lived child process per candidate tried.
 */
export async function findBendAmong(
  candidates: string[],
  cwd: string,
): Promise<string | "missing" | "old"> {
  let old = false;
  for (const candidate of candidates) {
    try {
      const said = (await createRun(candidate, cwd)(["version"])) as {
        version?: unknown;
      };
      if (typeof said.version === "number" && said.version >= NEEDED_VERSION) {
        return candidate;
      }
      old = true;
    } catch (cause) {
      // Not there: try the next. There but not answering as bend does (the
      // launcher of the TypeScript bend, say): an old one.
      if (!(cause instanceof BendFailure && cause.kind === "no-bend")) old = true;
    }
  }
  return old ? "old" : "missing";
}

/**
 * Builds the per-folder trackers for this plugin instance.
 *
 * @param findBd The beads program that works on this machine, or null
 *   (folders.findBd).
 * @param findBend The bend program, or why there is none (findBendAmong).
 * @param notFoundMessage What to say when there is no beads program.
 * @param bendMessages What to say when bend is missing, or too old.
 * @param warn Writes one line to the plugin's log.
 * Side effects: none until one of them is called.
 */
export function createTrackers({
  findBd,
  findBend,
  notFoundMessage,
  bendMessages,
  warn,
}: {
  findBd: (path: string) => Promise<string | null>;
  findBend: (path: string) => Promise<string | "missing" | "old">;
  notFoundMessage: string;
  bendMessages: { missing: string; old: string };
  warn: (line: string) => void;
}) {
  /** What was found for a folder: its tracker, and how to run bend there. */
  const known = new Map<
    string,
    { tracker: Tracker; run: Run; watch: Watched; about: About; root: string; chosen: string }
  >();

  /**
   * What decides a repository's tracker, as it stands on disk now: when
   * its setting file was last written, and whether it has a beads folder.
   * A tracker remembered for a folder is believed only while this is the
   * same, so that a tracker chosen or changed outside the tab (`bend setup
   * tracker` in a terminal, a pull that brings a setting file) is noticed
   * at the next read and not only after the plugin is reloaded.
   *
   * @param root The repository's top folder, as bend named it.
   * Side effects: two looks at the file system, no process.
   */
  const chosenIn = (root: string): string => {
    let written = "none";
    try {
      written = `${statSync(join(root, ".bend.json")).mtimeMs}`;
    } catch {
      // No setting file.
    }
    return `${written} ${existsSync(join(root, ".beads"))}`;
  };

  /**
   * Turns a failed run into the tab's outcome.
   *
   * @param what When given, the failure is written to the plugin's log
   *   under this name (e.g. "close"). Left out for plain reads, whose
   *   failures are shown to the user and need no log line.
   * Side effects: forgets what was found for the folder when a program has
   *   gone, so it is looked for again next time.
   */
  function problem(path: string, cause: unknown, what?: string): Problem {
    if (cause instanceof BendFailure) {
      switch (cause.kind) {
        case "no-program":
          known.delete(path);
          return { state: "no-bd", message: notFoundMessage };
        case "no-bend":
          known.delete(path);
          return { state: "no-bend", message: bendMessages.missing };
        case "not-set-up":
          known.delete(path);
          return { state: "no-beads", message: NOT_SET_UP_MESSAGE };
        case "not-signed-in":
          // bend's own words: they say how to sign in.
          known.delete(path);
          return { state: "no-login", message: cause.message };
        case "not-understood":
          break;
        default:
          if (what !== undefined) {
            warn(`${what} failed in ${path}: ${cause.message}`);
          }
          return { state: "error", message: cause.message };
      }
    }
    warn(
      `${what ?? "reading issues"} went wrong in ${path}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
    );
    return { state: "error", message: NOT_UNDERSTOOD_MESSAGE };
  }

  /**
   * How to run bend in a folder, whether or not it has a tracker: for what
   * needs none (the facts file).
   *
   * @param foundBd The beads program, for a caller that has looked for it.
   * @returns `{ run }`, or the problem when bend is missing or too old.
   * Side effects: looks for bend, and for beads so bend is told where it
   *   is (short-lived child processes).
   */
  async function bendIn(
    path: string,
    foundBd?: string | null,
  ): Promise<{ run: Run } | Problem> {
    const ready = known.get(path);
    if (ready !== undefined) return { run: ready.run };
    const bend = await findBend(path);
    if (bend === "missing" || bend === "old") {
      return { state: "no-bend", message: bendMessages[bend] };
    }
    // Looked for here unless the caller already has.
    const bd = foundBd === undefined ? await findBd(path) : foundBd;
    return { run: createRun(bend, path, bd === null ? {} : { BEND_BD: bd }) };
  }

  /**
   * The tracker for a folder.
   *
   * Pre-condition: the folder exists (see folders.folderFor).
   * @returns `{ tracker }`, or which of the expected problems stands in the
   *   way. Never throws.
   * Side effects: the first time for a folder, looks for the two programs
   *   and asks bend which tracker the folder has (short-lived child
   *   processes; nothing is asked of the tracker itself).
   */
  async function trackerFor(
    path: string,
  ): Promise<{ tracker: Tracker } | Problem> {
    const ready = known.get(path);
    if (ready !== undefined) {
      if (ready.chosen === chosenIn(ready.root)) return { tracker: ready.tracker };
      known.delete(path);
    }
    const bd = await findBd(path);
    const bend = await bendIn(path, bd);
    if ("state" in bend) return bend;
    let watch: Watched = { copy: null, sign: null };
    let about: About;
    let root = path;
    try {
      // The quick form asks the tracker nothing: it says which tracker the
      // folder has, or fails saying that it has none.
      const said = (await bend.run(["status", "--quick"])) as {
        tracker?: unknown;
        repository?: unknown;
        linkKinds?: unknown;
        queued?: unknown;
        root?: unknown;
        copy?: unknown;
        watch?: unknown;
      };
      root = typeof said.root === "string" ? said.root : path;
      if (typeof said.tracker !== "string") {
        throw new BendFailure("not-understood", "bend did not say which tracker the folder has.");
      }
      about = {
        tracker: said.tracker,
        repository: typeof said.repository === "string" ? said.repository : null,
        linkKinds: Array.isArray(said.linkKinds)
          ? said.linkKinds.filter((kind): kind is string => typeof kind === "string")
          : [],
        queued: said.queued === true,
      };
      watch = {
        copy: typeof said.copy === "string" ? said.copy : null,
        sign: typeof said.watch === "string" ? said.watch : null,
      };
    } catch (cause) {
      return problem(path, cause);
    }
    // Only beads needs its program; bend says so itself when it runs it,
    // and this says so before anything is asked.
    if (about.tracker === "beads" && bd === null) {
      return { state: "no-bd", message: notFoundMessage };
    }
    const found = {
      tracker: trackerOver(bend.run),
      run: bend.run,
      watch,
      about,
      root,
      chosen: chosenIn(root),
    };
    known.set(path, found);
    return { tracker: found.tracker };
  }

  /**
   * What to watch to learn that a folder's issues changed; nothing when the
   * folder's tracker is not known yet.
   */
  const watchOf = (path: string): Watched =>
    known.get(path)?.watch ?? { copy: null, sign: null };

  /**
   * What is known about a folder's tracker; null until `trackerFor` has
   * found it.
   */
  const aboutOf = (path: string): About | null => known.get(path)?.about ?? null;

  /**
   * Forgets what was found for a folder, so that it is looked for again:
   * after its tracker was chosen or changed.
   */
  const forget = (path: string): void => {
    known.delete(path);
  };

  return { trackerFor, bendIn, problem, watchOf, aboutOf, forget };
}

/** What createTrackers returns; handed to the store and to setup. */
export type Trackers = ReturnType<typeof createTrackers>;
