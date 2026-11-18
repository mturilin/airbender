import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { builtBend } from "./bend-for-tests.ts";
import type { IssuesResult } from "./contract.ts";

const bend = builtBend();

test("opening and refreshing the actual issue RPC never starts work or sends tracker writes", async (t) => {
  if (bend === null) return t.skip("Go is unavailable");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airbender-observation-")));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const folder = join(root, "repository");
  mkdirSync(join(folder, ".beads"), { recursive: true });
  const calls = join(root, "bd-calls.jsonl");
  const bd = join(root, "bd");
  writeFileSync(bd, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('bd version test'); process.exit(0); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd(), noSend: process.env.BEND_NO_SEND, noBackground: process.env.BEND_NO_BACKGROUND }) + '\\n');
if (args[0] !== '--readonly' || args[1] !== 'list') { console.error('Unexpected tracker mutation'); process.exit(99); }
console.log(JSON.stringify([{ id: 't-1', title: 'Unrequested work', status: 'open', priority: 2, issue_type: 'task', labels: [], description: '' }]));
`);
  chmodSync(bd, 0o755);
  const host = createFakePluginHost({
    settings: { bdCommand: bd, bendCommand: bend, backgroundSizing: true, issueTitles: false },
    sdk: {
      system: { config: async () => ({ primaryHostId: "local" }) },
      threads: {
        get: async () => ({ id: "owner", title: "Owner", projectId: "project", environmentId: "environment", status: "idle" }),
        getPluginMetadata: async () => ({}),
        list: async () => [],
      },
      environments: { get: async () => ({ hostId: "local", path: folder }) },
    },
  });
  t.after(async () => {
    await host.harness.dispose();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });
  await host.bb.storage.kv.set("autopilot", { owner: { epicId: "t-1", on: true, reason: null } });
  await plugin(host.bb);
  for (const input of [
    { threadId: "owner", projectId: null },
    { threadId: "owner", projectId: null, fresh: true },
    { threadId: "owner", projectId: null, fresh: true, passive: true },
  ]) {
    const result = await host.harness.callRpc("issues_list", input) as IssuesResult;
    assert.equal(result.state, "ok", result.message ?? "");
    assert.deepEqual(result.issues.map((issue) => issue.id), ["t-1"]);
    assert.equal(result.autopilot?.on, false);
  }
  // Advance beyond the former ten-second sizing debounce without real waiting.
  // No sizing timer may have been scheduled by any observation.
  t.mock.timers.tick(11_000);
  await immediate();
  await immediate();
  for (const method of ["threads.spawn", "threads.send", "threads.rename", "threads.updatePluginMetadata"]) {
    assert.deepEqual(host.harness.sdk.callsTo(method), [], method);
  }
  const recorded = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(recorded.length >= 2, "fresh reads must exercise the actual helper");
  for (const call of recorded) {
    assert.equal(call.cwd, folder);
    assert.equal(call.noSend, "1");
    assert.equal(call.noBackground, "1");
    assert.deepEqual(call.args.slice(0, 2), ["--readonly", "list"]);
  }
});
