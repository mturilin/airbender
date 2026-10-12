// sync/bend.ts — the sync of a hosted tracker's issues, run through bend.
//
// What: the SyncSource for a repository whose issues bend keeps in a local
// copy and sends to a hosted tracker afterwards (GitHub issues): what
// waits to be sent, and one sync.
//
// Why: the tab's sync service (service.ts) decides when a sync runs and
// keeps the log, whatever is synced; beads was its first source and "next
// implementation will be GitHub" (bead-bb-6a9). bend already does such a
// sync itself (`bend sync`, bead-bb-c9l.5), so this source only asks for
// one and puts the answer into this layer's words (bead-bb-c9l.6).
//
// Design notes:
// - How a run ends: another sync running is "busy"; changes that still
//   wait, or a tracker that could not be asked, is "failed" with bend's
//   words, and is tried again. "conflict" and "stuck" are never used:
//   nothing on a hosted tracker needs a person to untangle before syncing
//   can go on.
// - A change the tracker refused for good does not fail the run: it will
//   never work, and trying again would not help. The run ends "synced" and
//   its message says how many were refused; the tab lists them.
// - What a change was (a comment, a link) is not told apart: bend names the
//   issues, and every one counts as "updated".
// - No lock file: bend lets one sync run at a time by itself, and one that
//   finds another running waits for it.
//
// Gotchas:
// - Like the rest of sync/, no import from the plugin, BB or a tracker:
//   everything bend is asked comes in as functions.
// - bend also sends a change by itself a moment after it is made. A sync
//   from here then finds nothing to send, and only brings in.

import type { Change, SyncRun, SyncSource } from "./types.ts";

/** What one `bend sync` answers; see SyncResult in bend/internal/kept. */
export interface BendSyncAnswer {
  busy: boolean;
  sent: number;
  refused: number;
  waiting: number;
  problem: string;
  sentIssues: string[];
  broughtInIssues: string[];
}

/**
 * Makes the sync source of one repository on a hosted tracker.
 *
 * @param name The tracker's name, e.g. "github".
 * @param remote What the issues are synced with, in words for the owner.
 * @param unsent The ids of the issues that have changes not yet sent, each
 *   once; null when they cannot be read.
 * @param sync Runs one `bend sync`; rejects with bend's own words when the
 *   tracker could not be asked.
 * Side effects: none until `pending` or `run` is called.
 */
export function createBendSource({
  name,
  remote,
  unsent,
  sync,
}: {
  name: string;
  remote: string;
  unsent: () => Promise<string[] | null>;
  sync: () => Promise<BendSyncAnswer>;
}): SyncSource {
  const updated = (ids: string[]): Change[] =>
    ids.map((id) => ({ id, kinds: ["updated"] }));
  return {
    name,
    lockFile: null,
    remote: () => Promise.resolve(remote),
    async pending() {
      const ids = await unsent();
      return ids === null ? null : updated(ids);
    },
    async run(): Promise<SyncRun> {
      let answer: BendSyncAnswer;
      try {
        answer = await sync();
      } catch (cause) {
        return {
          end: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
          sent: null,
          broughtIn: null,
        };
      }
      if (answer.busy) {
        return {
          end: "busy",
          message: "Another sync of these issues was running; it does the work.",
          sent: [],
          broughtIn: [],
        };
      }
      const sent = updated(answer.sentIssues);
      // What was just sent comes back as changed; that is this side's own
      // change, not something brought in.
      const broughtIn = answer.broughtInIssues.filter(
        (id) => !answer.sentIssues.includes(id),
      );
      if (answer.problem !== "") {
        return { end: "failed", message: answer.problem, sent, broughtIn };
      }
      return {
        end: "synced",
        message:
          answer.refused === 0
            ? ""
            : `${answer.refused} ${answer.refused === 1 ? "change was" : "changes were"} refused and will not be sent again. They are listed under "Refused changes".`,
        sent,
        broughtIn,
      };
    },
  };
}
