// app/use-issue-sync.test.ts — tests for the words the tab says about the
// issue sync (use-issue-sync.ts).
//
// What: checks what a sync is said to have done, the state on the menu's
// row, the refresh button's tooltip, and when that button is marked.
// Why: these words are all the owner sees of a sync that otherwise runs
// unseen (bead-bb-0bz, bead-bb-6a9).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ago,
  refreshTip,
  syncDid,
  syncFailing,
  syncState,
  troubleLines,
} from "./use-issue-sync.ts";
import type { SyncEntry, SyncStatus, SyncTrouble } from "./use-issue-sync.ts";

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
  refused: 0,
  waiting: 0,
  runs: 1,
  ...over,
});

/** A status with unremarkable values, changed by `over`. */
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  source: "made-up",
  remote: "the made-up remote",
  running: false,
  halted: false,
  refused: [],
  last: null,
  syncedAt: null,
  trouble: null,
  helper: null,
  ...over,
});

/** Trouble as bend reports it, changed by `over`. */
const trouble = (over: Partial<SyncTrouble> = {}): SyncTrouble => ({
  kind: "failing",
  serious: true,
  title: "The issues are not being synced: the last 3 syncs failed.",
  advice: "Sync again once the cause is dealt with.",
  message: "no route to host",
  since: NOW - 9 * MINUTE,
  failures: 3,
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

test("the refresh button is marked exactly when bend reports serious trouble", () => {
  const failed = entry({ end: "failed", message: "x" });
  // A failed run alone decides nothing here: when it counts is bend's rule.
  assert.equal(syncFailing(status({ last: failed })), null);
  assert.equal(
    syncFailing(status({ last: failed, trouble: trouble() })),
    "The issues are not being synced: the last 3 syncs failed.",
  );
  // Something to know, not a sync that does not work: not marked.
  assert.equal(
    syncFailing(status({ trouble: trouble({ kind: "refused", serious: false }) })),
    null,
  );
});

test("the trouble bar says since when, when the issues were last synced, and what to do", () => {
  assert.deepEqual(troubleLines(status({}), NOW), []);
  assert.deepEqual(
    troubleLines(status({ trouble: trouble(), syncedAt: NOW - 12 * MINUTE }), NOW),
    ["Since 9 minutes ago. Last synced 12 minutes ago.", "Sync again once the cause is dealt with."],
  );
  assert.deepEqual(troubleLines(status({ trouble: trouble() }), NOW)[0],
    "Since 9 minutes ago. The issues have never been synced from this computer.");
  // What is not serious has no "since": only what to do.
  assert.deepEqual(
    troubleLines(
      status({ trouble: trouble({ kind: "disabled", serious: false, advice: "Enable it." }) }),
      NOW,
    ),
    ["Enable it."],
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
    status({ last: entry({ end: "failed" }), syncedAt: NOW - 25 * MINUTE, trouble: trouble() }),
    NOW,
  );
  assert.match(failed, /^The issues are not being synced/u);
  assert.match(failed, / Last sync 1 minute ago: failed\.$/u);
});

test("refused changes are said under the row of a sync that otherwise worked", () => {
  const change = { seq: 1, at: "", issue: "12", what: "a comment", text: "Hi", reason: "locked" };
  const now = 1_000_000;
  const worked = status({ last: entry({ at: now }), syncedAt: now });
  assert.equal(syncState(worked, now).message, null);
  assert.match(
    syncState({ ...worked, refused: [change] }, now).message ?? "",
    /^1 change was refused and not sent/,
  );
  assert.match(
    syncState({ ...worked, refused: [change, { ...change, seq: 2 }] }, now).message ?? "",
    /^2 changes were refused/,
  );
});
