// server/trackers.ts — the tracker for each folder, and what its failures
// mean to the tab.
//
// What: gives the tracker core's adapter (tracker/) for a folder, one per
// folder and kept for reuse, and turns anything the core throws into one of
// the tab's own outcomes.
//
// Why: the tab reads and changes issues through the tracker core, as `bend`
// does (bead-bb-c9l.2). The core reports a problem by throwing; the tab's
// rule is that an expected problem is data (a state, and a message in plain
// words) so that it can be shown. This file is the one place where the two
// meet.
//
// Design notes:
// - The beads program is looked for before the folder is, so that a machine
//   without beads is told so ("no-bd") even in a folder that has no issues
//   yet. The setup screen offers a different step for each.
// - The program found for a folder is remembered with its tracker. It is
//   forgotten when a run reports the program missing, so installing or
//   moving beads is picked up without reloading the plugin.
// - A folder with no tracker is not remembered: setting it up must show on
//   the next read.
// - Anything thrown that is not one of the core's refusals (bd answering in
//   a shape the adapter does not expect, say) is reported as an answer that
//   could not be understood, and logged with its real text.
//
// Gotchas:
// - No BB import here, so it can be tested with plain node; the plugin's
//   log and its search for bd are handed in.

import { detectTracker } from "../tracker/detect.ts";
import {
  NoProgram,
  NotSetUp,
  Refused,
  Unsupported,
  type Tracker,
} from "../tracker/types.ts";

/** Why a folder's issues cannot be read or changed. */
export interface Problem {
  /**
   * no-bd: the beads program is not on this machine. no-beads: the folder
   * has no issues set up. error: anything else; the message says what.
   */
  state: "no-bd" | "no-beads" | "error";
  /** The reason in plain words, for the tab to show. */
  message: string;
}

/** What the tab says about a folder that has no tracker in it. */
const NOT_SET_UP_MESSAGE =
  "This folder does not use beads yet. Set it up to start tracking issues here.";

/** What the tab says when the tracker's answer could not be read. */
const NOT_UNDERSTOOD_MESSAGE =
  "bd answered in a format this plugin does not understand. It may be a newer or older bd than the plugin was written for.";

/**
 * Builds the per-folder trackers for this plugin instance.
 *
 * @param findBd The beads program that works on this machine, or null
 *   (folders.findBd).
 * @param notFoundMessage What to say when there is none.
 * @param warn Writes one line to the plugin's log.
 * Side effects: none until one of them is called.
 */
export function createTrackers({
  findBd,
  notFoundMessage,
  warn,
}: {
  findBd: (path: string) => Promise<string | null>;
  notFoundMessage: string;
  warn: (line: string) => void;
}) {
  /** The tracker already built for a folder. */
  const known = new Map<string, Tracker>();

  /**
   * Turns something a tracker threw into the tab's outcome.
   *
   * @param what When given, the failure is written to the plugin's log
   *   under this name (e.g. "close"). Left out for plain reads, whose
   *   failures are shown to the user and need no log line.
   * Side effects: forgets the folder's tracker when its program has gone,
   *   so it is looked for again next time.
   */
  function problem(path: string, cause: unknown, what?: string): Problem {
    if (cause instanceof NoProgram) {
      known.delete(path);
      return { state: "no-bd", message: notFoundMessage };
    }
    if (cause instanceof NotSetUp) {
      known.delete(path);
      return { state: "no-beads", message: NOT_SET_UP_MESSAGE };
    }
    if (cause instanceof Refused || cause instanceof Unsupported) {
      if (what !== undefined) {
        warn(`${what} failed in ${path}: ${cause.message}`);
      }
      return { state: "error", message: cause.message };
    }
    warn(
      `${what ?? "reading issues"} went wrong in ${path}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
    );
    return { state: "error", message: NOT_UNDERSTOOD_MESSAGE };
  }

  /**
   * The tracker for a folder.
   *
   * Pre-condition: the folder exists (see folders.folderFor).
   * @returns `{ tracker }`, or which of the expected problems stands in the
   *   way. Never throws.
   * Side effects: the first time for a folder, looks for the beads program
   *   (short-lived child processes) and reads the file system.
   */
  async function trackerFor(
    path: string,
  ): Promise<{ tracker: Tracker } | Problem> {
    const ready = known.get(path);
    if (ready !== undefined) return { tracker: ready };
    const bdCommand = await findBd(path);
    if (bdCommand === null) {
      return { state: "no-bd", message: notFoundMessage };
    }
    try {
      // Beads only: the tab reads the whole list on every reload, which a
      // hosted tracker is too slow for until there is a cache
      // (bead-bb-c9l.5). A repository on GitHub issues is "not set up" here.
      const { tracker } = detectTracker(path, undefined, {
        bdCommand,
        accept: ["beads"],
      });
      known.set(path, tracker);
      return { tracker };
    } catch (cause) {
      return problem(path, cause);
    }
  }

  return { trackerFor, problem };
}

/** What createTrackers returns; handed to the store. */
export type Trackers = ReturnType<typeof createTrackers>;
