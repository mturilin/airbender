// server/agent-tools.test.ts — tests for what the agent's tools say and
// when "set the current issue" is refused.
//
// What: checks that both tools' instructions begin with when they apply,
// and that an issue may only become current when it is an open issue of a
// folder whose issues can be read.
//
// Why: the tools are offered to every thread, in any folder (bead-bb-8fm).
// Instructions that claimed "this repository tracks work in beads" would be
// false in most folders, and a tool that stored an id where there is no
// beads would show the user a current issue that does not exist.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_TOOL, standardWorkflow } from "../shared/standard-workflow.ts";
import {
  CURRENT_TOOL,
  CURRENT_TOOL_INSTRUCTIONS,
  currentRefusal,
  moveToolInstructions,
  switchNote,
  workflowLine,
} from "./agent-tools.ts";
import type { Issue } from "./contract.ts";

/** An issue with only what the check reads. */
const issue = (id: string, status: string) => ({ id, status }) as Issue;

const readable = {
  state: "ok" as const,
  path: "/repo",
  message: null,
  issues: [issue("proj-a1b", "open"), issue("proj-c2d", "closed")],
};

test("both tools' instructions begin with when they apply", () => {
  assert.match(CURRENT_TOOL_INSTRUCTIONS, /^This applies only if the folder/u);
  const text = moveToolInstructions(standardWorkflow.describeForAgents());
  assert.match(text, /^This applies only if the folder/u);
  assert.match(text, /standard workflow/u);
  assert.match(text, /simple workflow/u);
  // The workflow's own text follows, whole.
  assert.ok(text.endsWith(standardWorkflow.describeForAgents()));
});

test("an open issue of a readable folder may become current", () => {
  assert.equal(currentRefusal(readable, "proj-a1b"), null);
});

test("a closed issue, or an id that is not there, is refused", () => {
  assert.match(currentRefusal(readable, "proj-c2d") ?? "", /is closed/u);
  assert.match(
    currentRefusal(readable, "proj-zzz") ?? "",
    /No issue with id proj-zzz in \/repo/u,
  );
});

test("a folder whose issues cannot be read refuses, with the folder's reason", () => {
  for (const state of ["no-beads", "no-bd", "unavailable", "error"] as const) {
    const refusal = currentRefusal(
      { state, path: "/repo", message: "No beads here.", issues: [] },
      "proj-a1b",
    );
    assert.match(refusal ?? "", /No beads here\./u);
    assert.match(refusal ?? "", /only applies in a folder that tracks its issues with Airbender/u);
  }
  // A missing reason still gives a sentence.
  assert.match(
    currentRefusal(
      { state: "no-beads", path: null, message: null, issues: [] },
      "proj-a1b",
    ) ?? "",
    /cannot be read/u,
  );
});

test("the agent is told which workflow applies and where the issue stands", () => {
  const simple = workflowLine(null, "plan");
  assert.match(simple, /simple workflow/u);
  assert.match(simple, /do not call airbender_workflow_move/u);
  // A step kept from before the switch is not mentioned on Simple.
  assert.doesNotMatch(simple, /Plan/u);
  const agents = workflowLine(standardWorkflow, "plan");
  assert.match(agents, /standard workflow/u);
  assert.match(agents, /"Plan" step \(the agent's work\)/u);
  assert.match(
    workflowLine(standardWorkflow, "review-plan"),
    /"Review plan" step \(waiting for the user\)/u,
  );
  // An issue with no step yet is at the workflow's first one.
  assert.match(workflowLine(standardWorkflow, null), /"Not started" step/u);
});

test("a switch of workflow is told as a note that asks for nothing", () => {
  for (const to of ["simple", "standard"] as const) {
    const note = switchNote(to);
    assert.match(note, /^FYI: the user switched this repository/u);
    assert.match(note, new RegExp(`${to} workflow`, "u"));
    assert.match(note, /No action is needed\.$/u);
  }
  assert.match(switchNote("simple"), /do not call airbender_workflow_move/u);
});

test("the step tool's standing instructions fit the limit BB sets", () => {
  // BB refuses to load a plugin whose tool instructions exceed 4096
  // characters (found when the epic's step was added, bead-bb-ty5.2).
  assert.ok(
    moveToolInstructions(standardWorkflow.describeForAgents()).length <= 4096,
  );
});

test("the tools have their names, and nothing an agent reads names an earlier one", () => {
  assert.equal(CURRENT_TOOL, "airbender_set_current");
  assert.equal(MOVE_TOOL, "airbender_workflow_move");
  // The standing texts name bend and the new names only.
  const texts = [
    CURRENT_TOOL_INSTRUCTIONS,
    moveToolInstructions(standardWorkflow.describeForAgents()),
  ].join("\n");
  assert.doesNotMatch(texts, /\bbd\b|beads_|beads issue/u);
  assert.match(texts, /`bend start`/u);
});
