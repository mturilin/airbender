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
import type { IssueTree } from "./issue-model.ts";
import type { Scope, useIssues } from "./use-issues.ts";

/**
 * What a row or an opened issue may ask about the list: plain lookups that
 * change nothing.
 */
export interface IssueLookups {
  /** Id of the bead this thread works on; null when none. */
  currentBeadId: string | null;
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
   * Changes which bead this thread works on without messaging the agent; the
   * tab uses it to clear the choice. Null when there is no thread.
   */
  setCurrent: ((beadId: string | null) => void) | null;
  /**
   * The play button: marks an issue as this thread's bead and tells the
   * agent to start on it (requirements, then a plan, then the work). Null
   * when there is no thread.
   */
  start: ((beadId: string) => void) | null;
  /**
   * Asks to close an open issue (the user confirms in a dialog first).
   * `commit` true is the happy path: the work is accepted, so the thread's
   * agent is also asked to commit it. `commit` false closes without a
   * commit: the issue is dropped, not done.
   */
  close: (beadId: string, commit: boolean) => void;
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
   * Starts a background agent that defines the issue. Does nothing
   * visible here beyond the row showing that it is under way.
   */
  define: (beadId: string) => void;
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
  /** Closes (open=false) or reopens an issue, after any confirmation. */
  applyOpen: (beadId: string, open: boolean, commit?: boolean) => void;
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
 * @param askClose Called when a row asks to close an issue; the panel
 *   confirms and then calls `applyOpen`.
 * @param openDetails Opens the details window on an issue.
 * @param closeDetails Closes the details window (play starts the agent in
 *   the conversation, which the window would cover).
 * @param addSubIssue Readies the new-issue field for a sub-issue of the
 *   given issue.
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
  openDetails,
  closeDetails,
  addSubIssue,
}: {
  scope: Scope;
  rpc: ReturnType<typeof useIssues>["rpc"];
  result: IssuesResult | null;
  tree: IssueTree;
  descendantIds: (beadId: string) => Set<string>;
  categories: string[];
  refresh: () => void;
  askClose: (issue: Issue, commit: boolean) => void;
  openDetails: (beadId: string) => void;
  closeDetails: () => void;
  addSubIssue: (parentId: string) => void;
}): IssueActionsView {
  const { threadId, projectId } = scope;
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
  /**
   * Closes (open=false) or reopens (open=true) an issue in beads.
   *
   * @param commit When closing, also ask the thread's agent to commit the
   *   issue's work. Has no effect when reopening or without a thread.
   */
  const applyOpen = (beadId: string, open: boolean, commit = false) => {
    const target = { threadId, projectId, beadId };
    (open
      ? rpc.call("issue_reopen", target)
      : rpc.call("issue_close", { ...target, commit })
    ).then((outcome) => {
      setActionProblem(outcome.message);
      refresh();
    }, reportProblem);
  };
  const actions: IssueActions = {
    currentBeadId: result?.currentBeadId ?? null,
    loadComments,
    close: (beadId, commit) => {
      // Confirmed in a dialog first: remember which issue and which kind of
      // close, and let the dialog below call applyOpen when the user agrees.
      const issue = result?.issues.find((candidate) => candidate.id === beadId);
      if (issue !== undefined) askClose(issue, commit);
    },
    reopen: (beadId) => applyOpen(beadId, true),
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
    define: (beadId) => {
      rpc.call("issue_define", { threadId, projectId, beadId }).then(
        (outcome) => {
          setActionProblem(outcome.message);
          refresh();
        },
        reportProblem,
      );
    },
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
    start:
      threadId === null
        ? null
        : (beadId) => {
            // Play starts the agent in the conversation, which the details
            // window covers, so the window gets out of the way.
            closeDetails();
            rpc
              .call("current_start", { threadId, beadId })
              .then((outcome) => {
                setActionProblem(outcome.message);
                refresh();
              }, reportProblem);
          },
    setCurrent:
      threadId === null
        ? null
        : (beadId) => {
            rpc
              .call("current_set", { threadId, beadId })
              .then((outcome) => {
                setActionProblem(outcome.message);
                refresh();
              }, reportProblem);
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
    applyOpen,
    actionProblem,
    setActionProblem,
    reportProblem,
  };
}
