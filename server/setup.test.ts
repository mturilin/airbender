// server/setup.test.ts — the tab's setup, over `bend setup`.
//
// What: checks how bend's setup state is put into the shape the tab draws
// (pure), and puts a real throwaway repository, set up the way beads does
// it by default, through the tab's setup actions.
//
// Why: what the steps are and do is bend's and is tested there
// (bend/e2e/setup_test.go). What is the plugin's is the translation, which
// step the tab runs for which button, and that the tab's answer follows
// what was done; a slip there shows the wrong card or runs the wrong step.
//
// Gotchas:
// - The second test needs `bd`, `git` and Go (to build bend); it is skipped
//   where they are missing. The pieces of BB the setup is built with are a
//   few lines each.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBend, type BendSetup } from "./setup.ts";

/** A step as bend gives it. */
const step = (
  name: string,
  state: BendSetup["steps"][number]["state"],
  over: Partial<BendSetup["steps"][number]> = {},
) => ({ name, title: `Title of ${name}`, state, why: `Why ${name}.`, command: "", runs: "", explain: [], ...over });

/** bend's state with these steps, and nothing else of note. */
const bendState = (steps: BendSetup["steps"], over: Partial<BendSetup> = {}): BendSetup => ({
  root: "/r",
  tracker: "beads",
  ready: false,
  steps,
  installMethods: [],
  issuesHow: "",
  foreign: null,
  elsewhere: false,
  instructions: {
    rules: "none",
    rulesVersion: 0,
    currentVersion: 4,
    claudeFile: "none",
    claudeRules: "none",
    imports: false,
    beadsBlocks: [],
    beadsHooks: [],
    machineWide: [],
    leftovers: [],
  },
  savedFacts: [],
  ...over,
});

test("bend's steps become the tab's conditions; 'not needed' counts as in place", () => {
  const fresh = fromBend(
    bendState(
      [
        step("tracker", "missing"),
        step("program", "blocked"),
        step("issues", "blocked"),
        step("instructions", "blocked"),
        step("facts", "not-needed"),
        step("publish", "blocked"),
      ],
      { tracker: null },
    ),
  );
  assert.deepEqual(
    [fresh.trackerChosen, fresh.bdInstalled, fresh.folderReady, fresh.rulesPresent],
    [false, false, false, false],
  );
  assert.deepEqual(fresh.syncSteps, { on: null, fetch: null });
  // Blocked for an earlier step is still said: the tab names that step.
  assert.equal(fresh.issuesBlocked, "Why issues.");

  const onGitHub = fromBend(
    bendState(
      [
        step("tracker", "done"),
        step("program", "not-needed"),
        step("issues", "done"),
        step("instructions", "done"),
        step("facts", "not-needed"),
        step("publish", "not-needed"),
      ],
      { tracker: "github", ready: true },
    ),
  );
  assert.deepEqual(
    [onGitHub.tracker, onGitHub.trackerChosen, onGitHub.bdInstalled, onGitHub.folderReady, onGitHub.rulesPresent],
    ["github", true, true, true, true],
  );
});

test("the steps whose words are bend's come through with what they run", () => {
  const steps = [
    step("tracker", "done"),
    step("program", "done"),
    step("issues", "missing", {
      title: "Get this repository's issues",
      runs: "bd bootstrap --yes",
      explain: ["It downloads the issues."],
    }),
    step("instructions", "blocked"),
    step("facts", "missing"),
    step("publish", "missing", { runs: "bd dolt push --yes && bd sync", explain: ["It publishes."] }),
  ];
  const saved = [{ key: "build", text: "Run make" }];
  const fetching = fromBend(bendState(steps, { issuesHow: "fetch", savedFacts: saved }));
  assert.deepEqual(fetching.syncSteps.fetch, {
    label: "Get this repository's issues",
    why: "Why issues.",
    explain: { lead: "Runs `bd bootstrap --yes` in this folder.", points: ["It downloads the issues."] },
  });
  assert.equal(fetching.syncSteps.on?.explain.lead, "Runs `bd dolt push --yes && bd sync` in this folder.");
  assert.deepEqual(fetching.savedFacts, saved);
  // Starting a database is the tab's own step, with its own words.
  assert.equal(fromBend(bendState(steps, { issuesHow: "init" })).syncSteps.fetch, null);
  // Facts are offered only while their step is missing.
  const looked = steps.map((one) => (one.name === "facts" ? step("facts", "done") : one));
  assert.deepEqual(fromBend(bendState(looked, { savedFacts: saved })).savedFacts, []);
});

test("someone else's project and the command that sets up beads reach the tab (bead-bb-dof)", () => {
  const steps = [
    step("tracker", "missing"),
    step("program", "done"),
    step("issues", "missing", { runs: "bd init --skip-agents --non-interactive --role maintainer" }),
  ];
  const foreign = { repository: "them/project", fork: true, canPush: null };
  const fresh = fromBend(bendState(steps, { issuesHow: "init", foreign }));
  assert.deepEqual(fresh.foreign, foreign);
  assert.equal(fresh.elsewhere, false);
  assert.equal(fresh.initRuns, "bd init --skip-agents --non-interactive --role maintainer");
  // Getting the issues of a fresh clone is not setting up beads.
  assert.equal(fromBend(bendState(steps, { issuesHow: "fetch" })).initRuns, null);
  assert.equal(fromBend(bendState(steps, { elsewhere: true })).elsewhere, true);
});

// --- The switch-over, in a real repository (bead-bb-c9l.8, now through
// bend: bead-bb-c9l.9) ---

test("a repository set up the old way is switched over by the tab's actions", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createSetup } = await import("./setup.ts");
  const { createRun } = await import("./bend.ts");
  const { builtBend } = await import("./bend-for-tests.ts");
  const bend = builtBend();
  if (bend === null) return t.skip("bend cannot be built here (Go is not installed)");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airbender-setup-")));
  try {
    const run = (program: string, ...args: string[]) =>
      execFileSync(program, args, { cwd: root, stdio: "pipe", encoding: "utf8" });
    try {
      run("git", "init", "-q");
      run("bd", "init", "--prefix", "t", "--non-interactive");
      run("bd", "setup", "claude");
      run("bd", "setup", "codex");
      run("bd", "remember", "Run npm test before handing over", "--key", "build");
      run("bd", "remember", "Agents do not close issues", "--key", "no-close");
    } catch {
      return t.skip("bd or git is not available");
    }
    // The owner's own text, around what beads wrote.
    const agentsFile = join(root, "AGENTS.md");
    writeFileSync(agentsFile, `${readFileSync(agentsFile, "utf8")}\n## Mine\n\nMy own rules.\n`);

    let published = 0;
    const setup = createSetup({
      bb: { realtime: { publish: () => void (published += 1) }, log: { warn: () => {} } } as never,
      folders: {
        resolveFolder: async () => ({ path: root }),
        findBd: async () => "bd",
        findBend: async () => bend,
      } as never,
      store: { stale: () => {} } as never,
      bendIn: async (path: string) => ({ run: createRun(bend, path) }),
    });
    const here = { threadId: null, projectId: "p" };

    let status = await setup.setupStatus(here);
    assert.deepEqual(
      [status.bend, status.tracker, status.trackerChosen, status.bdInstalled, status.folderReady, status.rulesPresent],
      ["ready", "beads", true, true, true, false],
    );
    assert.equal(status.instructions.rules, "none");
    assert.deepEqual(status.instructions.beadsBlocks, ["AGENTS.md", "CLAUDE.md"]);
    assert.deepEqual(status.instructions.beadsHooks, ["Claude Code", "Codex"]);
    assert.ok(status.instructions.leftovers.includes("Quick Reference"));
    assert.deepEqual(status.savedFacts.map((fact) => fact.key).sort(), ["build", "no-close"]);
    // No remote to publish to: not offered.
    assert.equal(status.syncSteps.on, null);

    // The CLAUDE.md beads generated is a file of its own: what it is to be
    // has to be said, and the tab passes the owner's answer on.
    assert.deepEqual(
      [status.instructions.claudeFile, status.instructions.claudeRules],
      ["file", "none"],
    );
    assert.match(
      (await setup.runSetup({ ...here, action: "rules", option: null })).message ?? "",
      /--claude link or --claude rules/u,
    );
    assert.deepEqual(await setup.runSetup({ ...here, action: "rules", option: "claude:link" }), {
      message: null,
    });
    assert.equal(published, 2);
    const after = readFileSync(agentsFile, "utf8");
    assert.doesNotMatch(after, /BEGIN BEADS/u);
    assert.match(after, /<!-- airbender:rules:start -->/u);
    assert.ok(after.includes("## Mine\n\nMy own rules.\n"));
    // A link to AGENTS.md now, and no line that imports a file anywhere.
    assert.equal(readlinkSync(join(root, "CLAUDE.md")), "AGENTS.md");
    assert.doesNotMatch(after, /^@(AGENTS|FACTS)\.md$/mu);
    assert.ok(existsSync(join(root, "FACTS.md")));
    assert.doesNotMatch(readFileSync(join(root, ".claude", "settings.json"), "utf8"), /bd prime/u);
    // What was kept about the folder was dropped: the answer follows at once.
    status = await setup.setupStatus(here);
    assert.equal(status.rulesPresent, true);
    assert.deepEqual(status.instructions.beadsHooks, []);
    // Done twice: bend says so, and the tab passes its words on as success.
    assert.deepEqual(await setup.runSetup({ ...here, action: "rules", option: null }), { message: null });

    assert.match(
      (await setup.runSetup({ ...here, action: "facts", option: "not json" })).message ?? "",
      /not understood/u,
    );
    assert.deepEqual(await setup.runSetup({ ...here, action: "facts", option: '["build"]' }), { message: null });
    const facts = readFileSync(join(root, "FACTS.md"), "utf8");
    assert.match(facts, /- \*\*build\*\* — Run npm test before handing over/u);
    assert.doesNotMatch(facts, /no-close/u);
    status = await setup.setupStatus(here);
    assert.deepEqual(status.savedFacts, []);

    // Steps that cannot apply are refused in words, and open no terminal
    // (there is none to open here: that would throw).
    assert.match((await setup.runSetup({ ...here, action: "init", option: null })).message ?? "", /already set up/u);
    assert.match((await setup.runSetup({ ...here, action: "sync", option: null })).message ?? "", /already synced/u);
    assert.match((await setup.runSetup({ ...here, action: "install", option: "script" })).message ?? "", /already installed/u);
    assert.match((await setup.runSetup({ ...here, action: "tracker", option: "linear" })).message ?? "", /not understood/u);
    assert.match((await setup.runSetup({ ...here, action: "bend", option: null })).message ?? "", /already installed/u);

    // The owner changes the rules by hand, and they are from an earlier
    // version: the step is offered again, and needs to be told which.
    const mine = readFileSync(agentsFile, "utf8")
      .replace(/rules:version \d+ -->/u, "rules:version 1 -->")
      .replace("Every piece of work has an issue", "Every piece of work has an issue, here too");
    writeFileSync(agentsFile, mine);
    // Without the choice bend refuses in its own words and changes nothing.
    // (Asked first: the tab keeps "everything is in place" for a while, and
    // a step that was run makes it look again.)
    assert.match(
      (await setup.runSetup({ ...here, action: "rules", option: null })).message ?? "",
      /--rules replace or --rules keep/u,
    );
    assert.equal(readFileSync(agentsFile, "utf8"), mine);
    status = await setup.setupStatus(here);
    assert.equal(status.rulesPresent, false);
    assert.equal(status.instructions.rules, "behind");
    assert.equal(status.instructions.rulesVersion, 1);
    assert.ok(status.instructions.currentVersion > 1);
    // Keep: theirs stay, marked as compared with the current version.
    assert.deepEqual(await setup.runSetup({ ...here, action: "rules", option: "rules:keep" }), { message: null });
    assert.match(readFileSync(agentsFile, "utf8"), /has an issue, here too/u);
    status = await setup.setupStatus(here);
    assert.deepEqual([status.rulesPresent, status.instructions.rules], [true, "edited"]);
    // Replace: the current rules stand there.
    writeFileSync(agentsFile, mine);
    assert.deepEqual(await setup.runSetup({ ...here, action: "rules", option: "rules:replace" }), { message: null });
    assert.doesNotMatch(readFileSync(agentsFile, "utf8"), /here too/u);
    status = await setup.setupStatus(here);
    assert.deepEqual([status.rulesPresent, status.instructions.rules], [true, "current"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
