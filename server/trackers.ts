// server/trackers.ts — the tracker for each folder, and what its failures
// mean to the tab.
//
// What: gives the tracker core's adapter (tracker/) for a folder, one per
// folder and kept for reuse, says which tracker that is, and turns anything
// the core throws into one of the tab's own outcomes.
//
// Why: the tab reads and changes issues through the tracker core, as `bend`
// does (bead-bb-c9l.2), and since bead-bb-c9l.6 for either of two trackers:
// beads, or GitHub issues. The core reports a problem by throwing; the
// tab's rule is that an expected problem is data (a state, and a message in
// plain words) so that it can be shown. This file is the one place where
// the two meet.
//
// Design notes:
// - The tab uses GitHub issues only where the repository's setting file
//   says so (`guess: false`). `bend` takes a GitHub remote as enough; the
//   tab must not, or opening it in any repository with a GitHub remote and
//   no beads would show that repository's GitHub issues at once and, with
//   background sizing on, start labelling them, before the owner chose
//   anything (bead-bb-c9l.6).
// - The folder is looked at first, and the beads program only when the
//   tracker is beads, so a repository on GitHub issues opens on a machine
//   that has no beads. Where a folder has no tracker at all, a machine
//   without beads is still told so first ("no-bd"), as before: beads is
//   then the tracker the setup screen can install.
// - The tracker found for a folder is remembered. It is forgotten when a
//   run reports its program missing or its login gone, so installing beads
//   or signing in is picked up without reloading the plugin, and when the
//   owner switches the repository's tracker (`forget`).
// - A folder with no tracker is not remembered: setting it up must show on
//   the next read.
// - Anything thrown that is not one of the core's refusals (the tracker
//   answering in a shape the adapter does not expect, say) is reported as
//   an answer that could not be understood, and logged with its real text.
//
// Gotchas:
// - No BB import here, so it can be tested with plain node; the plugin's
//   log and its search for bd are handed in.

import type { TrackerName } from "../tracker/config.ts";
import { detectTracker, type Found } from "../tracker/detect.ts";
import type { GitHubClient } from "../tracker/github-api.ts";
import {
  NoProgram,
  NotSetUp,
  NotSignedIn,
  Refused,
  Unsupported,
  type Tracker,
} from "../tracker/types.ts";

/** Why a folder's issues cannot be read or changed. */
export interface Problem {
  /**
   * no-bd: the beads program is not on this machine. no-beads: the folder
   * has no tracker set up. no-login: the tracker is a hosted one and there
   * is no login for it. error: anything else; the message says what.
   */
  state: "no-bd" | "no-beads" | "no-login" | "error";
  /** The reason in plain words, for the tab to show. */
  message: string;
}

/** A folder's tracker, and what the tab shows about it. */
export interface Known {
  tracker: Tracker;
  name: TrackerName;
  /** For GitHub: the repository, as "owner/name"; null for beads. */
  repository: string | null;
}

/** What the tab says about a folder that has no tracker in it. */
const NOT_SET_UP_MESSAGE =
  "This folder has no issue tracker yet. Set it up to start tracking issues here.";

/** What the tab says when the tracker's answer could not be read. */
const NOT_UNDERSTOOD_MESSAGE =
  "The issue tracker answered in a format this plugin does not understand. It may be a newer or older version than the plugin was written for.";

/**
 * Builds the per-folder trackers for this plugin instance.
 *
 * @param findBd The beads program that works on this machine, or null
 *   (folders.findBd).
 * @param notFoundMessage What to say when there is none.
 * @param warn Writes one line to the plugin's log.
 * @param githubClient Makes the connection to a GitHub repository; the real
 *   one when left out. Replaced in tests.
 * Side effects: none until one of them is called.
 */
export function createTrackers({
  findBd,
  notFoundMessage,
  warn,
  githubClient,
}: {
  findBd: (path: string) => Promise<string | null>;
  notFoundMessage: string;
  warn: (line: string) => void;
  githubClient?: (repository: string) => GitHubClient;
}) {
  /** The tracker already found for a folder. */
  const known = new Map<string, Known>();

  /**
   * Forgets a folder's tracker, so that it is looked for again: after the
   * owner switched the repository's tracker, or signed in.
   */
  function forget(path: string): void {
    known.delete(path);
  }

  /**
   * Turns something a tracker threw into the tab's outcome.
   *
   * @param what When given, the failure is written to the plugin's log
   *   under this name (e.g. "close"). Left out for plain reads, whose
   *   failures are shown to the user and need no log line.
   * Side effects: forgets the folder's tracker when its program or its
   *   login has gone, so it is looked for again next time.
   */
  function problem(path: string, cause: unknown, what?: string): Problem {
    if (cause instanceof NoProgram) {
      forget(path);
      return { state: "no-bd", message: notFoundMessage };
    }
    if (cause instanceof NotSignedIn) {
      // The connection keeps the login it was built with, so a new one is
      // needed once the owner has signed in.
      forget(path);
      return { state: "no-login", message: cause.message };
    }
    if (cause instanceof NotSetUp) {
      forget(path);
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
   * @returns The tracker and which one it is, or which of the expected
   *   problems stands in the way. Never throws.
   * Side effects: the first time for a folder, reads the file system and,
   *   for beads or where there is no tracker, looks for the beads program
   *   (short-lived child processes). Nothing is sent to GitHub here.
   */
  async function trackerFor(path: string): Promise<Known | Problem> {
    const ready = known.get(path);
    if (ready !== undefined) return ready;
    // See the header for why the tab does not guess GitHub from a remote.
    const look = (bdCommand?: string): Found =>
      detectTracker(path, undefined, { bdCommand, guess: false, githubClient });
    let found: Found;
    try {
      found = look();
    } catch (cause) {
      // No tracker here. On a machine without beads that is said first, as
      // before: installing beads is then the first step setup can offer.
      if (cause instanceof NotSetUp && (await findBd(path)) === null) {
        return { state: "no-bd", message: notFoundMessage };
      }
      return problem(path, cause);
    }
    if (found.name === "beads") {
      const bdCommand = await findBd(path);
      if (bdCommand === null) {
        return { state: "no-bd", message: notFoundMessage };
      }
      // Built again with the program that was found, which may not be the
      // one on the PATH.
      found = look(bdCommand);
    }
    const entry: Known = {
      tracker: found.tracker,
      name: found.name,
      repository: found.repository,
    };
    known.set(path, entry);
    return entry;
  }

  /**
   * Which tracker a folder was last found to have, without looking again;
   * null when it was never found or has since been forgotten. For callers
   * that have just read the folder's issues and only need the name.
   */
  function nameOf(path: string): TrackerName | null {
    return known.get(path)?.name ?? null;
  }

  return { trackerFor, problem, forget, nameOf };
}

/** What createTrackers returns; handed to the store. */
export type Trackers = ReturnType<typeof createTrackers>;
