// app/use-issue-sync.test.ts — tests for the line the menu says about the
// issues' sync (use-issue-sync.ts).
//
// What: checks the wording for each state a sync can be in.
// Why: this line is how the owner learns that the issues are on one
// computer only, or that syncing stopped on a conflict (bead-bb-0bz).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, syncFailing, syncLine } from "./use-issue-sync.ts";
import type { SyncStatus } from "./use-issue-sync.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A status with unremarkable values, changed by `over`. */
const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  enabled: true,
  running: false,
  halted: false,
  last: null,
  ...over,
});

test("how long ago, in the largest fitting unit", () => {
  assert.equal(ago(NOW - 20_000, NOW), "just now");
  assert.equal(ago(NOW - MINUTE, NOW), "1 minute ago");
  assert.equal(ago(NOW - 3 * MINUTE, NOW), "3 minutes ago");
  assert.equal(ago(NOW - 60 * MINUTE, NOW), "1 hour ago");
  assert.equal(ago(NOW - 50 * 60 * MINUTE, NOW), "2 days ago");
  // A clock that disagrees must not give a negative time.
  assert.equal(ago(NOW + MINUTE, NOW), "just now");
});

test("issues that are synced nowhere are said to be on this computer only", () => {
  assert.match(syncLine(status({ enabled: false }), NOW), /on this computer only/u);
});

test("a sync under way, a first one still to come, and a good one", () => {
  assert.match(syncLine(status({ running: true }), NOW), /^Syncing/u);
  assert.match(syncLine(status(), NOW), /not yet synced from here/u);
  assert.equal(
    syncLine(
      status({ last: { at: NOW - 3 * MINUTE, end: "synced", message: "", syncedAt: NOW - 3 * MINUTE } }),
      NOW,
    ),
    "Synced 3 minutes ago.",
  );
});

test("a failure says it is tried again; a conflict says it stopped, with beads' words", () => {
  const failed = syncLine(
    status({
      last: { at: NOW - MINUTE, end: "error", message: "could not reach remote", syncedAt: NOW - 30 * MINUTE },
    }),
    NOW,
  );
  assert.match(failed, /failed 1 minute ago; it is tried again\. Last synced 30 minutes ago\./u);
  assert.match(failed, /could not reach remote$/u);
  const conflict = syncLine(
    status({
      halted: true,
      last: { at: NOW, end: "conflict", message: "conflict in issues", syncedAt: null },
    }),
    NOW,
  );
  assert.match(conflict, /^Stopped: /u);
  assert.match(conflict, /conflict in issues$/u);
  assert.doesNotMatch(conflict, /Last synced/u);
  assert.match(
    syncLine(status({ last: { at: NOW, end: "busy", message: "x", syncedAt: null } }), NOW),
    /tried again/u,
  );
});

test("the refresh button is marked only when syncing has not worked for a while", () => {
  const failing = (over: Partial<SyncStatus>) => syncFailing(status(over), NOW);
  const failed = (minutesSinceGood: number | null) => ({
    at: NOW - MINUTE,
    end: "error" as const,
    message: "could not reach remote",
    syncedAt: minutesSinceGood === null ? null : NOW - minutesSinceGood * MINUTE,
  });
  // Working, or nothing to work: not marked.
  assert.equal(failing({}), null);
  assert.equal(failing({ enabled: false }), null);
  assert.equal(
    failing({ last: { at: NOW - 40 * MINUTE, end: "synced", message: "", syncedAt: NOW - 40 * MINUTE } }),
    null,
  );
  // One failed attempt soon after a good one: not yet.
  assert.equal(failing({ last: failed(7) }), null);
  // Failing, and more than ten minutes since the last good one.
  assert.match(failing({ last: failed(25) }) ?? "", /not been synced .* for 25 minutes\. See the menu\./u);
  // Never synced from this computer, and the attempt failed.
  assert.match(failing({ last: failed(null) }) ?? "", /could not be synced/u);
  // Stopped on a conflict: at once.
  assert.match(
    failing({
      halted: true,
      last: { at: NOW, end: "conflict", message: "x", syncedAt: NOW - MINUTE },
    }) ?? "",
    /has stopped/u,
  );
});
