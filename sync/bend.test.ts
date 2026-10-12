// sync/bend.test.ts — how a `bend sync` is put into the sync layer's words.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBendSource } from "./bend.ts";
import type { BendSyncAnswer } from "./bend.ts";

/** An answer where nothing happened, changed by `over`. */
const answer = (over: Partial<BendSyncAnswer> = {}): BendSyncAnswer => ({
  busy: false,
  sent: 0,
  refused: 0,
  waiting: 0,
  problem: "",
  sentIssues: [],
  broughtInIssues: [],
  ...over,
});

/** A source whose sync gives `said`, or fails with it when it is an Error. */
const source = (said: BendSyncAnswer | Error, unsent: string[] | null = []) =>
  createBendSource({
    name: "github",
    remote: "GitHub issues of someone/scratch",
    unsent: () => Promise.resolve(unsent),
    sync: () => (said instanceof Error ? Promise.reject(said) : Promise.resolve(said)),
  });

test("what waits is the issues with unsent changes, and not known when they cannot be read", async () => {
  assert.deepEqual(await source(answer(), ["3", "7"]).pending(), [
    { id: "3", kinds: ["updated"] },
    { id: "7", kinds: ["updated"] },
  ]);
  assert.equal(await source(answer(), null).pending(), null);
  assert.equal(await source(answer()).remote(), "GitHub issues of someone/scratch");
  assert.equal(source(answer()).lockFile, null);
});

test("a clean sync names what it sent, and what came in apart from that", async () => {
  const run = await source(
    answer({ sent: 2, sentIssues: ["3"], broughtInIssues: ["3", "9"] }),
  ).run();
  assert.deepEqual(run, {
    end: "synced",
    message: "",
    sent: [{ id: "3", kinds: ["updated"] }],
    broughtIn: ["9"],
  });
});

test("changes left waiting, and a tracker that cannot be asked, fail in bend's words", async () => {
  const waiting = await source(
    answer({ waiting: 1, problem: "GitHub could not be reached." }),
  ).run();
  assert.equal(waiting.end, "failed");
  assert.equal(waiting.message, "GitHub could not be reached.");
  const down = await source(new Error("Not signed in to GitHub.")).run();
  assert.deepEqual(down, {
    end: "failed",
    message: "Not signed in to GitHub.",
    sent: null,
    broughtIn: null,
  });
});

test("another sync running is busy; a refused change does not fail the run", async () => {
  assert.equal((await source(answer({ busy: true })).run()).end, "busy");
  const refused = await source(answer({ refused: 1 })).run();
  assert.equal(refused.end, "synced");
  assert.match(refused.message, /^1 change was refused/);
  assert.match((await source(answer({ refused: 2 })).run()).message, /^2 changes were refused/);
});
