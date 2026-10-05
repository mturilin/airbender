// shared/standard-workflow.ts — the one workflow issues follow today.
//
// What: the states an issue passes through, the moves between them, the
// button labels, and what the agent is told in each state.
//
//   Not started -> Define -> Review definition -> Plan -> Review plan
//          -> Implement
//          -> Agent review -> Human review -> Apply -> closed
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
// - Accepting at "Human review" does not close the issue: it moves it to
//   Apply, where the agent commits the work (and merges it, if it was done
//   on its own branch). The issue closes only when that is reported done.
//   Before, the issue was closed first and the commit asked for afterwards,
//   so a commit or merge that failed left a closed issue whose work was not
//   in git, with nothing showing it. The user named the step.
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
    // It waits for the user only to say "go"; the work that follows, looking
    // at what was written and defining it, is the agent's (the user's view).
    nextWork: "agent",
    hint: "Nobody has started on this issue yet; the agent defines it next.",
    ask: "Not started yet. Press Define when you want the agent to begin.",
  },
  {
    id: "define",
    label: "Define",
    actor: "agent",
    runLabel: "Define",
    hint: "The agent writes up what is wanted, why, and what done means.",
    ask: "The agent is defining this issue.",
  },
  {
    id: "review-definition",
    label: "Review definition",
    actor: "user",
    hint: "You check that the issue says what you want.",
    ask: "Please review the definition and give feedback.",
  },
  {
    id: "plan",
    label: "Plan",
    actor: "agent",
    runLabel: "Plan",
    hint: "The agent works out how to do it and writes the plan down.",
    ask: "The agent is planning the work.",
  },
  {
    id: "review-plan",
    label: "Review plan",
    actor: "user",
    hint: "You check that the plan is good.",
    ask: "Please review the plan and give feedback.",
  },
  {
    id: "implement",
    label: "Implement",
    actor: "agent",
    runLabel: "Implement",
    hint: "The agent does the work.",
    ask: "The agent is doing the work.",
  },
  {
    id: "agent-review",
    label: "Agent review",
    actor: "agent",
    runLabel: "Review",
    hint: "The agent checks its own work against the issue.",
    ask: "The agent is reviewing its own work.",
  },
  {
    id: "user-review",
    label: "Human review",
    actor: "user",
    hint: "You validate the work.",
    ask: "Please review the results and give feedback.",
  },
  {
    id: "apply",
    label: "Apply",
    actor: "agent",
    // The step is Apply; its button says what applying will be here.
    runLabel: ({ ownBranch }) => (ownBranch ? "Commit & merge" : "Commit"),
    hint: "The agent commits the accepted work, and merges it in if it has its own branch.",
    ask: "The agent is committing the work.",
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
    // The agent may make this move too: in the conversation the user does
    // not "send back", they just say what should change, and the agent
    // moves the issue to where the work now is.
    id: "send-back",
    from,
    to: back,
    by: ["user", "agent"],
    label: "Send back",
    hint: "It needs changes: say what, and the agent redoes it.",
    needsNote: true,
  },
  {
    // The user's verdict, given in the conversation and recorded by the
    // agent, so the user does not have to press a button for something they
    // have already said. The note must quote them.
    id: "approved",
    from,
    to: onward,
    by: ["agent"],
    label: "Approved by the user",
    hint: "The user has approved this in the conversation; quote what they said.",
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
    to: "apply",
    by: ["user"],
    label: "Accept",
    hint: "The work is good: have the agent commit it, which closes the issue.",
    primary: true,
  },
  {
    id: "send-back",
    from: "user-review",
    to: "implement",
    by: ["user", "agent"],
    label: "Send back",
    hint: "It needs changes: say what, and the agent fixes it.",
    needsNote: true,
  },
  {
    id: "approved",
    from: "user-review",
    to: "apply",
    by: ["agent"],
    label: "Accepted by the user",
    hint: "The user has accepted the work in the conversation; quote what they said.",
    needsNote: true,
  },
  {
    id: "done",
    from: "apply",
    to: CLOSED,
    by: ["agent", "user"],
    label: "Mark as applied",
    hint: "The work is in git: committed, and merged if it had its own branch. Closes the issue.",
  },
  {
    id: "send-back",
    from: "apply",
    to: "implement",
    by: ["agent"],
    label: "Send back",
    hint: "The work cannot be applied as it is (for example a conflict that needs rework); say why.",
    needsNote: true,
  },
];

/**
 * The agent's freedom to move an issue (the user's rule): "agent can move
 * issue to any state. It has agency to do it ... if it thinks that plan is
 * not necessary, it can skip steps. While we're in review and until I review
 * it, it wouldn't be good for agent to move forward."
 *
 * So, as moves named `to:<step>`, each needing a reason:
 * - from a step where the agent's work is next, to any other step;
 * - from a step that waits for the user's review, only back to an earlier
 *   step;
 * - never to Apply, whichever way: that is reached only by the user's
 *   acceptance (the agent's own caution, kept from before the rule above).
 */
const LAST_STEP = "apply";
const jumps: WorkflowMove[] = states.flatMap((from, fromIndex) =>
  states
    .filter(
      (to, toIndex) =>
        to.id !== from.id &&
        to.id !== LAST_STEP &&
        ((from.nextWork ?? from.actor) === "agent" || toIndex < fromIndex),
    )
    .map((to) => ({
      id: `to:${to.id}`,
      from: from.id,
      to: to.id,
      by: ["agent"] as const,
      label: `Move to ${to.label}`,
      hint: `Go straight to ${to.label}; say why.`,
      needsNote: true,
      unlisted: true,
    })),
);
moves.push(...jumps);

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
        `If nothing does, add a comment to the issue saying what was done, how it was checked and what was not checked, then ${report(id, "pass")}, and tell the user it is ready for them to validate. Do not close the issue and do not commit: the user accepts it from the Airbender tab, and committing is the step after that.`,
      ];
    case "apply":
      return [
        "The user has accepted this work. Your job now is to get it into git.",
        "",
        "- Commit the changes that belong to this issue, following the commit rules in AGENTS.md if it has any: only this issue's files, with the issue's id and title in the subject line. With sub-issues: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title.",
        "- If the work was done on its own branch (not the repository's main branch), merge that branch into the main one once everything is committed. If your own rules require the user's approval for a merge, ask for it and wait.",
        "- If this repository pushes commits by itself, tell the user if that push fails. Do not push by hand unless the repository's rules say to.",
        "- If everything was already committed and there is nothing to merge, say so.",
        "",
        `When the work is in git, ${report(id, "done")} naming the commit. That closes the issue.`,
        `If it cannot be applied as it is, for example a merge conflict that needs the work redone, ${report(id, "send-back")} saying why.`,
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

function describeForAgents(): string {
  const steps = states
    .map(
      (state) =>
        `${state.label} [${state.id}] (${state.actor === "agent" ? "you" : "the user"})`,
    )
    .join(", then ");
  const agentMoves = states
    .map((state) => ({
      state,
      open: movesFor(standardWorkflow, state.id, "agent").filter(
        (move) => move.unlisted !== true,
      ),
    }))
    .filter(({ open }) => open.length > 0)
    .map(
      ({ state, open }) =>
        `at ${state.label}: ${open.map((move) => `\`${move.id}\``).join(", ")}`,
    )
    .join("; ");
  return [
    `Every beads issue in this repository goes through these steps before it is closed: ${steps}.`,
    "You are told which step an issue is at when you are started on it. Do that step.",
    `If you begin work on an issue that is still at ${states[0]!.label} (for example from a typed request), move it with \`start\` first.`,
    `When you finish a step, report it with the ${MOVE_TOOL} tool (${agentMoves}), each with a short note. The tool tells you what comes next: either your next step, or that the issue now waits for the user.`,
    "You have the judgment to move an issue to where the work really is: the move `to:<step id>` (the ids are in square brackets above) takes it to any step, with your reason, for example to leave out steps that are not needed. Two limits: while an issue waits for the user's review you may only move it back, not on; and you can never move an issue to Apply.",
    "While an issue waits for the user's review, read what they reply. If they ask for changes, move it back with `send-back`, giving their words as the reason, and redo the work; a long rework belongs in the work step, a quick question does not need a move at all. If they approve in the conversation, record it with `approved`, quoting what they said, and carry on. Never record an approval the user has not given.",
    "Do not commit before the user has accepted an issue; an issue is closed by reporting its last step, never with bd close.",
  ].join(" ");
}

/** The workflow every issue follows. */
export const standardWorkflow: Workflow = {
  states,
  moves,
  initial: "not-started",
  instruction,
  describeForAgents,
};
