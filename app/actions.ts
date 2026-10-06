// app/actions.ts — what a row or an opened issue can do, and how it is done.
//
// What: the actions a row or an opened issue has: IssueLookups (questions
// about the list) and IssueCommands (things that change something), the
// hook that builds them out of requests to the backend (useIssueActions),
// and the context that hands them to the rows (IssueActionsProvider,
// useActions).
//
// Why: rows are drawn several levels below the panel that owns the data and
// the requests. One documented set of actions, provided once and picked up
// where it is used, keeps the components in between out of it.
//
// Design notes:
// - Lookups and commands are separate interfaces so it is plain which
//   members can change something, and so a new one has an obvious home.
// - Delivered by React context, so adding an action touches this file and
//   the component that uses it, and nothing in between.

import { createContext, useCallback, useContext, useState } from "react";
import type {
  Issue,
  IssueComment,
  IssueLink,
  IssuesResult,
} from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import type { IssueType, LinkKind } from "../shared/constants.ts";
import { CLOSED, movesFor, stateOf } from "../shared/workflow.ts";
import { DEFAULT_WORKFLOW_ID, workflowFor } from "../shared/workflows.ts";
import type { PendingClose } from "./close-dialog.tsx";
import { focusBlock } from "./issue-model.ts";
import type { IssueTree } from "./issue-model.ts";
import type { Scope, useIssues } from "./use-issues.ts";

/**
 * What a row or an opened issue may ask about the list: plain lookups that
 * change nothing.
 */
export interface IssueLookups {
  /**
   * Whether the folder's work is on a branch other than the repository's
   * main one; the workflow words some buttons by it.
   */
  ownBranch: boolean;
  /** Id of the bead this thread works on; null when none. */
  currentBeadId: string | null;
  /** The epic the tab is zoomed in on (epic mode); null for the whole list. */
  focusId: string | null;
  /**
   * Whether an issue offers epic mode, and whether it may be entered now.
   *
   * @returns Null when it is not offered: the issue has no sub-issues, is
   *   closed, or is the epic already zoomed in on. Otherwise `blocked` is
   *   null when it may be entered, else the reason in plain words.
   */
  focusOffer: (beadId: string) => { blocked: string | null } | null;
  /**
   * Fetches one issue's comments, oldest first. Resolves to the comments, or
   * rejects with a plain-language reason.
   */
  loadComments: (beadId: string) => Promise<IssueComment[]>;
  /**
   * The sub-issues drawn under an issue: its direct children, open ones
   * first. Leaves out the thread's current bead, which is drawn in Current.
   */
  childrenOf: (beadId: string) => Issue[];
  /**
   * Whether `beadId` may be dropped into `parentId`: not into itself, not
   * into one of its own sub-issues, and not where it already is.
   */
  canNest: (beadId: string, parentId: string) => boolean;
  /** The categories in use in this repository, in alphabetical order. */
  categories: string[];
  /**
   * The issues `beadId` may be moved into: every open issue except itself,
   * its own sub-issues at any depth, and the parent it is already in.
   */
  moveTargets: (beadId: string) => Issue[];
  /** The issues `beadId` may be linked with: every issue except itself. */
  linkTargets: (beadId: string) => Issue[];
}

/**
 * What a row or an opened issue may do. Each is a request to the backend
 * followed by a refresh, or a change to what the panel shows.
 */
export interface IssueCommands {
  /**
   * Changes which bead this thread works on, straight away; null releases
   * it. No workflow step is moved; the backend tells the agent with a short
   * note. Null when there is no thread.
   */
  setCurrent: ((beadId: string | null) => void) | null;
  /**
   * Makes an issue this thread's current one, asking first when another
   * issue is current and would be replaced (see CurrentToggle). Null when
   * there is no thread.
   */
  makeCurrent: ((beadId: string) => void) | null;
  /**
   * Epic mode: zooms the tab in on an issue's sub-issues; null goes back to
   * the whole list. Entering while that issue is the thread's current one
   * releases it first (the user's rule), so a sub-issue can be picked.
   * Does nothing when entering is not allowed (see focusOffer).
   */
  focus: (beadId: string | null) => void;
  /**
   * Play: makes an issue this thread's current one and gets the agent going
   * on the step of the workflow the issue is at. Null when there is no
   * thread, since there is then no agent to start.
   */
  run: ((beadId: string) => void) | null;
  /**
   * Makes one of the user's moves in an issue's workflow (approve, send
   * back, skip, accept…). A move that closes the issue is confirmed in a
   * dialog first; the others happen straight away.
   *
   * @param note The reason, for moves that need one; "" otherwise.
   */
  move: (beadId: string, moveId: string, note: string) => void;
  /**
   * Sets or changes an issue's size (S, M, L: how much of the workflow it
   * takes), straight away. When the agent is already working on the issue
   * the backend tells it to take the new size's path.
   */
  setSize: (beadId: string, size: string) => void;
  /**
   * Asks the background agent to size an issue now, replacing any size it
   * has. Only useful on an open issue that has not been started.
   */
  requestSizing: (beadId: string) => void;
  /**
   * Cancel: asks to close an open issue without finishing it (the user
   * confirms in a dialog first). Finishing an issue is a workflow move.
   */
  close: (beadId: string) => void;
  /**
   * Changes an issue's type and/or priority in beads, straight away and
   * without confirmation (it is one click to change back). A field left out
   * is not touched.
   */
  edit: (
    beadId: string,
    change: { type?: IssueType; priority?: number },
  ) => void;
  /**
   * Saves a new title and description for an issue. Resolves to null on
   * success, or to a plain-language reason on failure, so the edit form can
   * stay open with what was typed.
   */
  saveText: (
    beadId: string,
    text: { title: string; description: string },
  ) => Promise<string | null>;
  /**
   * Opens the details window on an issue that has sub-issues, or moves the
   * already open window to it.
   */
  openDetails: (beadId: string) => void;
  /**
   * Moves an issue inside another (parentId set) or out to the top level
   * (parentId null). No confirmation: it is undone by moving it back.
   */
  setParent: (beadId: string, parentId: string | null) => void;
  /**
   * Sets an issue's category (replacing the one it has) or, with null,
   * clears it. Straight away and without confirmation, like type and
   * priority.
   */
  setCategory: (beadId: string, category: string | null) => void;
  /**
   * Adds a link of one of beads' kinds, stored on `fromId` and pointing at
   * `toId` ("fromId is blocked by toId"). Straight away, no confirmation:
   * it is undone with the chip's remove button.
   */
  link: (fromId: string, toId: string, kind: LinkKind) => void;
  /** Removes `link`, one of the links listed on issue `beadId`. */
  unlink: (beadId: string, link: IssueLink) => void;
  /**
   * Gets the new-issue field at the bottom ready to create an issue inside
   * `parentId`: selects it as the parent there and puts the cursor in the
   * field. Nothing is created until the user types a title and presses
   * Enter. There is deliberately no second text field for this on the row.
   */
  addSubIssue: (parentId: string) => void;
  /** Reopens a closed issue; no confirmation. */
  reopen: (beadId: string) => void;
}

/** Everything a row can ask and do: the lookups and the commands together. */
export type IssueActions = IssueLookups & IssueCommands;

const ActionsContext = createContext<IssueActions | null>(null);

/**
 * Makes the actions available to every row drawn inside it. The panel
 * provides its own; the details window provides a copy in which "Add
 * sub-issue" readies the window's own field.
 */
export const IssueActionsProvider = ActionsContext.Provider;

/**
 * The actions for the list this component is drawn in.
 *
 * Read from context and not passed as a prop: a row sits four components
 * below the panel, and handing the object through each of them made every
 * one of them know about all of it.
 *
 * @throws When used outside an IssueActionsProvider, which is a mistake in
 *   the code and not something a user can cause.
 */
export function useActions(): IssueActions {
  const actions = useContext(ActionsContext);
  if (actions === null) {
    throw new Error("useActions must be used inside an IssueActionsProvider.");
  }
  return actions;
}

/** What useIssueActions hands back to the panel. */
export interface IssueActionsView {
  actions: IssueActions;
  /**
   * Creates an issue inside `parentId` (null for the top level). Resolves
   * to null on success, else the reason in plain words.
   */
  createIn: (
    parentId: string | null,
    draft: {
      title: string;
      description: string;
      type: IssueType | null;
      priority: number | null;
      category: string | null;
    },
  ) => Promise<string | null>;
  /**
   * Carries out a close the user has confirmed: the workflow's closing move
   * when it came from one, a plain cancel otherwise.
   */
  confirmClose: (pending: PendingClose) => void;
  /** The last action's failure in plain words; null when it worked. */
  actionProblem: string | null;
  setActionProblem: (problem: string | null) => void;
  /** Shows a thrown failure the same way as a refused action. */
  reportProblem: (cause: unknown) => void;
}

/**
 * Builds the IssueActions object for a panel: every action is a request to
 * the backend followed by a refresh, with a failure kept in `actionProblem`
 * for the panel to show.
 *
 * The few actions that change what the panel itself shows (asking to
 * confirm a close, moving the details window, readying the new-issue field)
 * are handed in, because that state belongs to the panel.
 *
 * @param askClose Called when a row asks to close an issue, by cancelling
 *   it or by a closing move; the panel confirms and then calls
 *   `confirmClose`.
 * @param askWarn Called with a warning to show in a message box (a move
 *   that was not made because of something the user can put right).
 * @param askSwitch Called when making an issue current would replace
 *   another current issue; the panel confirms and then sets it.
 * @param openDetails Opens the details window on an issue.
 * @param closeDetails Closes the details window (play starts the agent in
 *   the conversation, which the window would cover).
 * @param addSubIssue Readies the new-issue field for a sub-issue of the
 *   given issue.
 * @param focusId The epic the tab is zoomed in on; `setFocus` changes it.
 */
export function useIssueActions({
  scope,
  rpc,
  result,
  tree,
  descendantIds,
  categories,
  refresh,
  askClose,
  askSwitch,
  askWarn,
  openDetails,
  closeDetails,
  addSubIssue,
  focusId,
  setFocus,
}: {
  scope: Scope;
  rpc: ReturnType<typeof useIssues>["rpc"];
  result: IssuesResult | null;
  tree: IssueTree;
  descendantIds: (beadId: string) => Set<string>;
  categories: string[];
  refresh: () => void;
  askClose: (pending: PendingClose) => void;
  askSwitch: (to: Issue) => void;
  askWarn: (warning: string) => void;
  openDetails: (beadId: string) => void;
  closeDetails: () => void;
  addSubIssue: (parentId: string) => void;
  focusId: string | null;
  setFocus: (beadId: string | null) => void;
}): IssueActionsView {
  const { threadId, projectId } = scope;
  // The repository's workflow; null on the simple one, which has no moves.
  const workflow = workflowFor(result?.workflow ?? DEFAULT_WORKFLOW_ID);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const reportProblem = (cause: unknown) =>
    setActionProblem(cause instanceof Error ? cause.message : String(cause));
  const loadComments = useCallback(
    async (beadId: string) => {
      const answer = await rpc.call("issue_comments", {
        threadId,
        projectId,
        beadId,
      });
      if (answer.message !== null) throw new Error(answer.message);
      return answer.comments;
    },
    [rpc, threadId, projectId],
  );
  /** After any request: show its problem, if it had one, and reload. */
  const settle = (outcome: { message: string | null }) => {
    setActionProblem(outcome.message);
    refresh();
  };
  /** Closes (open=false) or reopens (open=true) an issue in beads. */
  const applyOpen = (beadId: string, open: boolean) => {
    rpc
      .call(open ? "issue_reopen" : "issue_close", {
        threadId,
        projectId,
        beadId,
      })
      .then(settle, reportProblem);
  };
  /** Asks the backend to make a workflow move. */
  const applyMove = (beadId: string, moveId: string, note: string) => {
    rpc
      .call("workflow_move", { threadId, projectId, beadId, moveId, note })
      .then((outcome) => {
        // A warning is something the user can put right (uncommitted
        // changes before a branch): it gets a message box, not the line
        // for a failed action. Nothing was moved.
        if (outcome.warning && outcome.message !== null) {
          setActionProblem(null);
          askWarn(outcome.message);
          return;
        }
        settle(outcome);
      }, reportProblem);
  };
  const confirmClose = (pending: PendingClose) =>
    pending.moveId === null
      ? applyOpen(pending.issue.id, false)
      : applyMove(pending.issue.id, pending.moveId, "");
  const currentBeadId = result?.currentBeadId ?? null;
  /** Sets or releases the thread's current issue; nothing without a thread. */
  const setCurrentTo = (beadId: string | null) => {
    if (threadId === null) return;
    rpc.call("current_set", { threadId, beadId }).then(settle, reportProblem);
  };
  // Every issue that has at least one sub-issue. Asked of the whole list,
  // not of the tree: the tree leaves out the current issue, and an epic
  // whose only sub-issue is the current one must still offer epic mode.
  const parentIds = new Set(
    (result?.issues ?? []).flatMap((issue) =>
      issue.parentId === null ? [] : [issue.parentId],
    ),
  );
  const focusOffer = (beadId: string) => {
    const issue = tree.byId.get(beadId);
    if (
      issue === undefined ||
      issue.status === CLOSED_STATUS ||
      beadId === focusId ||
      !parentIds.has(beadId)
    ) {
      return null;
    }
    return { blocked: focusBlock(tree.byId, beadId, currentBeadId) };
  };
  const actions: IssueActions = {
    currentBeadId,
    focusId,
    focusOffer,
    focus: (beadId) => {
      if (beadId === null) {
        setFocus(null);
        return;
      }
      if (focusBlock(tree.byId, beadId, currentBeadId) !== null) return;
      // The window would cover the list that is about to change.
      closeDetails();
      // "It deselects epic from the current ... and you can select the
      // next": an ordinary release, so the agent gets its usual note.
      if (currentBeadId === beadId) setCurrentTo(null);
      setFocus(beadId);
    },
    ownBranch: result?.ownBranch ?? false,
    loadComments,
    close: (beadId) => {
      // Confirmed in a dialog first: the panel remembers which issue and
      // calls confirmClose when the user agrees.
      const issue = tree.byId.get(beadId);
      if (issue !== undefined) askClose({ issue, moveId: null, label: null });
    },
    move: (beadId, moveId, note) => {
      const issue = tree.byId.get(beadId);
      if (issue === undefined || workflow === null) return;
      // The workflow is asked only whether this move closes the issue: a
      // closing move is confirmed first, like any other close. Whether the
      // move is allowed at all is the backend's check.
      const closing = movesFor(
        workflow,
        stateOf(workflow, issue.step).id,
        "user",
      ).find((move) => move.id === moveId && move.to === CLOSED);
      if (closing !== undefined) {
        askClose({
          issue,
          moveId,
          label: closing.label,
        });
        return;
      }
      // A move may start the agent in the conversation, which the details
      // window covers, so the window gets out of the way.
      closeDetails();
      applyMove(beadId, moveId, note);
    },
    reopen: (beadId) => applyOpen(beadId, true),
    requestSizing: (beadId) => {
      rpc
        .call("issue_request_sizing", { threadId, projectId, beadId })
        .then(settle, reportProblem);
    },
    setSize: (beadId, size) => {
      rpc
        .call("issue_set_size", { threadId, projectId, beadId, size })
        .then(settle, reportProblem);
    },
    categories,
    setCategory: (beadId, category) => {
      rpc
        .call("issue_set_category", { threadId, projectId, beadId, category })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    childrenOf: (beadId) => tree.children.get(beadId) ?? [],
    openDetails,
    canNest: (beadId, parentId) =>
      beadId !== parentId &&
      tree.byId.get(beadId)?.parentId !== parentId &&
      !descendantIds(beadId).has(parentId),
    setParent: (beadId, parentId) => {
      rpc
        .call("issue_set_parent", { threadId, projectId, beadId, parentId })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    link: (fromId, toId, kind) => {
      rpc
        .call("issue_link", { threadId, projectId, fromId, toId, kind })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    unlink: (beadId, link) => {
      // The link is stored on whichever issue is its "from" end.
      const [fromId, toId] =
        link.direction === "out" ? [beadId, link.id] : [link.id, beadId];
      rpc
        .call("issue_unlink", {
          threadId,
          projectId,
          fromId,
          toId,
          kind: link.kind,
        })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    linkTargets: (beadId) =>
      [...tree.byId.values()].filter((issue) => issue.id !== beadId),
    moveTargets: (beadId) => {
      const inside = descendantIds(beadId);
      const presentParent = tree.byId.get(beadId)?.parentId ?? null;
      return [...tree.byId.values()].filter(
        (issue) =>
          issue.status !== CLOSED_STATUS &&
          issue.id !== beadId &&
          issue.id !== presentParent &&
          !inside.has(issue.id),
      );
    },
    addSubIssue,
    saveText: async (beadId, text) => {
      try {
        const outcome = await rpc.call("issue_update", {
          threadId,
          projectId,
          beadId,
          type: null,
          priority: null,
          title: text.title,
          description: text.description,
        });
        if (outcome.message === null) refresh();
        return outcome.message;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
    edit: (beadId, change) => {
      rpc
        .call("issue_update", {
          threadId,
          projectId,
          beadId,
          type: change.type ?? null,
          priority: change.priority ?? null,
          title: null,
          description: null,
        })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    run:
      threadId === null
        ? null
        : (beadId) => {
            // Play starts the agent in the conversation, which the details
            // window covers, so the window gets out of the way.
            closeDetails();
            rpc
              .call("workflow_run", { threadId, beadId })
              .then(settle, reportProblem);
          },
    setCurrent:
      threadId === null
        ? null
        : (beadId) => {
            rpc
              .call("current_set", { threadId, beadId })
              .then(settle, reportProblem);
          },
    makeCurrent:
      threadId === null
        ? null
        : (beadId) => {
            const present = result?.currentBeadId ?? null;
            const issue = tree.byId.get(beadId);
            // Asked about only when it replaces another current issue (the
            // user's decision); otherwise it is one click to undo.
            if (present !== null && present !== beadId && issue !== undefined) {
              askSwitch(issue);
              return;
            }
            rpc
              .call("current_set", { threadId, beadId })
              .then(settle, reportProblem);
          },
  };
  /**
   * Creates an issue inside `parentId` (null for the top level). Shared by
   * the panel's new-issue field and the one in the details window, which
   * differ only in which parent they pass.
   */
  const createIn = async (
    parentId: string | null,
    draft: {
      title: string;
      description: string;
      type: IssueType | null;
      priority: number | null;
      category: string | null;
    },
  ) => {
    try {
      const created = await rpc.call("issue_create", {
        threadId,
        projectId,
        ...draft,
        parentId,
      });
      refresh();
      return created.message;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  return {
    actions,
    createIn,
    confirmClose,
    actionProblem,
    setActionProblem,
    reportProblem,
  };
}
