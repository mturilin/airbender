// plugin-close.test.ts — registered Simple RPC/CLI round trip with real bend,
// Beads and Git in a disposable repository. BB messages stay in the fake host;
// no real conversation starts and no user checkout is committed or changed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import plugin from "../server.ts";
import hostEntry from "../host.ts";
import { builtBend } from "./bend-for-tests.ts";

test("registered Simple Start, preview, commit completion across reload, and reopen", async (t) => {
  const bend = builtBend(); assert.ok(bend, "Go must be available for this integration check");
  const path = mkdtempSync(join(tmpdir(), "airbender-plugin-close-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  /** Runs only against this fixture, with all repository hooks disabled. */
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: path, encoding: "utf8", env }).trim();
  /** Uses the real CLI/adapter rather than inventing tracker responses. */
  const run = (...args: string[]) => execFileSync(bend, ["-C", path, ...args], { encoding: "utf8", env }).trim();
  git("init", "-q", "--initial-branch=main");
  run("setup", "tracker", "-y", "--use", "beads");
  run("setup", "issues", "-y");
  git("add", "."); git("commit", "-qm", "Fixture baseline");
  const beadId = run("create", "Work");
  let metadata: Record<string, unknown> = {};
  const thread = makeThreadResponse({ id: "thread-work", projectId: "project-test", environmentId: null });
  // The plugin's own part on the machine (host.ts) answers its calls, as
  // BB's daemon would on the folder's machine (bead-bb-fyv).
  const host = experimental_createHostEntryHarness(hostEntry);
  const machine = {
    experimental_callHostRpc: (call: { method: string; input: unknown }) =>
      host.experimental_call(call.method as never, call.input as never),
  };
  const hosts = { get: async () => ({ id: "host-test", name: "test", status: "connected", lifecycle: { phase: "active" } }) };
  let { bb, harness } = createFakePluginHost({ pluginId: "airbender", ...machine, settings: {
    bendCommand: bend, backgroundSizing: false, issueTitles: false, summaryBackend: "off",
  }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-test" }) },
    hosts,
    projects: { get: async () => ({ id: "project-test", sources: [{ hostId: "host-test", path, isDefault: true }] }) },
    threads: {
      get: async () => thread, list: async () => [thread], send: async () => ({}),
      getPluginMetadata: async () => metadata,
      updatePluginMetadata: async ({ set }: { set: Record<string, unknown> }) => { metadata = { ...metadata, ...set }; return metadata; },
    },
  } as never });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const scope = { threadId: thread.id, projectId: null, beadId };
  assert.deepEqual(await harness.behavior.callRpc("workflow_set", { threadId: null, projectId: "project-test", workflow: "simple" }), { message: null });
  assert.deepEqual(await harness.behavior.callRpc("issue_start", { threadId: thread.id, beadId }), { message: null });
  assert.equal(metadata.currentBead, beadId);
  const first = await harness.behavior.callRpc("issue_close_preview", scope) as { changes: boolean };
  assert.equal(first.changes, false);
  assert.equal(JSON.parse(run("show", beadId, "--json")).status, "open");
  writeFileSync(join(path, "work.txt"), "work\n");
  assert.equal((await harness.behavior.callRpc("issue_close_preview", scope) as { changes: boolean }).changes, true);
  assert.deepEqual(await harness.behavior.callRpc("issue_close_request", { ...scope, ending: "verified", git: "commit", duplicateOf: null }), { message: null, openThreadId: thread.id });
  const send = harness.inspection.sdk.callsTo("threads.send").at(-1)!;
  const text = JSON.stringify(send);
  const request = /finish-close --request ([a-f0-9-]+)/.exec(text)?.[1]; assert.ok(request, text);
  assert.equal(JSON.parse(run("show", beadId, "--json")).status, "open");
  git("add", "--", "work.txt"); git("commit", "-qm", `${beadId}: Work`);
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(path, "unrelated.txt"), "keep\n");
  ({ bb, harness } = await harness.lifecycle.reload(plugin));
  const result = await harness.behavior.runCli(["finish-close", "--request", request, "--commit", sha], { threadId: thread.id });
  assert.equal(result.exitCode, 0, result.stderr);
  const closed = JSON.parse(run("show", beadId, "--json"));
  assert.equal(closed.status, "closed"); assert.equal(closed.ending, "verified"); assert.ok(closed.closedAt);
  assert.match(run("comments", beadId), new RegExp(sha));
  assert.equal((await harness.behavior.runCli(["finish-close", "--request", request, "--commit", sha], { threadId: thread.id })).exitCode, 0);
  assert.equal(metadata.currentBead, null);
  run("reopen", beadId);
  assert.equal(JSON.parse(run("show", beadId, "--json")).status, "open");
  assert.deepEqual(await harness.behavior.callRpc("issue_close_request", { ...scope, ending: "cancelled", git: "none", duplicateOf: null }), { message: null });
  assert.equal(JSON.parse(run("show", beadId, "--json")).ending, "cancelled");
});
