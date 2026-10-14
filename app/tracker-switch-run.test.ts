// app/tracker-switch-run.test.ts — tests for the order a switch of tracker
// is carried out in (tracker-switch-run.ts).
//
// Why: this order is what keeps a repository's tracker from being changed
// when the owner was told it would not be (bead-bb-c9l.18).

import assert from "node:assert/strict";
import { test } from "node:test";
import { runSwitch } from "./tracker-switch-run.ts";
import type { CopyEnd } from "./tracker-switch-run.ts";

/** A run over made-up steps, with what was done recorded. */
function made(over: { copy?: CopyEnd | Error; refused?: string | null; alive?: () => boolean } = {}) {
  const did: string[] = [];
  return {
    did,
    steps: {
      copy: async () => {
        did.push("copy");
        if (over.copy instanceof Error) throw over.copy;
        return over.copy ?? { failed: null, warnings: [] };
      },
      switchTracker: async () => {
        did.push("switch");
        return over.refused ?? null;
      },
      alive: over.alive ?? (() => true),
    },
  };
}

test("to GitHub issues: the copy first, then the switch", async () => {
  const { did, steps } = made();
  assert.deepEqual(await runSwitch({ to: "github", ...steps }), { switched: true, problem: null });
  assert.deepEqual(did, ["copy", "switch"]);
});

test("to GitHub issues: a copy that failed, or left issues out, switches nothing", async () => {
  for (const copy of [
    { failed: "GitHub answered 500.", warnings: [] },
    { failed: null, warnings: ["t-3 was not found on GitHub."] },
    new Error("the connection was lost"),
  ]) {
    const { did, steps } = made({ copy });
    const end = await runSwitch({ to: "github", ...steps });
    assert.equal(end.switched, false);
    assert.ok(end.problem !== null);
    assert.deepEqual(did, ["copy"]);
  }
  const said = await runSwitch({
    to: "github",
    ...made({ copy: { failed: null, warnings: ["t-3 was not found on GitHub."] } }).steps,
  });
  assert.match(said.problem ?? "", /nothing was switched:\nt-3 was not found/u);
});

test("to GitHub issues: a window closed during the copy switches nothing afterwards", async () => {
  const { did, steps } = made({ alive: () => false });
  assert.deepEqual(await runSwitch({ to: "github", ...steps }), { switched: false, problem: null });
  assert.deepEqual(did, ["copy"]);
});

test("to beads: the switch first, then the copy; a failed copy is said as that", async () => {
  const fine = made();
  assert.deepEqual(await runSwitch({ to: "beads", ...fine.steps }), { switched: true, problem: null });
  assert.deepEqual(fine.did, ["switch", "copy"]);
  const failing = made({ copy: { failed: "GitHub answered 500.", warnings: [] } });
  const end = await runSwitch({ to: "beads", ...failing.steps });
  assert.equal(end.switched, true);
  assert.match(end.problem ?? "", /now uses beads, but the issues were not all brought in/u);
});

test("a switch that is refused copies nothing after it, and switch only copies nothing at all", async () => {
  const refused = made({ refused: "Build bend first." });
  assert.deepEqual(await runSwitch({ to: "beads", ...refused.steps }), {
    switched: false,
    problem: "Build bend first.",
  });
  assert.deepEqual(refused.did, ["switch"]);
  const only = made();
  assert.deepEqual(await runSwitch({ to: "github", ...only.steps, copy: null }), {
    switched: true,
    problem: null,
  });
  assert.deepEqual(only.did, ["switch"]);
});
