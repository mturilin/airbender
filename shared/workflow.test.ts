// shared/workflow.test.ts — tests for the issue state machine.
//
// What: checks the generic rules (shared/workflow.ts) and the one workflow in
// use (shared/standard-workflow.ts): which moves are allowed, to whom, and
// which are refused.
//
// Why: the point of the state machine is that an issue cannot be closed
// without passing through it, and that the agent cannot make the user's
// moves. Those guarantees are exactly what these tests pin down.
//
// Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_TOOL, standardWorkflow as flow } from "./standard-workflow.ts";
import { CLOSED, checkMove, movesFor, problemsIn, stateOf } from "./workflow.ts";
import type { Actor } from "./workflow.ts";

/** Where a move leads, or the refusal's message. */
function go(step: string | null, moveId: string, by: Actor, note = "because"): string {
  const move = checkMove(flow, step, moveId, by, note);
  return "message" in move ? `refused: ${move.message}` : move.to;
}

test("the workflow hangs together", () => {
  assert.deepEqual(problemsIn(flow), []);
});

test("an issue with no state, or an unknown one, is at the first state", () => {
  assert.equal(stateOf(flow, null).id, "define");
  assert.equal(stateOf(flow, "something-old").id, "define");
  assert.equal(stateOf(flow, "plan").id, "plan");
});

test("the whole path, each move made by the one whose move it is", () => {
  const path: [string, string, Actor][] = [
    ["define", "done", "agent"],
    ["review-definition", "approve", "user"],
    ["plan", "done", "agent"],
    ["review-plan", "approve", "user"],
    ["implement", "done", "agent"],
    ["agent-review", "pass", "agent"],
    ["user-review", "accept", "user"],
  ];
  const order = flow.states.map((state) => state.id);
  path.forEach(([from, moveId, by], index) => {
    assert.equal(from, order[index]);
    assert.equal(go(from, moveId, by), order[index + 1] ?? CLOSED);
  });
});

test("the agent cannot make the user's moves", () => {
  for (const [step, moveId] of [
    ["review-definition", "approve"],
    ["review-plan", "approve"],
    ["user-review", "accept"],
    ["user-review", "send-back"],
  ] as const) {
    assert.match(go(step, moveId, "agent"), /^refused: .*not the agent's move/u);
  }
});

test("nothing closes an issue except the user's acceptance at the last step", () => {
  const closing = flow.moves.filter((move) => move.to === CLOSED);
  assert.equal(closing.length, 1);
  assert.equal(closing[0]!.from, "user-review");
  assert.deepEqual(closing[0]!.by, ["user"]);
  assert.equal(closing[0]!.commit, true);
});

test("a move cannot jump ahead", () => {
  assert.match(go("define", "approve", "user"), /^refused: .*no move called "approve"/u);
  assert.match(go("plan", "accept", "user"), /^refused/u);
  assert.match(go("implement", "skip", "agent"), /^refused/u);
  assert.match(go("agent-review", "skip", "user"), /^refused/u);
});

test("define and plan can be skipped, with a reason", () => {
  assert.equal(go("define", "skip", "agent", "one-line fix"), "plan");
  assert.equal(go("plan", "skip", "user", "obvious"), "implement");
  assert.match(go("define", "skip", "agent", "  "), /^refused: .*needs a reason/u);
});

test("sending back needs a reason and returns to the work step", () => {
  assert.equal(go("review-definition", "send-back", "user", "too vague"), "define");
  assert.equal(go("review-plan", "send-back", "user", "too big"), "plan");
  assert.equal(go("user-review", "send-back", "user", "broken"), "implement");
  assert.equal(go("agent-review", "send-back", "agent", "test fails"), "implement");
  assert.match(go("review-plan", "send-back", "user", ""), /^refused: .*needs a reason/u);
});

test("the user can report a step the agent finished without saying so", () => {
  assert.equal(go("define", "done", "user"), "review-definition");
  assert.equal(go("implement", "done", "user"), "agent-review");
  assert.equal(go("agent-review", "pass", "user"), "user-review");
});

test("a refusal says what is allowed instead", () => {
  assert.match(go("plan", "approve", "agent"), /The agent may: "done".*"skip"/u);
  assert.match(go("review-plan", "done", "agent"), /nothing for the agent to do; it waits for the user/u);
});

test("the user's main button comes first, and agent states have none", () => {
  assert.equal(movesFor(flow, "review-plan", "user")[0]!.id, "approve");
  assert.equal(movesFor(flow, "user-review", "user")[0]!.label, "Accept & commit");
  for (const state of flow.states.filter((s) => s.actor === "agent")) {
    assert.ok(!movesFor(flow, state.id, "user").some((move) => move.primary));
    assert.ok(state.runLabel);
  }
});

test("the agent is told its step, how to report it, and about sub-issues", () => {
  const issue = { id: "x-1", title: 'Fix "it"', openSubIssues: [] };
  for (const state of flow.states.filter((s) => s.actor === "agent")) {
    const text = flow.instruction(state, issue);
    assert.match(text, /Work on beads issue x-1: "Fix \\"it\\""/u);
    assert.ok(text.includes(`"${state.label}" step`));
    assert.ok(text.includes(MOVE_TOOL), state.id);
    // Every move the agent may make in this state is named in its text.
    for (const move of movesFor(flow, state.id, "agent")) {
      assert.ok(text.includes(`move \`${move.id}\``), `${state.id}: ${move.id}`);
    }
  }
  const epic = flow.instruction(stateOf(flow, "plan"), {
    ...issue,
    openSubIssues: [{ id: "x-1.1", title: "part" }],
  }, "too big");
  assert.match(epic, /- x-1\.1: "part"/u);
  assert.match(epic, /sent back to this step with this note: too big/u);
});

test("the standing instructions name every step and the tool", () => {
  const text = flow.describeForAgents();
  for (const state of flow.states) assert.ok(text.includes(state.label));
  assert.ok(text.includes(MOVE_TOOL));
});
