// tracker/beads.test.ts — tests for the beads adapter's pure parts.
//
// What: checks turning beads' rows into the common issue shape (links from
// both ends, sub-issues, what blocks what, where the parts are kept) and
// putting bd's refusals into bend's words.
//
// Why: every read goes through toIssues. The commands themselves are tested
// against a real beads folder in bend/main.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { descendantIds, explain, toIssues, type BdRow } from "./beads.ts";

/** A row as `bd list --json` gives it. */
function row(id: string, over: Partial<BdRow> = {}): BdRow {
  return { id, title: id.toUpperCase(), status: "open", ...over };
}
const dep = (to: string, type: string) => ({ depends_on_id: to, type });
const find = (rows: BdRow[], id: string) =>
  toIssues(rows).find((issue) => issue.id === id)!;

test("beads' fields land in the common parts", () => {
  const issue = find(
    [
      row("a", {
        description:
          "Wanted.\n\n<!-- bend:requirements -->\n## Requirements\n\nR1\n<!-- /bend:requirements -->",
        acceptance_criteria: "Done when…",
        design: "The plan",
        notes: "A note",
        issue_type: "bug",
        priority: 1,
        assignee: "sam",
        labels: ["category:ux", "urgent"],
        comment_count: 2,
      }),
    ],
    "a",
  );
  assert.equal(issue.description, "Wanted.");
  assert.equal(issue.requirements, "R1");
  assert.equal(issue.done, "Done when…");
  assert.equal(issue.plan, "The plan");
  assert.equal(issue.notes, "A note");
  assert.equal(issue.category, "ux");
  assert.deepEqual(issue.labels, ["urgent"]);
  assert.deepEqual([issue.type, issue.priority, issue.assignee, issue.commentCount], ["bug", 1, "sam", 2]);
});

test("a blocking link shows from both ends under the common name", () => {
  const rows = [row("a", { dependencies: [dep("b", "blocks")] }), row("b")];
  assert.deepEqual(
    find(rows, "a").links.map((link) => [link.kind, link.direction, link.id]),
    [["blocked-by", "out", "b"]],
  );
  assert.deepEqual(
    find(rows, "b").links.map((link) => [link.kind, link.direction, link.id]),
    [["blocked-by", "in", "a"]],
  );
  assert.deepEqual(find(rows, "a").blockedBy.map((ref) => ref.id), ["b"]);
});

test("a closed blocker no longer blocks, but the link is still shown", () => {
  const issue = find(
    [row("a", { dependencies: [dep("b", "blocks")] }), row("b", { status: "closed" })],
    "a",
  );
  assert.deepEqual(issue.blockedBy, []);
  assert.equal(issue.links[0]!.status, "closed");
});

test("a related link shows once per issue, whichever way beads stored it", () => {
  const both = [
    row("a", { dependencies: [dep("b", "relates-to")] }),
    row("b", { dependencies: [dep("a", "relates-to")] }),
  ];
  const oneWay = [row("a", { dependencies: [dep("b", "relates-to")] }), row("b")];
  for (const rows of [both, oneWay]) {
    for (const id of ["a", "b"]) {
      assert.deepEqual(
        find(rows, id).links.map((link) => [link.kind, link.direction]),
        [["related", "out"]],
      );
    }
  }
});

test("sub-issues are listed on the parent, and are not links", () => {
  const rows = [
    row("p"),
    row("c", { parent: "p", dependencies: [dep("p", "parent-child")] }),
  ];
  assert.deepEqual(find(rows, "p").subIssues.map((ref) => ref.id), ["c"]);
  assert.equal(find(rows, "c").parentId, "p");
  assert.deepEqual(find(rows, "c").links, []);
});

test("a sub-issue of a blocked issue is blocked too; a parent loop is not followed", () => {
  const rows = [
    row("x"),
    row("p", { dependencies: [dep("x", "blocks")] }),
    row("c", { parent: "p" }),
    row("g", { parent: "c" }),
  ];
  assert.deepEqual(find(rows, "g").blockedBy.map((ref) => ref.id), ["x"]);
  const loop = [row("a", { parent: "b" }), row("b", { parent: "a" })];
  assert.deepEqual(find(loop, "a").blockedBy, []);
});

test("a link to an issue outside the list is left out; an unknown kind is shown as it is", () => {
  const rows = [
    row("a", { dependencies: [dep("gone", "blocks"), dep("b", "supersedes")] }),
    row("b"),
  ];
  assert.deepEqual(
    find(rows, "a").links.map((link) => [link.kind, link.id]),
    [["supersedes", "b"]],
  );
});

test("descendantIds finds every level and survives a loop", () => {
  const rows = [row("p"), row("c", { parent: "p" }), row("g", { parent: "c" }), row("o")];
  assert.deepEqual([...descendantIds("p", rows)].sort(), ["c", "g"]);
  assert.deepEqual(
    [...descendantIds("a", [row("a", { parent: "b" }), row("b", { parent: "a" })])],
    ["b"],
  );
});

test("bd's refusals are put into bend's words", () => {
  assert.equal(
    explain("cannot close t-1: 2 open child issue(s); close children first or use --force to override"),
    "cannot close t-1: 2 open child issue(s); close them first",
  );
  assert.match(
    explain('cannot close t-1: assignee is "sam", actor is "kim"; reclaim or use --force to override'),
    /assigned to sam, and you are acting as kim/u,
  );
  assert.match(explain("Error updating t-1: adding dependency would create a cycle"), /make a loop/u);
  assert.equal(explain("Error: no such thing\nUsage:\n  bd …"), "no such thing");
});
