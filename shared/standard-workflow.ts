// shared/standard-workflow.ts — the one workflow issues follow today.
//
// What: the states an issue passes through, the moves between them, the
// button labels, and what the agent is told in each state.
//
//   Not started -> Define -> Review definition -> Plan -> Review plan
//          -> Implement
//          -> Agent review -> Human review -> Apply -> Commit (or
//             Commit & merge) -> closed
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
//   Apply, where the user chooses how the work goes into git: Commit, or
//   Commit & merge. The agent then does that, and the issue closes only when
//   it is reported done. Before, the issue was closed first and the commit
//   asked for afterwards, so a commit or merge that failed left a closed
//   issue whose work was not in git, with nothing showing it.
// - Issues differ in size, and the workflow is only as long as an issue
//   needs (bead-bb-4mb). The user found the full sequence "very clunky" for
//   a question with two clarifications: "like a 15 button presses for three
//   questions". So the agent first sizes an issue, S, M or L (the user's
//   T-shirt sizes), and takes that path: S is done in one go and reaches
//   the user once, at the end; M has one review at the front, of definition
//   and plan together; L is every step. The size is stored on the issue,
//   and the user can change it, or set it before the agent does. The paths
//   are instructions over the same steps and moves, not separate sets of
//   steps: the agent could already jump an issue to where its work is.
//   Rejected: the user choosing the size every time (one more decision per
//   issue), a third "light" workflow per repository (issues in one
//   repository differ), and a size XS for pure questions (the user: "Pure
//   question doesn't need an issue").
// - Where there is only one way to apply accepted work, the user is not
//   stopped to choose it: on the main branch "Accept & commit" goes
//   straight to the commit. Apply remains for work on a branch of its own.
// - An issue can be started in a branch of its own (bead-bb-jqn.1): a
//   second move out of Not started. It is not a step: the agent makes the
//   branch as the first thing it does, then sizes and works as usual, and
//   "Commit & merge" ends the branch. The user's decisions: the branch is
//   in the folder the conversation is in (work trees are another issue);
//   it is named from the issue's id and title; it cannot be started over
//   uncommitted changes; on the row it is offered only on the main branch,
//   in the menu always; after the merge the main branch is pushed and the
//   branch deleted, locally and on the remote. Rejected: the plugin making
//   the branch (it never changes git), and a step of its own for it.
// - An issue can be started in a work tree of its own (bead-bb-ak0), so
//   that several are worked at once: a third move out of Not started. It
//   opens a new top-level conversation in a work tree that BB makes, and
//   the agent works there. The user's decisions: one conversation per
//   issue, visible; BB places the tree; it is started from the issue's
//   menu, never the row; and when it has landed, everything is closed
//   (their option A of three): the conversation is archived, the tree
//   removed, the branch deleted. Landing itself is the agent's: it brings
//   the main branch into its own first, so a conflict is settled in its
//   work tree and never on the main branch.
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
  WorkflowSize,
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
    hint: "Nobody has started on this issue yet; the agent sizes it and begins.",
    ask: "Not started yet. Press Start when you want the agent to begin.",
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
    // Worded to fit a medium issue too, where the definition and the plan
    // arrive here together and this is the first review of either.
    ask: "Please review what is planned and give feedback.",
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
    actor: "user",
    hint: "You choose how the accepted work goes into git.",
    ask: "The work is accepted. Choose how to apply it.",
  },
  {
    id: "commit",
    label: "Commit",
    actor: "agent",
    runLabel: "Commit",
    hint: "The agent commits the accepted work.",
    ask: "The agent is committing the work.",
  },
  {
    id: "commit-merge",
    label: "Commit & merge",
    actor: "agent",
    runLabel: "Commit & merge",
    hint: "The agent commits the accepted work and merges its branch into the main one.",
    ask: "The agent is committing and merging the work.",
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
    // "Start", not "Define" (the user: "Define is weird"): what happens
    // first is the agent sizing the issue, and a small one has no separate
    // definition step at all.
    label: "Start",
    hint: "Start on this issue: the agent sizes it and begins.",
    primary: true,
    // Without words on a row (the user's choice): the step already reads
    // "Not started", and a play triangle needs no label.
    icon: "play",
  },
  {
    id: "start-branch",
    from: "not-started",
    to: "define",
    by: ["user", "agent"],
    label: "Start in a new branch",
    hint: "Start on this issue in a branch of its own: the agent creates the branch, then sizes the issue and begins. Commit & merge at the end brings it back.",
    icon: "play-branch",
    // From another branch the new one would be cut from that branch and
    // merge back into it, rarely what is wanted: so not on the row there,
    // but still in the menu for someone who means it.
    mainBranchOnly: true,
    alsoInMenu: true,
    needsCleanFolder:
      "There are uncommitted changes in this folder. Commit them before starting a branch.",
    opening: (issue) => [
      `The user started this issue in a branch of its own. Before anything else, create and switch to a new branch named \`${branchName(issue)}\` from where the folder is now (\`git switch -c ${branchName(issue)}\`), and tell the user in one line that the work is on that branch.`,
      "If a branch of that name already exists, or the branch cannot be created, stop and tell the user: do not reuse or overwrite a branch, and do not go on in the branch you were in.",
      "All of this issue's work is done on that branch. At the end the user chooses whether it is merged.",
      "",
    ],
  },
  {
    id: "start-worktree",
    from: "not-started",
    to: "define",
    // The user's only: an agent does not open conversations for other
    // issues by its own judgment.
    by: ["user"],
    label: "Start in a work tree",
    hint: "Start on this issue in a conversation and a work tree of its own, so it can be worked alongside others. Commit & merge at the end brings it to the main branch and closes that conversation.",
    icon: "play-tree",
    alsoInMenu: true,
    menuOnly: true,
    ownConversation: true,
    opening: (issue) => [
      `This conversation was opened for one issue, ${issue.id}, in a git work tree of its own, on a branch of its own, so that it can be worked while other issues are worked elsewhere. Tell the user in one line which branch this is (\`git branch --show-current\`); do not rename it.`,
      "All of this issue's work is done here. Do not switch branches, and do not touch the repository's main folder until the issue is to be landed.",
      "",
    ],
  },
  // How the agent records the size it chose (see the design notes). A small
  // issue goes straight to Implement, so the step shown is the one the work
  // is really in; a medium or large one stays at Define.
  ...(
    [
      ["s", "implement"],
      ["m", "define"],
      ["l", "define"],
    ] as const
  ).map(
    ([size, to]): WorkflowMove => ({
      id: `size:${size}`,
      from: "define",
      to,
      by: ["agent"],
      label: `Size ${size.toUpperCase()}`,
      hint: `This issue is size ${size.toUpperCase()}; say why in one line.`,
      needsNote: true,
      size,
    }),
  ),
  // A small issue that turns out not to be small: the agent says so from
  // the work step, and goes back to define it at the larger size.
  ...(["m", "l"] as const).map(
    (size): WorkflowMove => ({
      id: `size:${size}`,
      from: "implement",
      to: "define",
      by: ["agent"],
      label: `Size ${size.toUpperCase()}`,
      hint: `This issue is size ${size.toUpperCase()} after all; say why in one line.`,
      needsNote: true,
      size,
      // Not among the usual moves at Implement: it is for the rare case
      // the Implement instructions name.
      unlisted: true,
    }),
  ),
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
    hint: "The work is good. Next you choose how it goes into git.",
    primary: true,
    // Only where there is a choice to make (see "Accept & commit" below).
    ownBranchOnly: true,
  },
  {
    id: "accept-commit",
    from: "user-review",
    to: "commit",
    by: ["user"],
    label: "Accept & commit",
    hint: "The work is good: the agent commits it and the issue closes.",
    primary: true,
    // On the main branch committing is the only way to apply the work, so
    // the Apply step would be a stop with nothing to choose.
    mainBranchOnly: true,
  },
  {
    id: "approved:commit",
    from: "user-review",
    to: "commit",
    by: ["agent"],
    label: "Accepted by the user, to commit",
    hint: "The user has accepted the work and said to commit it, in the conversation; quote what they said.",
    needsNote: true,
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
  // Apply is the user's choice between the two ways the work can go into
  // git (their request: "one option is commit and second, commit and merge,
  // and both of them close the issue"). Before, Apply was the agent's step
  // and it had to ask in the conversation whether it may merge; pressing
  // "Commit & merge" is now that permission.
  {
    id: "commit",
    from: "apply",
    to: "commit",
    by: ["user"],
    label: "Commit",
    hint: "Commit the work where it is. The issue closes when that is done.",
    primary: true,
  },
  {
    id: "commit-merge",
    from: "apply",
    to: "commit-merge",
    by: ["user"],
    label: "Commit & merge",
    hint: "Commit the work and merge its branch into the main one. The issue closes when that is done.",
    ownBranchOnly: true,
  },
  {
    id: "send-back",
    from: "apply",
    to: "implement",
    by: ["user", "agent"],
    label: "Send back",
    hint: "It needs changes after all: say what, and the agent fixes it.",
    needsNote: true,
  },
  // The user's choice, made in the conversation and recorded by the agent,
  // quoting them (as with approvals).
  {
    id: "approved:commit",
    from: "apply",
    to: "commit",
    by: ["agent"],
    label: "Commit, as the user said",
    hint: "The user has said to commit; quote what they said.",
    needsNote: true,
  },
  {
    id: "approved:commit-merge",
    from: "apply",
    to: "commit-merge",
    by: ["agent"],
    label: "Commit & merge, as the user said",
    hint: "The user has said to commit and merge; quote what they said.",
    needsNote: true,
  },
  {
    id: "done",
    from: "commit",
    to: CLOSED,
    by: ["agent", "user"],
    label: "Mark as done",
    hint: "The work is in git: committed. Closes the issue.",
  },
  {
    id: "send-back",
    from: "commit",
    to: "implement",
    by: ["agent"],
    label: "Send back",
    hint: "It cannot be done as it is (for example a conflict that needs rework); say why.",
    needsNote: true,
  },
  {
    id: "done",
    from: "commit-merge",
    to: CLOSED,
    by: ["agent", "user"],
    label: "Mark as done",
    hint: "The work is in git: committed, and its branch merged into the main one. Closes the issue.",
  },
  {
    id: "send-back",
    from: "commit-merge",
    to: "implement",
    by: ["agent"],
    label: "Send back",
    hint: "It cannot be done as it is (for example a conflict that needs rework); say why.",
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
 * - never to Apply or beyond, whichever way: those steps are reached only by
 *   the user's acceptance and then their choice of how to apply the work
 *   (the agent's own caution, kept from before the rule above).
 */
const APPLY_FROM = states.findIndex((state) => state.id === "apply");
const jumps: WorkflowMove[] = states.flatMap((from, fromIndex) =>
  states
    .filter(
      (to, toIndex) =>
        to.id !== from.id &&
        toIndex < APPLY_FROM &&
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

/**
 * The branch an issue is worked in when it is started in one: its id, then
 * a short form of its title, so that the branch says what it is in git.
 * Lower case, words joined by dashes, nothing git would refuse; the title's
 * part is cut at a word where it runs long, and left out when the title has
 * nothing usable in it.
 */
export function branchName(issue: { id: string; title: string }): string {
  const words = issue.title
    .normalize("NFKD")
    // The accents NFKD split off their letters go, the letters stay.
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > 40) break;
    slug = next;
  }
  return slug === "" ? issue.id : `${issue.id}-${slug}`;
}

/** How the agent is told to report a move. */
const report = (issueId: string, moveId: string) =>
  `call the \`${MOVE_TOOL}\` tool with id \`${issueId}\`, move \`${moveId}\` and a one-line note`;

/** The sizes, smallest first (the user's T-shirt sizes). */
const sizes: WorkflowSize[] = [
  {
    id: "s",
    label: "S",
    hint: "Small: done in one go, with one stop for you, at the end.",
  },
  {
    id: "m",
    label: "M",
    hint: "Medium: you review the definition and the plan together, once, then the result.",
  },
  {
    id: "l",
    label: "L",
    hint: "Large: you review the definition, then the plan, then the result.",
  },
];

/** What each size means, as the agent is told it. */
const SIZE_PATHS = [
  "- S, small: one evident way to do it, little to get wrong. No separate definition or plan: you write a short description and acceptance criteria, do the work and review it yourself, and the user sees it once, at the end.",
  "- M, medium: worth agreeing on before building. You write the definition and the plan together and the user reviews both once, then the result.",
  "- L, large, risky or unclear: every step. The user reviews the definition, then the plan, then the result.",
];

/** The four things a definition is made of; shared by the paths that write one. */
const DEFINE_POINTS = [
        "- Make sure it is clear what is wanted, why, and what \"done\" means. Read the code it touches.",
        "- If the issue records open questions for the user, or you have your own, ask them and wait for the answers. Being started on an issue is not permission to assume them. Ask at most a few, only ones whose answer changes what gets built.",
        "- Then write onto the issue, with `bd update`: a description (what is wanted and why, in the user's words where possible, how things work today, what is out of scope) and acceptance criteria (short checks a person can verify). Set its type and priority if they are missing.",
        "- Be proportionate: a one-line request gets a short write-up. Stay inside the request. Format with Markdown. Check every claim about the code against the code.",
];

/**
 * What the agent does at Define. It depends on the issue's size: with none
 * yet, the job is to size it; with one, to take that size's path from here.
 */
function defineText(id: string, size: string | null): string[] {
  switch (size) {
    case "s":
      return [
        "This issue is sized S, small: it has no separate definition or plan.",
        "",
        `Move it to Implement: ${report(id, "to:implement")} saying it is small, and do the work there.`,
      ];
    case "m":
      return [
        "This issue is sized M, medium: define it and plan it together, for one review by the user. Do not build yet.",
        "",
        ...DEFINE_POINTS,
        "- Then work out how to do it and write the plan into the issue's design field (`bd update --design`): the files, the order, anything risky, how you will check it, and what you rejected and why. Do not repeat the definition in the plan.",
        "- Present both to the user in plain words, briefly.",
        "",
        `When both are on the issue, ${report(id, "to:review-plan")} saying that definition and plan are ready together, and wait: the user approves them or sends them back from the Airbender tab.`,
      ];
    case "l":
      return [
        "This issue is sized L, large: every step. Your job now is to define it: turn it from a request into something clear enough to build. Do not plan or build yet.",
        "",
        ...DEFINE_POINTS,
        "",
        `When the definition is on the issue, ${report(id, "done")}, and tell the user it is ready for them to review. They approve it or send it back from the Airbender tab.`,
      ];
    default:
      return [
        "Your first job is to size the issue, so that it takes only the steps it needs. Read it and the code it touches, then choose:",
        "",
        ...SIZE_PATHS,
        "",
        "- In doubt between two sizes, take the larger. The user can change the size until the work reaches them for review, and if they send your work back, take the next larger path.",
        "- Tell the user the size and why in one line.",
        "- Whatever the size: if the issue records open questions for the user, or you have your own, ask them and wait for the answers before anything else. Being started on an issue is not permission to assume them.",
        "",
        `Then record the size: ${report(id, "size:s")} (or \`size:m\`, \`size:l\`), the note saying why. The answer tells you what to do next on that path.`,
      ];
  }
}

/** What the agent does in each of its states. */
function stepText(
  stateId: string,
  id: string,
  size: string | null,
  workTree: boolean,
): string[] {
  switch (stateId) {
    case "define":
      return defineText(id, size);
    case "plan":
      return [
        "Your job now is to plan the work. The definition is agreed; do not change any file yet, and do not repeat the definition in the plan.",
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
        ...(size === "s"
          ? [
              "This issue is sized S, small: there was no separate definition or plan, and this step is the whole job. The user sees it once, at the end.",
              "",
              "- First make sure the issue itself says what is wanted: if its description or acceptance criteria are missing or thin, write a short version of each onto it with `bd update`. A few lines; no plan document.",
              "- If it turns out not to be small after all, stop and say so to the user, and record the larger size with the move `size:m` or `size:l` and a note; that takes the issue back to Define on that path.",
            ]
          : ["Your job now is to do the work. The plan is agreed.", ""]),
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
    case "commit":
      return [
        "The user has accepted this work and chosen to commit it. Your job now is to get it into git.",
        "",
        "- Commit the changes that belong to this issue, following the commit rules in AGENTS.md if it has any: only this issue's files, with the issue's id and title in the subject line. With sub-issues: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title.",
        "- Commit only. Do not merge: the user chose to leave the work on the branch it is on.",
        "- If this repository pushes commits by itself, tell the user if that push fails. Do not push by hand unless the repository's rules say to.",
        "- If everything was already committed, say so. If the work changed no files at all (the issue was a question or a decision), say so: there is nothing to commit.",
        "",
        `When the work is committed, or there was nothing to commit, ${report(id, "done")} naming the commit or saying there was none. That closes the issue.`,
        `If it cannot be done as it is, ${report(id, "send-back")} saying why.`,
      ];
    case "commit-merge":
      if (workTree) {
        return [
          "The user has accepted this work and chosen to commit it and merge it. This conversation works in a work tree of its own, so landing it takes a few steps, in this order.",
          "",
          "- Commit the changes that belong to this issue, following the commit rules in AGENTS.md if it has any: only this issue's files, with the issue's id and title in the subject line.",
          "- Bring the main branch into your branch, here in the work tree: `git merge main`. Other issues may have landed since you started. If there are conflicts and they are straightforward, settle them, make sure the work still does what the issue asks (run what can be run), and commit the merge.",
          `- If you cannot settle the conflicts cleanly, abort the merge (\`git merge --abort\`) and ${report(id, "send-back")} saying which files conflict and why: the issue goes back to the work step.`,
          "- Then move the main branch forward to your branch. The main branch is normally checked out in the repository's main folder (`git worktree list` shows where): run `git -C <that folder> merge --ff-only <your branch>`. If the main branch is checked out nowhere, `git fetch . <your branch>:main` does it. Never force either: if git refuses, for example because that folder has uncommitted changes in the same files, stop and tell the user what is in the way.",
          "- Push the main branch to its remote, if it has one (`git push origin main`): the user's choice of Commit & merge is their approval of that push. Then delete your branch on the remote if it is there (`git push origin --delete <your branch>`).",
          "- Do not remove this work tree or delete the local branch yourself. When you report this step done, Airbender archives this conversation, and removes the work tree and the branch. Tell the user that in one line first: this conversation moves to the archive, where it can still be read.",
          "- Tell the user plainly if any step fails; what has been committed is safe in this work tree.",
          "",
          `When the work is on the main branch and pushed, ${report(id, "done")} naming the commit. That closes the issue and this conversation.`,
          `If it cannot be done as it is, ${report(id, "send-back")} saying why.`,
        ];
      }
      return [
        "The user has accepted this work and chosen to commit it and merge it. Your job now is to get it into git and onto the main branch.",
        "",
        "- Commit the changes that belong to this issue, following the commit rules in AGENTS.md if it has any: only this issue's files, with the issue's id and title in the subject line. With sub-issues: one commit per issue where its changes can be told apart, otherwise one commit whose body lists each issue as id and title.",
        "- Then merge the branch the work is on into the repository's main branch, leaving the folder on the main branch. The user chose this in the Airbender tab: that is their approval of this merge, so do not ask again.",
        "- Then push the main branch to its remote, if it has one: the user's choice of Commit & merge is their approval of that push too. A merge that makes no commit of its own does not set off a hook that pushes on commit, so do not rely on one.",
        "- Only when the main branch is on the remote, delete the branch the work was on: locally (`git branch -d`), and on the remote if it is there (`git push origin --delete <branch>`). Never delete the main branch, and never force a deletion: if git refuses, leave the branch and say why.",
        "- Tell the user plainly if any push or deletion fails; the commit and the merge are safe locally.",
        "- If everything was already committed, say so and merge. If the work is already on the main branch, say so: there is nothing to merge.",
        "",
        `When the work is committed and merged, ${report(id, "done")} naming the commit. That closes the issue.`,
        `If it cannot be done as it is, for example a merge conflict that needs the work redone, ${report(id, "send-back")} saying why.`,
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
    ...stepText(state.id, issue.id, issue.size, issue.workTree === true),
  ].join("\n");
}

/** A size's label, for sentences; the id itself for one this file does not know. */
const sizeLabel = (id: string) =>
  sizes.find((size) => size.id === id)?.label ?? id;

/**
 * The size may be changed until the work reaches the user for their
 * review. After that the work exists, and "Send back" with a sentence says
 * what is to be redone; a new size then would not say whether to keep it.
 */
const REVIEW_FROM = states.findIndex((state) => state.id === "user-review");
function canResize(stateId: string): boolean {
  const index = states.findIndex((state) => state.id === stateId);
  return index >= 0 && index < REVIEW_FROM;
}

/** What the agent is told when the user changes an issue's size under it. */
function resizeInstruction(
  state: WorkflowState,
  issue: WorkflowIssue,
  from: string | null,
  to: string,
): string {
  return [
    `The user changed the size of beads issue ${issue.id} (${JSON.stringify(issue.title)}) ${from === null ? "" : `from ${sizeLabel(from)} `}to ${sizeLabel(to)}. It is at the "${state.label}" step. Take the ${sizeLabel(to)} path from here.`,
    "",
    "The paths:",
    ...SIZE_PATHS,
    "",
    "- A larger size means the user wants to see more before you go on: stop what you are doing, keep what is useful, and bring them what that size has them review first (for M, definition and plan together at Review plan; for L, the definition at Review definition).",
    "- A smaller size means the remaining reviews before the work are dropped: go on to the work.",
    `- Move the issue to the step the new path needs now with ${report(issue.id, "to:<step id>")}, saying why, and carry on from there. If it is already at the right step, say so to the user in one line and carry on.`,
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
    `Not every issue takes every step. Issues have a size, S, M or L, which you choose when you are started on one that has none, with the move \`size:s\`, \`size:m\` or \`size:l\` at ${states[1]!.label}: S is done in one go and reaches the user once, at the end; M has one review at the front, of definition and plan together; L takes every step. In doubt, take the larger. The user can set or change the size; you are told when they do.`,
    "When you create an issue yourself you may give it a size, since you know it better than anyone sizing it later: add the label `size:s`, `size:m` or `size:l`.",
    "A plain question or a discussion needs no issue: answer it in the conversation. Create an issue only when something is to be changed; where a discussion ends in a decision worth keeping, offer to record it.",
    `If you begin work on an issue that is still at ${states[0]!.label} (for example from a typed request), move it with \`start\` first; if the user asked for it to be done in a branch of its own, with \`start-branch\` instead, which tells you the branch to create and is refused while the folder has uncommitted changes.`,
    `When you finish a step, report it with the ${MOVE_TOOL} tool (${agentMoves}), each with a short note. The tool tells you what comes next: either your next step, or that the issue now waits for the user.`,
    "You have the judgment to move an issue to where the work really is: the move `to:<step id>` (the ids are in square brackets above) takes it to any step, with your reason, for example to leave out steps that are not needed. Two limits: while an issue waits for the user's review you may only move it back, not on; and you can never move an issue to Apply or past it.",
    "While an issue waits for the user's review, read what they reply. If they ask for changes, move it back with `send-back`, giving their words as the reason, and redo the work; a long rework belongs in the work step, a quick question does not need a move at all. If they approve in the conversation, record it with `approved`, quoting what they said, and carry on. At Human review, if they accept the work and say to commit it, record that with `approved:commit` instead, which goes straight to the commit. At Apply the user chooses between committing and committing with a merge; if they say which in the conversation, record it with `approved:commit` or `approved:commit-merge`, quoting them. Never record an approval the user has not given.",
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
  sizes,
  sizeGuide: SIZE_PATHS.join("\n"),
  canResize,
  resizeInstruction,
};
