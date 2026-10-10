// tracker/config.ts — a repository's own word on which tracker it uses.
//
// What: reads the setting file `.bend.json` at a repository's root.
//
// Why: most repositories need no setting: a `.beads` folder means beads,
// and otherwise a GitHub remote means GitHub issues. But a repository can
// have both (every beads repository pushed to GitHub does), and the owner
// decided that such a repository says which one it uses in a small
// checked-in file (bead-bb-c9l.1), so that the choice travels with the
// code and is the same for everyone who clones it.
//
// Design notes:
// - JSON, because node reads it without another package and the Go
//   rewrite of bend (bead-bb-c9l.4) will too.
// - A file that cannot be understood is a refusal that names the file, not
//   a silent fall back to guessing: guessing the wrong tracker would send
//   an agent's issues to the wrong place.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Refused } from "./types.ts";

/** The setting file's name, at a repository's root. */
export const SETTING_FILE = ".bend.json";

/** The trackers a repository can name. */
export const TRACKER_NAMES = ["beads", "github"] as const;
export type TrackerName = (typeof TRACKER_NAMES)[number];

/** What a setting file says; a field left out is not decided by it. */
export interface Setting {
  tracker?: TrackerName;
  /** For GitHub: "owner/name"; else the remote called origin decides. */
  repository?: string;
}

/**
 * Reads the setting file of a folder.
 *
 * @returns What it says, or null when the folder has none.
 * @throws Refused when the file is there but cannot be understood: not
 *   JSON, an unknown tracker, or a repository not written "owner/name".
 * Side effects: reads the file system only.
 */
export function readSetting(folder: string): Setting | null {
  const file = join(folder, SETTING_FILE);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Refused(`${file} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Refused(`${file} must hold one object, like {"tracker": "github"}.`);
  }
  const { tracker, repository } = parsed as Record<string, unknown>;
  if (
    tracker !== undefined &&
    !(TRACKER_NAMES as readonly unknown[]).includes(tracker)
  ) {
    throw new Refused(
      `${file} names the tracker ${JSON.stringify(tracker)}. It can be: ${TRACKER_NAMES.join(", ")}.`,
    );
  }
  if (
    repository !== undefined &&
    (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repository))
  ) {
    throw new Refused(
      `${file} names the repository ${JSON.stringify(repository)}. Write it as "owner/name".`,
    );
  }
  return {
    tracker: tracker as TrackerName | undefined,
    repository: repository as string | undefined,
  };
}
