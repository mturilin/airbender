import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { standardWorkflow } from "../shared/standard-workflow.ts";
import type { Issue } from "./contract.ts";
import { createSizing } from "./sizing.ts";

const issue = (id: string, over: Partial<Issue> = {}) => ({
  id, title: id, description: "", acceptance: "", design: "", notes: "",
  type: "task", parentId: null, step: null, size: null, status: "open", ...over,
}) as Issue;

async function fixture() {
  const host = createFakePluginHost();
  const issues = [issue("a"), issue("b")];
  const writes: string[] = [];
  let title = "";
  // The plugin targets ES2022, before Promise.withResolvers.
  let finish!: () => void;
  const idle = new Promise<void>((resolve) => { finish = resolve; });
  host.harness.sdk.stub("threads.get", async () => ({ title, projectId: "project", environmentId: "environment" }));
  host.harness.sdk.stub("threads.spawn", async (input: unknown) => {
    assert.ok(input && typeof input === "object" && "title" in input);
    assert.equal(typeof input.title, "string");
    title = String(input.title);
    return { id: "worker" };
  });
  host.harness.sdk.stub("threads.wait", () => idle);
  host.harness.sdk.stub("threads.archive", async () => undefined);
  host.harness.sdk.stub("threads.stop", async () => undefined);
  const sizing = await createSizing({
    bb: host.bb as BbPluginApi,
    readSettings: async () => ({ providerId: "", model: "" }),
    readIssues: async () => ({ state: "ok", issues: issues.map((item) => ({ ...item })) }),
    workflowFor: () => standardWorkflow,
    setSize: async (_path, _thread, id, size) => { writes.push(`${id}:${size}`); return { message: null }; },
    addComment: async (_path, id) => { writes.push(`${id}:comment`); return { message: null }; },
  });
  return { ...host, sizing, issues, writes, finish };
}

test("only explicitly requested issues may be sized, even when a worker reports unrelated ids", async (t) => {
  const f = await fixture();
  t.after(async () => { f.finish(); await immediate(); await f.harness.dispose(); });
  assert.deepEqual(f.harness.sdk.callsTo("threads.spawn"), []);
  assert.equal((await f.sizing.request("/repo", "a", { threadId: "owner", projectId: "project" })).message, null);
  await f.sizing.report("worker", [
    { id: "a", size: "m", reason: "Several paths" },
    { id: "b", size: "l", reason: "Not requested" },
  ]);
  assert.deepEqual(f.writes, ["a:m", "a:comment"]);
  await f.sizing.report("worker", [{ id: "a", size: "s", reason: "Duplicate" }]);
  assert.deepEqual(f.writes, ["a:m", "a:comment"]);
});

test("sizing cannot overwrite changes made after the request", async (t) => {
  const f = await fixture();
  t.after(async () => { f.finish(); await immediate(); await f.harness.dispose(); });
  await f.sizing.request("/repo", "a", { threadId: "owner", projectId: "project" });
  f.issues[0]!.size = "l";
  await f.sizing.report("worker", [{ id: "a", size: "s", reason: "Old view" }]);
  assert.deepEqual(f.writes, []);
});

test("a started issue is not sized by a pending worker", async (t) => {
  const f = await fixture();
  t.after(async () => { f.finish(); await immediate(); await f.harness.dispose(); });
  await f.sizing.request("/repo", "a", { threadId: "owner", projectId: "project" });
  f.issues[0]!.step = "implement";
  await f.sizing.report("worker", [{ id: "a", size: "s", reason: "Too late" }]);
  assert.deepEqual(f.writes, []);
});
