// server/sync.test.ts — tests for the plugin's side of the issue sync.
//
// What: checks that the plugin only shows and asks: the state and the log
// are bend's answers passed on, Refresh starts one `bend sync` and tells
// the tabs at its start and end, and nothing is started where the issues
// are synced with nothing.
// Why: the plugin used to run the syncs itself; what is left must not grow
// a timer or a second opinion again (bead-bb-c9l.16).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SyncEntry, SyncState } from "../sync/types.ts";
import type { Tracker, Trackers } from "./bend.ts";
import type { Store } from "./store.ts";
import { createSync } from "./sync.ts";

const state = (over: Partial<SyncState> = {}): SyncState => ({
  source: "made-up",
  remote: "the made-up remote",
  running: false,
  halted: false,
  last: null,
  syncedAt: null,
  pending: [],
  trouble: null,
  helper: { running: true, pid: 7, since: 1, disabled: false, gaveUpAt: 0, heldBackUntil: 0 },
  ...over,
});

const entry: SyncEntry = {
  end: "synced",
  message: "",
  sent: [],
  broughtIn: ["x-1"],
  at: 5,
  seconds: 1,
  cause: "asked",
  refused: 0,
  waiting: 0,
  runs: 1,
};

/** The plugin's sync over a made-up bend, with what it did recorded. */
function made(answers: { state?: SyncState; noTracker?: boolean } = {}) {
  const did: string[] = [];
  let endSync: (entry: SyncEntry) => void = () => {};
  const tracker = {
    syncState: async (passive?: boolean) => {
      did.push(`state${passive === true ? " passive" : ""}`);
      return answers.state ?? state();
    },
    syncLog: async (failed?: boolean) => {
      did.push(`log${failed === true ? " failed" : ""}`);
      return [entry];
    },
    sync: () => {
      did.push("sync");
      return new Promise<SyncEntry>((resolve) => {
        endSync = resolve;
      });
    },
  } as unknown as Tracker;
  const sync = createSync({
    bb: {
      log: { info: () => {}, warn: () => {} },
      realtime: { publish: () => did.push("tabs told") },
      storage: { kv: { delete: async (key: string) => void did.push(`forgot ${key}`) } },
    } as unknown as BbPluginApi,
    store: { stale: () => did.push("list stale") } as unknown as Store,
    trackers: {
      trackerFor: async () =>
        answers.noTracker === true
          ? { state: "not-set-up", message: "This folder has no tracker." }
          : { tracker },
    } as unknown as Trackers,
  });
  return { sync, did, endSync: (with_: SyncEntry) => endSync(with_) };
}

/** Lets what was started settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("what the plugin's earlier sync kept in storage is removed", () => {
  const { did } = made();
  assert.deepEqual(did, ["forgot syncLog", "forgot syncJournalPosition"]);
});

test("the state and the log are bend's answers, and a passive read is asked as one", async () => {
  const { sync, did } = made({ state: state({ halted: true }) });
  did.length = 0;
  assert.equal((await sync.state("/repo")).halted, true);
  await sync.state("/repo", true);
  assert.deepEqual(await sync.log("/repo", true), [entry]);
  assert.deepEqual(did, ["state", "state passive", "log failed"]);
});

test("a folder with no tracker has nothing to say and nothing to sync", async () => {
  const { sync } = made({ noTracker: true });
  const found = await sync.state("/repo");
  assert.equal(found.remote, null);
  assert.equal(found.helper, null);
  assert.deepEqual(await sync.log("/repo"), []);
  assert.equal((await sync.refresh("/repo")).message, "This folder has no tracker.");
});

test("refresh starts one sync, says it is running, and tells the tabs at both ends", async () => {
  const { sync, did, endSync } = made();
  did.length = 0;
  assert.deepEqual(await sync.refresh("/repo"), { message: null });
  // Asked again while it runs: not a second sync.
  assert.deepEqual(await sync.refresh("/repo"), { message: null });
  assert.equal((await sync.state("/repo")).running, true);
  assert.deepEqual(did, ["state", "tabs told", "sync", "state"]);
  endSync(entry);
  await settled();
  assert.deepEqual(did.slice(4), ["list stale", "tabs told"]);
  assert.equal((await sync.state("/repo")).running, false);
});

test("issues synced with nothing are not synced, and the owner is told where to look", async () => {
  const { sync, did } = made({ state: state({ remote: null }) });
  assert.match((await sync.refresh("/repo")).message ?? "", /not synced with anything yet/u);
  assert.ok(!did.includes("sync"));
});
