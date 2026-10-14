// server/watch.test.ts — tests for the watcher following a folder's copy.
//
// What: checks that when a folder's copy of the issues is in another place
// than before, the watch moves with it: a change in the new place is told
// to the tabs, one in the old place no longer is.
// Why: switching a repository's tracker moves bend's copy to another
// folder (bead-bb-c9l.18). A watch left on the first one would tell the
// tab of the other tracker's changes and miss this one's.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createWatcher } from "./watch.ts";

/** Long enough for a change to be noticed and the burst to settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 700));

test("a folder whose copy moved is watched in the new place, not the old", async () => {
  const root = mkdtempSync(join(tmpdir(), "airbender-watch-"));
  let dispose = () => {};
  try {
    const first = join(root, "bend", "beads");
    const second = join(root, "bend", "owner__name");
    mkdirSync(join(root, ".beads"), { recursive: true });
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    let told = 0;
    const { watchFolder } = await createWatcher({
      log: { info: () => {}, warn: () => {} },
      realtime: { publish: () => void (told += 1) },
      storage: { kv: { get: async () => undefined, set: async () => {} } },
      onDispose: (run: () => void) => void (dispose = run),
    } as unknown as BbPluginApi);

    watchFolder(root, { copy: first, sign: null });
    writeFileSync(join(first, "issues.json"), "[1]");
    await settled();
    assert.equal(told, 1, "a change in the copy is told");

    // The same place again: nothing is replaced, and it still works.
    watchFolder(root, { copy: first, sign: null });
    writeFileSync(join(first, "sync-runs.json"), "[1]");
    await settled();
    assert.equal(told, 2, "a change in the log of syncs is told");

    // The tracker was switched: the copy is elsewhere.
    watchFolder(root, { copy: second, sign: null });
    writeFileSync(join(first, "issues.json"), "[2]");
    writeFileSync(join(first, "sync-runs.json"), "[2]");
    await settled();
    assert.equal(told, 2, "the old place is no longer watched");
    writeFileSync(join(second, "issues.json"), "[1]");
    await settled();
    assert.equal(told, 3, "the new place is");
  } finally {
    dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
