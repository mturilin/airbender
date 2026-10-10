// shared/tracker-words.ts — what an agent is told to type, per tracker.
//
// What: the few phrases in the workflow's instructions that name a command
// of the tracker, once for beads (`bd`) and once for a repository whose
// issues are on GitHub (`bend`).
//
// Why: the workflow says what to do at each step ("write the plan onto the
// issue"); how that is typed depends on where the repository keeps its
// issues (bead-bb-c9l.6). On GitHub `bd` has nothing to read, so an agent
// told `bd show` would be stuck at its first line. Keeping the phrases in
// one table means the steps themselves are written once, for every tracker.
//
// Design notes:
// - The beads phrases are, to the letter, what the instructions said before
//   there was a second tracker, so a beads repository's agents read exactly
//   what they always did (shared/workflow.test.ts holds that).
// - On GitHub agents are told `bend`, not `gh issue`: `bend` keeps an
//   issue's plan, its "done" and its requirements where the tab looks for
//   them, and `gh` knows nothing of those.
// - This file has no imports, like the rest of shared/, so it can be
//   bundled on either side.

/** The phrases; each is put into a sentence as it stands. */
export interface TrackerWords {
  /** What an issue is called where it is first named: "beads issue". */
  issue: string;
  /** The command that shows one issue, for a given id, in backticks. */
  show(id: string): string;
  /** The command that shows one issue's comments, in backticks. */
  comments(id: string): string;
  /** The show command without an id, in backticks: "read each with …". */
  showAny: string;
  /** With what the description and "done" are written onto an issue. */
  write: string;
  /** Where the plan goes, with the command: "the issue's design field (…)". */
  planPlace: string;
  /** The command that marks an issue in progress, in backticks. */
  inProgress: string;
  /** With what an unknown id can be looked up: "Run … to see ids." */
  list: string;
}

/** Beads: the wording the instructions always had. */
export const BEADS_WORDS: TrackerWords = {
  issue: "beads issue",
  show: (id) => `\`bd show ${id}\``,
  comments: (id) => `\`bd comments ${id}\``,
  showAny: "`bd show`",
  write: "`bd update`",
  planPlace: "the issue's design field (`bd update --design`)",
  inProgress: "`bd update --status in_progress`",
  list: "bd list",
};

/** A repository whose issues are on GitHub: the `bend` command. */
export const GITHUB_WORDS: TrackerWords = {
  issue: "GitHub issue",
  show: (id) => `\`bend show ${id}\``,
  comments: (id) => `\`bend comments ${id}\``,
  showAny: "`bend show`",
  write:
    "`bend write <id> description` and `bend write <id> done` (and `bend edit` for its type and priority)",
  planPlace: "the issue's plan (`bend write <id> plan`)",
  inProgress: "`bend start <id>`",
  list: "bend list",
};

/** The phrases for a tracker; beads' where there is none or it is unknown. */
export function wordsFor(tracker: string | null): TrackerWords {
  return tracker === "github" ? GITHUB_WORDS : BEADS_WORDS;
}
