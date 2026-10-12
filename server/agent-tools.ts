// server/agent-tools.ts — what the agent's two tools say, apart from doing.
//
// What: the standing instructions that come with Airbender's two agent
// tools, and the decision whether "set the current issue" may go ahead in a
// given folder.
//
// Why: the tools are offered to every thread, in any folder (bead-bb-8fm).
// BB decides a thread's tools when its session starts and never adds any to
// a running one, so offering them only where the folder already used beads
// left agents without them: a thread started minutes before beads was set
// up, and one running while its repository was switched to the simple
// workflow and back. The price is that the tools are also there where they
// do not apply, so their instructions must say when they apply, and the
// tools must refuse in plain words elsewhere.
//
// Design notes:
// - Standing instructions are frozen when a session starts, so they cannot
//   say which workflow a repository is on: the user may switch it later.
//   The agent is therefore told at the moments it matters, by the server,
//   which always knows (the user: "agent should understand if the workflow
//   applicable"): in the answer when it sets its current issue, in the note
//   it gets when the user sets one, and in a note when the user switches
//   the workflow (workflowLine, switchNote).
// - Kept apart from server.ts so the wording and the refusal can be tested
//   without BB.
// - The step tool's own refusals are not here: moving a step already goes
//   through the folder and workflow checks in server/work.ts.

import { CLOSED_STATUS } from "../shared/constants.ts";
import { MOVE_TOOL } from "../shared/standard-workflow.ts";
import { nextWorkOf, stateOf } from "../shared/workflow.ts";
import type { Workflow } from "../shared/workflow.ts";
import type { WorkflowId } from "../shared/workflows.ts";
import type { IssuesResult } from "./contract.ts";

/** The name of the "set the current issue" tool. */
export const CURRENT_TOOL = "airbender_set_current";

/**
 * The names the two tools had before (bead-bb-c9l.10), each with its
 * present one. They are still offered, doing the same: an agent calls a
 * tool by name, a conversation that was open at the change keeps the names
 * it started with, and a repository keeps the rules that name them until
 * its instructions step is run again. To be taken out in a later issue.
 */
export const EARLIER_TOOL_NAMES: readonly (readonly [earlier: string, now: string])[] = [
  ["beads_set_current", CURRENT_TOOL],
  ["beads_workflow_move", MOVE_TOOL],
];

/** What a tool offered under an earlier name says of itself. */
export const renamedTo = (now: string): string =>
  `The earlier name of the ${now} tool, which does the same. Call ${now} instead.`;

/** Standing instructions for the "set the current issue" tool. */
export const CURRENT_TOOL_INSTRUCTIONS =
  `This applies only if the folder you work in tracks its issues with Airbender (it has a .beads folder, or a .bend.json that names a tracker); otherwise ignore the ${CURRENT_TOOL} tool. Its answer also tells you which workflow the repository is on and, on the standard one, which step the issue is at. When you start working on an issue, or switch to another one, call ${CURRENT_TOOL} with its id so the user can see what this thread is working on. Call it with an empty id when the thread is no longer working on any issue. It does not change the issue itself: still mark it started, with \`bend start\`. Do not close an issue when you finish it; the user validates the work and closes it.`;

/**
 * Standing instructions for the step tool: the condition first, then the
 * workflow's own description of how issues move.
 *
 * @param workflowText What the standard workflow says to agents.
 */
export function moveToolInstructions(workflowText: string): string {
  return `This applies only if the folder you work in tracks its issues with Airbender (a .beads folder, or .bend.json) and its repository is on the standard workflow. Which workflow a repository is on is the user's choice and can change: you are told it when you set your current issue with ${CURRENT_TOOL}, when the user sets one for you, and when the user switches it. Where there is neither, or the repository is on the simple workflow, there are no steps: do not call the step tool; it refuses and says why.\n\n${workflowText}`;
}

/**
 * Whether an issue may become a thread's current issue.
 *
 * @param listed The folder's issue list, as just read.
 * @param beadId A well-formed issue id.
 * @returns Null when it may; otherwise the reason in plain words, for the
 *   agent. Changes nothing.
 */
export function currentRefusal(
  listed: Pick<IssuesResult, "state" | "path" | "message" | "issues">,
  beadId: string,
): string | null {
  // Without a readable list there is nothing to point at: no folder, no
  // beads in it, no bd program, or bd failing. Storing the id anyway would
  // show the user a current issue that does not exist.
  if (listed.state !== "ok") {
    return `${beadId} cannot be this thread's current issue: ${listed.message ?? "this folder's issues cannot be read."} This tool only applies in a folder that tracks its issues with Airbender.`;
  }
  const target = listed.issues.find((issue) => issue.id === beadId);
  if (target === undefined) {
    return `No issue with id ${beadId} in ${listed.path}. List the issues to see ids.`;
  }
  if (target.status === CLOSED_STATUS) {
    return `${beadId} is closed, so it cannot be this thread's current issue. Reopen it first if work on it continues.`;
  }
  return null;
}

/**
 * One or two sentences telling the agent which workflow applies to an
 * issue, for the answers and notes it gets about its current issue.
 *
 * @param workflow The repository's workflow; null on the simple one.
 * @param step The step stored on the issue; null when none is.
 */
export function workflowLine(
  workflow: Workflow | null,
  step: string | null,
): string {
  if (workflow === null) {
    return `This repository is on the simple workflow: issues have no steps, so do not call ${MOVE_TOOL}. The user directs the work and closes issues themselves.`;
  }
  const state = stateOf(workflow, step);
  const whose =
    nextWorkOf(state) === "agent" ? "the agent's work" : "waiting for the user";
  return `This repository is on the standard workflow: the issue is at the "${state.label}" step (${whose}). Steps are reported with ${MOVE_TOOL}.`;
}

/**
 * The note a thread gets when the user switches its repository's workflow,
 * so an agent in the middle of work does not go on by the old rules.
 */
export function switchNote(to: WorkflowId): string {
  return to === "simple"
    ? `FYI: the user switched this repository to the simple workflow. Issues have no steps from now on: do not call ${MOVE_TOOL}, and do not wait for a step to be approved. The user directs the work and closes issues themselves. No action is needed.`
    : `FYI: the user switched this repository to the standard workflow. Issues go through their steps again, each from the step it had: you are told the step when you are started on an issue, and you report steps with ${MOVE_TOOL}. No action is needed.`;
}
