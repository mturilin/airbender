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
// - A git work tree need not hold a `.beads` folder of its own: beads finds
//   its database through git, in the repository's main folder. So when the
//   walk upward finds nothing, the main folder is looked at too. Without
//   this, the Airbender tab lost its issues in such a work tree, where
//   running bd directly had shown them.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createBeadsTracker } from "./beads.ts";
import { NotSetUp, Refused, type Tracker } from "./types.ts";

/** A tracker found for a folder. */
export interface Found {
  tracker: Tracker;
  /** The folder the tracker was found in: the repository's root. */
  root: string;
}

/**
 * The main folder of the git repository a folder is a work tree of.
 *
 * @returns Null when the folder is not in a git repository, when git is not
 *   installed, and when it cannot be told.
 * Side effects: one read-only git command.
 */
function mainFolderOf(dir: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common === "") return null;
    // git answers relative to `dir` when the folder is the main one.
    return dirname(isAbsolute(common) ? common : resolve(dir, common));
  } catch {
    return null;
  }
}

/**
 * Finds the tracker for a folder.
 *
 * @param dir Where to start looking; its parents are tried in turn.
 * @param actor Who is acting, passed to the adapter for the tracker's
 *   history.
 * @param options.bdCommand The beads program to run, for a caller that has
 *   found it itself; else the environment's BEND_BD, else `bd` on the PATH.
 * @throws NotSetUp when no supported tracker is found; Refused when the
 *   folder does not exist.
 * Side effects: reads the file system; one read-only git command when the
 *   walk upward finds nothing.
 */
export function detectTracker(
  dir: string,
  actor?: string,
  options: { bdCommand?: string } = {},
): Found {
  const start = resolve(dir);
  if (!existsSync(start)) {
    throw new Refused(`The folder ${start} does not exist.`);
  }
  // Lets a machine where bd is not on the PATH still be used.
  const bdCommand =
    options.bdCommand?.trim() || process.env.BEND_BD?.trim() || "bd";
  for (let folder = start; ; folder = dirname(folder)) {
    if (existsSync(join(folder, ".beads"))) {
      return {
        root: folder,
        tracker: createBeadsTracker({ dir: folder, actor, bdCommand }),
      };
    }
    if (dirname(folder) === folder) break;
  }
  const main = mainFolderOf(start);
  if (main !== null && existsSync(join(main, ".beads"))) {
    return {
      root: main,
      // Run where the caller is, as it would run bd itself: beads finds the
      // main folder's database from a work tree.
      tracker: createBeadsTracker({ dir: start, actor, bdCommand }),
    };
  }
  throw new NotSetUp(
    `No supported issue tracker was found in ${start} or the folders above it. Beads is supported today (a .beads folder).`,
  );
}
