// sync/service.test.ts — tests for the sync service, on a source made up
// for the purpose.
//
// What: checks the service's rules with a fake source: one run at a time
// per repository and one follow-up per burst, the lock file, the skip when
// nothing is pending, the stop after a conflict, what set a run off, and
// the log.
// Why: the service is meant to serve any source (bead-bb-6a9: "this will
// be multiple, and next implementation will be GitHub"). That it needs
// nothing from beads is shown by testing it without beads.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createQueue, createSyncService, takeLock, LOG_LENGTH } from "./service.ts";
import { haltsOn } from "./types.ts";
import type { Change, SyncEntry, SyncRun, SyncSource } from "./types.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Lets promise chains and immediate callbacks run out. */
const settle = async () => {
  for (let round = 0; round < 6; round += 1) await tick();
};

/** A promise with its resolver, to hold a run open from the test. */
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, closed };
}

/** A source whose every answer the test sets. */
function fake(over: Partial<SyncSource> & { results?: SyncRun[] } = {}) {
  const state = {
    runs: 0,
    remote: "a made-up remote" as string | null,
    pending: [] as Change[] | null,
    hold: null as Promise<void> | null,
    results: over.results ?? [],
  };
  const source: SyncSource = {
    name: "fake",
    lockFile: null,
    remote: async () => state.remote,
    pending: async () => state.pending,
    run: async () => {
      const mine = state.results[state.runs] ?? {
        end: "synced",
        message: "",
        sent: [],
        broughtIn: [],
      };
      state.runs += 1;
      if (state.hold !== null) await state.hold;
      return mine;
    },
    steps: async () => ({ on: null, fetch: null }),
    ...over,
  };
  return { source, state };
}

/** A service with short times and nothing kept. */
async function service(saved: Record<string, SyncEntry[]> = {}) {
  const said: string[] = [];
  let stored: Record<string, SyncEntry[]> = saved;
  const made = await createSyncService({
    load: async () => stored,
    save: (logs) => {
      stored = logs;
    },
    notify: () => {},
    info: (message) => said.push(message),
    times: { quietMs: 20, everyMs: 1_000, ownChangesMs: 0, lockedRetryMs: 20 },
  });
  return { made, said, stored: () => stored };
}

test("the queue: requests during a run start nothing, exactly one more run follows", async () => {
  const gates = [gate(), gate(), gate()];
  let runs = 0;
  let together = 0;
  let most = 0;
  const queue = createQueue(async () => {
    const mine = gates[runs]!;
    runs += 1;
    together += 1;
    most = Math.max(most, together);
    await mine.closed;
    together -= 1;
  });
  queue.request("repo");
  await tick();
  for (let asked = 0; asked < 10; asked += 1) queue.request("repo");
  await tick();
  assert.equal(runs, 1);
  gates[0]!.open();
  await settle();
  assert.equal(runs, 2);
  gates[1]!.open();
  await settle();
  assert.equal(runs, 2);
  assert.equal(queue.running("repo"), false);
  assert.equal(most, 1);
});

test("the queue: two repositories do not wait for each other, and a throw frees the key", async () => {
  const held = gate();
  const started: string[] = [];
  const queue = createQueue(async (key) => {
    started.push(key);
    if (key === "boom") throw new Error("boom");
    await held.closed;
  });
  queue.request("a");
  queue.request("b");
  queue.request("boom");
  await settle();
  assert.deepEqual(started, ["a", "b", "boom"]);
  assert.equal(queue.running("boom"), false);
  held.open();
});

test("the lock file lets one holder in, and a lock left behind is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "airbender-lock-"));
  try {
    const file = join(dir, "sync.lock");
    const release = takeLock(file, 60_000);
    assert.notEqual(release, null);
    assert.equal(takeLock(file, 60_000), null);
    release!();
    assert.equal(existsSync(file), false);
    assert.notEqual(takeLock(file, 60_000), null);
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    assert.equal(takeLock(file, 600_000), null);
    const taken = takeLock(file, 60_000);
    assert.notEqual(taken, null);
    taken!();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh runs the source and logs what it did, with what set it off", async () => {
  const { made, stored } = await service();
  const { source, state } = fake({
    results: [
      {
        end: "synced",
        message: "",
        sent: [{ id: "x-1", kinds: ["comment"] }],
        broughtIn: ["x-2"],
      },
    ],
  });
  made.use("repo", source);
  assert.equal(await made.refresh("repo"), true);
  await settle();
  assert.equal(state.runs, 1);
  const [entry] = made.log("repo");
  assert.equal(entry!.cause, "refresh");
  assert.equal(entry!.end, "synced");
  assert.deepEqual(entry!.sent, [{ id: "x-1", kinds: ["comment"] }]);
  assert.deepEqual(entry!.broughtIn, ["x-2"]);
  const now = await made.state("repo");
  assert.equal(now.source, "fake");
  assert.equal(now.remote, "a made-up remote");
  assert.equal(now.syncedAt, entry!.at);
  // Kept by the host.
  assert.equal(stored().repo!.length, 1);
});

test("many requests at once, from anywhere, are one run and one follow-up", async () => {
  const { made } = await service();
  const held = gate();
  const { source, state } = fake();
  state.hold = held.closed;
  made.use("repo", source);
  for (let asked = 0; asked < 12; asked += 1) void made.refresh("repo");
  await settle();
  assert.equal(state.runs, 1);
  assert.equal((await made.state("repo")).running, true);
  state.hold = null;
  held.open();
  await settle();
  assert.equal(state.runs, 2);
  assert.equal((await made.state("repo")).running, false);
});

test("a source that is not switched on is never run", async () => {
  const { made } = await service();
  const { source, state } = fake();
  state.remote = null;
  made.use("repo", source);
  assert.equal(await made.refresh("repo"), false);
  made.changed("repo");
  made.opened("repo");
  made.tick();
  await wait(60);
  assert.equal(state.runs, 0);
  assert.equal((await made.state("repo")).remote, null);
});

test("a change syncs after the quiet time, unless nothing is pending", async () => {
  const { made, said } = await service();
  const { source, state } = fake();
  made.use("repo", source);
  // Nothing pending: what looked like a change was a read.
  state.pending = [];
  made.changed("repo");
  await wait(60);
  assert.equal(state.runs, 0);
  assert.ok(said.some((line) => line.includes("nothing to send")));
  // Something pending: one run for a burst of changes.
  state.pending = [{ id: "x-1", kinds: ["updated"] }];
  made.changed("repo");
  made.changed("repo");
  made.changed("repo");
  await wait(60);
  assert.equal(state.runs, 1);
  assert.equal(made.log("repo")[0]!.cause, "change");
  // The source cannot tell: it runs.
  state.pending = null;
  made.changed("repo");
  await wait(60);
  assert.equal(state.runs, 2);
});

test("the timed sync runs whatever is pending; an opened tab only when the last run is old", async () => {
  const { made } = await service();
  const { source, state } = fake();
  state.pending = [];
  made.use("repo", source);
  made.tick();
  await settle();
  assert.equal(state.runs, 1);
  assert.equal(made.log("repo")[0]!.cause, "timer");
  // Just synced: opening a tab asks for nothing.
  made.opened("repo");
  await settle();
  assert.equal(state.runs, 1);
});

test("an opened tab syncs when nothing was synced lately", async () => {
  const { made } = await service();
  const { source, state } = fake();
  made.use("repo", source);
  made.opened("repo");
  await settle();
  assert.equal(state.runs, 1);
  assert.equal(made.log("repo")[0]!.cause, "opened");
});

test("after a conflict nothing runs by itself until a sync asked for succeeds", async () => {
  const { made } = await service();
  const { source, state } = fake({
    results: [
      { end: "conflict", message: "cannot merge x-1", sent: null, broughtIn: null },
      { end: "synced", message: "", sent: [], broughtIn: [] },
    ],
  });
  state.pending = null;
  made.use("repo", source);
  await made.refresh("repo");
  await settle();
  assert.equal((await made.state("repo")).halted, true);
  made.tick();
  made.changed("repo");
  made.opened("repo");
  await wait(60);
  assert.equal(state.runs, 1);
  // The owner asks: it runs, and syncing by itself is taken up again.
  await made.refresh("repo");
  await settle();
  assert.equal(state.runs, 2);
  assert.equal((await made.state("repo")).halted, false);
  made.tick();
  await settle();
  assert.equal(state.runs, 3);
  assert.ok(haltsOn("stuck") && !haltsOn("failed") && !haltsOn("busy"));
});

test("a source that throws is logged as a failed run", async () => {
  const { made } = await service();
  const { source } = fake({
    run: async () => {
      throw new Error("no network");
    },
  });
  made.use("repo", source);
  await made.refresh("repo");
  await settle();
  const [entry] = made.log("repo");
  assert.equal(entry!.end, "failed");
  assert.equal(entry!.message, "no network");
});

test("after failures the wait before the next sync by itself grows; asking still syncs at once", async () => {
  const said: string[] = [];
  const made = await createSyncService({
    load: async () => ({}),
    save: () => {},
    notify: () => {},
    info: (message) => said.push(message),
    times: { quietMs: 5, everyMs: 40, ownChangesMs: 0, longestWaitMs: 100 },
  });
  const failed = { end: "failed" as const, message: "x", sent: null, broughtIn: null };
  const { source, state } = fake({ results: [failed, failed, failed, failed] });
  state.pending = null;
  made.use("repo", source);
  made.tick();
  await settle();
  assert.equal(state.runs, 1);
  // One failure: twice the usual time has to pass.
  made.tick();
  made.opened("repo");
  made.changed("repo");
  await wait(30);
  assert.equal(state.runs, 1);
  await wait(60);
  made.tick();
  await settle();
  assert.equal(state.runs, 2);
  // Two failures: it would be four times, but never longer than the cap.
  await wait(50);
  made.tick();
  await settle();
  assert.equal(state.runs, 2);
  await wait(60);
  made.tick();
  await settle();
  assert.equal(state.runs, 3);
  // The owner asks: at once, whatever the wait.
  await made.refresh("repo");
  await settle();
  assert.equal(state.runs, 4);
  // And once it works again, the usual pace is back.
  await made.refresh("repo");
  await settle();
  assert.equal(state.runs, 5);
  made.tick();
  await settle();
  assert.equal(state.runs, 6);
  made.dispose();
});

test("a held lock file puts the run off, and it happens once the lock is free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "airbender-sync-"));
  try {
    const { made } = await service();
    const lockFile = join(dir, "nested", "sync.lock");
    const { source, state } = fake({ lockFile });
    made.use("repo", source);
    // Held by "another process".
    await made.refresh("repo");
    await settle();
    assert.equal(state.runs, 1);
    const release = takeLock(lockFile, 60_000)!;
    await made.refresh("repo");
    await settle();
    assert.equal(state.runs, 1);
    release();
    await wait(60);
    assert.equal(state.runs, 2);
    assert.equal(existsSync(lockFile), false);
    made.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log is kept across a restart, newest first, and has a limit", async () => {
  const old: SyncEntry = {
    at: 1,
    seconds: 1,
    cause: "timer",
    end: "synced",
    message: "",
    sent: [],
    broughtIn: [],
  };
  const { made } = await service({
    repo: Array.from({ length: LOG_LENGTH }, (_unused, index) => ({ ...old, at: index + 1 })),
  });
  const { source } = fake();
  made.use("repo", source);
  assert.equal(made.log("repo")[0]!.at, LOG_LENGTH);
  await made.refresh("repo");
  await settle();
  const log = made.log("repo");
  assert.equal(log.length, LOG_LENGTH);
  assert.equal(log[0]!.cause, "refresh");
  // The oldest one made room.
  assert.equal(log.at(-1)!.at, 2);
});
