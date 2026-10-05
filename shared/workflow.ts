// shared/workflow.ts — what a workflow is.
//
// What: the interface a workflow has to meet, and the few generic questions
// the rest of the plugin asks of one: which state is this issue in, which
// moves are open to whom, is this move allowed.
//
// Why: every issue goes through a state machine to be closed (bead-bb-e2b).
// The user did not want the particular steps written into the tab or the
// server, where they had changed four times in a day, each time as edits in
// several places. So the tab and the server know only this interface; the
// steps, their button labels and the wording for agents live in one file
// that implements it (shared/standard-workflow.ts).
//
// Design notes:
// - Plain TypeScript, not a data format. The user's decision: no YAML or
//   similar yet; a loadable, editable workflow can come later, and this
//   interface is the shape it would have to fill.
// - A state says who acts in it (the agent or the user). A move says who may
//   make it. That is all the rest of the plugin needs in order to draw the
//   right button and to refuse a move that skips ahead.
// - Running a state (getting the agent to do its work) is not part of the
//   workflow. The workflow only supplies the instruction; the server decides
//   how it is delivered (today: a message to the thread; later perhaps a
//   background agent). See server/work.ts.
//
// Gotchas:
// - Like the other files in shared/, this one has no imports, so it is safe
//   to bundle on either side and to load in tests.

/** Who acts: the thread's agent, or the user. */
export type Actor = "agent" | "user";

/** Where a closing move leads: out of the workflow, the issue is closed. */
export const CLOSED = "closed";

/**
 * What a workflow may know about where an issue's work lives, when it
 * decides which moves to offer. Deliberately small: facts the tab can be
 * given, not git itself.
 */
export interface WorkflowContext {
  /** The folder is on a branch other than the repository's main one. */
  ownBranch: boolean;
}

/** One state an open issue can be in. */
export interface WorkflowState {
  /** Stored on the issue; letters, digits and dashes only. */
  id: string;
  /** Shown as a tag on the issue, e.g. "Review plan". */
  label: string;
  /** Who the issue is waiting for while it is in this state. */
  actor: Actor;
  /**
   * Whose work comes next, when that is not the one the state waits for.
   * A state can wait for the user only to say "go" (a new issue) while the
   * work that follows is the agent's; the tab then marks it as the agent's.
   * Left out, it is the same as `actor`.
   */
  nextWork?: Actor;
  /** One line saying what happens in this state, for tooltips. */
  hint: string;
  /**
   * What to say to the user about this state, as a friendly sentence shown
   * beside the buttons: what they are asked to do when it is their turn
   * ("Please review the plan and give feedback."), or what is going on when
   * it is the agent's.
   */
  ask: string;
  /**
   * For an agent's state: the label of the button that gets the agent going
   * on it, e.g. "Plan". Left out for the user's states, where the buttons
   * are the user's own moves.
   */
  runLabel?: string;
}

/** One allowed change of state. */
export interface WorkflowMove {
  /** Names the move within its state, e.g. "done", "approve", "send-back". */
  id: string;
  from: string;
  /** The state it leads to, or CLOSED. */
  to: string;
  /** Who may make it. */
  by: readonly Actor[];
  /** The button label when the user makes it. */
  label: string;
  /** One line saying what the move does, for tooltips and for the agent. */
  hint: string;
  /** The user's main button in this state (at most one per state). */
  primary?: boolean;
  /** A note is required: why it is sent back, or why it is skipped. */
  needsNote?: boolean;
  /**
   * Offered only when the issue's work is on a branch of its own (see
   * WorkflowContext), e.g. a move that merges. It is a matter of what to
   * show: the move itself stays valid, since only the tab knows the branch.
   */
  ownBranchOnly?: boolean;
  /**
   * Left out when the moves open at a step are listed for someone (in a
   * refusal, in the agent's instructions). For moves that exist at nearly
   * every step and would drown the ones particular to it.
   */
  unlisted?: boolean;
}

/** What a workflow's instruction may say about the issue. */
export interface WorkflowIssue {
  id: string;
  title: string;
  /** Its open sub-issues, at any depth; worked together with it. */
  openSubIssues: readonly { id: string; title: string }[];
}

/** A workflow: the states an issue passes through and the moves between them. */
export interface Workflow {
  /** In the order they are normally passed through. */
  states: readonly WorkflowState[];
  moves: readonly WorkflowMove[];
  /** The state of an issue that has none recorded. */
  initial: string;
  /**
   * What to tell the agent to do for an issue in one of the agent's states.
   *
   * @param note What the user said when sending the issue here, if anything
   *   (the reason it was sent back).
   */
  instruction(state: WorkflowState, issue: WorkflowIssue, note?: string): string;
  /** Standing instructions for agents: how issues move and what they may do. */
  describeForAgents(): string;
}

/**
 * The state an issue is in.
 *
 * @param step The state id stored on the issue, or null when none is.
 * @returns That state, or the workflow's first state for an issue with no
 *   state yet, or with one this workflow does not know (a renamed state, or
 *   a label written by hand).
 */
export function stateOf(workflow: Workflow, step: string | null): WorkflowState {
  return (
    workflow.states.find((state) => state.id === step) ??
    workflow.states.find((state) => state.id === workflow.initial)!
  );
}

/**
 * The moves out of a state to show `by`, given where the work lives: the
 * same as movesFor, without the ones that do not apply here.
 */
export function offeredMoves(
  workflow: Workflow,
  stateId: string,
  by: Actor,
  context: WorkflowContext,
): WorkflowMove[] {
  return movesFor(workflow, stateId, by).filter(
    (move) => move.ownBranchOnly !== true || context.ownBranch,
  );
}

/** Whose work comes next for an issue in this state (see `nextWork`). */
export function nextWorkOf(state: WorkflowState): Actor {
  return state.nextWork ?? state.actor;
}

/** The moves out of a state that `by` may make, the main one first. */
export function movesFor(
  workflow: Workflow,
  stateId: string,
  by: Actor,
): WorkflowMove[] {
  return workflow.moves
    .filter((move) => move.from === stateId && move.by.includes(by))
    .sort((left, right) => Number(right.primary ?? false) - Number(left.primary ?? false));
}

/**
 * Checks one requested move against the workflow.
 *
 * @param step The state id stored on the issue (null for none).
 * @returns The move, or `{ message }` saying in plain words why it is
 *   refused, including what is allowed instead.
 */
export function checkMove(
  workflow: Workflow,
  step: string | null,
  moveId: string,
  by: Actor,
  note: string,
): WorkflowMove | { message: string } {
  const state = stateOf(workflow, step);
  const open = movesFor(workflow, state.id, by);
  const move = open.find((candidate) => candidate.id === moveId);
  if (move === undefined) {
    const others = workflow.moves.some(
      (candidate) => candidate.from === state.id && candidate.id === moveId,
    );
    const allowed =
      open.length === 0
        ? `In that state there is nothing for the ${by} to do; it waits for the ${state.actor}.`
        : `The ${by} may: ${open
            .filter((candidate) => candidate.unlisted !== true)
            .map((candidate) => `"${candidate.id}" (${candidate.hint})`)
            .join("; ")}.`;
    return {
      message: others
        ? `The issue is at "${state.label}", and "${moveId}" there is not the ${by}'s move to make. ${allowed}`
        : `The issue is at "${state.label}", where there is no move called "${moveId}". ${allowed}`,
    };
  }
  if (move.needsNote === true && note.trim() === "") {
    return { message: `"${move.label}" needs a reason.` };
  }
  return move;
}

/**
 * Checks that a workflow hangs together: ids are usable as labels, every
 * move joins known states, a state has at most one main button, and every
 * state can reach CLOSED. Used by the tests, so a mistake in a workflow file
 * is caught before it reaches an issue.
 *
 * @returns The problems found, in plain words; empty when there are none.
 */
export function problemsIn(workflow: Workflow): string[] {
  const problems: string[] = [];
  const ids = new Set(workflow.states.map((state) => state.id));
  if (ids.size !== workflow.states.length) problems.push("Two states share an id.");
  if (!ids.has(workflow.initial)) problems.push("The initial state is not a state.");
  for (const state of workflow.states) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(state.id) || state.id === CLOSED) {
      problems.push(`State id "${state.id}" cannot be stored as a label.`);
    }
    if (state.actor === "agent" && state.runLabel === undefined) {
      problems.push(`Agent state "${state.id}" has no button label.`);
    }
    const mains = workflow.moves.filter(
      (move) => move.from === state.id && move.primary === true,
    );
    if (mains.length > 1) problems.push(`State "${state.id}" has two main moves.`);
  }
  for (const move of workflow.moves) {
    if (!ids.has(move.from)) problems.push(`Move "${move.id}" starts at an unknown state.`);
    if (move.to !== CLOSED && !ids.has(move.to)) {
      problems.push(`Move "${move.id}" from "${move.from}" leads to an unknown state.`);
    }
  }
  // Every state must be able to reach CLOSED.
  const reaches = new Set<string>([CLOSED]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const move of workflow.moves) {
      if (reaches.has(move.to) && !reaches.has(move.from)) {
        reaches.add(move.from);
        grew = true;
      }
    }
  }
  for (const id of ids) {
    if (!reaches.has(id)) problems.push(`State "${id}" can never be closed.`);
  }
  return problems;
}
