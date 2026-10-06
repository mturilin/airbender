// shared/workflows.ts — the workflows a repository can choose between.
//
// What: the list of choices ("Standard", "Simple"), which one a repository
// uses when it has never chosen, and the state machine behind each.
//
// Why: the user wants to choose the workflow per repository (bead-bb-8j6):
// the standard one, where every issue goes through its steps, or none at
// all, where an issue is only made current, released and closed by hand.
// Until now one workflow was named in one file and imported everywhere; the
// tab and the server now ask here for the workflow of a choice instead.
//
// Design notes:
// - "Simple" is the absence of a state machine: `workflowFor` answers null.
//   A second state machine with a single "open" state was rejected: every
//   screen would still draw a chip and a button for it and then need a
//   special case to hide them.
// - The choice is an id, stored per repository by the server
//   (server/workflow-choice.ts) and sent to the tab with the issue list.
//
// Gotchas:
// - An issue keeps the step it had while its repository is on Simple; the
//   step is only not shown. Back on Standard it is where it was.

import { standardWorkflow } from "./standard-workflow.ts";
import type { Workflow } from "./workflow.ts";

/** The ids of the choices, as stored and as sent to the tab. */
export const WORKFLOW_IDS = ["standard", "simple"] as const;

export type WorkflowId = (typeof WORKFLOW_IDS)[number];

/** What a repository uses until someone chooses. */
export const DEFAULT_WORKFLOW_ID: WorkflowId = "standard";

/** The choices as the tab lists them, in order. */
export const WORKFLOW_CHOICES: readonly {
  id: WorkflowId;
  label: string;
  /** One line saying what choosing it means. */
  hint: string;
}[] = [
  {
    id: "standard",
    label: "Standard",
    hint: "Every issue goes through its steps: define, plan, implement, review, apply.",
  },
  {
    id: "simple",
    label: "Simple",
    hint: "No steps. Make an issue current, release it, close it; you direct the agent yourself.",
  },
];

/** What is said when a step is asked for where there are none. */
export const NO_STEPS_MESSAGE =
  "This folder uses the simple workflow, which has no steps.";

/** Whether a stored or received value names one of the choices. */
export function isWorkflowId(value: unknown): value is WorkflowId {
  return (WORKFLOW_IDS as readonly unknown[]).includes(value);
}

/**
 * The state machine behind a choice.
 *
 * @returns The workflow, or null for "simple", which has none.
 */
export function workflowFor(id: WorkflowId): Workflow | null {
  return id === "standard" ? standardWorkflow : null;
}
