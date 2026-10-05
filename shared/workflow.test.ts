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
import {
  CLOSED,
  checkMove,
  movesFor,
  nextWorkOf,
  problemsIn,
  runLabelOf,
  stateOf,
} from "./workflow.ts";
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
  assert.equal(stateOf(flow, null).id, "not-started");
  assert.equal(stateOf(flow, "something-old").id, "not-started");
  // It waits for the user to say go, but the work that follows is the agent's.
  assert.equal(stateOf(flow, null).actor, "user");
  assert.equal(nextWorkOf(stateOf(flow, null)), "agent");
  assert.equal(nextWorkOf(stateOf(flow, "review-plan")), "user");
  assert.equal(nextWorkOf(stateOf(flow, "plan")), "agent");
  assert.equal(stateOf(flow, "plan").id, "plan");
});

test("the whole path, each move made by the one whose move it is", () => {
  const path: [string, string, Actor][] = [
    ["not-started", "start", "user"],
    ["define", "done", "agent"],
    ["review-definition", "approve", "user"],
    ["plan", "done", "agent"],
    ["review-plan", "approve", "user"],
    ["implement", "done", "agent"],
    ["agent-review", "pass", "agent"],
    ["user-review", "accept", "user"],
    ["apply", "done", "agent"],
  ];
  const order = flow.states.map((state) => state.id);
  path.forEach(([from, moveId, by], index) => {
    assert.equal(from, order[index]);
    assert.equal(go(from, moveId, by), order[index + 1] ?? CLOSED);
  });
});

test("the agent cannot press the user's approval buttons", () => {
  for (const [step, moveId] of [
    ["review-definition", "approve"],
    ["review-plan", "approve"],
    ["user-review", "accept"],
  ] as const) {
    assert.match(go(step, moveId, "agent"), /^refused: .*not the agent's move/u);
  }
});

test("an issue closes only from the last step, which needs the user's acceptance", () => {
  const closing = flow.moves.filter((move) => move.to === CLOSED);
  assert.equal(closing.length, 1);
  assert.equal(closing[0]!.from, "apply");
  // Every way into that step starts at the user's review: their own
  // button, or their acceptance in the conversation recorded by the agent.
  const into = flow.moves.filter((move) => move.to === "apply");
  assert.deepEqual(into.map((move) => [move.from, move.id]).sort(), [
    ["user-review", "accept"],
    ["user-review", "approved"],
  ]);
  // Accepting does not close the issue: the work has to be applied first.
  assert.equal(go("user-review", "accept", "user"), "apply");
  assert.match(go("user-review", "done", "agent"), /^refused/u);
});

test("apply can go back to the work when it cannot be applied", () => {
  assert.equal(go("apply", "send-back", "agent", "merge conflict"), "implement");
  assert.match(go("apply", "send-back", "agent", ""), /^refused: .*needs a reason/u);
  // The user can report it applied, for work they committed by hand.
  assert.equal(go("apply", "done", "user"), CLOSED);
});

test("a move cannot jump ahead", () => {
  assert.match(go("define", "approve", "user"), /^refused: .*no move called "approve"/u);
  assert.match(go("plan", "accept", "user"), /^refused/u);
  assert.match(go("implement", "skip", "agent"), /^refused/u);
  assert.match(go("agent-review", "skip", "user"), /^refused/u);
});

test("a new issue is started by the user's main button, or by the agent", () => {
  const main = movesFor(flow, "not-started", "user")[0]!;
  assert.equal(main.id, "start");
  assert.equal(main.label, "Define");
  assert.equal(go(null, "start", "user", ""), "define");
  assert.equal(go(null, "start", "agent", ""), "define");
  // Not started is not the agent's step: it cannot report work from there.
  assert.match(go(null, "done", "agent"), /^refused: .*no move called "done"/u);
  assert.equal(go("not-started", "skip", "user", "already clear"), "plan");
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
  // At a review the agent has no "done": only the two moves that follow
  // from what the user says.
  assert.match(go("review-plan", "done", "agent"), /The agent may: "send-back".*"approved"/u);
});

test("the user's main button comes first, and agent states have none", () => {
  assert.equal(movesFor(flow, "review-plan", "user")[0]!.id, "approve");
  assert.equal(movesFor(flow, "user-review", "user")[0]!.label, "Accept");
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
    for (const move of movesFor(flow, state.id, "agent").filter(
      (candidate) => candidate.unlisted !== true,
    )) {
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

test("the agent can move an issue to any step when its own work is next", () => {
  // Leaving out steps that are not needed is the agent's judgment.
  assert.equal(go("define", "to:implement", "agent", "one-line fix"), "implement");
  assert.equal(go(null, "to:plan", "agent", "already defined"), "plan");
  assert.equal(go("implement", "to:define", "agent", "the request changed"), "define");
  assert.equal(go("agent-review", "to:user-review", "agent", "nothing to review"), "user-review");
  // Always with a reason.
  assert.match(go("define", "to:implement", "agent", ""), /^refused: .*needs a reason/u);
  // And these are the agent's moves, not buttons for the user.
  assert.match(go("define", "to:implement", "user"), /^refused/u);
});

test("while an issue waits for the user's review the agent may only move it back", () => {
  for (const step of ["review-definition", "review-plan", "user-review"]) {
    assert.match(go(step, "to:apply", "agent"), /^refused/u, step);
  }
  assert.match(go("review-definition", "to:plan", "agent"), /^refused/u);
  assert.match(go("review-plan", "to:implement", "agent"), /^refused/u);
  assert.match(go("review-plan", "to:user-review", "agent"), /^refused/u);
  assert.equal(go("review-plan", "to:plan", "agent", "user wants it smaller"), "plan");
  assert.equal(go("review-plan", "to:define", "agent", "the request changed"), "define");
  assert.equal(go("user-review", "to:implement", "agent", "user found a bug"), "implement");
});

test("the agent can never move an issue to Apply by its own judgment", () => {
  for (const state of flow.states) {
    assert.match(go(state.id, "to:apply", "agent"), /^refused/u, state.id);
  }
});

test("the agent moves an issue back when the user's reply asks for changes", () => {
  assert.equal(go("review-definition", "send-back", "agent", "user: add the edge case"), "define");
  assert.equal(go("review-plan", "send-back", "agent", "user: split it in two"), "plan");
  assert.equal(go("user-review", "send-back", "agent", "user: the button is off"), "implement");
});

test("the agent records an approval the user gave in the conversation, quoting them", () => {
  assert.equal(go("review-definition", "approved", "agent", "user: looks right"), "plan");
  assert.equal(go("review-plan", "approved", "agent", "user: go ahead with the plan"), "implement");
  assert.equal(go("user-review", "approved", "agent", "user: ship it"), "apply");
  // Not without their words, and not where there is nothing to approve.
  assert.match(go("review-plan", "approved", "agent", " "), /^refused: .*needs a reason/u);
  assert.match(go("plan", "approved", "agent", "x"), /^refused/u);
});

test("a refusal lists the moves particular to the step, not every jump", () => {
  const refusal = go("plan", "approve", "agent");
  assert.match(refusal, /"done"/u);
  assert.doesNotMatch(refusal, /"to:/u);
});

test("the Apply step's button says what applying will be", () => {
  const apply = stateOf(flow, "apply");
  assert.equal(apply.label, "Apply");
  assert.equal(runLabelOf(apply, { ownBranch: false }), "Commit");
  assert.equal(runLabelOf(apply, { ownBranch: true }), "Commit & merge");
  assert.equal(runLabelOf(stateOf(flow, "plan"), { ownBranch: true }), "Plan");
  assert.equal(runLabelOf(stateOf(flow, "review-plan"), { ownBranch: true }), "");
});

test("every step has a friendly sentence for the user, and the reviews ask for feedback", () => {
  for (const state of flow.states) {
    assert.ok(state.ask.length > 10, state.id);
    assert.match(state.ask, /\.$/u, state.id);
  }
  for (const step of ["review-definition", "review-plan", "user-review"]) {
    assert.match(stateOf(flow, step).ask, /^Please review .* give feedback\.$/u);
  }
  assert.equal(
    stateOf(flow, "user-review").ask,
    "Please review the results and give feedback.",
  );
});
