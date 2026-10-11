// server/issues.test.ts — tests for turning beads' rows into the tab's issues.
//
// What: checks the whole way from a row of beads to an issue the tab draws
// (who is blocked and why, links from both ends, what is kept in labels),
// and the shared descendantsOf walk.
//
// Design notes: the rows go through bend's beads adapter first
// (in bend, run for real with a stand-in for bd) and then through the tab's
// own step (server/issues.ts),
// as they do in the running tab. The expectations are the ones from before
// the tab was moved onto the core (bead-bb-c9l.2): they are what "the tab
// behaves as before" means for the rules below.
//
// Why: a wrong edge here silently regroups every issue in the tab, and the
// rules are easy to break: blocking passes down to sub-issues (beads' rule)
// and up to an issue whose open sub-issues are all blocked (the user's rule).
//
// Run with `npm test` (node's built-in test runner; no extra dependency).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test as nodeTest } from "node:test";
import { branchOf, toIssues as toTabIssues } from "./issues.ts";
import { descendantsOf } from "../shared/tree.ts";
import { builtBend } from "./bend-for-tests.ts";
import type { TrackerIssue } from "./bend.ts";

/** A row of beads, as the tests write it: what `bd list --json` prints. */
interface BdIssue {
  id: string;
  title: string;
  status: string;
  parent?: string | null;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  labels?: string[];
  metadata?: unknown;
  dependencies?: { depends_on_id: string; type: string }[];
}

const bend = builtBend();
/** Skipped where bend cannot be built (no Go on this machine). */
const test = bend === null ? nodeTest.skip : nodeTest;

// A folder that looks like a beads repository, and a stand-in for bd that
// prints the rows a test wrote, whatever it is asked.
const folder = mkdtempSync(join(tmpdir(), "airbender-issues-"));
mkdirSync(join(folder, ".beads"));
const rowsFile = join(folder, "rows.json");
const fakeBd = join(folder, "bd");
writeFileSync(fakeBd, `#!/bin/sh\ncat ${JSON.stringify(rowsFile)}\n`);
chmodSync(fakeBd, 0o755);
after(() => rmSync(folder, { recursive: true, force: true }));

/** Rows of beads as bend gives them: its beads adapter, for real. */
function fromRows(rows: BdIssue[]): TrackerIssue[] {
  writeFileSync(rowsFile, JSON.stringify(rows));
  return JSON.parse(
    execFileSync(
      bend!,
      ["-C", folder, "list", "--status", "all", "--with-body", "--json"],
      { env: { ...process.env, BEND_BD: fakeBd }, encoding: "utf8" },
    ),
  ) as TrackerIssue[];
}

/** Rows of beads to the tab's issues: bend, then the tab's step. */
const toIssues = (rows: BdIssue[]) => toTabIssues(fromRows(rows));

/** A row as `bd list --json` gives it; `blockers` become "blocks" links. */
function row(
  id: string,
  parent: string | null,
  status: string,
  blockers: string[] = [],
  extra: Partial<BdIssue> = {},
): BdIssue {
  return {
    id,
    title: id,
    status,
    parent,
    dependencies: blockers.map((blocker) => ({
      depends_on_id: blocker,
      type: "blocks",
    })),
    ...extra,
  };
}

/** "id:blockers[*]" per issue, where * marks "all sub-issues blocked". */
function blocking(rows: BdIssue[]): string {
  return toIssues(rows)
    .map(
      (issue) =>
        `${issue.id}:${issue.blockedBy.map((b) => b.id).join("+") || "-"}${issue.subIssuesBlocked ? "*" : ""}`,
    )
    .join(" ");
}

test("an open issue is blocked by an unfinished issue it depends on", () => {
  const issues = toIssues([row("X", null, "open"), row("A", null, "open", ["X"])]);
  const a = issues.find((issue) => issue.id === "A")!;
  const x = issues.find((issue) => issue.id === "X")!;
  assert.deepEqual(a.blockedBy, [{ id: "X", title: "X" }]);
  assert.deepEqual(x.blocks, [{ id: "A", title: "A" }]);
});

test("a closed blocker does not block, and a closed issue is never blocked", () => {
  assert.equal(
    blocking([row("X", null, "closed"), row("A", null, "open", ["X"])]),
    "X:- A:-",
  );
  assert.equal(
    blocking([row("X", null, "open"), row("A", null, "closed", ["X"])]),
    "X:- A:-",
  );
});

test("an issue whose open sub-issues are all blocked counts as blocked", () => {
  assert.equal(
    blocking([
      row("X", null, "open"),
      row("E", null, "open"),
      row("c1", "E", "open", ["X"]),
      row("c2", "E", "open", ["X"]),
    ]),
    "X:- E:-* c1:X c2:X",
  );
});

test("one workable sub-issue keeps its parent actionable", () => {
  assert.equal(
    blocking([
      row("X", null, "open"),
      row("E", null, "open"),
      row("c1", "E", "open", ["X"]),
      row("c2", "E", "open"),
    ]),
    "X:- E:- c1:X c2:-",
  );
});

test("closed sub-issues are ignored; all closed is not blocked", () => {
  assert.equal(
    blocking([
      row("X", null, "open"),
      row("E", null, "open"),
      row("c1", "E", "open", ["X"]),
      row("c2", "E", "closed"),
    ]),
    "X:- E:-* c1:X c2:-",
  );
  assert.equal(blocking([row("E", null, "open"), row("c1", "E", "closed")]), "E:- c1:-");
});

test("blocking passes down from a blocked issue to its sub-issues, at any depth", () => {
  assert.equal(
    blocking([
      row("X", null, "open"),
      row("E", null, "open", ["X"]),
      row("c1", "E", "open"),
      row("g", "c1", "open"),
    ]),
    "X:- E:X* c1:X* g:X",
  );
});

test("'all sub-issues blocked' works through several levels", () => {
  assert.equal(
    blocking([
      row("X", null, "open"),
      row("E", null, "open"),
      row("m", "E", "open"),
      row("g", "m", "open", ["X"]),
    ]),
    "X:- E:-* m:-* g:X",
  );
});

test("a loop in the parent data does not hang or block anything", () => {
  assert.equal(blocking([row("a", "b", "open"), row("b", "a", "open")]), "a:- b:-");
});

test("links are listed from both ends; parent-child is not a link", () => {
  const issues = toIssues([
    row("A", null, "open", [], {
      dependencies: [
        { depends_on_id: "B", type: "discovered-from" },
        { depends_on_id: "P", type: "parent-child" },
      ],
    }),
    row("B", null, "closed"),
    row("P", null, "open"),
  ]);
  const links = (id: string) =>
    issues.find((issue) => issue.id === id)!.links.map((link) => [
      link.direction,
      link.kind,
      link.id,
      link.closed,
    ]);
  assert.deepEqual(links("A"), [["out", "discovered-from", "B", true]]);
  assert.deepEqual(links("B"), [["in", "discovered-from", "A", false]]);
  assert.deepEqual(links("P"), []);
});

test("a two-way relates-to pair shows once on each issue", () => {
  const issues = toIssues([
    row("A", null, "open", [], {
      dependencies: [{ depends_on_id: "B", type: "relates-to" }],
    }),
    row("B", null, "open", [], {
      dependencies: [{ depends_on_id: "A", type: "relates-to" }],
    }),
  ]);
  for (const issue of issues) {
    assert.equal(issue.links.length, 1);
    assert.equal(issue.links[0]!.direction, "out");
  }
});

test("a link to an issue that is not in the list is left out", () => {
  const [a] = toIssues([
    row("A", null, "open", [], {
      dependencies: [{ depends_on_id: "gone", type: "related" }],
    }),
  ]);
  assert.deepEqual(a!.links, []);
});

test("the category comes from its label and is kept out of the labels", () => {
  const [a] = toIssues([
    row("A", null, "open", [], { labels: ["category:ux", "urgent"] }),
  ]);
  assert.equal(a!.category, "ux");
  assert.deepEqual(a!.labels, ["urgent"]);
  const [b, c] = toIssues([
    row("B", null, "open", [], { labels: ["urgent"] }),
    // Written with capitals by hand: still the same category.
    row("C", null, "open", [], { labels: ["category: UX "] }),
  ]);
  assert.equal(b!.category, null);
  assert.equal(c!.category, "ux");
});

test("the step and the size are read from their labels and kept out of the plain labels", () => {
  const [a] = toIssues([
    row("A", null, "open", [], { labels: ["step:plan", "size:m", "ui"] }),
  ]);
  assert.deepEqual([a!.step, a!.size, a!.labels], ["plan", "m", ["ui"]]);
});

test("the written parts keep the tab's names, and the description holds the requirements", () => {
  const text =
    "Wanted.\n\n<!-- bend:requirements -->\n## Requirements\n\nR1\n<!-- /bend:requirements -->";
  const [a, b] = toIssues([
    row("A", null, "open", [], {
      description: text,
      design: "The plan",
      acceptance_criteria: "Done when",
      notes: "A note",
    }),
    row("B", null, "open", [], { description: "Plain." }),
  ]);
  assert.equal(a!.description, text);
  assert.deepEqual([a!.design, a!.acceptance, a!.notes], ["The plan", "Done when", "A note"]);
  assert.equal(b!.description, "Plain.");
});

test("a blocking link is listed under the tab's name for it, from both ends", () => {
  const issues = toIssues([row("X", null, "open"), row("A", null, "open", ["X"])]);
  const links = (id: string) =>
    issues.find((issue) => issue.id === id)!.links.map((link) => [link.direction, link.kind, link.id]);
  assert.deepEqual(links("A"), [["out", "blocks", "X"]]);
  assert.deepEqual(links("X"), [["in", "blocks", "A"]]);
});

test("descendantsOf lists every level, parents before children", () => {
  const issues = toIssues([
    row("g", "c", "open"),
    row("c", "E", "open"),
    row("E", null, "open"),
    row("other", null, "open"),
  ]);
  assert.deepEqual(
    descendantsOf("E", issues).map((issue) => issue.id),
    ["c", "g"],
  );
});

test("an epic's branch is read from the issue's metadata, and from the label it used to be in", () => {
  assert.equal(branchOf({ branch: "x-1-kanban-board" }, []), "x-1-kanban-board");
  assert.equal(branchOf({ branch: " " }, []), null);
  assert.equal(branchOf({ branch: 3 }, []), null);
  assert.equal(branchOf(null, []), null);
  assert.equal(branchOf("text", []), null);
  // The old label is still read; metadata comes first.
  assert.equal(branchOf(undefined, ["step:on-branch", "branch:x-1-kanban-board"]), "x-1-kanban-board");
  assert.equal(branchOf({ branch: "new" }, ["branch:old"]), "new");
  assert.equal(branchOf(undefined, ["step:plan"]), null);
  assert.equal(branchOf(undefined, ["branch: "]), null);
  const [epic, old] = toIssues([
    row("x-1", null, "open", [], { metadata: { branch: "x-1-kanban-board" }, labels: ["ui"] }),
    row("x-2", null, "open", [], { labels: ["branch:x-2-old", "ui"] }),
  ]);
  assert.equal(epic!.branch, "x-1-kanban-board");
  assert.deepEqual(epic!.labels, ["ui"]);
  // The old label is still kept out of the plain labels.
  assert.equal(old!.branch, "x-2-old");
  assert.deepEqual(old!.labels, ["ui"]);
});
