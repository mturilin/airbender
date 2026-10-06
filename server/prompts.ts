// server/prompts.ts — the words sent to agents and written for them.
//
// What: Airbender's rules for a folder's AGENTS.md, and the decision about
// what a folder's CLAUDE.md should contain. What an agent is told at each
// step of an issue is not here: that is the workflow's
// (shared/standard-workflow.ts).
//
// Why: all wording an agent reads on the user's behalf is in one file, so it
// can be reviewed and changed together.
//
// Gotchas:
// - The texts are template strings; a backtick inside them must be escaped.

/** Marks the start and end of Airbender's block inside an AGENTS.md. */
export const RULES_START = "<!-- airbender:rules:start -->";

const RULES_END = "<!-- airbender:rules:end -->";

/**
 * Airbender's working rules, added to a folder's AGENTS.md on request
 * (bead-bb-80e). They are the rules the tab's buttons rely on: play expects
 * an agent that asks before it builds, and accepting an issue expects one that
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
  created the issue yourself. The user sees in the Airbender tab, and
  above the message box, which issue the thread is on.
- **The repository's owner chooses its workflow** in the Airbender tab:
  standard, where every issue goes through steps, or simple, with no steps.
  You are on the standard workflow when you have the
  \`beads_workflow_move\` tool and are told which step an issue is at; the
  rules below marked "(standard)" then apply. Without that tool the
  repository is on the simple workflow: there are no steps to report, the
  user directs the work in the conversation and closes issues themselves.
- **(standard) Every issue goes through its workflow.** Do the step you are
  started on only, and report it with the \`beads_workflow_move\` tool when
  it is finished. You may move an issue to another step when that is where
  the work really is, with your reason, but never forward past a review
  that is the user's (of the definition, of the plan, of the finished
  work). While an issue waits for the user: if their reply asks for
  changes, move it back and redo the work; if they approve, record that,
  quoting them; if it is only a question, answer it.
- **Ask the issue's open questions first.** Being started on an issue is not
  permission to assume the answers. Record each answer on the issue.
- **Record as you go.** Decisions and their reasons, things that did not
  work, and progress go on the issue (\`bd comment\`, \`bd note\`, the design
  field). Follow-up work becomes its own issue, linked to the one it came
  from.
- **Do not close the issue.** When the work is done, add a comment saying
  what you did, how you checked it and what you did not check, and tell the
  user it is ready to validate. Never close an issue with \`bd close\`
  unless the user tells you to close that issue: on the standard workflow
  it closes when its last step is reported done, on the simple one the user
  closes it.
- **(standard) Commit when the user has accepted the issue and chosen
  how**, not before. That is the workflow's last step: one commit per
  issue, only that issue's files, with the issue's id and title as the
  subject line; and a merge only when the user chose "Commit & merge".
- **On the simple workflow, commit only when the user asks.**
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
