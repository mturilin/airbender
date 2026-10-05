// app/issue-model.test.ts — tests for how the tab reads the issue list.
//
// What: checks the status groups (toSections), the blocked rule (isBlocked),
// the sub-groups of Ready (toSubGroups), the order of rows (byUrgency), the
// pickers' search ranking (fuzzyScore) and a few small helpers.
//
// Why: these decide where every issue appears. They are pure, so they are
// tested here without BB or a browser.
//
// Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../server/contract.ts";
import {
  byUrgency,
  fuzzyScore,
  isBlocked,
  isLongDescription,
  linkWords,
  toSections,
  toSubGroups,
  toggled,
} from "./issue-model.ts";

/** An issue with unremarkable values, changed by `over`. */
function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    title: id,
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    closeReason: "",
    commentCount: 0,
    parentId: null,
    defineThreadId: null,
    status: "open",
    priority: 2,
    type: "task",
    assignee: null,
    category: null,
    labels: [],
    updatedAt: "2026-10-01T00:00:00Z",
    blockedBy: [],
    blocks: [],
    subIssuesBlocked: false,
    links: [],
    ...over,
  };
}

/** "group:ids" for every group that has issues. */
function grouped(issues: Issue[]): string {
  return toSections(issues)
    .filter((section) => section.issues.length > 0)
    .map((section) => `${section.id}:${section.issues.map((i) => i.id).join(",")}`)
    .join(" ");
}

test("each issue lands in the group for what can be done about it", () => {
  assert.equal(
    grouped([
      issue("ready"),
      issue("doing", { status: "in_progress" }),
      issue("done", { status: "closed" }),
      issue("later", { status: "deferred" }),
      issue("stuck", { blockedBy: [{ id: "x", title: "x" }] }),
    ]),
    "in_progress:doing ready:ready blocked:stuck other:later closed:done",
  );
});

test("blocked wins over the issue's own status, but not over closed", () => {
  const blocker = [{ id: "x", title: "x" }];
  assert.equal(
    grouped([issue("a", { status: "in_progress", blockedBy: blocker })]),
    "blocked:a",
  );
  assert.equal(
    grouped([issue("a", { status: "closed", blockedBy: blocker })]),
    "closed:a",
  );
});

test("an issue whose sub-issues are all blocked is blocked", () => {
  assert.equal(isBlocked(issue("a", { subIssuesBlocked: true })), true);
  assert.equal(isBlocked(issue("a")), false);
  assert.equal(
    isBlocked(issue("a", { status: "closed", subIssuesBlocked: true })),
    false,
  );
});

test("rows are ordered most urgent first, then most recently changed", () => {
  const ordered = [
    issue("old-p2", { updatedAt: "2026-01-01T00:00:00Z" }),
    issue("none", { priority: null }),
    issue("p0", { priority: 0 }),
    issue("new-p2", { updatedAt: "2026-09-01T00:00:00Z" }),
  ]
    .sort(byUrgency)
    .map((i) => i.id);
  assert.deepEqual(ordered, ["p0", "new-p2", "old-p2", "none"]);
});

const SAMPLE = [
  issue("a", { priority: 2, type: "task", category: "ux" }),
  issue("b", { priority: 0, type: "bug", category: null }),
  issue("c", { priority: null, type: "zeta", category: "api" }),
  issue("d", { priority: 2, type: "epic", category: "ux" }),
  issue("e", { priority: 4, type: null, category: "api" }),
  issue("f", { priority: 1, type: "alpha", category: null }),
];
const subGroups = (groupBy: Parameters<typeof toSubGroups>[1]) =>
  toSubGroups(SAMPLE, groupBy).map((group) => [
    group.key,
    group.label,
    group.issues.map((i) => i.id).join(""),
  ]);

test("no grouping gives no sub-groups", () => {
  assert.deepEqual(subGroups("none"), []);
});

test("by priority: P0 to P4, 'No priority' last, empty ones left out", () => {
  assert.deepEqual(subGroups("priority"), [
    ["priority:0", "P0", "b"],
    ["priority:1", "P1", "f"],
    ["priority:2", "P2", "ad"],
    ["priority:4", "P4", "e"],
    ["priority:", "No priority", "c"],
  ]);
});

test("by type: the type dropdown's order, then others by name, 'No type' last", () => {
  assert.deepEqual(subGroups("type"), [
    ["type:task", "task", "a"],
    ["type:bug", "bug", "b"],
    ["type:epic", "epic", "d"],
    ["type:alpha", "alpha", "f"],
    ["type:zeta", "zeta", "c"],
    ["type:", "No type", "e"],
  ]);
});

test("by category: alphabetical, 'No category' last", () => {
  assert.deepEqual(subGroups("category"), [
    ["category:api", "api", "ce"],
    ["category:ux", "ux", "ad"],
    ["category:", "No category", "bf"],
  ]);
});

test("search ranks a whole match above scattered letters, and drops misses", () => {
  const score = (query: string) => fuzzyScore(query, "login page");
  assert.equal(fuzzyScore("", "anything"), 1);
  assert.ok(score("log") > score("page"), "earlier match ranks higher");
  assert.ok(score("page") > score("ogi"), "a word start ranks higher");
  assert.ok(score("ogi") > score("lgp"), "a whole match beats scattered letters");
  assert.ok(score("lgp") > 0);
  assert.equal(score("zzz"), 0);
});

test("small helpers", () => {
  assert.deepEqual(toggled([1, 2], 2), [1]);
  assert.deepEqual(toggled([1], 2), [1, 2]);
  assert.equal(linkWords("blocks"), "blocked by");
  assert.equal(linkWords("relates-to"), "related");
  assert.equal(linkWords("something-new"), "something-new");
  assert.equal(isLongDescription("short"), false);
  assert.equal(isLongDescription("x".repeat(300)), true);
  assert.equal(isLongDescription("a\nb\nc\nd\ne"), true);
});
