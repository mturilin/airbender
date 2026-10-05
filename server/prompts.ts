// server/prompts.ts — the words sent to agents and written for them.
//
// What: the message that starts an agent on an issue, the brief for the Define
// worker, Airbender's rules for AGENTS.md, and the decision about what a
// folder's CLAUDE.md should contain.
//
// Why: all wording an agent reads on the user's behalf is in one file, so it
// can be reviewed and changed together.
//
// Gotchas:
// - The texts are template strings; a backtick inside them must be escaped.

import type { Issue } from "./contract.ts";

/** Marks the start and end of Airbender's block inside an AGENTS.md. */
export const RULES_START = "<!-- airbender:rules:start -->";

const RULES_END = "<!-- airbender:rules:end -->";

/**
 * Airbender's working rules, added to a folder's AGENTS.md on request
 * (bead-bb-80e). They are the rules the tab's buttons rely on: play expects
 * an agent that asks before it builds, and "Close & commit" expects one that
 * leaves closing to the user and commits when told an issue was closed.
 * Without them the buttons still send their messages, but an agent has no
 * standing reason to behave that way between messages.
 *
 * Kept general on purpose: nothing here is about one repository (no spec
 * file, no push hook). Wrapped in marker comments so the tab can tell the
 * block is there, and so a later version can replace it without touching
 * the rest of the file.
 */
export const AIRBENDER_RULES = `${RULES_START}
## Working with beads through Airbender

This repository's issues are tracked in beads (\`bd\`) and worked from the
Airbender tab in BB. Follow these rules whenever you work on an issue.
Where they disagree with beads' own instructions elsewhere in this file (for
example "\`bd close <id>\` to complete work"), these rules take precedence.

- **Every piece of work has an issue.** If the user asks for something that
  has no issue yet, create one first (\`bd create\`), with what is wanted and
  why, and what "done" means (\`bd update <id> --acceptance "..."\`).
- **Make the issue you work on the thread's current issue**, by calling the
  \`beads_set_current\` tool with its id as soon as you start, also when you
  created the issue yourself. The Airbender tab offers the user "Close &
  commit" only on the current issue.
- **Ask the issue's open questions first.** Being started on an issue is not
  permission to assume the answers. Record each answer on the issue.
- **Requirements, then plan, then build.** Make sure it is clear what is
  wanted and what "done" means; say what you will change and wait for the
  user's approval; then do the work. You may skip a step that is obvious,
  and say so in one line when you do.
- **Record as you go.** Decisions and their reasons, things that did not
  work, and progress go on the issue (\`bd comment\`, \`bd note\`, the design
  field). Follow-up work becomes its own issue, linked to the one it came
  from.
- **Do not close the issue.** When you are finished, add a comment saying
  what you did, how you checked it and what you did not check, leave the
  issue in progress, and tell the user it is ready to validate. The user
  closes it.
- **Commit when the user has closed the issue**, not before: one commit per
  issue, only that issue's files, with the issue's id and title as the
  subject line.
${RULES_END}
`;

/**
 * The line that makes Claude Code read AGENTS.md from a CLAUDE.md. Used
 * only where a CLAUDE.md already exists: such a file would otherwise carry
 * its own, possibly contradicting, instructions.
 */
const CLAUDE_IMPORT = "@AGENTS.md";

/** CLAUDE.md as the rules step writes it when it owns the whole file. */
const CLAUDE_POINTER = `# Project Instructions for AI Agents

The instructions for this project are in [AGENTS.md](AGENTS.md). Read that
file in full before doing anything, and follow it.

${CLAUDE_IMPORT}

This file is only a pointer, so that tools which look for \`CLAUDE.md\` find
the same rules as tools which look for \`AGENTS.md\`. Do not add instructions
here; put them in \`AGENTS.md\`.
`;

/** Whether a CLAUDE.md already points at AGENTS.md (a line of its own). */
function claudePointsAtAgents(text: string): boolean {
  return text.split("\n").some((line) => line.trim() === CLAUDE_IMPORT);
}

/**
 * What the rules step should write to CLAUDE.md (bead-bb-0bk), given what is
 * there now.
 *
 * Why it touches this file at all: \`bd init\` creates a CLAUDE.md holding
 * beads' generic instructions, which tell agents to close issues themselves,
 * against Airbender's rules, and Claude Code reads that file.
 *
 * - No file (or an empty one): left alone. The user's decision: Claude Code
 *   reads AGENTS.md itself now, so there is no reason to create the file.
 * - The file beads generated and nobody filled in (its title, beads' block
 *   and its three untouched placeholders): replaced by the pointer. Nothing
 *   of the user's is lost, and beads' block stays available in AGENTS.md.
 * - Anything else is the user's own: kept whole, with the import line added
 *   at the top so AGENTS.md is read as well.
 *
 * @param existing The file's text, or null when there is no file.
 * @returns The new text, or null when nothing needs writing: there is no
 *   file, or it already points at AGENTS.md.
 */
export function claudeFileFor(existing: string | null): string | null {
  if (existing === null || existing.trim() === "") return null;
  if (claudePointsAtAgents(existing)) return null;
  const generated =
    existing.includes("<!-- BEGIN BEADS INTEGRATION") &&
    existing.includes("_Add your build and test commands here_") &&
    existing.includes("_Add a brief overview of your project architecture_") &&
    existing.includes("_Add your project-specific conventions here_");
  return generated ? CLAUDE_POINTER : `${CLAUDE_IMPORT}\n\n${existing}`;
}

/**
 * The message the play button sends to the thread's agent to start work on
 * an issue.
 *
 * The order was set by the user (bead-bb-avf): first make sure the
 * requirements are clear, then agree an implementation plan, then build.
 * The first two are the agent's call: either may be skipped when it is
 * obvious, but the agent has to say that it skipped it and why, so the user
 * can object. Both happen in the user's own thread, with its own model; the
 * background define run is a separate, optional way to prepare an issue and
 * is never started from here.
 *
 * It is sent as an ordinary message, not as BB's forced plan-mode request,
 * precisely because planning may be skipped: a forced plan request would
 * demand a plan and an approval even for a one-line fix.
 */
export function workRequest(
  beadId: string,
  title: string,
  subIssues: Issue[],
): string {
  // An issue with sub-issues is worked as a whole: the user asked that play
  // on an epic means "this issue and all its sub-issues" (bead-bb-5qt).
  const epic =
    subIssues.length === 0
      ? []
      : [
          "",
          "This issue has sub-issues. Work on it and all of them together, as one piece of work:",
          ...subIssues.map(
            (issue) => `- ${issue.id}: ${JSON.stringify(issue.title)}`,
          ),
          "",
          "Read each sub-issue with `bd show` as well. Steps 1 and 2 below cover the whole set: one round of questions and one plan, which says the order you will take the sub-issues in. In step 3, mark each sub-issue in progress when you start it and add a comment to it when it is finished. Do not close any of them.",
        ];
  return [
    `Work on beads issue ${beadId}: ${JSON.stringify(title)}. Start with \`bd show ${beadId}\` and \`bd comments ${beadId}\`.`,
    ...epic,
    "",
    "Go through these steps in order.",
    "",
    "1. Requirements. Make sure it is clear what is wanted, why, and what \"done\" means. If the issue records open questions for the user, or you have your own, ask them and wait for the answers: being started on an issue is not permission to assume them. Then write the agreed requirements onto the issue (description and acceptance criteria). Skip this step only if the requirements are already obvious and complete.",
    "",
    "2. Implementation plan. Say what you will change and how, and wait for the user's approval before changing anything. Use plan mode for this if you have it. Then write the agreed plan into the issue's design field. Skip this step only if the change is small and the way to do it is obvious.",
    "",
    "3. Build. Mark the issue in progress and do the work.",
    "",
    "When you skip step 1 or step 2, say so in one line and give the reason, so the user can stop you. If in doubt, do not skip.",
    "",
    "When you are finished, do not close the issue: add a comment to it saying what you did and how you checked it, leave it in progress, and tell the user it is ready for them to validate. The user closes it.",
  ].join("\n");
}

/**
 * The instruction given to the background agent that defines an issue.
 *
 * Wording notes, from reviewing the first real run (bead-bb-5nz): the result
 * was accurate but about 1,500 words for a one-line request, used capital
 * letters instead of Markdown for headings (the tab renders Markdown), asked
 * five questions, widened the request, and its comments were recorded under
 * the user's own name because bd signs with the git user by default. Each
 * rule below answers one of those.
 */
export function definePrompt(beadId: string, title: string): string {
  return [
    `Define beads issue ${beadId} (${JSON.stringify(title)}): turn it from a bare request into a clear, buildable issue. Start with \`bd show ${beadId}\`, then read the code it touches.`,
    "",
    "Write these onto the issue with `bd update`:",
    "- Description: what is wanted and why, how things work today (name the files and functions), and what is out of scope. Keep the user's original wording as a quote. At most about 200 words.",
    "- Acceptance criteria: at most 8 short checks a person can verify.",
    "- Design: the approach you propose, step by step, with the files to change and any gotcha you found in the code. Mention an alternative only if you rejected it for a reason worth knowing. At most about 300 words.",
    "- Type and priority, and links to issues it depends on or relates to.",
    "",
    "Rules:",
    "- Be proportionate. A one-line request gets a short write-up; someone should be able to read all of it in two minutes.",
    "- Stay inside the request. If you think of an extension, give it one line under out of scope; do not design it.",
    "- Format with Markdown: `##` headings and `-` bullets, not capital-letter headings. The text is shown rendered.",
    "- Check every claim about the code against the code before you write it.",
    "- Open questions: at most 3, only ones whose answer changes what gets built. Put them in one comment titled \"Open questions\", each with the answer you would assume, so work can start without waiting.",
    "- Add one more comment saying which decisions were yours and what you could not verify.",
    `- Add \`--actor "define agent"\` to every bd command that writes, so your changes and comments are not recorded under the user's name.`,
    "- Do not start the work, do not change any file, do not close the issue, do not commit, and do not make it this thread's current bead.",
    "",
    "Finish with three lines at most: what you set, and the open questions.",
  ].join("\n");
}
