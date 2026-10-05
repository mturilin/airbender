// server/work.ts — moving an issue through its workflow.
//
// What: the operations that drive an issue's state machine: play (get the
// agent going on the step the issue is at), a move (approve, send back,
// skip, report a step done, accept), and setting the thread's current issue.
//
// Why: an issue has to pass through its workflow to be closed
// (bead-bb-e2b). This file is the runner: it asks the workflow whether a
// move is allowed, records the new step on the issue, and gets the agent
// started when the next step is the agent's. It knows no step by name; the
// steps, labels and wording are the workflow's (shared/standard-workflow.ts).
//
// Design notes:
// - `deliver` is the one place that decides HOW an agent is put to work on a
//   step. Today it sends the thread a message. The user plans to run steps
//   in the background and in parallel later; that change belongs here and
//   nowhere else.
// - Messages are sent with mode "auto": a turn starts when the agent is
//   idle and the message queues behind a running turn otherwise, so nothing
//   here ever interrupts work.
// - Each move is recorded as a comment on the issue, with who made it and
//   the note given: the issue's own history, shown in the tab.
// - A move to "closed" is the only way the workflow ends. It closes the
//   issue's open sub-issues first. Committing is not done here: it is a
//   step of the workflow, done by the agent. The plugin never runs git.
// - Problems are returned as a message in plain words, like every other
//   operation, so the tab (and the agent's tool) can show them.
//
// Gotchas:
// - An agent can be told to report a step but not forced to. The workflow
//   therefore lets the user report it instead; nothing here tries to detect
//   work done without a report.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BEAD_ID_PATTERN, CLOSED_STATUS } from "../shared/constants.ts";
import { descendantsOf } from "../shared/tree.ts";
import { CLOSED, checkMove, stateOf } from "../shared/workflow.ts";
import type { Actor, Workflow, WorkflowState } from "../shared/workflow.ts";
import type { Issue } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { FolderRef, Outcome, Store } from "./store.ts";

/** Turns anything thrown into a sentence. */
const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** What a move led to, for whoever made it. */
export interface MoveOutcome extends Outcome {
  /** The state the issue is in now; null when it was closed or the move failed. */
  state: WorkflowState | null;
  /**
   * For the agent: what to do next, when the new state is the agent's.
   * Null when the issue now waits for the user, or was closed.
   */
  instruction: string | null;
}

/**
 * Builds the workflow operations for this plugin instance.
 *
 * @param workflow The workflow every issue follows.
 * @returns `run`, `move` and `setCurrent`.
 * Side effects: none until one of them is called.
 */
export function createWork({
  bb,
  store,
  currentBead,
  workflow,
}: {
  bb: BbPluginApi;
  store: Store;
  currentBead: CurrentBead;
  workflow: Workflow;
}) {
  const { issuesIn, setIssueOpen, setStep, addComment, changed } = store;

  /**
   * Puts the thread's agent to work: the one place that decides how a step
   * is run (see the design notes).
   *
   * @throws When BB cannot deliver the message.
   */
  async function deliver(threadId: string, text: string): Promise<void> {
    await bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", mentions: [], text }],
    });
  }

  /** What the workflow may say about an issue: itself and its open sub-issues. */
  const describe = (issue: Issue, issues: Issue[]) => ({
    id: issue.id,
    title: issue.title,
    openSubIssues: descendantsOf(issue.id, issues).filter(
      (candidate) => candidate.status !== CLOSED_STATUS,
    ),
  });

  /**
   * Finds an open issue for a workflow operation.
   *
   * @returns The folder, every issue, and the one asked for; or the reason
   *   it cannot be worked on.
   */
  async function openIssue(
    input: FolderRef,
    beadId: string,
  ): Promise<{ path: string; issues: Issue[]; issue: Issue } | { message: string }> {
    const found = await issuesIn(input, beadId);
    if ("message" in found) {
      // A row that has gone since the tab loaded: say how to get it back.
      return {
        message: found.message.endsWith("no longer in the list.")
          ? `${found.message} Refresh and try again.`
          : found.message,
      };
    }
    const issue = found.issues.find((candidate) => candidate.id === beadId)!;
    if (issue.status === CLOSED_STATUS) {
      return { message: `Issue ${beadId} is closed. Reopen it first.` };
    }
    return { ...found, issue };
  }

  /**
   * Play: makes an issue the thread's current one and gets the agent going
   * on the step it is at.
   *
   * Refused when that step is the user's: there is nothing for the agent to
   * do until the user has made their move.
   */
  async function run({
    threadId,
    beadId,
  }: {
    threadId: string;
    beadId: string;
  }): Promise<Outcome> {
    const found = await openIssue({ threadId, projectId: null }, beadId);
    if ("message" in found) return found;
    const state = stateOf(workflow, found.issue.step);
    if (state.actor !== "agent") {
      return {
        message: `Issue ${beadId} is at "${state.label}", which waits for you, not the agent.`,
      };
    }
    try {
      await currentBead.write(threadId, beadId);
      await deliver(
        threadId,
        workflow.instruction(state, describe(found.issue, found.issues)),
      );
    } catch (cause) {
      return {
        message: `The agent could not be started on ${beadId}: ${reason(cause)}`,
      };
    }
    return { message: null };
  }

  /**
   * Makes one move in an issue's workflow.
   *
   * The move is checked against the workflow, the new step is recorded on
   * the issue with a comment saying who moved it and why, and then:
   * - when the user's move lands on a step that is the agent's and there is
   *   a thread, the agent is started on it (so "Approve plan" is one click,
   *   not two);
   * - when the agent's move lands on another of its own steps, the next
   *   instruction is handed back for it to carry on;
   * - a move to "closed" closes the issue.
   *
   * @param by Who is making the move. The tab passes "user"; the agent's
   *   tool passes "agent". The workflow decides what each may do.
   */
  async function move(
    input: FolderRef & { beadId: string; moveId: string; note: string },
    by: Actor,
  ): Promise<MoveOutcome> {
    const fail = (message: string) => ({ message, state: null, instruction: null });
    const { beadId, threadId } = input;
    const found = await openIssue(input, beadId);
    if ("message" in found) return fail(found.message);
    const { issue, issues, path } = found;
    const from = stateOf(workflow, issue.step);
    const checked = checkMove(workflow, issue.step, input.moveId, by, input.note);
    if ("message" in checked) return fail(checked.message);
    const note = input.note.trim();
    const record = (to: string) =>
      addComment(
        path,
        beadId,
        `Workflow: ${from.label} → ${to} (${checked.label.toLowerCase()}, by the ${by})${note === "" ? "." : `: ${note}`}`,
      );

    if (checked.to === CLOSED) {
      const closed = await finish(input, issues);
      // Recorded only when the issue really was closed.
      if (closed.message === null) await record("closed");
      return { ...closed, state: null, instruction: null };
    }

    const to = stateOf(workflow, checked.to);
    // Not published yet: the comment and a possible message follow, and the
    // tabs should reload once, on the finished move.
    const stepped = await setStep(path, threadId, beadId, to.id, false);
    if (stepped.message !== null) return fail(stepped.message);
    await record(to.label);
    // The note is passed on to the agent only when the issue was sent back
    // to an earlier step: then it says what to redo. The note of a move
    // forward (what was done, why a step was skipped) is for the record,
    // not an instruction.
    const order = (state: WorkflowState) => workflow.states.indexOf(state);
    const text =
      to.actor === "agent"
        ? workflow.instruction(
            to,
            describe(issue, issues),
            order(to) < order(from) ? note : undefined,
          )
        : null;
    let message: string | null = null;
    if (text !== null && by === "user" && threadId !== null) {
      try {
        await currentBead.store(threadId, beadId);
        await deliver(threadId, text);
      } catch (cause) {
        message = `The issue is now at "${to.label}", but the agent could not be started: ${reason(cause)}`;
      }
    }
    changed(threadId);
    return { message, state: to, instruction: by === "agent" ? text : null };
  }

  /**
   * The closing move: closes the issue's open sub-issues, then the issue.
   * Nothing else: getting the work into git is a step of the workflow that
   * comes before this, not a side effect of closing.
   *
   * Sub-issues are closed deepest first, because beads refuses to close an
   * issue that still has open sub-issues (the user's decision, bead-bb-5qt:
   * finishing an epic finishes everything inside it).
   *
   * Side effects: one `bd close` per issue closed; one change published at
   *   the end.
   */
  async function finish(
    input: FolderRef & { beadId: string },
    issues: Issue[],
  ): Promise<Outcome> {
    const { beadId, threadId } = input;
    const closedSubIssues: Issue[] = [];
    const open = descendantsOf(beadId, issues).filter(
      (candidate) => candidate.status !== CLOSED_STATUS,
    );
    for (const subIssue of open.reverse()) {
      // Not published one by one: every open tab would reload once per
      // sub-issue. One change is published at the end instead.
      const closedOne = await setIssueOpen(
        "close",
        { ...input, beadId: subIssue.id },
        false,
      );
      if (closedOne.message !== null) {
        // Some sub-issues may already be closed; the tabs must see that.
        changed(threadId);
        return {
          message: `Could not close sub-issue ${subIssue.id}, so ${beadId} was left open: ${closedOne.message}`,
        };
      }
      closedSubIssues.push(subIssue);
    }
    const outcome = await setIssueOpen("close", input, false);
    changed(threadId);
    return outcome;
  }

  /**
   * Sets the thread's current issue without messaging the agent; null
   * clears it.
   */
  async function setCurrent({
    threadId,
    beadId,
  }: {
    threadId: string;
    beadId: string | null;
  }): Promise<Outcome> {
    if (beadId !== null && !BEAD_ID_PATTERN.test(beadId)) {
      return { message: `"${beadId}" is not a beads issue id.` };
    }
    try {
      await currentBead.write(threadId, beadId);
    } catch (cause) {
      return { message: reason(cause) };
    }
    return { message: null };
  }

  return { run, move, setCurrent };
}
