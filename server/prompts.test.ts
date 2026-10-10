// server/prompts.test.ts — tests for what the rules step writes to CLAUDE.md.
//
// What: checks claudeFileFor, which decides the new content of a folder's
// CLAUDE.md, and that Airbender's rules carry their marker.
//
// Why: this step writes into the user's repository. It must never throw
// away text the user wrote, and never create the file (the user's decision).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AIRBENDER_RULES,
  RULES_START,
  agentsFileWith,
  claudeFileFor,
  rulesFor,
  rulesIn,
} from "./prompts.ts";

/** A CLAUDE.md as `bd init` generates it, with its unfilled placeholders. */
const GENERATED = `# Project Instructions for AI Agents

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker
<!-- END BEADS INTEGRATION -->
## Build & Test

_Add your build and test commands here_

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
`;

test("no CLAUDE.md, or an empty one, is left alone", () => {
  assert.equal(claudeFileFor(null), null);
  assert.equal(claudeFileFor("  \n"), null);
});

test("beads' generated, unfilled file becomes a pointer to AGENTS.md", () => {
  const next = claudeFileFor(GENERATED);
  assert.ok(next !== null);
  assert.match(next, /^@AGENTS\.md$/mu);
  assert.doesNotMatch(next, /BEADS INTEGRATION/u);
});

test("a file the user has written in is kept whole, with one line added", () => {
  const edited = GENERATED.replace(
    "_Add your build and test commands here_",
    "npm test",
  );
  for (const own of [edited, "# Mine\n\nUse tabs.\n"]) {
    const next = claudeFileFor(own);
    assert.ok(next !== null);
    assert.ok(next.startsWith("@AGENTS.md\n\n"));
    assert.ok(next.endsWith(own));
  }
});

test("a file that already points at AGENTS.md is not touched", () => {
  const pointer = claudeFileFor(GENERATED)!;
  assert.equal(claudeFileFor(pointer), null);
  assert.equal(claudeFileFor("# Mine\n@AGENTS.md\n"), null);
});

test("Airbender's rules start with the marker the tab looks for", () => {
  assert.ok(AIRBENDER_RULES.startsWith(RULES_START));
});

test("the rules for a GitHub repository are the same rules, with bend for bd", () => {
  assert.equal(rulesFor("beads"), AIRBENDER_RULES);
  const github = rulesFor("github");
  assert.ok(github.startsWith(RULES_START));
  assert.doesNotMatch(github, /\bbd\b|\bbeads\b(?!_)/u);
  assert.match(github, /## Working with GitHub issues through Airbender/u);
  assert.match(github, /`bend create`/u);
  assert.match(github, /`bend write <id> done "\.\.\."`/u);
  assert.match(github, /Never close an issue with `bend close`/u);
  // The tools keep their names, and the rules about steps are untouched.
  assert.match(github, /`beads_set_current`/u);
  const committing = (text: string) =>
    text.slice(text.indexOf("- **(standard) Commit when"));
  assert.equal(committing(github), committing(AIRBENDER_RULES));
  assert.ok(committing(github).length > 500);
});

test("an AGENTS.md gets the rules for its tracker, and a switch replaces only that block", () => {
  assert.equal(rulesIn("# Mine\n"), null);
  assert.equal(agentsFileWith("", "beads"), AIRBENDER_RULES);
  const mine = "# Mine\n\nMy own text.\n";
  const withBeads = agentsFileWith(mine, "beads");
  assert.equal(withBeads, `# Mine\n\nMy own text.\n\n${AIRBENDER_RULES}`);
  assert.equal(rulesIn(withBeads), "beads");
  // Already right: the very same text, so nothing is written.
  assert.equal(agentsFileWith(withBeads, "beads"), withBeads);
  // Switched: the block is replaced where it stands, nothing else moves.
  const after = `${withBeads}\n## Added later\n\nBy hand.\n`;
  const switched = agentsFileWith(after, "github");
  assert.equal(rulesIn(switched), "github");
  assert.equal(
    switched,
    `# Mine\n\nMy own text.\n\n${rulesFor("github")}\n## Added later\n\nBy hand.\n`,
  );
  // And back again gives exactly what was there.
  assert.equal(agentsFileWith(switched, "beads"), after);
});
