// app/issue-model.test.ts — tests for how the tab reads the issue list.
//
// What: checks the status groups (toSections), the blocked rule (isBlocked),
// the sub-groups of Ready (toSubGroups), the order of rows (byUrgency), the
// pickers' search ranking (fuzzyScore), when epic mode may be entered or
// kept (focusBlock) and a few small helpers.
//
// Why: these decide where every issue appears. They are pure, so they are
// tested here without BB or a browser.
//
// Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue } from "../server/contract.ts";
import {
  buildTree,
  byUrgency,
  descendantIdsOf,
  finishedEpicSize,
  focusAfter,
  focusBlock,
  fuzzyScore,
  isBlocked,
  isLongDescription,
  linkWords,
  matchesFilters,
  NO_FILTERS,
  pathTo,
  shortPath,
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
    unsent: 0,
    parentId: null,
    step: null,
    size: null,
    branch: null,
    conversationId: null,
    createdAt: null,
    externalRef: null,
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
      issue("custom", { status: "review" }),
      issue("stuck", { blockedBy: [{ id: "x", title: "x" }] }),
    ]),
    "in_progress:doing ready:ready blocked:stuck someday:later other:custom closed:done",
  );
});

test("an issue in Someday stays there even when it waits on something (bead-bb-26g)", () => {
  assert.equal(
    grouped([issue("a", { status: "deferred", blockedBy: [{ id: "x", title: "x" }] })]),
    "someday:a",
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

const FAMILY = [
  issue("epic"),
  issue("open-child", { parentId: "epic", priority: 3 }),
  issue("urgent-child", { parentId: "epic", priority: 0 }),
  issue("done-child", { parentId: "epic", status: "closed", priority: 0 }),
  issue("grandchild", { parentId: "open-child" }),
  issue("orphan", { parentId: "not-in-the-list" }),
  issue("closed-epic", { status: "closed" }),
  issue("still-open", { parentId: "closed-epic" }),
];
const ids = (list: Issue[] | undefined) => (list ?? []).map((i) => i.id);

test("sub-issues are drawn under their parent: open first by urgency, closed last", () => {
  const tree = buildTree(FAMILY, null);
  assert.deepEqual(ids(tree.children.get("epic")), [
    "urgent-child",
    "open-child",
    "done-child",
  ]);
  assert.deepEqual(ids(tree.children.get("open-child")), ["grandchild"]);
});

test("the top level holds what is not drawn under a parent", () => {
  const tree = buildTree(FAMILY, null);
  // An issue whose parent is missing, and an open issue under a closed
  // parent (it would be hidden in the folded Closed group), stay on top.
  assert.deepEqual(ids(tree.topLevel), [
    "epic",
    "orphan",
    "closed-epic",
    "still-open",
  ]);
});

test("the current issue is in neither place: it has its own group", () => {
  const tree = buildTree(FAMILY, "open-child");
  assert.deepEqual(ids(tree.children.get("epic")), ["urgent-child", "done-child"]);
  assert.ok(!ids(tree.topLevel).includes("open-child"));
  // Its own sub-issues still hang under it.
  assert.deepEqual(ids(tree.children.get("open-child")), ["grandchild"]);
});

test("descendantIdsOf finds every level and survives a loop", () => {
  const tree = buildTree(FAMILY, null);
  assert.deepEqual(
    [...descendantIdsOf(tree.byId, "epic")].sort(),
    ["done-child", "grandchild", "open-child", "urgent-child"],
  );
  const loop = buildTree(
    [issue("a", { parentId: "b" }), issue("b", { parentId: "a" })],
    null,
  );
  assert.deepEqual([...descendantIdsOf(loop.byId, "a")], ["b"]);
});

test("pathTo runs from the top level down to the issue", () => {
  const tree = buildTree(FAMILY, null);
  assert.deepEqual(ids(pathTo(tree.byId, tree.byId.get("grandchild")!)), [
    "epic",
    "open-child",
    "grandchild",
  ]);
  assert.deepEqual(pathTo(tree.byId, null), []);
});

test("the filter lets everything through until something is ticked", () => {
  const bug = issue("x", { type: "bug", priority: 1, category: null });
  assert.equal(matchesFilters(bug, NO_FILTERS), true);
  assert.equal(matchesFilters(bug, { ...NO_FILTERS, types: ["task"] }), false);
  assert.equal(matchesFilters(bug, { ...NO_FILTERS, types: ["bug"], priorities: [1] }), true);
  assert.equal(matchesFilters(bug, { ...NO_FILTERS, priorities: [0] }), false);
  // "" among the categories stands for "no category".
  assert.equal(matchesFilters(bug, { ...NO_FILTERS, categories: [""] }), true);
  assert.equal(matchesFilters(bug, { ...NO_FILTERS, categories: ["ux"] }), false);
});

// An epic two levels deep, another epic beside it, and a closed one.
const EPICS = new Map(
  [
    issue("epic"),
    issue("child", { parentId: "epic" }),
    issue("grandchild", { parentId: "child" }),
    issue("other"),
    issue("other-child", { parentId: "other" }),
    issue("done", { status: "closed" }),
  ].map((entry) => [entry.id, entry]),
);

test("epic mode may be entered with no current issue, the epic, or one from inside it", () => {
  assert.equal(focusBlock(EPICS, "epic", null), null);
  assert.equal(focusBlock(EPICS, "epic", "epic"), null);
  assert.equal(focusBlock(EPICS, "epic", "child"), null);
  // At any depth.
  assert.equal(focusBlock(EPICS, "epic", "grandchild"), null);
  // One level at a time: a sub-issue with sub-issues is an epic too.
  assert.equal(focusBlock(EPICS, "child", "grandchild"), null);
});

test("epic mode is refused, with the reason, while the current issue is from outside", () => {
  for (const outside of ["other", "other-child"]) {
    const reason = focusBlock(EPICS, "epic", outside);
    assert.match(reason ?? "", /^You can only enter epic mode when/u);
  }
  // The epic's own parent is outside the deeper epic.
  assert.match(focusBlock(EPICS, "child", "epic") ?? "", /only enter epic mode/u);
  // An id that is not in the list at all is outside as well.
  assert.match(focusBlock(EPICS, "epic", "gone") ?? "", /only enter epic mode/u);
});

test("a closed or missing epic cannot be zoomed in on, whatever is current", () => {
  assert.match(focusBlock(EPICS, "done", null) ?? "", /is closed/u);
  assert.match(focusBlock(EPICS, "nowhere", null) ?? "", /no longer in the list/u);
});

test("an epic is finished when everything under it, at any depth, is closed", () => {
  const family = (grandchild: string, child = "closed") =>
    new Map(
      [
        issue("epic"),
        issue("child", { parentId: "epic", status: child }),
        issue("grandchild", { parentId: "child", status: grandchild }),
        issue("other"),
      ].map((entry) => [entry.id, entry]),
    );
  // Both levels closed: finished, and it has two issues under it.
  assert.equal(finishedEpicSize(family("closed"), "epic"), 2);
  // One open issue anywhere under it: not finished.
  assert.equal(finishedEpicSize(family("open"), "epic"), 0);
  assert.equal(finishedEpicSize(family("closed", "in_progress"), "epic"), 0);
  // Nothing under it: an issue, not a finished epic.
  assert.equal(finishedEpicSize(family("closed"), "other"), 0);
  // Already closed, or not there: nothing to offer.
  const closed = family("closed");
  closed.set("epic", issue("epic", { status: "closed" }));
  assert.equal(finishedEpicSize(closed, "epic"), 0);
  assert.equal(finishedEpicSize(family("closed"), "nowhere"), 0);
});

test("leaving an epic remembers it; entering one, or dismissing, forgets", () => {
  const none = { focus: null, last: null };
  // In, then out: the way back is remembered.
  const inside = focusAfter(none, { enter: "epic" });
  assert.deepEqual(inside, { focus: "epic", last: null });
  const out = focusAfter(inside, "leave");
  assert.deepEqual(out, { focus: null, last: "epic" });
  // Leaving again from the whole list keeps it.
  assert.deepEqual(focusAfter(out, "leave"), out);
  // Going back in: nothing is offered while inside.
  assert.deepEqual(focusAfter(out, { enter: "epic" }), inside);
  // Another epic entered and left becomes the one to go back to.
  const other = focusAfter(focusAfter(out, { enter: "other" }), "leave");
  assert.deepEqual(other, { focus: null, last: "other" });
  // Up one level is entering the parent: still epic mode, nothing offered.
  assert.deepEqual(focusAfter({ focus: "child", last: null }, { enter: "epic" }), inside);
  // The cross forgets the offer and nothing else.
  assert.deepEqual(focusAfter(out, "forget"), none);
  assert.deepEqual(focusAfter({ focus: "epic", last: "x" }, "forget"), inside);
});

test("a path inside the home folder is shown with a tilde", () => {
  assert.equal(shortPath("/home/me/Development/x", "/home/me"), "~/Development/x");
  assert.equal(shortPath("/home/me", "/home/me/"), "~");
  // Only the folder itself, not one whose name merely starts the same.
  assert.equal(shortPath("/home/melanie/x", "/home/me"), "/home/melanie/x");
  assert.equal(shortPath("/srv/x", "/home/me"), "/srv/x");
  assert.equal(shortPath("/srv/x", ""), "/srv/x");
});
