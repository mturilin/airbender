import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { standardWorkflow } from "../shared/standard-workflow.ts";
import type { Issue } from "./contract.ts";
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
      setIssueOpen: async () => { effects.push("close"); return { message: null }; },
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
      return message === null ? { message: null, recheck: async () => recheckMessage } : { message };
    },
    events: { closed: () => { effects.push("closed-event"); } },
  });
  return { work, effects, workTrees };
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
  const { work, effects, workTrees } = await fixture(null);
  assert.equal((await work.move(input, "agent")).message, null);
  assert.deepEqual(effects, ["close", "changed", "comment", "release-branch-record", "closed-event"]);
  assert.equal(workTrees.threadFor("x-1"), "thread");
  assert.equal(workTrees.isOurs("thread"), true);
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
