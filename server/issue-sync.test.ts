// server/issue-sync.test.ts — tests for the one-at-a-time rule of the
// issue sync, and for how a sync's end is read.
//
// What: checks the queue (one run per repository at a time, one follow-up
// per burst of requests), the lock file (a second taker is refused, a lock
// left behind is taken over) and the reading of `bd sync`'s exit code.
// Why: the user's condition for syncing from the tab was that several open
// tabs on one repository must not race (bead-bb-0bz). The run itself needs
// beads and a remote and is checked for real.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createQueue, endOf, haltsOn, takeLock } from "./issue-sync.ts";

/** A promise with its resolver, to hold a run open from the test. */
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, closed };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("requests during a run start nothing; exactly one more run follows", async () => {
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
  assert.equal(runs, 1);
  assert.equal(queue.running("repo"), true);
  // Many tabs ask while it runs.
  for (let asked = 0; asked < 10; asked += 1) queue.request("repo");
  await tick();
  assert.equal(runs, 1);
  gates[0]!.open();
  await tick();
  await tick();
  // One follow-up, not ten.
  assert.equal(runs, 2);
  gates[1]!.open();
  await tick();
  await tick();
  assert.equal(runs, 2);
  assert.equal(queue.running("repo"), false);
  assert.equal(most, 1);
  // Idle again: the next request runs at once.
  queue.request("repo");
  await tick();
  assert.equal(runs, 3);
  gates[2]!.open();
});

test("two repositories do not wait for each other", async () => {
  const held = gate();
  const started: string[] = [];
  const queue = createQueue(async (key) => {
    started.push(key);
    await held.closed;
  });
  queue.request("a");
  queue.request("b");
  await tick();
  assert.deepEqual(started, ["a", "b"]);
  held.open();
});

test("a run that throws does not leave the repository locked", async () => {
  let runs = 0;
  const queue = createQueue(async () => {
    runs += 1;
    throw new Error("boom");
  });
  queue.request("repo");
  await tick();
  await tick();
  assert.equal(queue.running("repo"), false);
  queue.request("repo");
  await tick();
  assert.equal(runs, 2);
});

test("the lock file lets one holder in, and a lock left behind is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "airbender-lock-"));
  try {
    const file = join(dir, "sync.lock");
    const release = takeLock(file, 60_000);
    assert.notEqual(release, null);
    // Held: a second taker is refused.
    assert.equal(takeLock(file, 60_000), null);
    release!();
    assert.equal(existsSync(file), false);
    // Given back: it can be taken again.
    const again = takeLock(file, 60_000);
    assert.notEqual(again, null);
    // Never given back, and older than a run may take: taken over.
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

test("bd sync's exit code says how it ended, and which ends stop syncing by itself", () => {
  assert.equal(endOf(0), "synced");
  assert.equal(endOf(1), "error");
  assert.equal(endOf(2), "conflict");
  assert.equal(endOf(3), "busy");
  assert.equal(endOf(4), "stuck");
  // Killed, or a code beads does not document: an error, tried again later.
  assert.equal(endOf(null), "error");
  assert.equal(endOf(137), "error");
  assert.deepEqual(
    (["synced", "error", "conflict", "busy", "stuck"] as const).filter(haltsOn),
    ["conflict", "stuck"],
  );
});
