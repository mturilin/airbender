// shared/standard-workflow.ts — the one workflow issues follow today.
//
// What: the states an issue passes through, the moves between them, the
// button labels, and what the agent is told in each state.
//
//   Not started -> Define -> Review definition -> Plan -> Review plan
//          -> Implement
//          -> Agent review -> Human review -> closed (with a commit)
//
// Why: this is how the user works an issue (bead-bb-e2b, in their words):
// "First, we need to define what the issue is, and there is some review ...
// then we need to plan, and analyze if the plan is good. Then we need to
// implement, and then review by agent and review by myself. And then we can
// commit and close the issue." It used to be spread over a play message, a
// separate Define button with its own background agent, and the rules in
// AGENTS.md, which is why play restarted from the beginning every time.
//
// Design notes:
// - A new issue is "Not started", as in every common tracker (Todo, Backlog,
//   New). It was added after the first version, where a new issue was
//   already "Define" and that word meant both "nobody has touched it" and
//   "the agent is defining it". Now a step named after the agent's work
//   means the work is under way. Only the first step needs this: each later
//   one is started the moment the one before is approved.
// - Everything particular to this workflow is in this file. To change a
//   step, its wording or its buttons, change it here; the tab and the server
//   only read what this file says (see shared/workflow.ts).
// - The user reviews the definition and the plan (their decision); the
//   implementation is reviewed by the agent first and then by the user.
// - Define and Plan can be skipped with a reason, by the agent or the user:
//   a one-line fix should not need a written plan. The implementation and
//   its reviews cannot be skipped.
// - The user may also make the agent's "done" moves. An agent can be asked
//   to report but not forced to, and an issue must not get stuck behind a
//   report that never came.
// - Accepting at "Human review" closes the issue and asks the agent to commit
//   it: the user's acceptance is the moment the work becomes worth keeping.
// - Dropping an issue (Cancel) is not a move here. It is always possible and
//   is the tab's own action, outside the workflow.
//
// Gotchas:
// - A state's id is stored on issues as a label. Renaming an id strands the
//   issues that carry the old one: they fall back to the first state.
// - No imports from outside shared/: this file is bundled on both sides.

import { CLOSED, movesFor } from "./workflow.ts";
import type {
  Workflow,
  WorkflowIssue,
  WorkflowMove,
  WorkflowState,
} from "./workflow.ts";

/** The tool an agent reports a move with (registered in server.ts). */
export const MOVE_TOOL = "beads_workflow_move";

const states: WorkflowState[] = [
  {
    id: "not-started",
    label: "Not started",
    actor: "user",
    hint: "Nobody has started on this issue yet.",
  },
  {
    id: "define",
    label: "Define",
    actor: "agent",
    runLabel: "Define",
    hint: "The agent writes up what is wanted, why, and what done means.",
  },
  {
    id: "review-definition",
    label: "Review definition",
    actor: "user",
    hint: "You check that the issue says what you want.",
  },
  {
    id: "plan",
    label: "Plan",
    actor: "agent",
    runLabel: "Plan",
    hint: "The agent works out how to do it and writes the plan down.",
  },
  {
    id: "review-plan",
    label: "Review plan",
    actor: "user",
    hint: "You check that the plan is good.",
  },
  {
    id: "implement",
    label: "Implement",
    actor: "agent",
    runLabel: "Implement",
    hint: "The agent does the work.",
  },
  {
    id: "agent-review",
    label: "Agent review",
    actor: "agent",
    runLabel: "Review",
    hint: "The agent checks its own work against the issue.",
  },
  {
    id: "user-review",
    label: "Human review",
    actor: "user",
    hint: "You validate the work.",
  },
];

/** A step the agent finishes: it may report it, and so may the user. */
const finished = (from: string, to: string, hint: string): WorkflowMove => ({
  id: "done",
  from,
  to,
  by: ["agent", "user"],
  label: "Mark as done",
  hint,
});

/** A step that may be left out, with a reason. */
const skippable = (from: string, to: string, what: string): WorkflowMove => ({
  id: "skip",
  from,
  to,
  by: ["agent", "user"],
  label: "Skip",
  hint: `Leave out ${what} because it is obviously not needed; say why.`,
  needsNote: true,
});

/** The user's two answers at a review: on to the next step, or back. */
const reviewed = (
  from: string,
  onward: string,
  back: string,
  approveLabel: string,
): WorkflowMove[] => [
  {
    id: "approve",
    from,
    to: onward,
    by: ["user"],
    label: approveLabel,
    hint: "Accept it and let the agent go on.",
    primary: true,
  },
  {
    id: "send-back",
    from,
    to: back,
    by: ["user"],
    label: "Send back",
    hint: "Say what is wrong and have the agent redo it.",
    needsNote: true,
  },
];

const moves: WorkflowMove[] = [
  {
    // The agent may make this move too: work that begins from a typed
    // request, not from the tab, still has to enter the workflow.
    id: "start",
    from: "not-started",
    to: "define",
    by: ["user", "agent"],
    label: "Define",
    hint: "Start on this issue: the agent defines what is wanted.",
    primary: true,
  },
  skippable("not-started", "plan", "the definition"),
  finished(
    "define",
    "review-definition",
    "The definition is written on the issue and ready for the user to review.",
  ),
  skippable("define", "plan", "the definition"),
  ...reviewed("review-definition", "plan", "define", "Approve definition"),
  finished(
    "plan",
    "review-plan",
    "The plan is written on the issue and ready for the user to review.",
  ),
  skippable("plan", "implement", "the plan"),
  ...reviewed("review-plan", "implement", "plan", "Approve plan"),
  finished("implement", "agent-review", "The work is done and ready to be reviewed."),
  {
    id: "pass",
    from: "agent-review",
    to: "user-review",
    by: ["agent", "user"],
    label: "Mark as reviewed",
    hint: "The review found nothing left to fix; the work is ready for the user to validate.",
  },
  {
    id: "send-back",
    from: "agent-review",
    to: "implement",
    by: ["agent"],
    label: "Send back",
    hint: "The review found something to fix; say what.",
    needsNote: true,
  },
  {
    id: "accept",
    from: "user-review",
    to: CLOSED,
    by: ["user"],
    label: "Accept & commit",
    hint: "Close the issue and ask the agent to commit its work.",
    primary: true,
    commit: true,
  },
  {
    id: "send-back",
    from: "user-review",
    to: "implement",
    by: ["user"],
    label: "Send back",
    hint: "Say what is wrong and have the agent fix it.",
    needsNote: true,
  },
];

/** How the agent is told to report a move. */
const report = (issueId: string, moveId: string) =>
  `call the \`${MOVE_TOOL}\` tool with id \`${issueId}\`, move \`${moveId}\` and a one-line note`;

/** What the agent does in each of its states. */
function stepText(stateId: string, id: string): string[] {
  switch (stateId) {
    case "define":
      return [
        "Your job now is to define the issue: turn it from a request into something clear enough to build. Do not plan or build yet.",
        "",
        "- Make sure it is clear what is wanted, why, and what \"done\" means. Read the code it touches.",
        "- If the issue records open questions for the user, or you have your own, ask them and wait for the answers. Being started on an issue is not permission to assume them. Ask at most a few, only ones whose answer changes what gets built.",
        "- Then write onto the issue, with `bd update`: a description (what is wanted and why, in the user's words where possible, how things work today, what is out of scope) and acceptance criteria (short checks a person can verify). Set its type and priority if they are missing.",
        "- Be proportionate: a one-line request gets a short write-up. Stay inside the request. Format with Markdown. Check every claim about the code against the code.",
        "",
        `When the definition is on the issue, ${report(id, "done")}, and tell the user it is ready for them to review. They approve it or send it back from the Airbender tab.`,
        `If the issue is already clear and complete, ${report(id, "skip")} giving the reason, and say so to the user in one line.`,
      ];
    case "plan":
      return [
        "Your job now is to plan the work. The definition is agreed; do not change any file yet.",
        "",
        "- Say what you will change and how: the files, the order, anything risky, and how you will check it.",
        "- Write the plan into the issue's design field (`bd update --design`), with what you rejected and why.",
        "- Present the plan to the user in plain words.",
        "",
        `When the plan is on the issue, ${report(id, "done")}, and wait: the user approves it or sends it back from the Airbender tab.`,
        `If the change is small and there is one evident way to do it, ${report(id, "skip")} giving the reason, and say so to the user in one line.`,
      ];
    case "implement":
      return [
        "Your job now is to do the work. The plan is agreed.",
        "",
        "- Mark the issue in progress (`bd update --status in_progress`) and build what the plan says.",
        "- Record decisions, surprises and anything that did not work as comments on the issue as you go. Follow-up work becomes its own issue.",
        "- Check your work: run what can be run.",
        "",
        `When the work is done, ${report(id, "done")}. That moves the issue to your own review, which you do next. Do not close the issue.`,
      ];
    case "agent-review":
      return [
        "Your job now is to review the work on this issue as if someone else had done it.",
        "",
        "- Read the issue's description, acceptance criteria and design again, then read the changes that were made.",
        "- Check each acceptance criterion. Look for what was missed, what was not tested, and anything the project's own rules require (documents to update, tests to run).",
        "",
        `If something needs fixing, ${report(id, "send-back")} saying what, and fix it.`,
        `If nothing does, add a comment to the issue saying what was done, how it was checked and what was not checked, then ${report(id, "pass")}, and tell the user it is ready for them to validate. Do not close the issue and do not commit: the user accepts it from the Airbender tab, and you are asked to commit then.`,
      ];
    default:
      return [];
  }
}

function instruction(
  state: WorkflowState,
  issue: WorkflowIssue,
  note?: string,
): string {
  // An issue with sub-issues is worked as a whole: the user asked that play
  // on an epic means "this issue and all its sub-issues" (bead-bb-5qt).
  const epic =
    issue.openSubIssues.length === 0
      ? []
      : [
          "",
          "This issue has open sub-issues. This step covers it and all of them together, as one piece of work:",
          ...issue.openSubIssues.map(
            (sub) => `- ${sub.id}: ${JSON.stringify(sub.title)}`,
          ),
          "Read each with `bd show` as well, and when you build, mark each in progress when you start it and comment on it when it is finished. Do not close any of them.",
        ];
  const back =
    note === undefined || note.trim() === ""
      ? []
      : ["", `It was sent back to this step with this note: ${note.trim()}`];
  return [
    `Work on beads issue ${issue.id}: ${JSON.stringify(issue.title)}. It is at the "${state.label}" step. Start with \`bd show ${issue.id}\` and \`bd comments ${issue.id}\`.`,
    ...epic,
    ...back,
    "",
    ...stepText(state.id, issue.id),
  ].join("\n");
}

function commitRequest(
  issue: { id: string; title: string },
  closedSubIssues: readonly { id: string; title: string }[],
): string {
  const rules =
    "following the commit rules in AGENTS.md if it has any";
  const after =
    "If this repository pushes commits by itself, tell the user if that push fails.";
  return (
    `The user accepted beads issue ${issue.id}: ${JSON.stringify(issue.title)} in the Airbender tab. It is closed, and its work is to be committed now.` +
    (closedSubIssues.length === 0
      ? ` Commit the changes that belong to this issue, ${rules}: only this issue's files, and the issue's id and title in the subject line. ${after} If there is nothing to commit for it, say so.`
      : ` Its sub-issues were closed with it: ${closedSubIssues
          .map((sub) => `${sub.id} (${JSON.stringify(sub.title)})`)
          .join(
            ", ",
          )}. Commit the changes that belong to this issue and those sub-issues, ${rules}: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title; only these issues' files; and the issue's id and title in the subject line. ${after} If there is nothing to commit, say so.`)
  );
}

function describeForAgents(): string {
  const steps = states
    .map(
      (state) =>
        `${state.label} (${state.actor === "agent" ? "you" : "the user"})`,
    )
    .join(", then ");
  const agentMoves = states
    .map((state) => ({ state, open: movesFor(standardWorkflow, state.id, "agent") }))
    .filter(({ open }) => open.length > 0)
    .map(
      ({ state, open }) =>
        `at ${state.label}: ${open.map((move) => `\`${move.id}\``).join(", ")}`,
    )
    .join("; ");
  return [
    `Every beads issue in this repository goes through these steps before it is closed: ${steps}.`,
    "You are told which step an issue is at when you are started on it. Do that step only.",
    `If you begin work on an issue that is still at ${states[0]!.label} (for example from a typed request), move it with \`start\` first.`,
    `When you finish a step, report it with the ${MOVE_TOOL} tool (${agentMoves}), each with a short note. The tool tells you what comes next: either your next step, or that the issue now waits for the user.`,
    "The steps that are the user's are theirs alone: they approve or send back in the Airbender tab. Do not close an issue yourself and do not commit before the user has accepted it.",
  ].join(" ");
}

/** The workflow every issue follows. */
export const standardWorkflow: Workflow = {
  states,
  moves,
  initial: "not-started",
  instruction,
  commitRequest,
  describeForAgents,
};
