// sync/beads.test.ts — tests for the beads source of the issue sync.
//
// What: checks how `bd sync`'s exit code is read, how journal records
// become changes, how "brought in" is worked out, and a whole run against
// a made-up bd.
// Why: these decide what the sync log says a sync did (bead-bb-6a9). The
// journal lines follow beads 1.3.1's documented record.

import assert from "node:assert/strict";
import { test } from "node:test";
import { broughtIn, changesFrom, createBeadsSource, endOf } from "./beads.ts";
import type { Ran, Seen } from "./beads.ts";

test("bd sync's exit code says how it ended", () => {
  assert.equal(endOf(0), "synced");
  assert.equal(endOf(1), "failed");
  assert.equal(endOf(2), "conflict");
  assert.equal(endOf(3), "busy");
  assert.equal(endOf(4), "stuck");
  // Killed, or a code beads does not document.
  assert.equal(endOf(null), "failed");
  assert.equal(endOf(137), "failed");
});

const record = (seq: number, op: string, id: string) =>
  JSON.stringify({ seq, ts: "2026-10-10T00:00:00Z", op, issue_id: id, issue: { id } });

test("journal records become changes per issue, with each kind once", () => {
  const read = changesFrom(
    [
      record(7, "create", "x-1"),
      record(8, "update", "x-1"),
      record(9, "comment", "x-2"),
      record(10, "update", "x-1"),
      record(11, "dep_add", "x-2"),
      record(12, "dep_remove", "x-2"),
      record(13, "close", "x-3"),
      record(14, "delete", "x-4"),
      "",
      "not a record",
      JSON.stringify({ op: "update" }),
    ].join("\n"),
  );
  assert.deepEqual(read.changes, [
    { id: "x-1", kinds: ["created", "updated"] },
    { id: "x-2", kinds: ["comment", "link"] },
    { id: "x-3", kinds: ["closed"] },
    { id: "x-4", kinds: ["deleted"] },
  ]);
  assert.equal(read.head, 14);
  assert.deepEqual(changesFrom(""), { changes: [], head: null });
  // An operation this file does not know still counts as a change.
  assert.deepEqual(changesFrom(record(1, "something-new", "x-9")).changes, [
    { id: "x-9", kinds: ["updated"] },
  ]);
});

const seen = (id: string, updatedAt: string, status = "open"): Seen => ({
  id,
  updatedAt,
  status,
});

test("brought in is what is new or different afterwards and was not changed here", () => {
  const before = [seen("a", "1"), seen("b", "1"), seen("c", "1"), seen("d", "1")];
  const after = [
    seen("a", "1"),
    seen("b", "2"),
    seen("c", "2"),
    seen("d", "1", "closed"),
    seen("e", "1"),
  ];
  // "c" was changed here: its difference is this side's.
  assert.deepEqual(broughtIn(before, after, new Set(["c"])), ["b", "d", "e"]);
  assert.deepEqual(broughtIn(before, before, new Set()), []);
});

/** A bd that answers from a script, and records what it was asked. */
function fakeBd(answers: Record<string, Ran | (() => Ran)>) {
  const asked: string[] = [];
  const bd = async (args: string[]): Promise<Ran> => {
    const key = args.join(" ");
    asked.push(key);
    const found = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    const answer = found?.[1] ?? { code: 0, stdout: "", stderr: "" };
    return typeof answer === "function" ? answer() : answer;
  };
  return { bd, asked };
}

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

/** A source over a made-up bd, with the journal position kept in memory. */
function source(
  answers: Record<string, Ran | (() => Ran)>,
  issues: () => Seen[] | null,
  kept: number | null,
  /** What the git remote answers when asked whether it holds issues. */
  onRemote: string | null = "abc refs/dolt/data",
) {
  const state = { position: kept };
  const { bd, asked } = fakeBd(answers);
  const made = createBeadsSource({
    home: "/repo",
    bd,
    bdCommand: "bd",
    git: async () => onRemote,
    readIssues: async () => issues(),
    position: {
      get: async () => state.position,
      set: (seq) => {
        state.position = seq;
      },
    },
  });
  return { made, asked, state };
}

test("a run reports what the journal says was sent and what the comparison says came in", async () => {
  let list = [seen("x-1", "1"), seen("x-2", "1")];
  const { made, asked, state } = source(
    {
      "dolt remote list": ok('[{"name":"origin","url":"git+https://example.com/r.git"}]'),
      "config get events-journal": ok("true\n"),
      "events tail --since 5": ok([record(6, "comment", "x-1")].join("\n")),
      "events tail --since 6": ok(""),
      sync: () => {
        // The pull brings a change to x-2 and a new x-3.
        list = [seen("x-1", "1"), seen("x-2", "2"), seen("x-3", "1")];
        return ok("Sync complete.");
      },
    },
    () => list,
    5,
  );
  assert.equal(await made.remote(), "the repository's git remote");
  assert.deepEqual(await made.pending(), [{ id: "x-1", kinds: ["comment"] }]);
  const ran = await made.run();
  assert.deepEqual(ran, {
    end: "synced",
    message: "",
    sent: [{ id: "x-1", kinds: ["comment"] }],
    broughtIn: ["x-2", "x-3"],
  });
  // The position moved to the journal's head, and beads' sync was run.
  assert.equal(state.position, 6);
  assert.ok(asked.includes("sync"));
});

test("a run that fails says so in beads' words and keeps what is pending", async () => {
  const { made, state } = source(
    {
      "config get events-journal": ok("true\n"),
      "events tail --since 5": ok(record(6, "update", "x-1")),
      sync: { code: 2, stdout: "", stderr: "Error: merge conflict in issues\nresolve by hand" },
    },
    () => [seen("x-1", "1")],
    5,
  );
  const ran = await made.run();
  assert.equal(ran.end, "conflict");
  assert.match(ran.message, /merge conflict in issues/u);
  assert.equal(ran.sent, null);
  assert.equal(state.position, 5);
});

test("with no position in the journal yet, the journal is switched on and nothing is claimed", async () => {
  const { made, asked, state } = source(
    {
      "config get events-journal": ok("false\n"),
      "config set events-journal true": ok(),
      "events export": ok([record(1, "update", "x-1"), record(2, "update", "x-1")].join("\n")),
      sync: ok(),
    },
    () => [seen("x-1", "1")],
    null,
  );
  assert.equal(await made.pending(), null);
  assert.ok(asked.includes("config set events-journal true"));
  // The position is the journal's head: what came before is not known.
  assert.equal(state.position, 2);
  const ran = await made.run();
  assert.equal(ran.end, "synced");
  // The first run after taking a position reads from it.
  assert.deepEqual(ran.sent, []);
});

test("a position beads can no longer read is replaced, saying 'not known' once", async () => {
  const { made, state } = source(
    {
      "config get events-journal": ok("true\n"),
      "events tail --since 5": { code: 1, stdout: "", stderr: "since is below the oldest retained record" },
      "events export": ok(record(40, "update", "x-1")),
    },
    () => [seen("x-1", "1")],
    5,
  );
  assert.equal(await made.pending(), null);
  assert.equal(state.position, 40);
});

const GIT_REMOTE = ok('[{"name":"origin","url":"git+https://example.com/r.git"}]');

test("issues with no remote, or with one that holds nothing, are synced nowhere", async () => {
  const none = source({ "dolt remote list": ok("[]") }, () => [seen("x-1", "1")], null);
  assert.equal(await none.made.remote(), null);
  // `bd init` leaves this: a remote taken from the git origin, nothing sent.
  const empty = source({ "dolt remote list": GIT_REMOTE }, () => [seen("x-1", "1")], null, "");
  assert.equal(await empty.made.remote(), null);
});

test("a remote counts as syncing only when it holds the issues", async () => {
  const holds = source({ "dolt remote list": GIT_REMOTE }, () => [seen("x-1", "1")], null);
  assert.equal(await holds.made.remote(), "the repository's git remote");
  // Not reached: not on for now.
  const offline = source({ "dolt remote list": GIT_REMOTE }, () => [seen("x-1", "1")], null, null);
  assert.equal(await offline.made.remote(), null);
  // A remote that is not a git repository cannot be asked: taken as holding.
  const hosted = source(
    { "dolt remote list": ok('[{"name":"origin","url":"https://doltremoteapi.example.com/me/db"}]') },
    () => [seen("x-1", "1")],
    null,
    "",
  );
  assert.equal(await hosted.made.remote(), "the repository's git remote");
});
