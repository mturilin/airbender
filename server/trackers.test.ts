// server/trackers.test.ts — tests for what a tracker's failures mean to
// the tab.
//
// What: checks that each thing the tracker core can throw becomes the right
// state and message for the tab, what is written to the log, and when the
// tracker kept for a folder is looked for again.
//
// Why: the setup screen is chosen from the state alone ("no-bd" offers to
// install beads, "no-beads" to set the folder up), and an unexpected error
// must reach the user as a sentence, not as a stack trace or a hang.
//
// Gotchas: nothing here runs bd. A folder with a `.beads` folder in it is
// enough for a tracker to be found; none of its methods is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  NoProgram,
  NotSetUp,
  Refused,
  Unsupported,
} from "../tracker/types.ts";
import { createTrackers } from "./trackers.ts";

const base = mkdtempSync(join(tmpdir(), "airbender-trackers-"));
after(() => rmSync(base, { recursive: true, force: true }));
const withBeads = join(base, "with");
const without = join(base, "without");
mkdirSync(join(withBeads, ".beads"), { recursive: true });
mkdirSync(without);

/** Trackers whose log lines and searches for bd are collected. */
function build(bd: string | null = "bd") {
  const log: string[] = [];
  let searches = 0;
  const trackers = createTrackers({
    findBd: async () => {
      searches += 1;
      return bd;
    },
    notFoundMessage: "no bd here",
    warn: (line) => log.push(line),
  });
  return { ...trackers, log, searches: () => searches };
}

test("each kind of failure becomes the tab's state and words", () => {
  const { problem, log } = build();
  assert.deepEqual(problem("/f", new NoProgram("gone")), {
    state: "no-bd",
    message: "no bd here",
  });
  assert.equal(problem("/f", new NotSetUp("nothing")).state, "no-beads");
  assert.deepEqual(problem("/f", new Refused("It is closed.")), {
    state: "error",
    message: "It is closed.",
  });
  assert.deepEqual(problem("/f", new Unsupported("No such link.")), {
    state: "error",
    message: "No such link.",
  });
  // None of these is worth a log line unless the caller names the change.
  assert.deepEqual(log, []);
  problem("/f", new Refused("It is closed."), "close");
  assert.deepEqual(log, ["close failed in /f: It is closed."]);
});

test("an unexpected error is a sentence for the user and its real text in the log", () => {
  const { problem, log } = build();
  const failed = problem("/f", new TypeError("rows.map is not a function"));
  assert.equal(failed.state, "error");
  assert.match(failed.message, /format this plugin does not understand/u);
  assert.equal(log.length, 1);
  assert.match(log[0]!, /rows\.map is not a function/u);
});

test("a machine without bd and a folder without beads are told apart, bd first", async () => {
  assert.deepEqual(await build(null).trackerFor(withBeads), {
    state: "no-bd",
    message: "no bd here",
  });
  assert.deepEqual(await build(null).trackerFor(without), {
    state: "no-bd",
    message: "no bd here",
  });
  const none = await build().trackerFor(without);
  assert.ok("state" in none && none.state === "no-beads");
});

test("a folder's tracker is kept, and looked for again once its program has gone", async () => {
  const { trackerFor, problem, searches } = build();
  const first = await trackerFor(withBeads);
  const second = await trackerFor(withBeads);
  assert.ok("tracker" in first && "tracker" in second);
  assert.equal(first.tracker, second.tracker);
  assert.equal(searches(), 1);
  problem(withBeads, new NoProgram("gone"));
  const third = await trackerFor(withBeads);
  assert.ok("tracker" in third && third.tracker !== first.tracker);
  assert.equal(searches(), 2);
  // A folder that is not set up is not kept: setting it up must show.
  const { trackerFor: again, searches: looked } = build();
  await again(without);
  await again(without);
  assert.equal(looked(), 2);
});

// --- Two trackers (bead-bb-c9l.6) ---

test("GitHub issues are used only where the repository says so, and need no beads program", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const { createFakeGitHub } = await import("../tracker/github-fake.ts");
  const githubClient = (repository: string) => createFakeGitHub({ repository });
  const chosen = join(base, "chosen");
  const remoteOnly = join(base, "remote-only");
  mkdirSync(chosen);
  mkdirSync(remoteOnly);
  writeFileSync(
    join(chosen, ".bend.json"),
    '{"tracker": "github", "repository": "team/board"}',
  );
  // No beads program on this machine at all.
  let searches = 0;
  const trackers = createTrackers({
    findBd: async () => {
      searches += 1;
      return null;
    },
    notFoundMessage: "no bd here",
    warn: () => {},
    githubClient,
  });
  const found = await trackers.trackerFor(chosen);
  assert.ok("tracker" in found);
  assert.deepEqual([found.name, found.repository], ["github", "team/board"]);
  assert.equal(searches, 0, "the beads program is not looked for");
  assert.equal(trackers.nameOf(chosen), "github");
  assert.deepEqual([...found.tracker.linkKinds], ["blocked-by", "discovered-from", "related"]);

  // A GitHub remote alone is not a choice: the tab does not start reading
  // a repository's GitHub issues before its owner said so.
  try {
    execFileSync("git", ["init", "-q"], { cwd: remoteOnly, stdio: "pipe" });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:someone/thing.git"],
      { cwd: remoteOnly, stdio: "pipe" },
    );
  } catch {
    return t.skip("git is not available");
  }
  assert.deepEqual(await trackers.trackerFor(remoteOnly), {
    state: "no-bd",
    message: "no bd here",
  });
  const withBd = createTrackers({
    findBd: async () => "bd",
    notFoundMessage: "no bd here",
    warn: () => {},
    githubClient,
  });
  const none = await withBd.trackerFor(remoteOnly);
  assert.ok("state" in none && none.state === "no-beads");
  assert.equal(withBd.nameOf(remoteOnly), null);

  // After a switch the folder is looked at again.
  writeFileSync(join(chosen, ".bend.json"), '{"tracker": "beads"}');
  assert.equal(trackers.nameOf(chosen), "github");
  trackers.forget(chosen);
  assert.deepEqual(await trackers.trackerFor(chosen), {
    state: "no-bd",
    message: "no bd here",
  });
});

test("no GitHub login is its own state, and the folder is looked at again after it", async () => {
  const { NotSignedIn } = await import("../tracker/types.ts");
  const { problem, log } = build();
  const failed = problem("/f", new NotSignedIn("Not signed in to GitHub. Sign in with `gh auth login`."));
  assert.equal(failed.state, "no-login");
  assert.match(failed.message, /gh auth login/u);
  assert.deepEqual(log, []);
});
