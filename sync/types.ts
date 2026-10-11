// sync/types.ts — the one shape every sync of issues is seen through.
//
// What: what "syncing a repository's issues" means whatever holds them: a
// source that can exchange changes with a remote (SyncSource), how a run
// can end, what it reports, and one line of the log.
//
// Why: the owner wants the sync kept apart as "something that could be
// later replaced ... This will be multiple, and next implementation will
// be GitHub" (bead-bb-6a9). Beads syncs its database with the git remote;
// a hosted tracker will sync a local cache with the service. What they
// share is that issues are worked on in a local copy, and a sync exchanges
// changes with a remote. Everything above this file (the service, the
// plugin's requests, the tab) talks only in these terms.
//
// Design notes:
// - How a run ended is said in this layer's own five words; each source
//   translates its own signs into them (beads: `bd sync`'s exit codes).
// - "Not known" is a value (null), for what was sent and what was brought
//   in: a source that cannot tell says so, and nothing above guesses.
// - A source says for itself what setting it up takes (its steps, with the
//   words to show and the command to run), because that differs most
//   between sources: beads has to be given a remote, a hosted tracker is
//   its own remote.
//
// Gotchas:
// - This file must stay free of imports from the plugin, from BB and from
//   any tracker, like bend/internal/tracker in the tracker layer it is meant to
//   sit beside one day.

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

/** Whether syncing by itself stops after this end until the owner syncs. */
export const haltsOn = (end: SyncEnd): boolean =>
  end === "conflict" || end === "stuck";

/** The kinds of change made to an issue, in this layer's words. */
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

/** What one run reports. */
export interface SyncRun {
  end: SyncEnd;
  /** The source's own words about a run that did not end `synced`; else "". */
  message: string;
  /** What this side had to send; null when the source cannot tell. */
  sent: Change[] | null;
  /** Issues that came in new or changed; null when it cannot tell. */
  broughtIn: string[] | null;
}

/** One thing a source offers to do in setup, with what to show for it. */
export interface SyncStep {
  /** The step's name on its button and in the menu. */
  label: string;
  /** One line on why it is offered, for the setup card. */
  why: string;
  /** What it does, for the confirmation: an opening line, then points. */
  explain: { lead: string; points: string[] };
  /** What is run, in a terminal the owner can watch, in the folder. */
  command: string;
}

/** One implementation of syncing, for one repository. */
export interface SyncSource {
  /** The source's name, e.g. "beads". */
  readonly name: string;
  /**
   * A lock file shared with other processes that may sync the same
   * repository; null when the source needs none.
   */
  readonly lockFile: string | null;
  /**
   * What the issues are synced with, in words for the owner ("the
   * repository's git remote"); null when syncing is not switched on.
   */
  remote(): Promise<string | null>;
  /**
   * The changes made on this side that have not been sent; null when the
   * source cannot tell. An empty list means there is nothing to send.
   */
  pending(): Promise<Change[] | null>;
  /** One sync. Never rejects: a failure is an end. */
  run(): Promise<SyncRun>;
  /**
   * The setup steps that apply now: `on` switches syncing on for a
   * repository whose issues are synced nowhere, `fetch` gets the issues of
   * a repository that has none here while its remote holds them. Null for
   * a step that does not apply.
   */
  steps(): Promise<{ on: SyncStep | null; fetch: SyncStep | null }>;
}

/** What set a sync off. */
export type SyncCause = "timer" | "change" | "opened" | "refresh";

/** One sync, as the log keeps it. */
export interface SyncEntry extends SyncRun {
  /** When it ended (milliseconds since 1970), and how long it took. */
  at: number;
  seconds: number;
  cause: SyncCause;
}
