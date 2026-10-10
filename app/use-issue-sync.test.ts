// app/use-issue-sync.test.ts — tests for the words the tab says about the
// issue sync (use-issue-sync.ts).
//
// What: checks what a sync is said to have done, the state on the menu's
// row, the refresh button's tooltip, and when that button is marked.
// Why: these words are all the owner sees of a sync that otherwise runs
// unseen (bead-bb-0bz, bead-bb-6a9).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, refreshTip, syncDid, syncFailing, syncState } from "./use-issue-sync.ts";
import type { SyncEntry, SyncStatus } from "./use-issue-sync.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A run with unremarkable values, changed by `over`. */
const entry = (over: Partial<SyncEntry> = {}): SyncEntry => ({
  at: NOW - MINUTE,
  seconds: 4,
  cause: "timer",
  end: "synced",
  message: "",
  sent: [],
  broughtIn: [],
  ...over,
});

/** A status with unremarkable values, changed by `over`. */
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  source: "made-up",
  remote: "the made-up remote",
  running: false,
  halted: false,
  last: null,
  syncedAt: null,
  ...over,
});

test("how long ago, in the largest fitting unit", () => {
  assert.equal(ago(NOW - 20_000, NOW), "just now");
  assert.equal(ago(NOW - MINUTE, NOW), "1 minute ago");
  assert.equal(ago(NOW - 3 * MINUTE, NOW), "3 minutes ago");
  assert.equal(ago(NOW - 60 * MINUTE, NOW), "1 hour ago");
  assert.equal(ago(NOW - 50 * 60 * MINUTE, NOW), "2 days ago");
  assert.equal(ago(NOW + MINUTE, NOW), "just now");
});

test("what a sync did, in a few words", () => {
  assert.equal(syncDid(entry()), "nothing new");
  assert.equal(
    syncDid(entry({ sent: [{ id: "x-1", kinds: ["comment"] }] })),
    "sent 1 issue (x-1: comment)",
  );
  assert.equal(
    syncDid(
      entry({
        broughtIn: ["x-2", "x-3"],
        sent: [{ id: "x-1", kinds: ["updated", "closed"] }],
      }),
    ),
    "brought in 2 issues (x-2, x-3), sent 1 issue (x-1: updated, closed)",
  );
  // Without room for ids.
  assert.equal(
    syncDid(entry({ broughtIn: ["x-2"], sent: [{ id: "x-1", kinds: ["comment"] }] }), false),
    "brought in 1 issue, sent 1 issue",
  );
  // Many: the first few are named.
  assert.equal(
    syncDid(entry({ broughtIn: ["a", "b", "c", "d", "e"] })),
    "brought in 5 issues (a, b, c and 2 more)",
  );
  // Not known is not "nothing new".
  assert.equal(syncDid(entry({ sent: null, broughtIn: null })), "synced");
  assert.equal(syncDid(entry({ end: "failed", sent: null, broughtIn: null })), "failed");
  assert.match(syncDid(entry({ end: "conflict" })), /cannot be merged/u);
});

test("the menu's row: a word or two, and a message only when there is something to read", () => {
  const row = (over: Partial<SyncStatus>) => syncState(status(over), NOW);
  assert.equal(row({ remote: null }).state, "not synced");
  assert.match(row({ remote: null }).message ?? "", /on this computer only/u);
  assert.deepEqual(row({ running: true }), { state: "syncing…", message: null });
  assert.deepEqual(row({}), { state: "not yet synced from here", message: null });
  assert.deepEqual(row({ last: entry(), syncedAt: NOW - MINUTE }), {
    state: "synced 1 minute ago",
    message: null,
  });
  const failed = row({
    last: entry({ end: "failed", message: "could not reach the remote" }),
    syncedAt: NOW - 30 * MINUTE,
  });
  assert.equal(failed.state, "failed");
  assert.match(failed.message ?? "", /tried again\. Last synced 30 minutes ago\./u);
  assert.match(failed.message ?? "", /could not reach the remote$/u);
  const stopped = row({ halted: true, last: entry({ end: "conflict", message: "x-1" }) });
  assert.equal(stopped.state, "stopped");
  assert.match(stopped.message ?? "", /press refresh/u);
  // Gave way to changes: still says when it last worked.
  assert.equal(
    row({ last: entry({ end: "busy" }), syncedAt: NOW - 6 * MINUTE }).state,
    "synced 6 minutes ago",
  );
});

test("the refresh button is marked only when syncing has not worked for a while", () => {
  const failing = (over: Partial<SyncStatus>) => syncFailing(status(over), NOW);
  const failed = entry({ end: "failed", message: "x" });
  assert.equal(failing({}), null);
  assert.equal(failing({ remote: null, last: failed }), null);
  assert.equal(failing({ last: entry({ at: NOW - 40 * MINUTE }), syncedAt: NOW - 40 * MINUTE }), null);
  // One failed attempt soon after a good one: not yet.
  assert.equal(failing({ last: failed, syncedAt: NOW - 7 * MINUTE }), null);
  assert.match(
    failing({ last: failed, syncedAt: NOW - 25 * MINUTE }) ?? "",
    /not been synced with the made-up remote for 25 minutes\. See the menu\./u,
  );
  // Never synced from this computer, and the attempt failed.
  assert.match(failing({ last: failed }) ?? "", /could not be synced/u);
  // Stopped on a conflict: at once.
  assert.match(
    failing({ halted: true, last: entry({ end: "conflict" }), syncedAt: NOW - MINUTE }) ?? "",
    /has stopped/u,
  );
});

test("the refresh button's tooltip says what it does, then when the last sync was and what it did", () => {
  assert.equal(refreshTip(null, NOW), "Refresh the list");
  assert.equal(refreshTip(status({ remote: null }), NOW), "Refresh the list");
  assert.equal(
    refreshTip(
      status({ last: entry({ sent: [{ id: "x-1", kinds: ["comment"] }] }), syncedAt: NOW - MINUTE }),
      NOW,
    ),
    "Refresh the list and sync the issues with the made-up remote. Last sync 1 minute ago: sent 1 issue.",
  );
  assert.match(refreshTip(status({ running: true }), NOW), / Syncing now…$/u);
  assert.match(refreshTip(status({}), NOW), / Not yet synced from here\.$/u);
  // Marked as failing: the reason first.
  const failed = refreshTip(
    status({ last: entry({ end: "failed" }), syncedAt: NOW - 25 * MINUTE }),
    NOW,
  );
  assert.match(failed, /^The issues have not been synced/u);
  assert.match(failed, / Last sync 1 minute ago: failed\.$/u);
});
