// server/list-cache.test.ts — tests for the list cache.
//
// What: checks when a kept answer is given out again and when it is read
// anew: the stamp, the stale mark, the age, joined reads, and reads that
// were under way when the answer went stale.
// Why: a stale list is the failure to fear in making the tab fast
// (bead-bb-3pr); these are the rules that prevent it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createListCache } from "./list-cache.ts";

/** A cache over a counter of reads, with a stamp and a clock to set. */
function made() {
  const state = { stamp: "s1" as string | null, time: 0, reads: 0 };
  const cache = createListCache<string>({
    stampOf: () => state.stamp,
    maxAgeMs: 60_000,
    keep: (value) => !value.startsWith("failed"),
    now: () => state.time,
  });
  const load = async () => `list ${++state.reads}`;
  return { cache, state, load };
}

test("the answer is kept while the stamp is the same, and read again when it differs", async () => {
  const { cache, state, load } = made();
  assert.equal(await cache.read("repo", load), "list 1");
  assert.equal(await cache.read("repo", load), "list 1");
  assert.equal(state.reads, 1);
  // Something changed outside.
  state.stamp = "s2";
  assert.equal(await cache.read("repo", load), "list 2");
  assert.equal(await cache.read("repo", load), "list 2");
  assert.equal(state.reads, 2);
});

test("marked stale, it is read again at once; fresh always reads", async () => {
  const { cache, state, load } = made();
  await cache.read("repo", load);
  cache.stale("repo");
  assert.equal(await cache.read("repo", load), "list 2");
  assert.equal(await cache.read("repo", load, true), "list 3");
  // And what a fresh read found is what is kept.
  assert.equal(await cache.read("repo", load), "list 3");
  assert.equal(state.reads, 3);
});

test("a kept answer is not given out past its age", async () => {
  const { cache, state, load } = made();
  await cache.read("repo", load);
  state.time = 60_000;
  assert.equal(await cache.read("repo", load), "list 1");
  state.time = 60_001;
  assert.equal(await cache.read("repo", load), "list 2");
});

test("requests during a read share it; two repositories are apart", async () => {
  const { cache, state } = made();
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  const slow = async () => {
    state.reads += 1;
    await held;
    return `list ${state.reads}`;
  };
  const asked = [cache.read("a", slow), cache.read("a", slow), cache.read("a", slow, true)];
  const other = cache.read("b", slow);
  assert.equal(state.reads, 2);
  open();
  assert.deepEqual(await Promise.all(asked), ["list 2", "list 2", "list 2"]);
  assert.equal(await other, "list 2");
});

test("a read under way when the answer went stale is not kept, nor joined afterwards", async () => {
  const { cache, state } = made();
  const gates: (() => void)[] = [];
  const slow = () => {
    const mine = ++state.reads;
    return new Promise<string>((resolve) => gates.push(() => resolve(`list ${mine}`)));
  };
  const before = cache.read("repo", slow);
  // A write happens while the first read is still running.
  cache.stale("repo");
  const after = cache.read("repo", slow);
  assert.equal(state.reads, 2);
  gates[1]!();
  gates[0]!();
  assert.equal(await before, "list 1");
  assert.equal(await after, "list 2");
  // The newer one is what is kept, although the older one ended last.
  assert.equal(await cache.read("repo", slow), "list 2");
  assert.equal(state.reads, 2);
});

test("an answer not worth keeping is read again; a read that throws leaves nothing behind", async () => {
  const { cache, state } = made();
  const failing = async () => `failed ${++state.reads}`;
  assert.equal(await cache.read("repo", failing), "failed 1");
  assert.equal(await cache.read("repo", failing), "failed 2");
  await assert.rejects(cache.read("repo", async () => Promise.reject(new Error("boom"))));
  assert.equal(await cache.read("repo", async () => "list"), "list");
});

test("with no stamp to go by, the mark and the age still hold", async () => {
  const { cache, state, load } = made();
  state.stamp = null;
  await cache.read("repo", load);
  assert.equal(await cache.read("repo", load), "list 1");
  cache.stale("repo");
  assert.equal(await cache.read("repo", load), "list 2");
});
