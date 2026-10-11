// server/prompts.ts — the words sent to agents and written for them.
//
// What: Airbender's rules for a folder's AGENTS.md, the decision about
// what a folder's CLAUDE.md should contain, and taking beads' own generated
// instructions out of both. What an agent is told at each step of an issue
// is not here: that is the workflow's (shared/standard-workflow.ts).
//
// Why: all wording an agent reads on the user's behalf is in one file, so it
// can be reviewed and changed together.
//
// Design notes:
// - Airbender's rules are the only instructions about issues a repository
//   gives its agents (bead-bb-c9l.8, the decision in bead-bb-c9l.7). Beads
//   writes instructions of its own, for its own way of working: "close the
//   issue when you are done", and a "session close protocol" printed at the
//   start of every session. That is the opposite of the workflow here, and
//   for a while these rules said "where they disagree, these take
//   precedence" and an agent got both. Now beads' text is taken out.
// - Only text between beads' own markers is removed. Beads also writes
//   text without markers; that cannot be told safely from the owner's own,
//   so it is named for the owner and left.
// - Everything here is text in, text out, so it is tested without a
//   repository (server/prompts.test.ts). server/setup.ts does the reading
//   and writing.
//
// Gotchas:
// - The texts are template strings; a backtick inside them must be escaped.
// - Changing AIRBENDER_RULES in a way agents should get means raising
//   RULES_VERSION and adding the old text's fingerprint to SHIPPED_BEFORE,
//   or repositories with the old block are taken for edited ones and never
//   updated. The test "an earlier version's block is recognised" fails
//   until that is done.

import { createHash } from "node:crypto";

/** Marks the start and end of Airbender's block inside an AGENTS.md. */
export const RULES_START = "<!-- airbender:rules:start -->";

const RULES_END = "<!-- airbender:rules:end -->";

/**
 * Which version of the rules a block holds, on a line of its own inside the
 * markers. Raised whenever the text below changes in a way an agent should
 * get, so that setup can tell an older block and offer to replace it. A
 * block without the line is from before there were versions.
 */
const RULES_VERSION = `<!-- airbender:rules:version 2 -->`;

/**
 * The rules as earlier versions of this plugin wrote them, by fingerprint
 * (SHA-256 of the block with every run of white space made one space).
 *
 * A block that matches one is ours, unchanged, and may be replaced by the
 * current text. A block that matches none was edited by the owner (this
 * project's own repository has a much longer one of its own inside the
 * markers), and replacing it would throw their text away; such a block is
 * left alone and the owner is told.
 */
const SHIPPED_BEFORE: readonly string[] = [
  // Version 1: before bead-bb-c9l.8, with the sentence about taking
  // precedence over beads' own instructions.
  "bcf270710cd722894f17bde63d8aa46944be782add371ede632d38a44bb47783",
];

/** The file standing facts are kept in, at a repository's root. */
export const FACTS_FILE = "FACTS.md";

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
${RULES_VERSION}
## Working with beads through Airbender

This repository's issues are tracked in beads (\`bd\`) and worked from the
Airbender tab in BB. These are the instructions for working on issues here;
follow them whenever you work on one.

The commands you need (\`bd <command> --help\` says more):

- \`bd show <id>\` and \`bd comments <id>\`: read an issue and its history.
- \`bd update <id>\` with \`--description "..."\`, \`--acceptance "..."\` or
  \`--design "..."\`: write what is wanted, what "done" means, and the plan.
  With \`--status in_progress\`: mark it started.
- \`bd comment <id> "..."\`: record a decision, a surprise, or a hand-over.
- \`bd create "..." --deps discovered-from:<id>\`: follow-up work, linked to
  the issue it came from.
- \`bd dep add <id> <other-id>\`: this issue waits for the other one.
- \`bd list\` and \`bd ready\`: what there is, and what can be worked on.

- **Standing facts are in \`${FACTS_FILE}\`.** Read it when you start. When
  you learn something every later session should know (how to build, a
  convention, a lasting preference of the user's), add it there as one
  line, \`- **short-key** — the fact\`. Do not use \`bd remember\` for that.

- **Every piece of work has an issue.** If the user asks for something that
  has no issue yet, create one first (\`bd create\`), with what is wanted and
  why, and what "done" means (\`bd update <id> --acceptance "..."\`).
- **A question is not work.** A plain question or a discussion needs no
  issue: answer it in the conversation. Where it ends in a decision worth
  keeping, offer to record it.
- **Make the issue you work on the thread's current issue**, by calling the
  \`beads_set_current\` tool with its id as soon as you start, also when you
  created the issue yourself. The user sees in the Airbender tab, and
  above the message box, which issue the thread is on.
- **The repository's owner chooses its workflow** in the Airbender tab:
  standard, where every issue goes through steps, or simple, with no steps.
  You are told which one applies when you set your current issue with
  \`beads_set_current\`, and again if the user switches it. On the standard
  workflow the rules below marked "(standard)" apply. On the simple
  workflow there are no steps to report (the \`beads_workflow_move\` tool
  refuses and says so): the user directs the work in the conversation and
  closes issues themselves.
- **(standard) An issue takes only the steps its size needs.** When you
  are started on an issue that has no size, size it first: S (small: done
  in one go, the user sees it once, at the end), M (medium: definition and
  plan together, one review, then the result) or L (large: every step). In
  doubt, take the larger. The user can set or change the size. When you
  create an issue yourself you may give it a size, with the label
  \`size:s\`, \`size:m\` or \`size:l\`.
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
  subject line. A merge only when the user chose "Commit & merge": then
  also push the main branch and, after that, delete the issue's branch
  locally and on the remote. An issue the user starts "in a new branch"
  tells you the branch to create first. In a conversation opened for one
  issue in a work tree, follow the landing order that step gives you, and
  leave the work tree and its local branch to Airbender.
- **(standard) An epic can have a branch for all of its issues.** The user
  starts an issue that has sub-issues "in a branch" or "in a work tree":
  you then only create the branch (or say which branch the work tree is
  on) and start no work. The epic waits at the step "On its branch". Its
  issues are started one at a time, in a folder on that branch only, and
  each is committed there and never merged by itself. The branch is merged
  once, when the user closes the epic with "Close & merge".
- **On the simple workflow, commit only when the user asks.**
${RULES_END}
`;

/** The rules block of an AGENTS.md, markers included; null when none. */
function rulesBlock(agentsFile: string): string | null {
  const start = agentsFile.indexOf(RULES_START);
  if (start === -1) return null;
  const end = agentsFile.indexOf(RULES_END, start);
  return end === -1
    ? agentsFile.slice(start)
    : agentsFile.slice(start, end + RULES_END.length);
}

/** A text's fingerprint, as kept in SHIPPED_BEFORE. */
const fingerprint = (text: string) =>
  createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex");

/**
 * Which rules an AGENTS.md holds.
 *
 * @returns "current": this version's, to the letter. "old": an earlier
 *   version's, unchanged, which may be replaced. "edited": a block the
 *   owner changed, of whatever version, which is theirs and is left alone.
 *   "none": no block.
 */
export function rulesIn(
  agentsFile: string,
): "current" | "old" | "edited" | "none" {
  const block = rulesBlock(agentsFile);
  if (block === null) return "none";
  const print = fingerprint(block);
  if (print === fingerprint(AIRBENDER_RULES)) return "current";
  return SHIPPED_BEFORE.includes(print) ? "old" : "edited";
}

/**
 * An AGENTS.md with Airbender's current rules in it.
 *
 * An older block of ours is replaced where it stands; with no block the
 * rules are added at the end, after whatever is there. A block the owner
 * edited is left as it is. Nothing else in the file is touched.
 *
 * @param existing The file's text; "" when there is no file.
 * @returns The new text; `existing` itself when the current rules are
 *   there, or the owner's own are.
 */
export function agentsFileWith(existing: string): string {
  const has = rulesIn(existing);
  if (has === "current" || has === "edited") return existing;
  if (has === "none") {
    return existing === ""
      ? AIRBENDER_RULES
      : `${existing.replace(/\n*$/u, "")}\n\n${AIRBENDER_RULES}`;
  }
  const start = existing.indexOf(RULES_START);
  const end = existing.indexOf(RULES_END, start);
  // A block without its end marker (cut by hand): replaced to the end of
  // the file, which is where the block was written.
  const after =
    end === -1
      ? ""
      : existing.slice(end + RULES_END.length).replace(/^\n/u, "");
  return existing.slice(0, start) + AIRBENDER_RULES + after;
}

/**
 * A block beads generated, between its own markers: the one `bd init`
 * writes ("BEGIN BEADS INTEGRATION ...") and the one `bd setup codex`
 * writes ("BEGIN BEADS CODEX SETUP ..."). The markers carry a version and a
 * hash that change between beads versions, so only their fixed start is
 * matched. Lazy, and each block ends at the first end marker after it, so
 * text between two blocks is never taken.
 */
const BEADS_BLOCK = /<!-- BEGIN BEADS [^>]*-->[\s\S]*?<!-- END BEADS [^>]*-->\n?/gu;

/** Whether a text holds a block beads generated. */
export function hasBeadsBlocks(text: string): boolean {
  return new RegExp(BEADS_BLOCK.source, "u").test(text);
}

/**
 * A text without the blocks beads generated.
 *
 * Only what is between beads' markers goes, markers included. Where a block
 * stood, the blank lines around it are closed up to one, so no gap is left;
 * nothing else changes, to the letter.
 *
 * @returns The new text; `text` itself when it holds no such block.
 */
export function withoutBeadsBlocks(text: string): string {
  if (!hasBeadsBlocks(text)) return text;
  return text
    .split(BEADS_BLOCK)
    .map((part, index, parts) => {
      // The blank lines that set a removed block apart, on either side.
      let kept = part;
      if (index > 0) kept = kept.replace(/^\n+/u, "");
      if (index < parts.length - 1) kept = kept.replace(/\n+$/u, "\n");
      return kept;
    })
    .filter((part) => part !== "")
    .join("\n")
    .replace(/\n*$/u, "\n");
}

/**
 * The sections beads writes into an AGENTS.md without markers, by what
 * gives each away. They tell agents the same things the marked blocks do
 * ("bd close <id> # Complete work"), but nothing marks where they start
 * and end, so they are named for the owner and not removed.
 */
const BEADS_UNMARKED: { name: string; sign: RegExp }[] = [
  {
    name: "the opening lines about bd prime",
    sign: /This project uses \*\*bd\*\* \(beads\) for issue tracking\. Run `bd prime`/u,
  },
  {
    name: "Quick Reference",
    sign: /^## Quick Reference\n[\s\S]{0,400}?bd close <id>/mu,
  },
  { name: "Session Completion", sign: /^## Session Completion$/mu },
  { name: "Beads Issue Tracker", sign: /^## Beads Issue Tracker$/mu },
];

/**
 * The names of beads' unmarked sections found in a text, for the owner to
 * remove by hand if they wish.
 *
 * Pre-condition: beads' marked blocks are already out of `text` (the last
 * two signs are headings that also stand inside those blocks).
 */
export function beadsLeftovers(text: string): string[] {
  return BEADS_UNMARKED.filter(({ sign }) => sign.test(text)).map(
    ({ name }) => name,
  );
}

/**
 * The lines that make Claude Code read AGENTS.md, and the standing facts,
 * from a CLAUDE.md. Used only where a CLAUDE.md already exists: such a file
 * would otherwise carry its own, possibly contradicting, instructions.
 *
 * The facts file is pulled in here because nothing else loads it by itself;
 * the rules also tell an agent to read it, for the agents this file does
 * not reach.
 */
const CLAUDE_IMPORT = "@AGENTS.md";
const FACTS_IMPORT = `@${FACTS_FILE}`;

/** CLAUDE.md as the rules step writes it when it owns the whole file. */
const CLAUDE_POINTER = `# Project Instructions for AI Agents

The instructions for this project are in [AGENTS.md](AGENTS.md). Read that
file in full before doing anything, and follow it. Standing facts about the
project are in [${FACTS_FILE}](${FACTS_FILE}).

${CLAUDE_IMPORT}
${FACTS_IMPORT}

This file is only a pointer, so that tools which look for \`CLAUDE.md\` find
the same rules as tools which look for \`AGENTS.md\`. Do not add instructions
here; put them in \`AGENTS.md\`.
`;

/** Whether a text has a line that is exactly `line`. */
const hasLine = (text: string, line: string) =>
  text.split("\n").some((candidate) => candidate.trim() === line);

/**
 * What the rules step should write to CLAUDE.md (bead-bb-0bk), given what is
 * there now.
 *
 * Why it touches this file at all: \`bd init\` and \`bd setup claude\` create
 * a CLAUDE.md holding beads' generic instructions, which tell agents to
 * close issues themselves, against Airbender's rules, and Claude Code reads
 * that file.
 *
 * - No file (or an empty one): left alone. The user's decision: Claude Code
 *   reads AGENTS.md itself now, so there is no reason to create the file.
 * - The file beads generated and nobody filled in (its title, beads' block
 *   and its three untouched placeholders): replaced by the pointer. Nothing
 *   of the user's is lost.
 * - Anything else is the user's own: kept whole, less beads' marked block,
 *   with the two import lines added at the top where they are missing, so
 *   AGENTS.md and the facts are read as well.
 *
 * @param existing The file's text, or null when there is no file.
 * @returns The new text, or null when nothing needs writing: there is no
 *   file, or it already points at both and holds no beads block.
 */
export function claudeFileFor(existing: string | null): string | null {
  if (existing === null || existing.trim() === "") return null;
  const generated =
    existing.includes("<!-- BEGIN BEADS INTEGRATION") &&
    existing.includes("_Add your build and test commands here_") &&
    existing.includes("_Add a brief overview of your project architecture_") &&
    existing.includes("_Add your project-specific conventions here_");
  if (generated) return CLAUDE_POINTER;
  let next = withoutBeadsBlocks(existing);
  if (!hasLine(next, CLAUDE_IMPORT)) {
    next = `${CLAUDE_IMPORT}\n${FACTS_IMPORT}\n\n${next}`;
  } else if (!hasLine(next, FACTS_IMPORT)) {
    // After the line it belongs with, wherever the owner put that.
    next = next.replace(
      new RegExp(`^([ \\t]*${CLAUDE_IMPORT}[ \\t]*)$`, "mu"),
      `$1\n${FACTS_IMPORT}`,
    );
  }
  return next === existing ? null : next;
}
