// server/setup.test.ts — tests for how beads' list of saved facts is read.
//
// What: checks that the facts saved with `bd remember` are read from what
// `bd memories --json` prints: one object, key to text, with the version
// of its own schema beside them.
// Why: setup offers these facts to the owner to carry over to FACTS.md
// (bead-bb-c9l.8). The version line is not a fact, and an answer in another
// shape must give "none", not an error on the setup screen. The shape is
// what beads printed on 2026-10-10.

import assert from "node:assert/strict";
import { test } from "node:test";
import { savedFactsFrom } from "./setup.ts";

test("saved facts are read as key and text; the schema's version is not one", () => {
  assert.deepEqual(
    savedFactsFrom('{"build": "Run npm test", "ids": "Monospace", "schema_version": 1}'),
    [
      { key: "build", text: "Run npm test" },
      { key: "ids", text: "Monospace" },
    ],
  );
  assert.deepEqual(savedFactsFrom('{"schema_version": 1}'), []);
});

test("anything else is no facts", () => {
  for (const said of ["", "null", "[]", '"text"', "not json", '{"a": 3, "b": null}']) {
    assert.deepEqual(savedFactsFrom(said), [], said);
  }
});

// --- The switch-over, in a real repository (bead-bb-c9l.8) ---
//
// A throwaway repository is set up the way beads does it by default, with
// beads' own setup for both coding agents, and then put through the two
// setup steps. Needs `bd`, `git` and Go (the facts file is bend's to look
// after); skipped where they are missing. The
// pieces of BB the setup is built with are a few lines each.

test("a repository set up the old way is switched over: beads' text and hooks out, ours in", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createSetup } = await import("./setup.ts");
  const { createRun } = await import("./bend.ts");
  const { builtBend } = await import("./bend-for-tests.ts");
  const bend = builtBend();
  if (bend === null) return t.skip("bend cannot be built here (Go is not installed)");
  const { rulesIn, hasBeadsBlocks } = await import("./prompts.ts");
  const root = mkdtempSync(join(tmpdir(), "airbender-setup-"));
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
    const before = readFileSync(agentsFile, "utf8");
    assert.ok(hasBeadsBlocks(before));

    const setup = createSetup({
      bb: { realtime: { publish: () => {} }, log: { warn: () => {} } } as never,
      folders: {
        resolveFolder: async () => ({ path: root }),
        findBd: async () => "bd",
        findBend: async () => bend,
        mainFolder: async () => root,
      } as never,
      store: { readIssues: async () => ({ state: "ok", issues: [] }) } as never,
      bendIn: async (path: string) => ({ run: createRun(bend, path) }),
      syncSteps: async () => ({ on: null, fetch: null }),
    });
    const here = { threadId: null, projectId: "p" };

    let status = await setup.setupStatus(here);
    assert.equal(status.rulesPresent, false);
    assert.equal(status.instructions.rules, "none");
    assert.deepEqual(status.instructions.beadsBlocks, ["AGENTS.md", "CLAUDE.md"]);
    assert.deepEqual(status.instructions.beadsHooks, ["Claude Code", "Codex"]);
    assert.ok(status.instructions.leftovers.includes("Quick Reference"));
    // The facts are offered only once the instructions are in place.
    assert.deepEqual(status.savedFacts.map((fact) => fact.key).sort(), ["build", "no-close"]);

    assert.deepEqual(await setup.runSetup({ ...here, action: "rules", option: null }), { message: null });
    const after = readFileSync(agentsFile, "utf8");
    assert.equal(hasBeadsBlocks(after), false);
    assert.equal(rulesIn(after), "current");
    assert.ok(after.includes("## Mine\n\nMy own rules.\n"));
    // Beads' unmarked text is still there: it is the owner's to remove.
    assert.match(after, /## Quick Reference/u);
    assert.equal(hasBeadsBlocks(readFileSync(join(root, "CLAUDE.md"), "utf8")), false);
    assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /^@AGENTS\.md\n@FACTS\.md$/mu);
    assert.ok(existsSync(join(root, "FACTS.md")));
    // Beads' own check now says neither agent is set up.
    for (const agent of ["claude", "codex"]) {
      assert.throws(() => run("bd", "setup", agent, "--check"), Error, agent);
    }
    // The hooks themselves are gone from their files, which is the point:
    // beads' check alone says "not installed" as soon as its block is out
    // of CLAUDE.md, with the session-start hook still in place.
    assert.doesNotMatch(readFileSync(join(root, ".claude", "settings.json"), "utf8"), /bd prime/u);
    assert.equal(existsSync(join(root, ".codex", "hooks.json")), false);

    status = await setup.setupStatus(here);
    assert.equal(status.rulesPresent, true);
    assert.deepEqual(status.instructions.beadsBlocks, []);
    assert.equal(
      (await setup.runSetup({ ...here, action: "rules", option: null })).message,
      "Airbender's instructions are already in place.",
    );

    // One of the two facts is carried over; the other stays in beads, and
    // neither is offered again.
    assert.deepEqual(
      await setup.runSetup({ ...here, action: "facts", option: '["build"]' }),
      { message: null },
    );
    const facts = readFileSync(join(root, "FACTS.md"), "utf8");
    assert.match(facts, /^- \*\*build\*\* — Run npm test before handing over$/mu);
    assert.doesNotMatch(facts, /no-close/u);
    assert.deepEqual((await setup.setupStatus(here)).savedFacts, []);
    assert.match(run("bd", "memories"), /no-close/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
