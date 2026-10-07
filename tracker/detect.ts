// tracker/detect.ts — which tracker a folder's repository uses.
//
// What: looks at a folder and gives the adapter for the tracker found there,
// and the repository's root folder.
//
// Why: the caller (an agent running `bend`) should not have to say which
// tracker a repository uses, or even know.
//
// Design notes:
// - Detection goes by what is in the folder, walking upward: a `.beads`
//   folder means beads. Other trackers will be added here, each with its own
//   sign (for GitHub, the repository's remote).
// - A folder with no supported tracker is a refusal with a plain message,
//   not a guess.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createBeadsTracker } from "./beads.ts";
import { Refused, type Tracker } from "./types.ts";

/** A tracker found for a folder. */
export interface Found {
  tracker: Tracker;
  /** The folder the tracker was found in: the repository's root. */
  root: string;
}

/**
 * Finds the tracker for a folder.
 *
 * @param dir Where to start looking; its parents are tried in turn.
 * @param actor Who is acting, passed to the adapter for the tracker's
 *   history.
 * @throws Refused when no supported tracker is found.
 * Side effects: reads the file system only.
 */
export function detectTracker(dir: string, actor?: string): Found {
  const start = resolve(dir);
  if (!existsSync(start)) {
    throw new Refused(`The folder ${start} does not exist.`);
  }
  for (let folder = start; ; folder = dirname(folder)) {
    if (existsSync(join(folder, ".beads"))) {
      return {
        root: folder,
        tracker: createBeadsTracker({
          dir: folder,
          actor,
          // Lets a machine where bd is not on the PATH still be used.
          bdCommand: process.env.BEND_BD?.trim() || "bd",
        }),
      };
    }
    if (dirname(folder) === folder) break;
  }
  throw new Refused(
    `No supported issue tracker was found in ${start} or the folders above it. bend supports beads today (a .beads folder).`,
  );
}
