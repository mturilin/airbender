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
//   step of the workflow, done by the agent. The plugin changes git in one
//   place only: a merged branch left by a work tree (server/work-trees.ts).
// - Which issue a thread is on is separate from the workflow: setCurrent
//   moves no step. It still tells the agent, with a note that asks for
//   nothing.
// - Which workflow applies is asked per folder (server/workflow-choice.ts):
//   a repository can be on the simple workflow, which has no steps. There
//   play and every move are refused in plain words, and closing an issue is
//   the plain close, done here so that it takes the open sub-issues along.
// - Problems are returned as a message in plain words, like every other
//   operation, so the tab (and the agent's tool) can show them.
//
// Gotchas:
// - An agent can be told to report a step but not forced to. The workflow
//   therefore lets the user report it instead; nothing here tries to detect
//   work done without a report.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { wordsFor } from "../shared/tracker-words.ts";
import { descendantsOf } from "../shared/tree.ts";
import {
  CLOSED,
  checkMove,
  epicOver,
  movesFor,
  stateOf,
} from "../shared/workflow.ts";
import type { Actor, Workflow, WorkflowState } from "../shared/workflow.ts";
import { NO_STEPS_MESSAGE } from "../shared/workflows.ts";
import { workflowLine } from "./agent-tools.ts";
import type { WorkTrees } from "./work-trees.ts";
import type { WorkflowChoice } from "./workflow-choice.ts";
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
   * The message is a warning about something the user can put right (the
   * folder has uncommitted changes), not a failure: the tab shows it in a
   * message box. Left out otherwise.
   */
  warning?: boolean;
  /**
   * The move opened a conversation of its own for the issue: its id, so
   * the tab can go there. Left out otherwise.
   */
  openThreadId?: string;
  /**
   * The move set an epic up to be worked issue by issue (in the
   * conversation opened, when there is one): the tab enters epic mode.
   */
  enterEpic?: boolean;
  /**
   * For the agent: what to do next, when the new state is the agent's.
   * Null when the issue now waits for the user, or was closed.
   */
  instruction: string | null;
}

/**
 * What happens here that autopilot (server/autopilot.ts) acts on. The
 * fields are set after both are built, since each needs the other; until
 * then, and in tests, nothing listens.
 */
export interface WorkEvents {
  /** The agent of a conversation was handed something to do. */
  delivered?: (threadId: string) => void;
  /** An issue was closed from a conversation, which may now be free. */
  closed?: (threadId: string) => void;
  /** The agent sent an issue back from the step that would have closed it. */
  stuck?: (threadId: string, beadId: string, why: string) => void;
  /** The owner made an issue current, or released one, by hand. */
  ownerCurrent?: (threadId: string) => void;
}

/**
 * Builds the workflow operations for this plugin instance.
 *
 * @param workflowChoice Answers which workflow a folder's issues follow.
 * @param events Told what happens; see WorkEvents.
 * @returns `run`, `begin`, `move`, `resize`, `close` and `setCurrent`.
 * Side effects: none until one of them is called.
 */
export function createWork({
  bb,
  store,
  currentBead,
  workflowChoice,
  onUserSize,
  hasUncommittedChanges,
  currentBranch,
  workTrees,
  trackerOf,
  events = {},
}: {
  bb: BbPluginApi;
  store: Store;
  currentBead: CurrentBead;
  workflowChoice: WorkflowChoice;
  /**
   * Told when the user has set an issue's size themselves, so that the
   * background sizing treats that size as theirs (server/sizing.ts).
   */
  onUserSize: (path: string, beadId: string) => void;
  /**
   * Which tracker a folder's issues are in, as last found; null when not
   * known. Decides how the agent is told to type the tracker's commands.
   */
  trackerOf: (path: string) => string | null;
  /** Whether a folder has uncommitted changes to tracked files. */
  hasUncommittedChanges: (path: string) => Promise<boolean>;
  /** The branch a folder is on; null when it cannot be told. */
  currentBranch: (path: string) => Promise<string | null>;
  /** Conversations opened for one issue in a work tree of its own. */
  workTrees: WorkTrees;
  events?: WorkEvents;
}) {
  const {
    issuesIn,
    setIssueOpen,
    setStep,
    setSize,
    setBranch,
    addComment,
    changed,
  } = store;

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
    events.delivered?.(threadId);
  }

  /**
   * The epic an issue belongs to that holds a branch for its issues
   * (bead-bb-ty5.2), or null. See epicOver.
   */
  const homeOf = (workflow: Workflow, issue: Issue, issues: Issue[]) =>
    epicOver(workflow, issue, (id) =>
      issues.find((candidate) => candidate.id === id),
    );

  /**
   * Why an issue cannot be worked on from this folder: it belongs to an
   * epic whose issues are worked on that epic's branch, and the folder is
   * not on it (the user's rule: "its issues are worked on only in a folder
   * on that branch"). The same for the epic itself, which is landed from
   * its branch.
   *
   * @returns The reason in plain words, or null when there is none.
   * Side effects: one read-only git command when the issue has such an epic.
   */
  async function wrongPlace(
    workflow: Workflow,
    issue: Issue,
    issues: Issue[],
    path: string,
  ): Promise<string | null> {
    const own = stateOf(workflow, issue.step).holdsBranch === true;
    const home = own ? issue : homeOf(workflow, issue, issues);
    if (home === null) return null;
    const what = own
      ? `${issue.id} is an epic whose issues are worked`
      : `${issue.id} belongs to the epic ${home.id} (${JSON.stringify(home.title)}), whose issues are worked`;
    if (home.branch === null) {
      return `${what} in a work tree that is still being set up. Try again in a moment.`;
    }
    const here = await currentBranch(path);
    if (here === home.branch) return null;
    return `${what} on the branch ${home.branch}. This folder is on ${here ?? "no branch"}: work on it in a folder that is on ${home.branch}.`;
  }

  /**
   * What the workflow may say about an issue: itself, its open sub-issues,
   * and how the commands of the folder's tracker are written.
   *
   * @param path The folder the issue was read from, which decides the
   *   wording: `bd` for beads, `bend` where the issues are on GitHub.
   */
  const describe = (
    path: string,
    issue: Issue,
    issues: Issue[],
    threadId: string | null = null,
    workflow: Workflow | null = null,
  ) => ({
    id: issue.id,
    title: issue.title,
    words: wordsFor(trackerOf(path)),
    size: issue.size,
    holdsBranch: issue.branch !== null,
    epic: (() => {
      const home = workflow === null ? null : homeOf(workflow, issue, issues);
      return home === null || home.branch === null
        ? undefined
        : { id: home.id, title: home.title, branch: home.branch };
    })(),
    // Whether the conversation that will read this is one the plugin
    // opened for an issue in a work tree: its landing is told differently.
    workTree: workTrees.isOurs(threadId),
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
    preface,
  }: {
    threadId: string;
    beadId: string;
    /** A line put in front of what the agent is told (autopilot's). */
    preface?: string;
  }): Promise<Outcome> {
    const found = await openIssue({ threadId, projectId: null }, beadId);
    if ("message" in found) return found;
    const workflow = workflowChoice.workflowFor(found.path);
    if (workflow === null) return { message: NO_STEPS_MESSAGE };
    const state = stateOf(workflow, found.issue.step);
    if (state.actor !== "agent") {
      return {
        message: `Issue ${beadId} is at "${state.label}", which waits for you, not the agent.`,
      };
    }
    const elsewhere = await wrongPlace(
      workflow,
      found.issue,
      found.issues,
      found.path,
    );
    if (elsewhere !== null) return { message: elsewhere };
    try {
      await currentBead.write(threadId, beadId);
      const told = workflow.instruction(
        state,
        describe(found.path, found.issue, found.issues, threadId, workflow),
      );
      await deliver(
        threadId,
        preface === undefined ? told : `${preface}\n\n${told}`,
      );
    } catch (cause) {
      return {
        message: `The agent could not be started on ${beadId}: ${reason(cause)}`,
      };
    }
    return { message: null };
  }

  /**
   * Starts an issue in a conversation, or takes it up again, as the tab's
   * buttons would: autopilot's way to get on with the next issue
   * (server/autopilot.ts). Knows no step by name:
   * - at one of the agent's steps, it is play (`run`);
   * - not started, it is the workflow's own starting move, the user's main
   *   move at the first step;
   * - waiting for the owner, the issue is only made the conversation's
   *   current one, so that its buttons show.
   *
   * @param preface A line put in front of what the agent is told.
   * @returns `message` null on success, else why not, in plain words.
   */
  async function begin({
    threadId,
    beadId,
    preface,
  }: {
    threadId: string;
    beadId: string;
    preface: string;
  }): Promise<Outcome> {
    const found = await openIssue({ threadId, projectId: null }, beadId);
    if ("message" in found) return found;
    const workflow = workflowChoice.workflowFor(found.path);
    if (workflow === null) return { message: NO_STEPS_MESSAGE };
    const state = stateOf(workflow, found.issue.step);
    if (state.actor === "agent") return run({ threadId, beadId, preface });
    if (state.id === workflow.initial) {
      const start = movesFor(workflow, state.id, "user").find(
        (candidate) => candidate.primary === true,
      );
      if (start === undefined) {
        return { message: "This workflow has no move that starts an issue." };
      }
      const moved = await move(
        { threadId, projectId: null, beadId, moveId: start.id, note: "", preface },
        "user",
      );
      return { message: moved.message };
    }
    const elsewhere = await wrongPlace(
      workflow,
      found.issue,
      found.issues,
      found.path,
    );
    if (elsewhere !== null) return { message: elsewhere };
    try {
      await currentBead.write(threadId, beadId);
    } catch (cause) {
      return { message: reason(cause) };
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
    input: FolderRef & {
      beadId: string;
      moveId: string;
      note: string;
      /** A line put in front of what the agent is told (autopilot's). */
      preface?: string;
    },
    by: Actor,
  ): Promise<MoveOutcome> {
    const fail = (message: string) => ({ message, state: null, instruction: null });
    const { beadId, threadId } = input;
    const found = await openIssue(input, beadId);
    if ("message" in found) return fail(found.message);
    const { issue, issues, path } = found;
    const workflow = workflowChoice.workflowFor(path);
    if (workflow === null) return fail(NO_STEPS_MESSAGE);
    const from = stateOf(workflow, issue.step);
    const checked = checkMove(workflow, issue.step, input.moveId, by, input.note);
    if ("message" in checked) return fail(checked.message);
    const warn = (message: string) => ({ ...fail(message), warning: true });
    const openSubIssues = descendantsOf(issue.id, issues).filter(
      (candidate) => candidate.status !== CLOSED_STATUS,
    );
    // An issue of an epic that holds a branch (bead-bb-ty5.2) is worked
    // only on that branch, never gets a place of its own, and is never
    // merged by itself.
    const home = homeOf(workflow, issue, issues);
    if (home !== null && checked.ownPlace === true) {
      return warn(
        `${beadId} belongs to the epic ${home.id} (${JSON.stringify(home.title)}), which has a branch of its own${home.branch === null ? "" : ` (${home.branch})`}. Its issues are worked there, not in a branch or work tree of their own.`,
      );
    }
    // Not asked of the move that gives the branch up: it is made when the
    // branch could not be created, so the folder is not on it.
    const elsewhere =
      checked.dropsBranch === true
        ? null
        : await wrongPlace(workflow, issue, issues, path);
    if (elsewhere !== null) return warn(elsewhere);
    if (home !== null && checked.merges === true) {
      return fail(
        `${beadId} belongs to the epic ${home.id}, whose branch is merged once, when the epic is closed. Commit this issue's work only.`,
      );
    }
    if (checked.needsSubIssuesClosed === true && openSubIssues.length > 0) {
      return warn(
        `${beadId} still has ${openSubIssues.length === 1 ? "an open issue" : `${openSubIssues.length} open issues`} under it (${openSubIssues.map((sub) => sub.id).join(", ")}). Close ${openSubIssues.length === 1 ? "it" : "them"} first.`,
      );
    }
    // Setting a place up for an epic's issues: not while one of them is
    // being worked on somewhere (the user: "we just check that ... the sub
    // issues of the epic are not worked on, so they're not current in any
    // of the chats. If there is any ... we will stop.").
    const forEpic =
      checked.epic !== undefined && openSubIssues.length > 0
        ? checked.epic
        : null;
    if (forEpic !== null) {
      // A branch is made by the conversation's agent; without a
      // conversation (the new-conversation screen) there is nobody to make
      // it, and the epic would be left pointing at a branch that is not
      // there. A work tree brings its own conversation.
      if (checked.ownConversation !== true && threadId === null) {
        return warn(
          "Open a conversation first: its agent creates the epic's branch. Or start the epic in a work tree, which opens a conversation of its own.",
        );
      }
      let projectId = input.projectId;
      try {
        if (threadId !== null) {
          projectId = (await bb.sdk.threads.get({ threadId })).projectId;
        }
        const held =
          projectId === null
            ? []
            : await currentBead.heldAmong(
                projectId,
                new Set(openSubIssues.map((sub) => sub.id)),
              );
        if (held.length > 0) {
          return warn(
            `${held.join(", ")} ${held.length === 1 ? "is" : "are"} being worked on: ${held.length === 1 ? "it is the current issue of a conversation" : "they are current issues of conversations"}. Finish or release ${held.length === 1 ? "it" : "them"} before giving the epic a branch or a work tree.`,
          );
        }
      } catch (cause) {
        return fail(
          `Could not check whether the epic's issues are being worked on: ${reason(cause)}`,
        );
      }
    }
    // A move may need the folder to be clean (starting in a new branch):
    // refused with the move's own warning, and nothing is changed.
    if (
      checked.needsCleanFolder !== undefined &&
      (await hasUncommittedChanges(path))
    ) {
      return { ...fail(checked.needsCleanFolder), warning: true };
    }
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
      if (closed.message === null) {
        await record("closed");
        // A landed epic's branch is gone: the record of it goes too, so
        // that an issue of it reopened later is not sent to that branch.
        if (issue.branch !== null) {
          await setBranch(path, threadId, beadId, null, false);
        }
        // Landed from a conversation opened for it in a work tree: that
        // conversation, its tree and its branch are closed up.
        if (threadId !== null) workTrees.landed(threadId, beadId);
        if (threadId !== null) events.closed?.(threadId);
      }
      return { ...closed, state: null, instruction: null };
    }

    if (forEpic !== null) {
      const holding = stateOf(workflow, forEpic.to);
      const about = describe(path, issue, issues);
      const text = forEpic.opening(about).join("\n");
      let openThreadId: string | undefined;
      if (checked.ownConversation === true) {
        const started = await workTrees.open({
          from: input,
          home: path,
          beadId,
          title: issue.title,
          prompt: text,
        });
        if ("message" in started) return fail(started.message);
        openThreadId = started.threadId;
        // The new conversation is on no issue: its issues are started one
        // by one. BB names the tree's branch itself, a moment later; it is
        // recorded on the epic when it is known.
        const opened = started.threadId;
        void workTrees.branchOf(opened).then(async (branch) => {
          if (branch === null) {
            bb.log.warn(`the work tree branch of epic ${beadId} could not be read`);
            return;
          }
          await setBranch(path, threadId, beadId, branch);
        });
      } else {
        const named = await setBranch(
          path,
          threadId,
          beadId,
          forEpic.branch?.(about) ?? null,
          false,
        );
        if (named.message !== null) return fail(named.message);
      }
      const moved = await setStep(path, threadId, beadId, holding.id, false);
      if (moved.message !== null) return fail(moved.message);
      await record(
        `${holding.label}${openThreadId === undefined ? "" : ", in a conversation and work tree of its own"}`,
      );
      let message: string | null = null;
      if (openThreadId === undefined && by === "user" && threadId !== null) {
        try {
          await deliver(threadId, text);
        } catch (cause) {
          message = `The epic is now at "${holding.label}", but the agent could not be asked to create the branch: ${reason(cause)}`;
        }
      }
      changed(threadId);
      return {
        message,
        state: holding,
        instruction: by === "agent" ? text : null,
        openThreadId,
        enterEpic: true,
      };
    }

    const to = stateOf(workflow, checked.to);
    // Leaving the epic's step without landing it: the branch is forgotten.
    if (checked.dropsBranch === true) {
      const dropped = await setBranch(path, threadId, beadId, null, false);
      if (dropped.message !== null) return fail(dropped.message);
    }
    // A move that is made in a conversation of its own: the conversation
    // is opened first, with what the agent is to do as its first message,
    // and only when that worked is anything recorded on the issue. Nothing
    // is sent to the conversation the move was asked from.
    if (checked.ownConversation === true) {
      const told = workflow.instruction(to, {
        ...describe(path, issue, issues),
        workTree: true,
      });
      const started = await workTrees.open({
        from: input,
        home: path,
        beadId,
        title: issue.title,
        prompt: [
          ...(checked.opening?.(describe(path, issue, issues)) ?? []),
          told,
        ].join("\n"),
      });
      if ("message" in started) return fail(started.message);
      await currentBead.store(started.threadId, beadId);
      const moved = await setStep(path, threadId, beadId, to.id, false);
      if (moved.message !== null) return fail(moved.message);
      await record(`${to.label}, in a conversation and work tree of its own`);
      changed(threadId);
      return {
        message: null,
        state: to,
        instruction: null,
        openThreadId: started.threadId,
      };
    }
    // Not published yet: the comment and a possible message follow, and the
    // tabs should reload once, on the finished move.
    const stepped = await setStep(path, threadId, beadId, to.id, false);
    if (stepped.message !== null) return fail(stepped.message);
    // A move may also record the issue's size: that is how the agent says
    // which path it chose. What follows is then told for that size.
    let sized = issue;
    if (checked.size !== undefined) {
      const resized = await setSize(path, threadId, beadId, checked.size, false);
      if (resized.message !== null) return fail(resized.message);
      sized = { ...issue, size: checked.size };
    }
    await record(to.label);
    // The note is passed on to the agent only when the issue was sent back
    // to an earlier step: then it says what to redo. The note of a move
    // forward (what was done, why a step was skipped) is for the record,
    // not an instruction.
    const order = (state: WorkflowState) => workflow.states.indexOf(state);
    const told =
      to.actor === "agent"
        ? workflow.instruction(
            to,
            describe(path, sized, issues, threadId, workflow),
            // A note is passed on only with a move back; a move that sets
            // the size is the agent's own and its note is for the record.
            order(to) < order(from) && checked.size === undefined
              ? note
              : undefined,
          )
        : null;
    // What the move itself has the agent do first (make a branch) goes in
    // front of the step's instructions.
    const text =
      told === null || checked.opening === undefined
        ? told
        : [...checked.opening(describe(path, sized, issues)), told].join("\n");
    let message: string | null = null;
    if (text !== null && by === "user" && threadId !== null) {
      try {
        await currentBead.store(threadId, beadId);
        await deliver(
          threadId,
          input.preface === undefined ? text : `${input.preface}\n\n${text}`,
        );
      } catch (cause) {
        message = `The issue is now at "${to.label}", but the agent could not be started: ${reason(cause)}`;
      }
    }
    // The agent gave up on the step that would have closed the issue (it
    // could not commit or merge): for autopilot that is a stuck issue.
    if (
      by === "agent" &&
      threadId !== null &&
      workflow.moves.some(
        (candidate) => candidate.from === from.id && candidate.to === CLOSED,
      )
    ) {
      events.stuck?.(threadId, beadId, note === "" ? `it went back to "${to.label}".` : note);
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
   * The user sets or changes an issue's size.
   *
   * Allowed while the workflow says the size may still change (until the
   * work reaches the user for review). When the issue is already under way
   * and is the thread's current issue, the agent is told to take the new
   * size's path. Otherwise the size is only recorded: an issue nobody has
   * started is read when it is started, and one that another thread is on
   * is not this thread's to redirect.
   *
   * @returns `message` null on success. When the size was recorded but the
   *   agent could not be told, the message says so; the size stands.
   * Side effects: a label and a comment on the issue; possibly one message
   *   to the thread.
   */
  async function resize(
    input: FolderRef & { beadId: string; size: string },
  ): Promise<Outcome> {
    const { beadId, threadId, size } = input;
    const found = await openIssue(input, beadId);
    if ("message" in found) return found;
    const { issue, issues, path } = found;
    const workflow = workflowChoice.workflowFor(path);
    if (workflow === null) return { message: NO_STEPS_MESSAGE };
    const known = workflow.sizes?.find((candidate) => candidate.id === size);
    if (known === undefined) {
      return { message: `"${size}" is not a size this workflow has.` };
    }
    if (issue.size === size) return { message: null };
    const state = stateOf(workflow, issue.step);
    if (workflow.canResize?.(state.id) !== true) {
      return {
        message: `Issue ${beadId} is at "${state.label}": its size can no longer be changed. Use "Send back" and say what should be redone.`,
      };
    }
    const resized = await setSize(path, threadId, beadId, size, false);
    if (resized.message !== null) return resized;
    onUserSize(path, beadId);
    const labelOf = (id: string | null) =>
      id === null
        ? "none"
        : (workflow.sizes?.find((candidate) => candidate.id === id)?.label ?? id);
    await addComment(
      path,
      beadId,
      `Workflow: size ${labelOf(issue.size)} → ${known.label} (by the user).`,
    );
    let message: string | null = null;
    // Told only when work is under way: before that there is nothing to
    // redirect, and the size is read when the issue is started.
    const started = state.id !== workflow.initial;
    const text = workflow.resizeInstruction?.(
      state,
      describe(path, { ...issue, size }, issues),
      issue.size,
      size,
    );
    // And only the thread that is on this issue: a size changed from the
    // tab of a thread working on something else must not pull that thread's
    // agent over to this issue.
    if (
      started &&
      threadId !== null &&
      text !== undefined &&
      (await currentBead.read(threadId).catch(() => null)) === beadId
    ) {
      try {
        await deliver(threadId, text);
      } catch (cause) {
        message = `The size is now ${known.label}, but the agent could not be told: ${reason(cause)}`;
      }
    }
    changed(threadId);
    return { message };
  }

  /**
   * The close button: closes an issue that is not being finished through a
   * workflow.
   *
   * On the standard workflow this is cancelling, and it closes that one
   * issue (beads refuses while it has open sub-issues, and says so). On the
   * simple workflow it is the only way an issue is closed, so it closes the
   * open sub-issues first, as finishing does on the standard one.
   */
  async function close(input: FolderRef & { beadId: string }): Promise<Outcome> {
    const found = await openIssue(input, input.beadId);
    if ("message" in found) return found;
    const outcome = await (workflowChoice.workflowFor(found.path) === null
      ? finish(input, found.issues)
      : setIssueOpen("close", input));
    if (outcome.message === null && input.threadId !== null) {
      events.closed?.(input.threadId);
    }
    return outcome;
  }

  /**
   * Sets the thread's current issue, or releases it (null), without moving
   * any workflow step and without starting any work.
   *
   * The agent is told with a short note (the user's decision), so that it
   * and the status line above the message box agree about which issue the
   * thread is on. The note says plainly that nothing is to be done: it costs
   * one short turn, in which the agent only acknowledges it.
   *
   * @returns `message` null on success. When the issue was set but the note
   *   could not be delivered, the message says so; the setting stands.
   * Side effects: writes the thread's current issue; one message to the
   *   thread, unless nothing changed.
   */
  async function setCurrent({
    threadId,
    beadId,
  }: {
    threadId: string;
    beadId: string | null;
  }): Promise<Outcome> {
    let title = "";
    // Which workflow applies to the issue and where it stands, for the note.
    let applies = "";
    if (beadId !== null) {
      const found = await openIssue({ threadId, projectId: null }, beadId);
      if ("message" in found) return found;
      title = found.issue.title;
      applies = ` ${workflowLine(workflowChoice.workflowFor(found.path), found.issue.step)}`;
    }
    let previous: string | null;
    try {
      previous = await currentBead.read(threadId);
      if (previous === beadId) return { message: null };
      // The owner has taken over: autopilot, if on here, turns off.
      events.ownerCurrent?.(threadId);
      await currentBead.write(threadId, beadId);
    } catch (cause) {
      return { message: reason(cause) };
    }
    const was = previous === null ? "" : ` It was ${previous}.`;
    const note =
      beadId === null
        ? `FYI: the user released this thread's current issue (${previous}). The thread is on no issue now. No action is needed.`
        : `FYI: the user made ${beadId} (${JSON.stringify(title)}) this thread's current issue.${was}${applies} This only changes which issue the thread is on: do not start work on it until you are asked to. No action is needed.`;
    try {
      await deliver(threadId, note);
    } catch (cause) {
      return {
        message: `The current issue was changed, but the agent could not be told: ${reason(cause)}`,
      };
    }
    return { message: null };
  }

  return { run, begin, move, resize, close, setCurrent };
}
