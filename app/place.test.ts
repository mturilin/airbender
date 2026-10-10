// app/place.test.ts — tests for where an issue's work belongs (place.ts).
//
// What: checks that an issue of an epic with a branch is told apart from
// any other, in a folder on that branch and in one that is not.
// Why: this decides which buttons an issue shows (bead-bb-ty5.2).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, IssuesResult } from "../server/contract.ts";
import { standardWorkflow } from "../shared/standard-workflow.ts";
import { placesIn } from "./place.ts";

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
    step: null,
    size: null,
    branch: null,
    conversationId: null,
    status: "open",
    priority: 2,
    type: "task",
    assignee: null,
    category: null,
    labels: [],
    updatedAt: null,
    createdAt: null,
    externalRef: null,
    blockedBy: [],
    subIssuesBlocked: false,
    blocks: [],
    links: [],
    ...over,
  };
}

/** The list answer for a folder on `branch`. */
function listed(branch: string | null, issues: Issue[]): IssuesResult {
  return {
    state: "ok",
    path: "/repo",
    home: "/home/someone",
    message: null,
    issues,
    currentBeadId: null,
    ownBranch: branch !== null && branch !== "main",
    branch,
    workTree: false,
    autopilot: null,
    workflow: "standard",
  };
}

const issues = [
  issue("e", { step: "on-branch", branch: "e-kanban" }),
  issue("e.1", { parentId: "e" }),
  issue("e.2", { parentId: "e", status: "closed" }),
  issue("other"),
  issue("done", {}),
  issue("done.1", { parentId: "done", status: "closed" }),
];

test("on the epic's branch its issues are only committed, and get no place of their own", () => {
  const place = placesIn(standardWorkflow, listed("e-kanban", issues));
  assert.deepEqual(place(issues[1]!).context, {
    ownBranch: true,
    inEpic: true,
    inEpicBranch: true,
  });
  assert.equal(place(issues[1]!).elsewhere, null);
  // An issue outside the epic, in the same folder, is as before.
  assert.deepEqual(place(issues[3]!).context, { ownBranch: true });
});

test("in any other folder the epic's issues say where they are worked", () => {
  const place = placesIn(standardWorkflow, listed("main", issues));
  const there = place(issues[1]!);
  assert.equal(there.context.inEpic, true);
  assert.equal(there.context.inEpicBranch, false);
  assert.match(there.elsewhere ?? "", /epic e: worked on the branch e-kanban/u);
  assert.equal(place(issues[3]!).elsewhere, null);
  // A work tree epic whose branch is not known yet.
  const fresh = [issue("t", { step: "on-branch" }), issue("t.1", { parentId: "t" })];
  assert.match(
    placesIn(standardWorkflow, listed("main", fresh))(fresh[1]!).elsewhere ?? "",
    /still being set up/u,
  );
});

test("an issue counts as having sub-issues only while one under it is open", () => {
  const place = placesIn(standardWorkflow, listed("main", issues));
  assert.equal(place(issues[0]!).hasSubIssues, true);
  assert.equal(place(issues[4]!).hasSubIssues, false);
  assert.equal(place(issues[3]!).hasSubIssues, false);
});

test("the simple workflow knows none of it", () => {
  const place = placesIn(null, listed("main", issues));
  assert.deepEqual(place(issues[1]!), {
    context: { ownBranch: false },
    hasSubIssues: false,
    elsewhere: null,
  });
});
