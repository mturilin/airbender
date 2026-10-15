// shared/constants.ts — values both halves of the plugin must agree on.
//
// What: the plain constants used by the backend (server.ts and server/*) and
// by the frontend (app.tsx and app/*) alike.
//
// Why: these used to be copied by hand into both entry files, on the belief
// that the frontend could not import values at all. It cannot import from
// the backend's modules (that would pull Node-only code into the browser
// bundle), but `bb plugin build` bundles each entry point separately and
// follows ordinary imports, so a file with no imports of its own is safe on
// both sides. One copy means a new link kind or issue type is one edit.
//
// Gotchas:
// - Keep this file free of imports. In particular no zod: a schema here
//   would be bundled into the browser.
// - Types derived from these constants live here too, for the same reason.
// - shared/tree.ts is the other file both sides import, under the same rule.

/** Issue types offered when creating an issue (beads' built-in set). */
export const ISSUE_TYPES = [
  "task",
  "feature",
  "bug",
  "epic",
  "chore",
  "decision",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** The beads status of a finished or cancelled issue. */
export const CLOSED_STATUS = "closed";

/**
 * What a beads issue id may look like. Checked before an id is handed to
 * `bd`, so nothing that could be read as an option reaches its command line.
 */
export const BEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Realtime channel the tab listens on. The backend publishes on it after any
 * change it makes or notices, so every open tab reloads.
 */
export const CHANGED_CHANNEL = "beads-changed";

/**
 * The link kinds the tab lets the user add (bead-bb-zty.4): beads' own
 * dependency types, under beads' own names, and nothing else (the user:
 * "standard bead to bead rels semantics, nothing additional").
 *
 * Two of beads' types are left out on purpose. "parent-child" has its own
 * controls in the tab (sub-issues). "relates-to" is what "related" becomes:
 * the tab creates a "related" link with `bd dep relate`, beads' own command
 * for a see-also link, which stores a "relates-to" link on both issues.
 */
export const LINK_KINDS = [
  "blocks",
  "discovered-from",
  "related",
  "tracks",
  "until",
  "caused-by",
  "validates",
  "supersedes",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * The message the quick-reply button sends (bead-bb-lit). It exists so the
 * user does not have to type "yes, go ahead" after every plan or question.
 * One is left, "Agree & continue". There was a plain "Go" as well; it went
 * when the message box got buttons for the real workflow moves, because it
 * looked like an approval and was not one. The backend sends them; the
 * frontend shows the same text in the buttons' tooltips.
 */
export const QUICK_REPLIES = {
  // The user's wording (bead-bb-ahs), with "your" added and the
  // exclamation mark dropped. "Recommendations" makes it an answer to an
  // agent's question that came with a recommendation, which the previous
  // "Sounds good. Please proceed." (bead-bb-7jd) was not; "LGTM" makes it
  // read as approval at a review step. Earlier tries: "I agree with your
  // recommendations. Go ahead.", "Confirmed. Go ahead.", "Recommendations
  // confirmed. Go ahead."
  agree: "LGTM. Agreed with your recommendations. Go ahead.",
} as const;

/**
 * The things that get a folder ready for Airbender (bead-bb-80e), in the
 * order they make sense: the beads program on the machine, beads set up in
 * the folder (or its issues fetched), Airbender's instructions for agents,
 * the saved facts carried over, and the issues given somewhere to sync to.
 * Beads' own setup for a coding agent was one of them until bead-bb-c9l.8:
 * its instructions contradict the workflow, and Airbender's replace them.
 */
export const SETUP_ACTIONS = [
  // Choose where the issues are kept: beads or GitHub issues
  // (bead-bb-c9l.9). The option is the tracker's name.
  "tracker",
  "install",
  // Install a verified bend release, or build from the included source
  // (bead-bb-c9l.4, bead-bb-bk2).
  "bend",
  "init",
  // Get the issues of a repository that already has them on its remote
  // (a fresh clone), in place of "init".
  "fetch",
  // Airbender's instructions for agents in place of beads' own
  // (bead-bb-c9l.8): writes the rules, and takes beads' generated blocks
  // and hooks out.
  "rules",
  // Carry facts saved in beads over to the facts file; the option is the
  // chosen keys, as a JSON list.
  "facts",
  // Give the folder's issues a remote and sync them for the first time.
  "sync",
] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/**
 * The coding agents BB runs, which beads has a setup of its own for. That
 * setup is no longer offered (see SETUP_ACTIONS); the list is what beads'
 * hooks are looked for, and removed, by.
 */
export const SETUP_AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;
