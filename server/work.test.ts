// work.test.ts — Start delivery and non-cascading close regressions.
// Boundaries are injected; no messages, real issues or Git state are changed.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork } from "./work.ts";
import { standardWorkflow } from "../shared/standard-workflow.ts";
import type { Issue } from "./contract.ts";
import type { ClosingOptions } from "../shared/closing.ts";
import { localFolder } from "./machine.ts";

/** Supplies only the boundaries used by these actions, retaining their writes. */
function fixture(simple = true) {
  const issue = { id: "issue-1", title: "Work", status: "open", step: "commit", parentId: null, branch: null, size: "l" } as Issue;
  const issues = [issue], sent: string[] = [], closed: ClosingOptions[] = [];
  let current: string | null = issue.id;
  const work = createWork({
    bb: { sdk: { threads: { send: async ({ input }: { input: { text: string }[] }) => { sent.push(input[0]!.text); } } } },
    store: {
      issuesIn: async () => ({ folder: localFolder("/no-repo"), path: "/no-repo", issues }),
      setIssueOpen: async (_: unknown, input: { closing: ClosingOptions }) => { closed.push(input.closing); return { message: null }; },
      changed: () => {}, addComment: async () => {},
    },
    currentBead: { read: async () => current, write: async (_: string, id: string | null) => { current = id; } },
    workflowChoice: { workflowFor: () => simple ? null : standardWorkflow },
    workTrees: { isOurs: () => false, landed: () => {} },
    onUserSize: () => {}, hasUncommittedChanges: async () => false, currentBranch: async () => "main",
  } as unknown as Parameters<typeof createWork>[0]);
  return { work, issue, issues, sent, closed };
}

test("Simple Start sends actual work even when this issue is already current", async () => {
  const f = fixture();
  assert.equal((await f.work.startSimple({ threadId: "working", beadId: f.issue.id })).message, null);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!, /Work on issue issue-1/);
  assert.match(f.sent[0]!, /mark it in progress/);
  assert.doesNotMatch(f.sent[0]!, /No action is needed/);
});

test("Standard close records cancellation and refuses every open descendant", async () => {
  const f = fixture(false);
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
  const f = fixture(false);
  assert.equal((await f.work.move({ threadId: "working", projectId: null, beadId: f.issue.id, moveId: "done", note: "No files changed" }, "agent")).message, null);
  assert.deepEqual(f.closed, [{ ending: "done", commit: undefined }]);
});
