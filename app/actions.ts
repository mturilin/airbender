// app/actions.ts — what a row or an opened issue can do.
//
// What: the IssueActions interface: every action and lookup the rows, the
// opened issue and the sections are handed by the panel.
//
// Why: rows are drawn several levels below the panel that owns the data and
// the requests. One documented object passed down keeps each component's props
// short and makes plain what a row is allowed to do.
//
// Design notes:
// - It is deliberately one object and not many small props or a React context:
//   nearly every member is used by a row and its opened issue between them.

import type { Issue, IssueComment, IssueLink } from "../server/contract.ts";
import type { IssueType, LinkKind } from "../shared/constants.ts";

/** What an issue row can do besides showing itself. */
export interface IssueActions {
  /** Id of the bead this thread works on; null when none. */
  currentBeadId: string | null;
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
   * Fetches one issue's comments, oldest first. Resolves to the comments, or
   * rejects with a plain-language reason.
   */
  loadComments: (beadId: string) => Promise<IssueComment[]>;
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
   * The sub-issues drawn under an issue: its direct children, open ones
   * first. Leaves out the thread's current bead, which is drawn in Current.
   */
  childrenOf: (beadId: string) => Issue[];
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
   * Whether `beadId` may be dropped into `parentId`: not into itself, not
   * into one of its own sub-issues, and not where it already is.
   */
  canNest: (beadId: string, parentId: string) => boolean;
  /** The categories in use in this repository, in alphabetical order. */
  categories: string[];
  /**
   * Sets an issue's category (replacing the one it has) or, with null,
   * clears it. Straight away and without confirmation, like type and
   * priority.
   */
  setCategory: (beadId: string, category: string | null) => void;
  /**
   * The issues `beadId` may be moved into: every open issue except itself,
   * its own sub-issues at any depth, and the parent it is already in.
   */
  moveTargets: (beadId: string) => Issue[];
  /**
   * Adds a link of one of beads' kinds, stored on `fromId` and pointing at
   * `toId` ("fromId is blocked by toId"). Straight away, no confirmation:
   * it is undone with the chip's remove button.
   */
  link: (fromId: string, toId: string, kind: LinkKind) => void;
  /** Removes `link`, one of the links listed on issue `beadId`. */
  unlink: (beadId: string, link: IssueLink) => void;
  /** The issues `beadId` may be linked with: every issue except itself. */
  linkTargets: (beadId: string) => Issue[];
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
