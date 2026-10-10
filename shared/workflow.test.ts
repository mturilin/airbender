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
import {
  MOVE_TOOL,
  branchName,
  standardWorkflow as flow,
} from "./standard-workflow.ts";
import {
  CLOSED,
  asOffered,
  checkMove,
  epicOver,
  menuMoves,
  movesFor,
  nextWorkOf,
  problemsIn,
  offeredMoves,
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
    ["apply", "commit", "user"],
    ["commit", "done", "agent"],
  ];
  const order = flow.states.map((state) => state.id);
  path.forEach(([from, moveId, by], index) => {
    assert.equal(from, order[index]);
    // The last step listed, "commit", is followed in the list of states by
    // its sibling "commit-merge"; finishing either closes the issue.
    assert.equal(
      go(from, moveId, by),
      from === "commit" ? CLOSED : order[index + 1],
    );
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

test("an issue closes only once its work is in git, which needs the user's acceptance", () => {
  // Closing happens only from the two steps where the agent commits.
  const closing = flow.moves.filter((move) => move.to === CLOSED);
  assert.deepEqual(closing.map((move) => move.from).sort(), ["commit", "commit-merge"]);
  // Merging is reached only from Apply, by the user's choice (their button,
  // or their words recorded by the agent). Committing is reached from Apply
  // too, and straight from the user's review, where accepting is the choice
  // when there is nothing else to choose.
  const from = (step: string) => [
    ...new Set(
      flow.moves.filter((move) => move.to === step).map((move) => move.from),
    ),
  ];
  // And, for an epic whose issues were worked on its own branch, from the
  // step it waits in: the user's Close & merge (bead-bb-ty5.2).
  assert.deepEqual(from("commit-merge").sort(), ["apply", "on-branch"]);
  assert.deepEqual(from("commit").sort(), ["apply", "user-review"]);
  // Either way it is the user's doing: their button, or their words quoted.
  for (const move of flow.moves.filter(
    (candidate) => candidate.to === "commit" || candidate.to === "commit-merge",
  )) {
    assert.ok(
      move.by.every((by) => by === "user") || move.needsNote === true,
      `${move.from}: ${move.id}`,
    );
  }
  // And Apply only from the user's review.
  const intoApply = flow.moves.filter((move) => move.to === "apply");
  assert.deepEqual(intoApply.map((move) => [move.from, move.id]).sort(), [
    ["user-review", "accept"],
    ["user-review", "approved"],
  ]);
  assert.equal(go("user-review", "accept", "user"), "apply");
  assert.match(go("user-review", "done", "agent"), /^refused/u);
});

test("at Apply the user chooses Commit or Commit & merge, and both close the issue", () => {
  const apply = stateOf(flow, "apply");
  assert.equal(apply.actor, "user");
  assert.equal(go("apply", "commit", "user"), "commit");
  assert.equal(go("apply", "commit-merge", "user"), "commit-merge");
  assert.equal(go("commit", "done", "agent"), CLOSED);
  assert.equal(go("commit-merge", "done", "agent"), CLOSED);
  // The agent cannot choose for the user...
  assert.match(go("apply", "commit", "agent"), /^refused/u);
  assert.match(go("apply", "commit-merge", "agent"), /^refused/u);
  // ...but records a choice the user made in the conversation, quoting them.
  assert.equal(go("apply", "approved:commit-merge", "agent", "user: commit and merge"), "commit-merge");
  assert.match(go("apply", "approved:commit", "agent", ""), /^refused: .*needs a reason/u);
});

test("Commit & merge is offered only when the work is on its own branch", () => {
  const labels = (ownBranch: boolean) =>
    offeredMoves(flow, "apply", "user", { ownBranch }).map((move) => move.label);
  assert.deepEqual(labels(true), ["Commit", "Commit & merge", "Send back"]);
  assert.deepEqual(labels(false), ["Commit", "Send back"]);
  // Elsewhere the branch makes no difference.
  assert.deepEqual(
    offeredMoves(flow, "review-plan", "user", { ownBranch: false }),
    movesFor(flow, "review-plan", "user"),
  );
});

test("committing can go back to the work when it cannot be done", () => {
  assert.equal(go("commit-merge", "send-back", "agent", "merge conflict"), "implement");
  assert.match(go("commit", "send-back", "agent", ""), /^refused: .*needs a reason/u);
  // The user can report it done, for work they committed by hand.
  assert.equal(go("commit", "done", "user"), CLOSED);
  // And can still change their mind at Apply.
  assert.equal(go("apply", "send-back", "user", "one more thing"), "implement");
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
  assert.equal(main.label, "Start");
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

test("only the Define button has an icon of its own; the others keep play", () => {
  const withIcon = flow.states
    .filter((state) => state.runIcon !== undefined)
    .map((state) => [state.id, state.runIcon]);
  assert.deepEqual(withIcon, [["define", "define"]]);
});

test("the agent is told its step, how to report it, and about sub-issues", () => {
  const issue = {
    id: "x-1",
    title: 'Fix "it"',
    size: null,
    openSubIssues: [],
  };
  for (const state of flow.states.filter((s) => s.actor === "agent")) {
    const text = flow.instruction(state, issue);
    assert.match(text, /Work on beads issue x-1: "Fix \\"it\\""/u);
    assert.ok(text.includes(`"${state.label}" step`));
    assert.ok(text.includes(MOVE_TOOL), state.id);
    // Every move the agent may make in this state is named in its text.
    // Define is checked on its own below: what it names depends on the
    // issue's size.
    if (state.id === "define") continue;
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
    for (const target of ["apply", "commit", "commit-merge"]) {
      assert.match(go(state.id, `to:${target}`, "agent"), /^refused/u, state.id);
    }
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

test("the agent sizes an issue first, and a small one goes straight to the work", () => {
  assert.deepEqual(
    flow.sizes?.map((size) => size.label),
    ["S", "M", "L"],
  );
  // The moves that record the size, and where each leaves the issue.
  assert.equal(go("define", "size:s", "agent", "one line fix"), "implement");
  assert.equal(go("define", "size:m", "agent", "worth agreeing on"), "define");
  assert.equal(go("define", "size:l", "agent", "touches everything"), "define");
  assert.match(go("define", "size:s", "agent", ""), /^refused: .*needs a reason/u);
  // Sizing through these moves is the agent's; the user has the dropdown.
  assert.match(go("define", "size:s", "user"), /^refused/u);
  for (const size of ["s", "m", "l"]) {
    const move = checkMove(flow, "define", `size:${size}`, "agent", "why");
    assert.ok(!("message" in move) && move.size === size);
  }
  // A small issue that is not small after all is re-sized from the work.
  assert.equal(go("implement", "size:m", "agent", "bigger than it looked"), "define");
  assert.match(go("implement", "size:s", "agent", "x"), /^refused/u);
});

test("what the agent is told at Define depends on the size", () => {
  const issue = { id: "x-1", title: "T", openSubIssues: [] };
  const define = stateOf(flow, "define");
  const unsized = flow.instruction(define, { ...issue, size: null });
  assert.match(unsized, /size the issue/u);
  for (const size of ["size:s", "size:m", "size:l"]) {
    assert.ok(unsized.includes(`\`${size}\``), size);
  }
  assert.match(unsized, /In doubt between two sizes, take the larger/u);
  // Small: nothing to define here, on to the work.
  assert.match(
    flow.instruction(define, { ...issue, size: "s" }),
    /move `to:implement`/u,
  );
  // Medium: definition and plan together, one review.
  const medium = flow.instruction(define, { ...issue, size: "m" });
  assert.match(medium, /define it and plan it together/u);
  assert.match(medium, /move `to:review-plan`/u);
  assert.equal(go("define", "to:review-plan", "agent", "both ready"), "review-plan");
  // Large: the definition alone, for its own review.
  const large = flow.instruction(define, { ...issue, size: "l" });
  assert.match(large, /move `done`/u);
  assert.doesNotMatch(large, /plan it together/u);
  // A small issue's work step says it is the whole job.
  assert.match(
    flow.instruction(stateOf(flow, "implement"), { ...issue, size: "s" }),
    /this step is the whole job/u,
  );
  assert.doesNotMatch(
    flow.instruction(stateOf(flow, "implement"), { ...issue, size: "l" }),
    /whole job/u,
  );
});

test("the size can be changed until the work reaches the user, and the agent is told how", () => {
  for (const step of ["not-started", "define", "review-plan", "implement", "agent-review"]) {
    assert.equal(flow.canResize?.(step), true, step);
  }
  for (const step of ["user-review", "apply", "commit", "commit-merge", "nowhere"]) {
    assert.equal(flow.canResize?.(step), false, step);
  }
  const text = flow.resizeInstruction?.(
    stateOf(flow, "implement"),
    { id: "x-1", title: "T", size: "m", openSubIssues: [] },
    "s",
    "m",
  );
  assert.match(text ?? "", /changed the size of beads issue x-1 \("T"\) from S to M/u);
  assert.match(text ?? "", /"Implement" step/u);
  assert.match(text ?? "", /move `to:<step id>`/u);
  // An issue that had no size yet.
  assert.match(
    flow.resizeInstruction?.(stateOf(flow, "define"), { id: "x-1", title: "T", size: "l", openSubIssues: [] }, null, "l") ?? "",
    /\("T"\) to L\./u,
  );
});

test("on the main branch accepting commits at once; on a branch of its own it leads to the choice", () => {
  const labels = (ownBranch: boolean) =>
    offeredMoves(flow, "user-review", "user", { ownBranch }).map((move) => move.label);
  assert.deepEqual(labels(false), ["Accept & commit", "Send back"]);
  assert.deepEqual(labels(true), ["Accept", "Send back"]);
  assert.equal(go("user-review", "accept-commit", "user"), "commit");
  assert.equal(go("user-review", "accept", "user"), "apply");
  // The agent cannot accept for the user, but records their words.
  assert.match(go("user-review", "accept-commit", "agent"), /^refused/u);
  assert.equal(go("user-review", "approved:commit", "agent", "user: looks good, commit it"), "commit");
  assert.match(go("user-review", "approved:commit", "agent", ""), /^refused: .*needs a reason/u);
});

test("the standing instructions tell the agent about sizes and that a question needs no issue", () => {
  const text = flow.describeForAgents();
  for (const size of ["`size:s`", "`size:m`", "`size:l`"]) assert.ok(text.includes(size));
  assert.match(text, /A plain question or a discussion needs no issue/u);
  assert.match(text, /`approved:commit`/u);
});

test("an issue can be started in a branch of its own, by the user or the agent", () => {
  assert.equal(go("not-started", "start-branch", "user", ""), "define");
  assert.equal(go(null, "start-branch", "agent", ""), "define");
  const move = checkMove(flow, null, "start-branch", "user", "");
  assert.ok(!("message" in move));
  if ("message" in move) return;
  assert.equal(move.label, "Start in branch");
  // It may not be started over uncommitted changes, and says what to do.
  assert.match(move.needsCleanFolder ?? "", /uncommitted changes.*Commit them before starting a branch/u);
  // Plain start has no such condition.
  const plain = checkMove(flow, null, "start", "user", "");
  assert.ok(!("message" in plain) && plain.needsCleanFolder === undefined);
});

test("on a row the two starts are icons; the branch one only on the main branch, but always in the menu", () => {
  const icons = (ownBranch: boolean) =>
    offeredMoves(flow, "not-started", "user", { ownBranch })
      .filter((move) => move.icon !== undefined)
      .map((move) => move.icon);
  assert.deepEqual(icons(false), ["play", "play-branch"]);
  assert.deepEqual(icons(true), ["play"]);
  assert.deepEqual(
    menuMoves(flow, "not-started", "user").map((move) => move.id),
    ["start-branch", "start-worktree"],
  );
  // Nothing else is put in the menu, and no later step draws icons.
  for (const state of flow.states.filter((s) => s.id !== "not-started")) {
    assert.deepEqual(menuMoves(flow, state.id, "user"), [], state.id);
    assert.ok(
      movesFor(flow, state.id, "user").every((move) => move.icon === undefined),
      state.id,
    );
  }
});

test("the branch is named from the issue's id and a short form of its title", () => {
  assert.equal(
    branchName({ id: "bead-bb-2oy", title: "have maximize button on all issues" }),
    "bead-bb-2oy-have-maximize-button-on-all-issues",
  );
  // Odd characters go; accents are flattened; case is lowered.
  assert.equal(
    branchName({ id: "x-1", title: 'Fix "it": crème brûlée / A&B!' }),
    "x-1-fix-it-creme-brulee-a-b",
  );
  // A long title is cut at a word, not in the middle of one.
  const long = branchName({
    id: "x-1",
    title: "Size issues in the background when they are created or changed by anyone",
  });
  assert.equal(long, "x-1-size-issues-in-the-background-when-they");
  assert.ok(long.length <= "x-1-".length + 40);
  // Nothing usable in the title: the id alone.
  assert.equal(branchName({ id: "x-1", title: "?!" }), "x-1");
  assert.equal(branchName({ id: "x-1.2", title: "" }), "x-1.2");
});

test("the agent is told to make the branch first, and what to do when it cannot", () => {
  const move = checkMove(flow, null, "start-branch", "user", "");
  assert.ok(!("message" in move));
  if ("message" in move) return;
  const lines = move.opening?.({
    id: "x-1",
    title: "Add a thing",
    size: null,
    openSubIssues: [],
  });
  const text = (lines ?? []).join("\n");
  assert.match(text, /Before anything else, create and switch to a new branch named `x-1-add-a-thing`/u);
  assert.match(text, /git switch -c x-1-add-a-thing/u);
  assert.match(text, /already exists.*stop and tell the user/u);
  // Plain start says nothing first.
  const plain = checkMove(flow, null, "start", "user", "");
  assert.ok(!("message" in plain) && plain.opening === undefined);
});

test("Commit & merge pushes the main branch before it deletes the issue's branch", () => {
  const text = flow.instruction(stateOf(flow, "commit-merge"), {
    id: "x-1",
    title: "T",
    size: null,
    openSubIssues: [],
  });
  const merge = text.indexOf("merge the branch the work is on");
  const push = text.indexOf("push the main branch");
  const remove = text.indexOf("delete the branch the work was on");
  assert.ok(merge >= 0 && push > merge && remove > push);
  assert.match(text, /Never delete the main branch, and never force a deletion/u);
  // Committing alone leaves the branch.
  assert.doesNotMatch(
    flow.instruction(stateOf(flow, "commit"), { id: "x-1", title: "T", size: null, openSubIssues: [] }),
    /delete the branch/u,
  );
});

test("an issue can be started in a work tree: from the menu only, by the user only, in a conversation of its own", () => {
  const move = checkMove(flow, null, "start-worktree", "user", "");
  assert.ok(!("message" in move));
  if ("message" in move) return;
  assert.equal(move.to, "define");
  assert.equal(move.label, "Start in worktree");
  assert.equal(move.icon, "play-tree");
  assert.equal(move.ownConversation, true);
  // The agent does not open conversations for other issues by itself.
  assert.match(go(null, "start-worktree", "agent", ""), /^refused/u);
  // Never on a row, on either kind of branch; always in the menu.
  for (const ownBranch of [false, true]) {
    assert.ok(
      !offeredMoves(flow, "not-started", "user", { ownBranch }).some(
        (offered) => offered.id === "start-worktree",
      ),
    );
  }
  assert.ok(
    menuMoves(flow, "not-started", "user").some((listed) => listed.id === "start-worktree"),
  );
  // It does not need a clean folder: nothing of this folder goes along.
  assert.equal(move.needsCleanFolder, undefined);
  const first = (move.opening?.({ id: "x-1", title: "T", size: null, openSubIssues: [] }) ?? []).join("\n");
  assert.match(first, /opened for one issue, x-1, in a git work tree of its own/u);
  assert.match(first, /do not rename it/u);
});

test("landing from a work tree: main comes into the branch first, conflicts go back to the work, and the agent leaves the closing up alone", () => {
  const issue = { id: "x-1", title: "T", size: null, openSubIssues: [] };
  const text = flow.instruction(stateOf(flow, "commit-merge"), { ...issue, workTree: true });
  const order = [
    "Commit the changes",
    "Bring the main branch into your branch",
    "move the main branch forward",
    "Push the main branch",
    "delete your branch on the remote",
  ].map((part) => text.indexOf(part));
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  assert.match(text, /git merge --abort.*move `send-back`/u);
  assert.match(text, /merge --ff-only/u);
  assert.match(text, /Never force either/u);
  assert.match(text, /Do not remove this work tree or delete the local branch yourself/u);
  assert.match(text, /moves to the archive/u);
  // The ordinary landing, in a plain folder, is told the other way.
  const plain = flow.instruction(stateOf(flow, "commit-merge"), issue);
  assert.doesNotMatch(plain, /work tree of its own/u);
  assert.match(plain, /delete the branch the work was on/u);
  // A conflict can be sent back from that step.
  assert.equal(go("commit-merge", "send-back", "agent", "conflict in a.ts"), "implement");
});

test("an epic can be given a branch or a work tree for all of its issues", () => {
  const epic = {
    id: "x-1",
    title: "Kanban board",
    size: null,
    openSubIssues: [{ id: "x-1.1", title: "A" }],
  };
  for (const [id, label, icon] of [
    ["start-branch", "Start epic in branch", "epic-branch"],
    ["start-worktree", "Start epic in worktree", "epic-tree"],
  ] as const) {
    const move = flow.moves.find((candidate) => candidate.id === id)!;
    // On an issue with sub-issues the move reads and looks different...
    const offered = asOffered(move, true);
    assert.equal(offered.label, label);
    assert.equal(offered.icon, icon);
    // ...and is itself on an issue without.
    assert.equal(asOffered(move, false).label, move.label);
    assert.equal(move.ownPlace, true);
    // It leads to the step the epic waits in, and starts no work.
    assert.equal(move.epic?.to, "on-branch");
    const told = (move.epic?.opening(epic) ?? []).join("\n");
    assert.match(told, /Do not start work on the epic or on any of its issues|do not start work on the epic or on any of its issues/u);
  }
  const branch = flow.moves.find((candidate) => candidate.id === "start-branch")!;
  assert.equal(branch.epic?.branch?.(epic), "x-1-kanban-board");
  const told = (branch.epic?.opening(epic) ?? []).join("\n");
  assert.match(told, /git switch -c x-1-kanban-board/u);
  // A branch that cannot be made takes the epic back, forgetting the branch.
  assert.match(told, /move `to:not-started`/u);
  const back = checkMove(flow, "on-branch", "to:not-started", "agent", "name taken");
  assert.ok(!("message" in back) && back.dropsBranch === true);
  // A work tree names its own branch.
  const tree = flow.moves.find((candidate) => candidate.id === "start-worktree")!;
  assert.equal(tree.epic?.branch, undefined);
});

test("an epic on its branch is not worked itself: it waits, then is closed and merged", () => {
  const step = stateOf(flow, "on-branch");
  assert.equal(step.holdsBranch, true);
  assert.equal(step.actor, "user");
  // The agent's free moves cannot enter it, and leave it only for the start.
  assert.ok(flow.moves.every((move) => move.id !== "to:on-branch"));
  assert.deepEqual(
    movesFor(flow, "on-branch", "agent").map((move) => move.id),
    ["to:not-started"],
  );
  // The user's one move there, drawn by the epic band and nowhere else.
  const close = checkMove(flow, "on-branch", "close-merge", "user", "");
  assert.ok(!("message" in close));
  assert.equal(close.to, "commit-merge");
  assert.equal(close.needsSubIssuesClosed, true);
  assert.deepEqual(offeredMoves(flow, "on-branch", "user", { ownBranch: true }), []);
  assert.deepEqual(menuMoves(flow, "on-branch", "user"), []);
  // The step is not one of those listed for agents as the path of an issue.
  assert.doesNotMatch(
    flow.describeForAgents().split("before it is closed:")[1]!.split(".")[0]!,
    /On its branch/u,
  );
  assert.match(flow.describeForAgents(), /On its branch \[on-branch\]/u);
  // Landing it: the agent is told there is normally nothing left to commit.
  const text = flow.instruction(stateOf(flow, "commit-merge"), {
    id: "x-1",
    title: "T",
    size: null,
    openSubIssues: [],
    holdsBranch: true,
  });
  assert.match(text, /every one of them is closed and committed there/u);
  // Not said where the epic was sent back to the work after a failed merge.
  assert.doesNotMatch(
    flow.instruction(stateOf(flow, "implement"), {
      id: "x-1",
      title: "T",
      size: "m",
      openSubIssues: [],
      holdsBranch: true,
    }),
    /nothing left to commit/u,
  );
});

test("an issue of an epic that has a branch is only committed, on that branch", () => {
  const ids = (context: Parameters<typeof offeredMoves>[3], step: string) =>
    offeredMoves(flow, step, "user", context).map((move) => move.id);
  // On the epic's branch: as on the main branch, no choice of a merge.
  const there = { ownBranch: true, inEpic: true, inEpicBranch: true };
  assert.ok(ids(there, "user-review").includes("accept-commit"));
  assert.ok(!ids(there, "user-review").includes("accept"));
  assert.ok(!ids(there, "apply").includes("commit-merge"));
  // On any other branch of its own, an issue still gets the choice.
  assert.ok(ids({ ownBranch: true }, "user-review").includes("accept"));
  // No branch or work tree of its own, on the row or in the menu.
  assert.ok(!ids({ ownBranch: false, inEpic: true }, "not-started").includes("start-branch"));
  assert.deepEqual(menuMoves(flow, "not-started", "user", { inEpic: true }), []);
  assert.equal(menuMoves(flow, "not-started", "user").length, 2);
  // Both ways of asking for a merge are marked, so the server can refuse them.
  assert.ok(
    flow.moves
      .filter((move) => move.from === "apply" && move.to === "commit-merge")
      .every((move) => move.merges === true),
  );
  // The agent is told where the work goes.
  const text = flow.instruction(stateOf(flow, "implement"), {
    id: "x-1.1",
    title: "A",
    size: "s",
    openSubIssues: [],
    epic: { id: "x-1", title: "Kanban board", branch: "x-1-kanban-board" },
  });
  assert.match(text, /belongs to the epic x-1/u);
  assert.match(text, /Stay on that branch/u);
});

test("the epic an issue belongs to is the nearest one above it that holds a branch", () => {
  const all = [
    { id: "e", parentId: null, step: "on-branch", branch: "e-branch" },
    { id: "e.1", parentId: "e", step: null, branch: null },
    { id: "e.1.1", parentId: "e.1", step: null, branch: null },
    // Started in a work tree a moment ago: the branch is not known yet.
    { id: "t", parentId: null, step: "on-branch", branch: null },
    { id: "t.1", parentId: "t", step: null, branch: null },
    { id: "plain", parentId: null, step: "implement", branch: null },
    { id: "plain.1", parentId: "plain", step: null, branch: null },
  ];
  const byId = (id: string) => all.find((issue) => issue.id === id);
  const over = (id: string) => epicOver(flow, byId(id)!, byId)?.id ?? null;
  assert.equal(over("e.1"), "e");
  assert.equal(over("e.1.1"), "e");
  assert.equal(over("t.1"), "t");
  assert.equal(over("plain.1"), null);
  // Never the issue itself.
  assert.equal(over("e"), null);
});

// --- How the tracker's commands are written (bead-bb-c9l.6) ---

test("without a word about the tracker, the agent is told bd, as always", async () => {
  const { BEADS_WORDS } = await import("./tracker-words.ts");
  const issue = { id: "x-1", title: "T", size: "l", openSubIssues: [{ id: "x-2", title: "Sub" }] };
  for (const state of flow.states) {
    assert.equal(
      flow.instruction(state, issue),
      flow.instruction(state, { ...issue, words: BEADS_WORDS }),
      state.id,
    );
  }
  const plan = flow.instruction(stateOf(flow, "plan"), issue);
  assert.match(plan, /^Work on beads issue x-1: "T"\. It is at the "Plan" step\. Start with `bd show x-1` and `bd comments x-1`\./u);
  assert.match(plan, /Read each with `bd show` as well/u);
  assert.match(plan, /Write the plan into the issue's design field \(`bd update --design`\), with what you rejected and why\./u);
  const define = flow.instruction(stateOf(flow, "define"), issue);
  assert.match(define, /Then write onto the issue, with `bd update`: a description/u);
  const implement = flow.instruction(stateOf(flow, "implement"), issue);
  assert.match(implement, /Mark the issue in progress \(`bd update --status in_progress`\) and build what the plan says\./u);
});

test("on a GitHub repository every instruction names bend and never bd", async () => {
  const { GITHUB_WORDS, wordsFor } = await import("./tracker-words.ts");
  assert.equal(wordsFor("github"), GITHUB_WORDS);
  assert.equal(wordsFor("beads").issue, "beads issue");
  assert.equal(wordsFor(null).issue, "beads issue");
  for (const state of flow.states) {
    for (const size of [null, "s", "m", "l"]) {
      const text = flow.instruction(
        state,
        { id: "12", title: "T", size, openSubIssues: [{ id: "13", title: "Sub" }], words: GITHUB_WORDS },
        "again",
      );
      assert.doesNotMatch(text, /\bbd\b|beads issue/u, `${state.id} ${size}`);
      assert.match(text, /^Work on GitHub issue 12: "T"\..* Start with `bend show 12` and `bend comments 12`\./u);
    }
  }
  const text = (id: string) =>
    flow.instruction(stateOf(flow, id), {
      id: "12", title: "T", size: "l", openSubIssues: [], words: GITHUB_WORDS,
    });
  assert.match(text("plan"), /Write the plan into the issue's plan \(`bend write <id> plan`\)/u);
  assert.match(text("implement"), /Mark the issue in progress \(`bend start <id>`\)/u);
  assert.match(text("define"), /with `bend write <id> description` and `bend write <id> done`/u);
  const resized = flow.resizeInstruction!(
    stateOf(flow, "plan"),
    { id: "12", title: "T", size: "l", openSubIssues: [], words: GITHUB_WORDS },
    "s",
    "l",
  );
  assert.match(resized, /^The user changed the size of GitHub issue 12/u);
});
