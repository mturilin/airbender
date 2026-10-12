// server/bend.test.ts — tests for the tab's door to issues.
//
// What: checks how each kind of failure of the bend program becomes one of
// the tab's states, in which order the programs and the folder are looked
// at, that what is found for a folder is kept, and how an old or missing
// bend is told from a working one.
//
// Why: this is the one place where "bend failed" turns into what the owner
// sees and which setup step they are offered. A slip sends them to the
// wrong step, or shows a raw error.
//
// Gotchas:
// - Runs the bend built from this repository's source (bend-for-tests.ts);
//   skipped where Go is not installed. No bd is needed: the folders here
//   only look like beads repositories, and nothing is asked of a tracker.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test as nodeTest } from "node:test";
import { builtBend } from "./bend-for-tests.ts";
import {
  BendFailure,
  NEEDED_VERSION,
  createRun,
  createTrackers,
  findBendAmong,
  trackerOver,
} from "./bend.ts";

const bend = builtBend();
/** Skipped where bend cannot be built (no Go on this machine). */
const test = bend === null ? nodeTest.skip : nodeTest;

const base = mkdtempSync(join(tmpdir(), "airbender-bend-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
const withBeads = join(base, "with");
const without = join(base, "without");
mkdirSync(join(withBeads, ".beads"), { recursive: true });
mkdirSync(without);
// "Supported issue tracker" is looked for in the folders above too; a
// setting file that names an unaccepted tracker stops nothing, and the
// temporary folder has no .beads above it.

/** Trackers whose log lines and searches for bd are collected. */
function build(bd: string | null = "bd", found: string | "missing" | "old" = bend!) {
  const log: string[] = [];
  let searches = 0;
  const trackers = createTrackers({
    findBd: async () => {
      searches += 1;
      return bd;
    },
    findBend: async () => found,
    notFoundMessage: "no bd here",
    bendMessages: { missing: "no bend here", old: "an old bend here" },
    warn: (line) => log.push(line),
  });
  return { ...trackers, log, searches: () => searches };
}

test("each kind of failure becomes the tab's state and words", () => {
  const { problem, log } = build();
  assert.deepEqual(problem("/f", new BendFailure("no-program", "gone")), {
    state: "no-bd",
    message: "no bd here",
  });
  assert.deepEqual(problem("/f", new BendFailure("no-bend", "gone")), {
    state: "no-bend",
    message: "no bend here",
  });
  assert.equal(problem("/f", new BendFailure("not-set-up", "nothing")).state, "no-beads");
  assert.deepEqual(problem("/f", new BendFailure("refused", "It is closed.")), {
    state: "error",
    message: "It is closed.",
  });
  assert.deepEqual(problem("/f", new BendFailure("unsupported", "No such link.")), {
    state: "error",
    message: "No such link.",
  });
  // None of these is worth a log line unless the caller names the change.
  assert.deepEqual(log, []);
  problem("/f", new BendFailure("refused", "It is closed."), "close");
  assert.deepEqual(log, ["close failed in /f: It is closed."]);
});

test("an answer that is not bend's is a sentence for the user and its real text in the log", () => {
  const { problem, log } = build();
  for (const cause of [
    new BendFailure("not-understood", "Segmentation fault"),
    new TypeError("rows.map is not a function"),
  ]) {
    const failed = problem("/f", cause);
    assert.equal(failed.state, "error");
    assert.match(failed.message, /format this plugin does not understand/u);
  }
  assert.equal(log.length, 2);
  assert.match(log[0]!, /Segmentation fault/u);
  assert.match(log[1]!, /rows\.map is not a function/u);
});

test("no bend, no tracker and no bd are told apart, in that order", async () => {
  // bend first: without it nothing can say what the folder has.
  for (const folder of [withBeads, without]) {
    assert.deepEqual(await build(null, "missing").trackerFor(folder), {
      state: "no-bend",
      message: "no bend here",
    });
  }
  // The beads program is asked for only where the tracker is beads: a
  // folder with no tracker says that, whether or not beads is installed
  // (choosing the tracker comes first in setup, bead-bb-c9l.6).
  assert.deepEqual(await build(null).trackerFor(withBeads), {
    state: "no-bd",
    message: "no bd here",
  });
  const neither = await build(null).trackerFor(without);
  assert.ok("state" in neither && neither.state === "no-beads");
  assert.deepEqual(await build("bd", "missing").trackerFor(withBeads), {
    state: "no-bend",
    message: "no bend here",
  });
  assert.deepEqual(await build("bd", "old").trackerFor(withBeads), {
    state: "no-bend",
    message: "an old bend here",
  });
  const none = await build().trackerFor(without);
  assert.ok("state" in none && none.state === "no-beads");
  // bend can still be run where there is no tracker, for the facts file.
  const run = await build().bendIn(without);
  assert.ok("run" in run);
  assert.deepEqual(await run.run(["facts", "--ensure"]), { ok: true, created: true });
});

test("GitHub issues are taken where the setting says so, with no beads program", async () => {
  const onGitHub = join(base, "github");
  mkdirSync(onGitHub);
  writeFileSync(join(onGitHub, ".bend.json"), '{"tracker": "github", "repository": "a/b"}');
  // No beads program on the machine: nothing of beads is asked for.
  const { trackerFor, aboutOf, watchOf, problem, forget } = build(null);
  assert.equal(aboutOf(onGitHub), null);
  const found = await trackerFor(onGitHub);
  assert.ok("tracker" in found, JSON.stringify(found));
  assert.deepEqual(aboutOf(onGitHub), {
    tracker: "github",
    repository: "a/b",
    linkKinds: ["blocked-by", "discovered-from", "related"],
    queued: true,
  });
  // Its copy is what changes; there is no file of the tracker's to watch.
  assert.equal(watchOf(onGitHub).sign, null);
  // A beads folder says the other thing about its changes.
  const beads = build();
  assert.ok("tracker" in (await beads.trackerFor(withBeads)));
  assert.equal(beads.aboutOf(withBeads)?.tracker, "beads");
  assert.equal(beads.aboutOf(withBeads)?.queued, false);
  // Not signed in is a state of its own, in bend's words, and the folder
  // is looked at again afterwards.
  assert.deepEqual(
    problem(onGitHub, new BendFailure("not-signed-in", "Not signed in to GitHub. Sign in.")),
    { state: "no-login", message: "Not signed in to GitHub. Sign in." },
  );
  assert.equal(aboutOf(onGitHub), null);
  assert.ok("tracker" in (await trackerFor(onGitHub)));
  forget(onGitHub);
  assert.equal(aboutOf(onGitHub), null);
});

test("a tracker changed outside the tab is noticed at the next look", async () => {
  const moving = join(base, "moving");
  mkdirSync(join(moving, ".beads"), { recursive: true });
  const { trackerFor, aboutOf } = build();
  const first = await trackerFor(moving);
  assert.ok("tracker" in first);
  assert.equal(aboutOf(moving)?.tracker, "beads");
  // Unchanged: the same tracker, without asking bend again.
  const again = await trackerFor(moving);
  assert.ok("tracker" in again && again.tracker === first.tracker);
  // The setting file now says GitHub issues, as `bend setup tracker` in a
  // terminal would write it.
  writeFileSync(join(moving, ".bend.json"), '{"tracker": "github", "repository": "a/b"}');
  const moved = await trackerFor(moving);
  assert.ok("tracker" in moved && moved.tracker !== first.tracker);
  assert.deepEqual(
    [aboutOf(moving)?.tracker, aboutOf(moving)?.queued, aboutOf(moving)?.repository],
    ["github", true, "a/b"],
  );
  // And back.
  rmSync(join(moving, ".bend.json"));
  assert.ok("tracker" in (await trackerFor(moving)));
  assert.equal(aboutOf(moving)?.tracker, "beads");
});

test("a folder's tracker is kept, and looked for again once a program has gone", async () => {
  const { trackerFor, problem, searches } = build();
  const first = await trackerFor(withBeads);
  const second = await trackerFor(withBeads);
  assert.ok("tracker" in first && "tracker" in second);
  assert.equal(first.tracker, second.tracker);
  assert.equal(searches(), 1);
  problem(withBeads, new BendFailure("no-program", "gone"));
  const third = await trackerFor(withBeads);
  assert.ok("tracker" in third && third.tracker !== first.tracker);
  assert.equal(searches(), 2);
  // A folder that is not set up is not kept: setting it up must show.
  const { trackerFor: again, searches: looked } = build();
  await again(without);
  await again(without);
  assert.equal(looked(), 2);
});

test("a run reports bend's own kind of failure, a missing program, and nonsense", async () => {
  const fails = async (run: ReturnType<typeof createRun>, args: string[]) => {
    try {
      await run(args);
    } catch (cause) {
      assert.ok(cause instanceof BendFailure);
      return [cause.kind, cause.message];
    }
    return assert.fail("the run did not fail");
  };
  assert.deepEqual(await fails(createRun(bend!, withBeads), ["list", "--wat"]), [
    "usage",
    "Unknown option --wat.",
  ]);
  // A tracker the tab does not accept is passed over.
  writeFileSync(join(without, ".bend.json"), '{"tracker": "github", "repository": "a/b"}');
  const [kind] = await fails(createRun(bend!, without, { BEND_ACCEPT: "beads" }), ["list"]);
  assert.equal(kind, "not-set-up");
  rmSync(join(without, ".bend.json"));
  const [missing] = await fails(createRun(join(base, "no-such-bend"), withBeads), ["version"]);
  assert.equal(missing, "no-bend");
  // The beads program the plugin found is the one bend runs.
  const [noBd] = await fails(
    createRun(bend!, withBeads, { BEND_BD: join(base, "no-such-bd") }),
    ["list"],
  );
  assert.equal(noBd, "no-program");
  const talker = join(base, "talker");
  writeFileSync(talker, "#!/bin/sh\necho hello\n");
  chmodSync(talker, 0o755);
  assert.deepEqual(await fails(createRun(talker, withBeads), ["version"]), [
    "not-understood",
    "hello",
  ]);
});

test("bend is found among the candidates; one that is not bend, or too old, is 'old'", async () => {
  const gone = join(base, "no-such-bend");
  assert.equal(await findBendAmong([gone, bend!], base), bend);
  assert.equal(await findBendAmong([gone], base), "missing");
  assert.equal(await findBendAmong([], base), "missing");
  const old = join(base, "old-bend");
  writeFileSync(old, `#!/bin/sh\necho '{"version": ${NEEDED_VERSION - 1}}'\n`);
  chmodSync(old, 0o755);
  assert.equal(await findBendAmong([gone, old], base), "old");
  // A newer one further down the list is still found.
  assert.equal(await findBendAmong([old, bend!], base), bend);
});

test("every operation is one run, with free text where it cannot be read as an option", async () => {
  const runs: { args: string[]; input: string | undefined }[] = [];
  const tracker = trackerOver(async (args, input) => {
    runs.push({ args, input });
    return args[0] === "create" ? { ok: true, id: "t-1" } : [];
  });
  assert.equal(
    await tracker.create({ title: "--help", description: "-d", priority: 0, parentId: "t-0" }),
    "t-1",
  );
  await tracker.edit("t-1", {
    title: "-t",
    category: null,
    addLabels: ["step:plan"],
    removeLabels: ["step:define"],
    metadata: { branch: "x", gone: null },
  });
  await tracker.edit("t-1", {});
  await tracker.writeBody("t-1", "--body");
  await tracker.comment("t-1", "-c", "sam");
  await tracker.move("t-1", null);
  await tracker.move("t-1", "t-0");
  await tracker.link("t-1", "t-0", "blocked-by");
  await tracker.unlink("t-1", "t-0", true);
  await tracker.list();
  assert.deepEqual(runs, [
    {
      args: ["create", "--description", "-d", "--priority", "0", "--parent", "t-0", "--", "--help"],
      input: undefined,
    },
    {
      args: [
        "edit", "--title", "-t", "--no-category", "--add-label", "step:plan",
        "--remove-label", "step:define", "--set-data", "branch=x", "--unset-data", "gone",
        "--", "t-1",
      ],
      input: undefined,
    },
    // An edit that changes nothing runs nothing.
    { args: ["write", "--text-file", "-", "--", "t-1", "body"], input: "--body" },
    { args: ["comment", "--as", "sam", "--text-file", "-", "--", "t-1"], input: "-c" },
    { args: ["move", "--top", "--", "t-1"], input: undefined },
    { args: ["move", "--under", "t-0", "--", "t-1"], input: undefined },
    { args: ["link", "--kind", "blocked-by", "--", "t-1", "t-0"], input: undefined },
    { args: ["unlink", "--from-first", "--", "t-1", "t-0"], input: undefined },
    { args: ["list", "--status", "all", "--with-body"], input: undefined },
  ]);
});
