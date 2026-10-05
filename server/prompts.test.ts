// server/prompts.test.ts — tests for what the rules step writes to CLAUDE.md.
//
// What: checks claudeFileFor, which decides the new content of a folder's
// CLAUDE.md, and that Airbender's rules carry their marker.
//
// Why: this step writes into the user's repository. It must never throw
// away text the user wrote, and never create the file (the user's decision).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AIRBENDER_RULES, RULES_START, claudeFileFor } from "./prompts.ts";

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
