// sync/beads.ts — syncing a repository's issues, where beads holds them.
//
// What: the beads implementation of SyncSource: beads' own `bd sync`
// (pull, check for conflicts, push) against the repository's git remote,
// what was sent read from beads' journal of changes, what was brought in
// worked out by comparing the issues before and after, and the two setup
// steps beads needs.
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
  SyncStep,
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
 * @param readIssues The folder's issues, or null when they cannot be read.
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
  readIssues: () => Promise<Seen[] | null>;
  position: { get: () => Promise<number | null>; set: (seq: number) => void };
}): SyncSource {
  /** Once beads has named a remote it stays so: asked once. */
  let hasRemote = false;
  /** The journal is known to be on. */
  let journalOn = false;

  async function remote(): Promise<string | null> {
    if (!hasRemote) {
      const run = await bd(["dolt", "remote", "list", "--json"]);
      try {
        const remotes: unknown = JSON.parse(run.stdout);
        hasRemote = run.code === 0 && Array.isArray(remotes) && remotes.length > 0;
      } catch {
        hasRemote = false;
      }
    }
    return hasRemote ? "the repository's git remote" : null;
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
      const after = await readIssues();
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

    async steps(): Promise<{ on: SyncStep | null; fetch: SyncStep | null }> {
      const here = await readIssues();
      if (here === null) {
        // No issues in this folder. Beads keeps a repository's issues on
        // its git remote under refs/dolt/data: if they are there, this is
        // a fresh clone, and they are to be fetched.
        const held = await git(["ls-remote", "origin", "refs/dolt/data"]);
        return {
          on: null,
          fetch:
            held === null || held === ""
              ? null
              : {
                  label: "Get this repository's issues",
                  why: "This folder has no issues yet, but the repository's remote holds them. Getting them brings this folder up to date with the other computers.",
                  explain: {
                    lead: "Runs `bd bootstrap` in this folder.",
                    points: [
                      "It downloads the issues that the repository's git remote holds into a database in this folder.",
                      "Nothing is published, and no existing issue is deleted.",
                    ],
                  },
                  command: `${bdCommand} bootstrap --yes`,
                },
        };
      }
      return {
        fetch: null,
        on:
          (await remote()) !== null
            ? null
            : {
                label: "Sync issues to the repository's remote",
                why: "This folder's issues are on this computer only: they are not in git and are synced nowhere. Syncing keeps a copy on the repository's remote and lets other computers get them.",
                explain: {
                  lead: "Runs `bd sync` in this folder, for the first time. Be aware of what it does:",
                  points: [
                    "It publishes this folder's whole issue history (every issue, with its text, comments and history) to the repository's git remote, where anyone who can read the repository can read it. It is kept apart from your branches.",
                    "Beads records the remote in `.beads/config.yaml` and makes a small git commit for that by itself. Pushing that commit is yours.",
                    "From then on the issues are kept in sync without your doing anything: every few minutes, and a little after they change.",
                  ],
                },
                command: `${bdCommand} sync --yes`,
              },
      };
    },
  };
}
