import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { standardWorkflow } from "../shared/standard-workflow.ts";
import type { Issue } from "./contract.ts";
import type { ClosingOptions } from "../shared/closing.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Store } from "./store.ts";
import { createWork } from "./work.ts";
import { createWorkTrees } from "./work-trees.ts";
import type { WorkflowChoice } from "./workflow-choice.ts";

async function fixture(
  message: string | null,
  duringVerification?: (issue: Issue) => void,
  recheckMessage: string | null = null,
) {
  const effects: string[] = [];
  const closed: ClosingOptions[] = [];
  const issue = {
    id: "x-1", title: "A change", step: "commit-merge", status: "open",
    branch: "feature", parentId: null, size: "s",
  } as Issue;
  const bb = {
    storage: { kv: {
      get: async () => ({ thread: { beadId: "x-1", home: "/checkout" } }),
      set: async () => { effects.push("save-worktrees"); },
    } },
    sdk: {
      threads: { archive: async () => { effects.push("archive"); } },
      environments: { delete: async () => { effects.push("delete-tree"); } },
    },
  } as unknown as BbPluginApi;
  const workTrees = await createWorkTrees({
    bb, mainBranch: async () => "trunk", mainFolder: async () => "/checkout",
  });
  const work = createWork({
    bb,
    store: {
      issuesIn: async () => ({ path: "/checkout", issues: [{ ...issue }] }),
      readIssues: async () => ({ state: "ok", issues: [{ ...issue }] }),
      setIssueOpen: async (_command: string, input: { closing: ClosingOptions }) => {
        closed.push(input.closing);
        effects.push("close");
        return { message: null };
      },
      setBranch: async () => { effects.push("release-branch-record"); return { message: null }; },
      addComment: async () => { effects.push("comment"); return { message: null }; },
      changed: () => { effects.push("changed"); },
    } as unknown as Store,
    currentBead: {} as CurrentBead,
    workflowChoice: { workflowFor: () => standardWorkflow } as unknown as WorkflowChoice,
    onUserSize: () => { effects.push("user-size"); },
    hasUncommittedChanges: async () => false,
    currentBranch: async () => "feature",
    workTrees,
    verifyMergedPullRequest: async () => {
      duringVerification?.(issue);
      return message === null ? { message: null, commit: "a".repeat(40), recheck: async () => recheckMessage } : { message };
    },
    events: { closed: () => { effects.push("closed-event"); } },
  });
  return { work, effects, workTrees, closed };
}

const input = {
  threadId: "thread", projectId: null, beadId: "x-1", moveId: "done", note: "PR opened",
};

test("pending or unknown PR evidence leaves the issue, conversation and worktree intact", async () => {
  for (const message of ["PR is open", "merge queue pending", "unknown", "authentication failed"]) {
    for (const by of ["agent", "user"] as const) {
      const { work, effects, workTrees } = await fixture(message);
      const result = await work.move(input, by);
      assert.equal(result.message, message);
      assert.deepEqual(effects, []);
      assert.equal(result.state?.id, "commit-merge");
      assert.equal(workTrees.threadFor("x-1"), "thread");
      assert.equal(workTrees.isOurs("thread"), true);
    }
  }
});

test("verified merged delivery closes the issue without archiving or deleting its worktree", async () => {
  const { work, effects, workTrees, closed } = await fixture(null);
  assert.equal((await work.move(input, "agent")).message, null);
  assert.deepEqual(effects, ["close", "changed", "comment", "release-branch-record", "closed-event"]);
  assert.deepEqual(closed, [{ ending: "done", commit: "a".repeat(40) }]);
  assert.equal(workTrees.threadFor("x-1"), "thread");
  assert.equal(workTrees.isOurs("thread"), true);
});

test("verified squash or rebase delivery records source evidence without imposing commit-only message rules", async () => {
  const { work, closed } = await fixture(null);
  const result = await work.move({ ...input, note: `Merged PR using squash commit ${"f".repeat(40)}` }, "agent");
  assert.equal(result.message, null);
  assert.deepEqual(closed, [{ ending: "done", commit: "a".repeat(40) }]);
});

test("a workflow change during PR verification prevents stale completion", async () => {
  const { work, effects } = await fixture(null, (issue) => { issue.step = "implement"; });
  const result = await work.move(input, "agent");
  assert.equal(typeof result.message, "string");
  assert.deepEqual(effects, []);
});

test("retained worktree history directs reopened work to its newest conversation", async () => {
  const workTrees = await createWorkTrees({
    bb: {
      storage: { kv: { get: async () => ({
        oldThread: { beadId: "x-1", home: "/checkout" },
        newThread: { beadId: "x-1", home: "/checkout" },
      }) } },
    } as unknown as BbPluginApi,
    mainBranch: async () => "trunk",
    mainFolder: async () => "/checkout",
  });
  assert.equal(workTrees.threadFor("x-1"), "newThread");
  assert.equal(workTrees.isOurs("oldThread"), true);
});

test("checkout changes during tracker reread prevent completion", async () => {
  const { work, effects } = await fixture(null, undefined, "HEAD changed during tracker reread");
  assert.equal((await work.move(input, "agent")).message, "HEAD changed during tracker reread");
  assert.deepEqual(effects, []);
});

/** Supplies only the boundaries used by these actions, retaining their writes. */
function simpleFixture(simple = true) {
  const issue = { id: "issue-1", title: "Work", status: "open", step: "commit", parentId: null, branch: null, size: "l" } as Issue;
  const issues = [issue], sent: string[] = [], closed: ClosingOptions[] = [];
  let current: string | null = issue.id;
  const work = createWork({
    bb: { sdk: { threads: { send: async ({ input }: { input: { text: string }[] }) => { sent.push(input[0]!.text); } } } },
    store: {
      issuesIn: async () => ({ path: "/no-repo", issues }),
      setIssueOpen: async (_: unknown, input: { closing: ClosingOptions }) => { closed.push(input.closing); return { message: null }; },
      changed: () => {}, addComment: async () => {},
    },
    currentBead: { read: async () => current, write: async (_: string, id: string | null) => { current = id; } },
    workflowChoice: { workflowFor: () => simple ? null : standardWorkflow },
    workTrees: { isOurs: () => false },
    onUserSize: () => {}, hasUncommittedChanges: async () => false, currentBranch: async () => "main",
  } as unknown as Parameters<typeof createWork>[0]);
  return { work, issue, issues, sent, closed };
}

test("Simple Start sends actual work even when this issue is already current", async () => {
  const f = simpleFixture();
  assert.equal((await f.work.startSimple({ threadId: "working", beadId: f.issue.id })).message, null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /Work on issue issue-1/);
  assert.match(f.sent[0]!, /mark it in progress/);
  assert.doesNotMatch(f.sent[0]!, /No action is needed/);
});

test("Standard close records cancellation and refuses every open descendant", async () => {
  const f = simpleFixture(false);
  f.issues.push({ id: "child", parentId: f.issue.id, status: "open" } as Issue);
  const scope = { threadId: "working", projectId: null, beadId: f.issue.id };
  assert.match((await f.work.close(scope)).message!, /sub-issues/);
  assert.match((await f.work.move({ ...scope, moveId: "done", note: "No files changed" }, "agent")).message!, /sub-issues/);
  assert.equal(f.closed.length, 0);
  f.issues[1]!.status = "closed";
  assert.equal((await f.work.close(scope)).message, null);
  assert.deepEqual(f.closed, [{ ending: "cancelled" }]);
});

test("Standard finish without file changes records Done without a commit", async () => {
  const f = simpleFixture(false);
  assert.equal((await f.work.move({ threadId: "working", projectId: null, beadId: f.issue.id, moveId: "done", note: "No files changed" }, "agent")).message, null);
  assert.deepEqual(f.closed, [{ ending: "done", commit: undefined }]);
});
