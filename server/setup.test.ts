// server/setup.test.ts — tests for how beads' check of an agent is read.
//
// What: checks that "installed but stale" is told apart from "not set up".
// Why: read as "not set up", it brought "Configure beads for Claude Code"
// back on a repository that had used beads for a week, the moment its
// issues were given a remote to sync with (bead-bb-0bz). The lines are
// what beads 1.3.1 printed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { staleFile } from "./setup.ts";

test("beads' 'installed but stale' names the file that is out of date", () => {
  assert.equal(
    staleFile(
      "✓ Project hooks installed: /home/me/repo/.claude/settings.json\n⚠ Claude Code integration installed but stale: /home/me/repo/AGENTS.md\n  Run: bd setup claude (to update)",
    ),
    "AGENTS.md",
  );
  assert.equal(
    staleFile("⚠ Claude Code integration installed but stale: /tmp/r/CLAUDE.md"),
    "CLAUDE.md",
  );
});

test("any other failed check is not 'stale'", () => {
  assert.equal(staleFile("✗ Claude Code integration not installed"), null);
  assert.equal(staleFile(""), null);
});
