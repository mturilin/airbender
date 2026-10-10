// tracker/detect.ts — which tracker a folder's repository uses.
//
// What: looks at a folder and gives the adapter for the tracker found there,
// and the repository's root folder.
//
// Why: the caller (an agent running `bend`) should not have to say which
// tracker a repository uses, or even know.
//
// Design notes:
// - The order, decided by the owner (bead-bb-c9l.1): what the repository
//   says itself in its setting file (config.ts) wins; without one, a
//   `.beads` folder means beads; without that, a remote called origin on
//   github.com means GitHub issues. So a repository that has both beads
//   and a GitHub remote, as nearly every beads repository does, stays on
//   beads unless it says otherwise.
// - A caller can name the trackers it accepts. The Airbender tab accepts
//   beads only: it reads the whole list on every reload, which a hosted
//   tracker is too slow for until there is a cache (bead-bb-c9l.5). A
//   tracker that is not accepted is passed over as if it were not there.
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
import { readSetting, TRACKER_NAMES, type TrackerName } from "./config.ts";
import { createGitHubClient, type GitHubClient } from "./github-api.ts";
import { createGitHubTracker } from "./github.ts";
import { NotSetUp, Refused, type Tracker } from "./types.ts";

/** A tracker found for a folder. */
export interface Found {
  tracker: Tracker;
  /** Which tracker it is. */
  name: TrackerName;
  /** For GitHub: the repository, as "owner/name"; null for beads. */
  repository: string | null;
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
 * The repository on github.com that a folder's remote called origin points
 * at, as "owner/name".
 *
 * @returns Null when the folder is not a git repository, has no such
 *   remote, or the remote is somewhere else.
 * Side effects: one read-only git command.
 */
export function githubRepositoryOf(dir: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  return parseGithubRemote(url);
}

/**
 * "owner/name" from a git remote's address, in any of the forms git
 * accepts for github.com (https, ssh, and the short git@ form); null for
 * an address that is not on github.com. Pure.
 */
export function parseGithubRemote(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(
      url.trim(),
    );
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/**
 * Finds the tracker for a folder.
 *
 * @param dir Where to start looking; its parents are tried in turn.
 * @param actor Who is acting, passed to the adapter for the tracker's
 *   history.
 * @param options.bdCommand The beads program to run, for a caller that has
 *   found it itself; else the environment's BEND_BD, else `bd` on the PATH.
 * @param options.accept The trackers the caller can work with; all of them
 *   when left out. One that is not accepted is passed over.
 * @param options.guess Whether a GitHub remote alone is enough to use
 *   GitHub issues; true when left out. With false, GitHub is used only
 *   where the setting file says so: for a caller that must not start
 *   reading and changing a repository's GitHub issues before its owner has
 *   chosen that (the Airbender tab).
 * @param options.githubClient Makes the connection to a GitHub repository;
 *   the real one when left out. Replaced in tests.
 * @throws NotSetUp when no accepted tracker is found; Refused when the
 *   folder does not exist, or its setting file cannot be understood or
 *   names GitHub without a repository that can be found.
 * Side effects: reads the file system; up to two read-only git commands
 *   when the walk upward finds nothing. Nothing is sent to GitHub here.
 */
export function detectTracker(
  dir: string,
  actor?: string,
  options: {
    bdCommand?: string;
    accept?: readonly TrackerName[];
    guess?: boolean;
    githubClient?: (repository: string) => GitHubClient;
  } = {},
): Found {
  const start = resolve(dir);
  if (!existsSync(start)) {
    throw new Refused(`The folder ${start} does not exist.`);
  }
  const accept = options.accept ?? TRACKER_NAMES;
  // Lets a machine where bd is not on the PATH still be used.
  const bdCommand =
    options.bdCommand?.trim() || process.env.BEND_BD?.trim() || "bd";
  const beadsIn = (root: string, runIn: string): Found => ({
    root,
    name: "beads",
    repository: null,
    tracker: createBeadsTracker({ dir: runIn, actor, bdCommand }),
  });
  const githubIn = (root: string, repository: string): Found => ({
    root,
    name: "github",
    repository,
    tracker: createGitHubTracker({
      client: (options.githubClient ?? ((name) => createGitHubClient({ repository: name })))(
        repository,
      ),
      actor,
    }),
  });
  // A setting file may name the repository without naming the tracker:
  // "the remote is not where the issues are". The nearest one is kept for
  // the case where the remote is what decides, below.
  let namedRepository: string | undefined;
  for (let folder = start; ; folder = dirname(folder)) {
    const setting = readSetting(folder);
    namedRepository ??= setting?.repository;
    if (setting?.tracker !== undefined && accept.includes(setting.tracker)) {
      if (setting.tracker === "beads") return beadsIn(folder, folder);
      const repository = setting.repository ?? githubRepositoryOf(folder);
      if (repository === null) {
        throw new Refused(
          `${folder} is set to use GitHub issues, but which repository cannot be told: its remote called origin is not on github.com. Name it in the setting file as "repository": "owner/name".`,
        );
      }
      return githubIn(folder, repository);
    }
    if (accept.includes("beads") && existsSync(join(folder, ".beads"))) {
      return beadsIn(folder, folder);
    }
    if (dirname(folder) === folder) break;
  }
  const main = mainFolderOf(start);
  if (
    accept.includes("beads") &&
    main !== null &&
    existsSync(join(main, ".beads"))
  ) {
    // Run where the caller is, as it would run bd itself: beads finds the
    // main folder's database from a work tree.
    return beadsIn(main, start);
  }
  if (accept.includes("github") && options.guess !== false) {
    const remote = githubRepositoryOf(start);
    const repository = remote === null ? null : (namedRepository ?? remote);
    // The folder the facts file sits in: the repository's main folder,
    // which is where a work tree's checked-in files come from too.
    if (repository !== null) return githubIn(main ?? start, repository);
  }
  throw new NotSetUp(
    `No supported issue tracker was found in ${start} or the folders above it. Supported: beads (a .beads folder) and GitHub issues (a remote called origin on github.com, or a ${"`.bend.json`"} setting file).`,
  );
}
