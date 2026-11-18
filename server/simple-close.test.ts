// simple-close.test.ts — protocol tests with injected persistence, delivery,
// tracker and Git boundaries. No real messages, commits or issues are made.
import test from "node:test";
import assert from "node:assert/strict";
import { createSimpleClose } from "./simple-close.ts";
import type { CloseContext, CloseGitState, SimpleCloseDependencies } from "./simple-close.ts";
import type { Issue } from "./contract.ts";
import type { ClosingOptions } from "../shared/closing.ts";

const sha = "a".repeat(40);
const scope = { threadId: "working", projectId: "project", beadId: "issue-1" };
const choice = { ...scope, ending: "done" as const, git: "commit" as const, duplicateOf: null };

/** Makes a minimal issue used only by the protocol's tree/identity checks. */
function issue(id = "issue-1", parentId: string | null = null): Issue {
  return { id, parentId, title: "The work", status: "open" } as Issue;
}

/** Gives a reusable database so a new service instance simulates a reload. */
function fixture() {
  const db = new Map<string, unknown>();
  const context: CloseContext = { path: "/repo", repository: "/repo", projectId: "project", issue: issue(), issues: [], simple: true };
  context.issues = [context.issue];
  const state: CloseGitState = { repository: "/repo", branch: "main", head: "b".repeat(40), changes: true };
  const sent: string[] = [], closed: ClosingOptions[] = [], released: string[] = [];
  const deps: SimpleCloseDependencies = {
    load: async () => context,
    working: async () => ({ threadId: "working", path: "/repo" }),
    git: async () => state,
    verify: async () => null,
    send: async (_, text) => { sent.push(text); },
    close: async (_, options) => { closed.push(options); context.issue.status = "closed"; return { message: null }; },
    get: async (key) => structuredClone(db.get(key)),
    set: async (key, value) => { db.set(key, structuredClone(value)); },
    released: async (thread) => { released.push(thread); },
    id: () => "request-1",
  };
  return { db, context, state, sent, closed, released, deps, service: createSimpleClose(deps) };
}

test("a preview changes nothing and open descendants prevent every close", async () => {
  const f = fixture();
  assert.equal((await f.service.preview(scope)).changes, true);
  assert.equal(f.db.size, 0); assert.equal(f.sent.length, 0);
  f.context.issues.push(issue("child", "issue-1"));
  assert.match((await f.service.preview(scope)).blocked!, /sub-issues/);
  assert.match((await f.service.request({ ...choice, git: "none" })).message!, /sub-issues/);
  assert.equal(f.closed.length, 0); assert.equal(f.sent.length, 0);
});

test("no conversation permits only a direct no-commit close", async () => {
  const f = fixture(); f.deps.working = async () => ({ reason: "No working conversation" });
  assert.match((await f.service.request(choice)).message!, /No working/);
  assert.equal(f.closed.length, 0);
  assert.equal((await f.service.request({ ...choice, git: "none", ending: "verified" })).message, null);
  assert.deepEqual(f.closed, [{ ending: "verified", duplicateOf: undefined }]);
});

test("a conversation lookup failure explains why commits are unavailable without blocking a direct close", async () => {
  const f = fixture();
  f.deps.working = async () => { throw new Error("BB is unavailable"); };
  const preview = await f.service.preview(scope);
  assert.equal(preview.message, null);
  assert.match(preview.unavailableReason!, /BB is unavailable/);
  assert.match((await f.service.request(choice)).message!, /BB is unavailable/);
  assert.equal(f.closed.length, 0);
  assert.equal((await f.service.request({ ...choice, git: "none" })).message, null);
  assert.equal(f.closed.length, 1);
});

test("a persistence failure after closing retries with the identical close request", async () => {
  const f = fixture(); await f.service.request(choice);
  const persist = f.deps.set;
  let fail = true;
  f.deps.set = async (key, value) => {
    if (fail && key.includes("request:") && (value as { completed?: string }).completed === sha) throw new Error("storage unavailable");
    return persist(key, value);
  };
  assert.match((await f.service.complete("request-1", sha, "working")).message!, /storage unavailable/);
  fail = false;
  assert.equal((await f.service.complete("request-1", sha, "working")).message, null);
  assert.deepEqual(f.closed[0], f.closed[1]);
  assert.deepEqual(f.released, ["working"]);
});

test("commit choice is delivered once and never closes before completion", async () => {
  const f = fixture();
  await Promise.all([f.service.request(choice), f.service.request(choice)]);
  assert.equal(f.sent.length, 1); assert.equal(f.closed.length, 0);
  assert.match(f.sent[0]!, /only this issue/);
  assert.match(f.sent[0]!, /finish-close --request request-1/);
  const afterReload = createSimpleClose(f.deps);
  assert.equal((await afterReload.complete("request-1", sha, "working")).message, null);
  assert.equal(f.closed[0]!.commit, sha); assert.equal(f.closed[0]!.requestId, "request-1");
  assert.equal((await afterReload.complete("request-1", sha, "working")).message, null);
  assert.equal(f.closed.length, 1);
});

test("a failed delivery is persisted and retry sends the same request", async () => {
  const f = fixture(); let fail = true;
  f.deps.send = async (_, text) => { if (fail) throw new Error("delivery failed"); f.sent.push(text); };
  assert.match((await f.service.request(choice)).message!, /delivery failed/);
  assert.equal(f.closed.length, 0); assert.ok(f.db.size > 0);
  fail = false;
  assert.equal((await f.service.request(choice)).message, null);
  assert.equal(f.sent.length, 1);
});

test("wrong thread, wrong branch and a new sub-issue cannot complete", async () => {
  const f = fixture(); await f.service.request(choice);
  assert.match((await f.service.complete("request-1", sha, "other")).message!, /working conversation/);
  f.state.branch = "other";
  assert.match((await f.service.complete("request-1", sha, "working")).message!, /branch changed/);
  f.state.branch = "main"; f.context.issues.push(issue("new-child", "issue-1"));
  assert.match((await f.service.complete("request-1", sha, "working")).message!, /sub-issues/);
  assert.equal(f.closed.length, 0);
});

test("bad commit evidence leaves the request open without requiring a clean tree", async () => {
  const f = fixture(); await f.service.request(choice);
  f.deps.verify = async () => "Not this issue's commit";
  assert.match((await f.service.complete("request-1", sha, "working")).message!, /Not this issue/);
  assert.equal(f.closed.length, 0);
  f.deps.verify = async () => null;
  assert.equal((await f.service.complete("request-1", sha, "working")).message, null);
  assert.equal(f.state.changes, true);
});

test("push failure is reported with the commit, never rolled back", async () => {
  const f = fixture(); await f.service.request({ ...choice, git: "push", ending: "cancelled" });
  assert.match((await f.service.complete("request-1", sha, "working")).message!, /push-result/);
  assert.equal(f.closed.length, 0);
  assert.equal((await f.service.complete("request-1", sha, "working", "failed: network unavailable")).message, null);
  assert.equal(f.closed[0]!.pushResult, "failed: network unavailable");
  assert.equal(f.closed[0]!.ending, "cancelled");
});

test("closing without a commit supersedes an older pending request", async () => {
  const f = fixture(); await f.service.request(choice);
  await f.service.request({ ...choice, git: "none", ending: "duplicate" });
  assert.match((await f.service.complete("request-1", sha, "working")).message!, /superseded/);
  assert.equal(f.closed.length, 1);
});

test("an invalid duplicate target or Standard workflow never changes an issue", async () => {
  const f = fixture();
  assert.match((await f.service.request({ ...choice, ending: "duplicate", duplicateOf: "issue-1" })).message!, /another existing/);
  f.context.simple = false;
  assert.match((await f.service.request(choice)).message!, /Standard/);
  assert.equal(f.closed.length, 0); assert.equal(f.sent.length, 0);
});
