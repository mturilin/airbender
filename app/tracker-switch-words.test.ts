// app/tracker-switch-words.test.ts — tests for what the "switch tracker"
// window says (tracker-switch-words.ts).
//
// Why: the window's whole point is to say plainly what will happen before
// anything does (bead-bb-c9l.18); these are its sentences and the button
// that goes with each case.

import assert from "node:assert/strict";
import { test } from "node:test";
import { switchWords } from "./tracker-switch-words.ts";
import type { SwitchPreview } from "./tracker-switch-words.ts";

const preview = (over: Partial<SwitchPreview> = {}): SwitchPreview => ({
  cannot: null,
  repository: "owner/name",
  createIds: [],
  createNumbers: [],
  update: [],
  closedLeft: 0,
  truncated: false,
  needsRepository: false,
  ...over,
});

/** The two sentences every case ends with. */
const ALWAYS = 2;

test("going to GitHub issues: what is created there, what is brought up to date, what stays", () => {
  const said = switchWords(
    "github",
    preview({ createIds: ["t-1", "t-2", "t-3"], update: ["t-4"], closedLeft: 240 }),
    0,
  );
  assert.deepEqual(said.lines.slice(0, -ALWAYS), [
    "3 open issues that are only in beads are created on GitHub.",
    "1 issue that is already on both sides is brought up to date.",
    "240 closed issues stay in beads; closed issues are not copied.",
  ]);
  assert.match(said.lines.at(-2)!, /^Nothing is deleted\. Switch back at any time/u);
  assert.match(said.lines.at(-1)!, /^\.bend\.json changes/u);
  assert.equal(said.copy, "Copy 3 issues and switch");
});

test("going to beads: the same, read from the other side", () => {
  const said = switchWords(
    "beads",
    preview({ createNumbers: [12], update: ["t-4", "t-5"], closedLeft: 1 }),
    0,
  );
  assert.deepEqual(said.lines.slice(0, -ALWAYS), [
    "1 open issue that is only on GitHub is brought into beads.",
    "2 issues that are already on both sides are brought up to date.",
    "1 closed issue stays on GitHub; closed issues are not copied.",
  ]);
  assert.equal(said.copy, "Copy 1 issue and switch");
});

test("with only linked issues the button says update; with nothing there is no copy button", () => {
  assert.equal(
    switchWords("github", preview({ update: ["t-1", "t-2"] }), 0).copy,
    "Update 2 issues and switch",
  );
  const nothing = switchWords("github", preview(), 0);
  assert.equal(nothing.copy, null);
  assert.equal(nothing.lines[0], "There is nothing to copy.");
});

test("where no copy can be made it says why, and offers none", () => {
  const said = switchWords("beads", preview({ cannot: "There is no GitHub sign-in to use." }), 0);
  assert.equal(said.copy, null);
  assert.equal(said.lines[0], "The issues cannot be copied: There is no GitHub sign-in to use.");
  assert.equal(said.lines.length, 1 + ALWAYS);
});

test("another repository than the git remote's: no copy, and it says which is which", () => {
  const found = preview({ createIds: ["t-1"], repository: "Owner/Name" });
  // The same one, however it is written.
  assert.equal(switchWords("github", found, 0, "owner/name").copy, "Copy 1 issue and switch");
  assert.equal(switchWords("github", found, 0, "  ").copy, "Copy 1 issue and switch");
  const other = switchWords("github", found, 0, "other/place");
  assert.equal(other.copy, null);
  assert.equal(
    other.lines[0],
    "The issues cannot be copied: copying works with the repository of this folder's git remote (Owner/Name), not with other/place.",
  );
});

test("while it is being worked out, changes that wait, and more issues than were read", () => {
  const waiting = switchWords("beads", null, 2);
  assert.equal(waiting.copy, null);
  assert.deepEqual(waiting.lines.slice(0, 2), [
    "Working out what would be copied…",
    "2 changes made here still wait to be sent. Refresh first to send them.",
  ]);
  assert.match(switchWords("beads", preview(), 1).lines.join("\n"), /1 change made here still waits to be sent\. Refresh first to send it\./u);
  assert.ok(
    switchWords("github", preview({ createIds: ["t-1"], truncated: true }), 0).lines.includes(
      "GitHub has more issues than were read; the numbers are at least these.",
    ),
  );
});
