// sync/beads.ts — syncing a repository's issues, where beads holds them.
//
// What: the beads implementation of SyncSource: beads' own `bd sync`
// (pull, check for conflicts, push) against the repository's git remote,
// what was sent read from beads' journal of changes, what was brought in
// worked out by comparing the issues before and after.
//
// Why: `bd init` leaves the issues on one computer (bead-bb-0bz), and the
// owner wants to see what each sync did (bead-bb-6a9). It is one source
// among several to come; everything that is not particular to beads is in
// sync/service.ts.
//
// Design notes:
// - How a run ended is `bd sync`'s exit code, which beads documents for
//   exactly this: 0 synced, 1 error, 2 conflict, 3 busy, 4 stuck.
// - What was sent comes from beads' events journal: every change made
//   through beads on this computer, each with a sequence number that only
//   grows. One number is remembered, the journal's head at the last good
//   sync; "what is pending" is everything after it. Exact, and it says
//   what kind of change it was. `bd sync` itself reports no counts.
// - What was brought in cannot come from the journal, which by beads'
//   design does not record what a pull brings. It is the one comparison:
//   the issues' "updated" times just before and just after the run, less
//   those the journal says were changed here.
// - The journal is off by default and records only while on. It is
//   switched on the first time a sync runs here; until there is a position
//   in it, what was sent is "not known" (null), never guessed.
//
// Gotchas:
// - A journal position means nothing on another computer, and beads fails
//   a read below what its retention kept (seven days by default). Either
//   way a new position is taken and "not known" is said once.
// - Free of BB: the host hands in how to run bd and git and where to keep
//   the position.

import type {
  Change,
  ChangeKind,
  SyncEnd,
  SyncRun,
  SyncSource,
} from "./types.ts";

/** What `bd sync`'s exit code means, in the layer's words. */
export function endOf(exitCode: number | null): SyncEnd {
  switch (exitCode) {
    case 0:
      return "synced";
    case 2:
      return "conflict";
    case 3:
      return "busy";
    case 4:
      return "stuck";
    default:
      return "failed";
  }
}

/** The journal's seven operations, as kinds of change. */
const KIND_OF: Record<string, ChangeKind> = {
  create: "created",
  update: "updated",
  close: "closed",
  delete: "deleted",
  comment: "comment",
  dep_add: "link",
  dep_remove: "link",
};

/**
 * Reads journal records into changes per issue.
 *
 * @param lines What `bd events tail` or `export` printed: one JSON record
 *   a line, `{seq, op, issue_id, ...}`. A line that is not such a record is
 *   passed over.
 * @returns The changes, one per issue in the order first seen, and the
 *   highest sequence number among the records (null when there were none).
 */
export function changesFrom(lines: string): { changes: Change[]; head: number | null } {
  const byId = new Map<string, ChangeKind[]>();
  let head: number | null = null;
  for (const line of lines.split("\n")) {
    if (line.trim() === "") continue;
    let record: { seq?: unknown; op?: unknown; issue_id?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.seq !== "number" || typeof record.issue_id !== "string") continue;
    head = head === null ? record.seq : Math.max(head, record.seq);
    const kind = KIND_OF[String(record.op)] ?? "updated";
    const kinds = byId.get(record.issue_id) ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    byId.set(record.issue_id, kinds);
  }
  return {
    changes: [...byId].map(([id, kinds]) => ({ id, kinds })),
    head,
  };
}

/** What the comparison needs of an issue. */
export interface Seen {
  id: string;
  updatedAt: string | null;
  status: string;
}

/**
 * The issues a sync brought in: new, or different after it, and not
 * changed here meanwhile.
 *
 * @param mine Ids changed on this side around the run (from the journal):
 *   their difference is this side's doing.
 * @returns Ids, in the order of `after`.
 */
export function broughtIn(
  before: readonly Seen[],
  after: readonly Seen[],
  mine: ReadonlySet<string>,
): string[] {
  const was = new Map(before.map((issue) => [issue.id, issue]));
  return after
    .filter((issue) => {
      if (mine.has(issue.id)) return false;
      const old = was.get(issue.id);
      return (
        old === undefined ||
        old.updatedAt !== issue.updatedAt ||
        old.status !== issue.status
      );
    })
    .map((issue) => issue.id);
}

/** How long "the issues are synced with nothing" is believed. */
const REMOTE_ASKED_MS = 30_000;

/** One run of a program: how it exited and what it printed. */
export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Builds the beads source for one repository.
 *
 * @param home The repository's main folder: where bd is run and where the
 *   lock file is kept.
 * @param bd Runs `bd` there with these arguments; `long` for a run that
 *   may take minutes. Resolves also when bd fails or is missing (code
 *   null).
 * @param bdCommand How to write `bd` in a command the owner sees run.
 * @param git Runs a read-only git command there; null when it failed.
 * @param readIssues The folder's issues, or null when they cannot be read;
 *   with `fresh`, read anew even if the host has them kept (a sync changes
 *   them in ways the host's own signs do not show).
 * @param position Where the journal's position is kept across restarts.
 */
export function createBeadsSource({
  home,
  bd,
  bdCommand,
  git,
  readIssues,
  position,
}: {
  home: string;
  bd: (args: string[], long?: boolean) => Promise<Ran>;
  bdCommand: string;
  git: (args: string[]) => Promise<string | null>;
  readIssues: (fresh?: boolean) => Promise<Seen[] | null>;
  position: { get: () => Promise<number | null>; set: (seq: number) => void };
}): SyncSource {
  /** The remote is known to hold the issues: it stays so, asked once. */
  let holds = false;
  /** The journal is known to be on. */
  let journalOn = false;
  /** The last answer about the remote that was not "holds", and when. */
  let asked: { at: number; state: "none" | "empty" | "unknown" } | null = null;

  /**
   * Where the issues stand with a remote.
   *
   * - `none`: beads has no remote for them.
   * - `empty`: it has one, and nothing was ever sent there. `bd init`
   *   leaves a repository like this: it takes the git origin as the remote
   *   and pushes nothing. Syncing is not on then, and must not be tried:
   *   `bd sync` pulls first and fails on a remote with nothing on it, every
   *   time (bead-bb-fmr: two repositories did so every five minutes).
   * - `holds`: the remote holds the issues; syncing is on.
   * - `unknown`: it could not be told now (the remote was not reached).
   */
  async function remoteState(): Promise<"none" | "empty" | "holds" | "unknown"> {
    if (holds) return "holds";
    // Asked on every look at the tab: an answer other than "holds" is
    // believed for a short while, so a switch between repositories does
    // not start a beads program for it each time (bead-bb-3pr).
    if (asked !== null && Date.now() - asked.at < REMOTE_ASKED_MS) return asked.state;
    const state = await askRemote();
    if (state !== "holds") asked = { at: Date.now(), state };
    return state;
  }

  /** Asks beads, and the git remote, where the issues stand; see remoteState. */
  async function askRemote(): Promise<"none" | "empty" | "holds" | "unknown"> {
    const run = await bd(["dolt", "remote", "list", "--json"]);
    let url: string | null = null;
    try {
      const remotes: unknown = JSON.parse(run.stdout);
      if (run.code !== 0 || !Array.isArray(remotes)) return "unknown";
      if (remotes.length === 0) return "none";
      const first = (remotes[0] ?? {}) as { url?: unknown };
      url = typeof first.url === "string" ? first.url : null;
    } catch {
      return "unknown";
    }
    // Beads keeps the issues on a git remote under refs/dolt/data. A remote
    // that is not a git repository cannot be asked this way: taken as
    // holding, as before.
    if (url === null || !url.startsWith("git+")) {
      holds = true;
      return "holds";
    }
    const answer = await git(["ls-remote", url.slice("git+".length), "refs/dolt/data"]);
    if (answer === null) return "unknown";
    if (answer === "") return "empty";
    holds = true;
    return "holds";
  }

  async function remote(): Promise<string | null> {
    return (await remoteState()) === "holds" ? "the repository's git remote" : null;
  }

  /**
   * Makes sure beads is keeping its journal, and that there is a position
   * in it to read from.
   *
   * @returns The position, or null when it was only now taken (or cannot
   *   be): what happened before it is not known.
   */
  async function journal(): Promise<number | null> {
    let fresh = false;
    if (!journalOn) {
      const asked = await bd(["config", "get", "events-journal"]);
      if (asked.stdout.trim() !== "true") {
        const set = await bd(["config", "set", "events-journal", "true"]);
        if (set.code !== 0) return null;
        fresh = true;
      }
      journalOn = true;
    }
    const kept = await position.get();
    if (kept !== null && !fresh) return kept;
    // No position yet: take the journal's present head, and say nothing
    // about what came before.
    const all = await bd(["events", "export"]);
    position.set(all.code === 0 ? (changesFrom(all.stdout).head ?? 0) : 0);
    return null;
  }

  /**
   * The journal's records after a position.
   *
   * @returns Null when beads cannot give them (the position was pruned
   *   away, or belongs to another computer's journal): a new position is
   *   then taken.
   */
  async function since(seq: number): Promise<{ changes: Change[]; head: number } | null> {
    const run = await bd(["events", "tail", "--since", String(seq)]);
    if (run.code !== 0) {
      const all = await bd(["events", "export"]);
      position.set(all.code === 0 ? (changesFrom(all.stdout).head ?? 0) : 0);
      return null;
    }
    const read = changesFrom(run.stdout);
    return { changes: read.changes, head: read.head ?? seq };
  }

  return {
    name: "beads",
    lockFile: `${home}/.beads/airbender-sync.lock`,
    remote,

    async pending(): Promise<Change[] | null> {
      const seq = await journal();
      if (seq === null) return null;
      return (await since(seq))?.changes ?? null;
    },

    async run(): Promise<SyncRun> {
      const seq = await journal();
      const mine = seq === null ? null : await since(seq);
      const before = await readIssues();
      const ran = await bd(["sync"], true);
      const end = endOf(ran.code);
      const message =
        end === "synced"
          ? ""
          : (ran.stderr.trim() || ran.stdout.trim() || "bd sync did not run.")
              .split("\n")
              .slice(-8)
              .join("\n");
      if (end !== "synced") {
        // Nothing was sent; what is pending stays pending.
        return { end, message, sent: null, broughtIn: null };
      }
      const after = await readIssues(true);
      // Changed here while the sync ran: not brought in, and for next time.
      const during = mine === null ? null : await since(mine.head);
      if (mine !== null) position.set(mine.head);
      const changedHere = new Set([
        ...(mine?.changes ?? []).map((change) => change.id),
        ...(during?.changes ?? []).map((change) => change.id),
      ]);
      return {
        end,
        message,
        sent: mine?.changes ?? null,
        // Without the journal this side's own changes cannot be told from
        // the other's, so nothing is claimed.
        broughtIn:
          before === null || after === null || mine === null
            ? null
            : broughtIn(before, after, changedHere),
      };
    },
  };
}
