// sync/types.ts — the shapes bend reports the syncing of issues in.
//
// What: how a sync can end, one entry of the sync log, what is wrong with
// a repository's syncing (the trouble), and how the helper that syncs on a
// clock stands, as `bend sync --json`, `--status` and `--log` give them.
//
// Why: syncing is bend's, for every tracker; the plugin only shows it
// (bead-bb-c9l.16). These are the words it is shown in, the same in the
// server, the contract and the tab. They are written to match
// bend/internal/kept/report.go and bend/internal/tracker/sync.go, where
// each is explained in full.
//
// Design notes:
// - Nothing here names a tracker.
// - "Not known" is a value (null), for what was sent and what was brought
//   in: bend says so when a tracker cannot tell, and nothing above guesses.
//
// Gotchas:
// - This file must stay free of imports from the plugin and from BB: the
//   tab's code and the server's both read it.

/**
 * How a sync ended.
 *
 * - `synced`: both ways done, or nothing to do.
 * - `failed`: it did not work this time (network, sign-in, storage); worth
 *   trying again.
 * - `busy`: it gave way to something else changing the issues; nothing was
 *   sent; worth trying again.
 * - `conflict`: the two sides changed in a way that cannot be merged; a
 *   person has to settle it.
 * - `stuck`: something on this side blocks every sync until a person
 *   clears it.
 */
export type SyncEnd = "synced" | "failed" | "busy" | "conflict" | "stuck";

/** The kinds of change made to an issue. */
export type ChangeKind =
  | "created"
  | "updated"
  | "closed"
  | "deleted"
  | "comment"
  | "link";

/** An issue changed on this side, and how. */
export interface Change {
  id: string;
  /** Each kind once, in the order first seen. */
  kinds: ChangeKind[];
}

/**
 * What set a sync off: someone asked (`bend sync`, the tab's Refresh), the
 * helper's clock, a change made through bend a moment before, or a read
 * that found bend's copy a few minutes old.
 */
export type SyncCause = "asked" | "timer" | "change" | "read";

/** One sync, as bend's log keeps it. */
export interface SyncEntry {
  end: SyncEnd;
  /** The tracker's own words about a run that did not end `synced`; else "". */
  message: string;
  /** What this side sent; null when it is not known. */
  sent: Change[] | null;
  /** Issues that came in new or changed; null when it is not known. */
  broughtIn: string[] | null;
  /** When it ended (milliseconds since 1970), and how long it took. */
  at: number;
  seconds: number;
  cause: SyncCause;
  /** Changes the tracker refused for good in this run; those still waiting. */
  refused: number;
  waiting: number;
  /**
   * How many runs the entry stands for: more than 1 for runs that ended
   * well with nothing to do, one after another.
   */
  runs: number;
}

/** What is wrong with a repository's syncing now. */
export interface SyncTrouble {
  kind: "conflict" | "stuck" | "failing" | "refused" | "disabled";
  /**
   * The issues are not being synced, so work can be lost or done twice;
   * otherwise it is something to know and deal with at leisure.
   */
  serious: boolean;
  /** It in a few words, and what to do. */
  title: string;
  advice: string;
  /** The tracker's own words from the last run that did not work; or "". */
  message: string;
  /** When it began (milliseconds since 1970; 0 when that means nothing). */
  since: number;
  /** How many syncs in a row did not work. */
  failures: number;
}

/** How the helper that syncs on a clock stands. */
export interface HelperState {
  running: boolean;
  pid: number;
  /** When the running one started (milliseconds since 1970); 0 for none. */
  since: number;
  /** Kept from being started in this repository (`bend helper disable`). */
  disabled: boolean;
  /** When the last one ended after failed syncs; 0 for never. */
  gaveUpAt: number;
  heldBackUntil: number;
}

/** What `bend sync --status` answers. */
export interface SyncState {
  /** The tracker's name. */
  source: string;
  /** What the issues are synced with, in words; null when with nothing. */
  remote: string | null;
  running: boolean;
  /** Syncing by itself has stopped until a sync asked for ends well. */
  halted: boolean;
  last: SyncEntry | null;
  /** When the last sync that worked ended; null when none did. */
  syncedAt: number | null;
  /** Changes made here not yet sent; null when it is not known. */
  pending: Change[] | null;
  trouble: SyncTrouble | null;
  helper: HelperState;
}
