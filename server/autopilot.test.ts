// server/autopilot.test.ts — tests for which issue autopilot starts next.
//
// What: checks the picker (nextIssue): the order, what is passed over, and
// the two ways a run ends.
// Why: the order and the "never start what is blocked or worked on
// elsewhere" rule are what the owner relies on when leaving an epic to
// autopilot (bead-bb-8ff). The loop around the picker needs BB and is
// checked by running it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextIssue } from "./autopilot.ts";
import type { PickIssue } from "./autopilot.ts";

/** A sub-issue of the epic "e" with unremarkable values, changed by `over`. */
function sub(id: string, over: Partial<PickIssue> = {}): PickIssue {
  return {
    id,
    parentId: "e",
    status: "open",
    priority: 2,
    createdAt: "2026-10-01T00:00:00Z",
    blockedBy: [],
    subIssuesBlocked: false,
    ...over,
  };
}

const NONE = new Set<string>();

test("the most urgent ready issue is next; among equals, the oldest", () => {
  const issues = [
    sub("late", { createdAt: "2026-10-03T00:00:00Z" }),
    sub("early", { createdAt: "2026-10-02T00:00:00Z" }),
    sub("urgent", { priority: 0, createdAt: "2026-10-05T00:00:00Z" }),
  ];
  assert.deepEqual(nextIssue(issues, "e", NONE), { kind: "next", id: "urgent" });
  assert.deepEqual(nextIssue(issues.slice(0, 2), "e", NONE), {
    kind: "next",
    id: "early",
  });
  // No priority counts as the least urgent; the same moment falls back on the id.
  assert.deepEqual(
    nextIssue([sub("b", { priority: null }), sub("a", { priority: null })], "e", NONE),
    { kind: "next", id: "a" },
  );
});

test("only the epic's own open sub-issues are looked at", () => {
  const issues = [
    sub("closed", { status: "closed", priority: 0 }),
    sub("elsewhere", { parentId: "other", priority: 0 }),
    sub("deeper", { parentId: "mine", priority: 0 }),
    sub("mine"),
  ];
  assert.deepEqual(nextIssue(issues, "e", NONE), { kind: "next", id: "mine" });
});

test("an issue in Someday is never started, and is not left to do (bead-bb-26g)", () => {
  assert.deepEqual(
    nextIssue([sub("later", { status: "deferred", priority: 0 }), sub("now", { priority: 3 })], "e", NONE),
    { kind: "next", id: "now" },
  );
  assert.deepEqual(nextIssue([sub("later", { status: "deferred" })], "e", NONE), {
    kind: "finished",
  });
});

test("blocked issues, and ones being worked on in another conversation, are passed over", () => {
  const issues = [
    sub("blocked", { priority: 0, blockedBy: [{ id: "x", title: "X" }] }),
    sub("all-subs-blocked", { priority: 0, subIssuesBlocked: true }),
    sub("held", { priority: 0 }),
    sub("free", { priority: 3 }),
  ];
  assert.deepEqual(nextIssue(issues, "e", new Set(["held"])), {
    kind: "next",
    id: "free",
  });
});

test("the run ends when nothing is open, and when nothing open can be started", () => {
  assert.deepEqual(nextIssue([sub("a", { status: "closed" })], "e", NONE), {
    kind: "finished",
  });
  assert.deepEqual(nextIssue([], "e", NONE), { kind: "finished" });
  assert.deepEqual(
    nextIssue(
      [sub("a", { blockedBy: [{ id: "x", title: "X" }] }), sub("b")],
      "e",
      new Set(["b"]),
    ),
    { kind: "none", left: 2 },
  );
});
