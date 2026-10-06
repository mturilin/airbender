// app/place.ts — where an issue's work belongs, as the tab sees it.
//
// What: for one issue, whether it belongs to an epic whose issues are
// worked on a branch of that epic's, whether this folder is on that branch,
// and whether the issue has open sub-issues of its own.
//
// Why: an epic can be given a branch or a work tree for all of its issues
// (bead-bb-ty5.2). Its issues are then worked only in a folder on that
// branch (the user's rule), are only committed there, and cannot be given a
// branch of their own; and on an issue with sub-issues the two "in a place
// of its own" starts read and mean something else. The rows, the menu, the
// opened issue and the message box's buttons all need the same answer.
//
// Design notes:
// - The tab only decides what to show. The server refuses the same things
//   by itself (server/work.ts), since a tab can be out of date.
// - Nothing here knows the standard workflow: which step holds a branch is
//   asked of the workflow (epicOver in shared/workflow.ts).

import type { Issue, IssuesResult } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { epicOver } from "../shared/workflow.ts";
import type { Workflow, WorkflowContext } from "../shared/workflow.ts";

/** Where one issue's work belongs. */
export interface Place {
  /** What the workflow is told when it is asked which moves to offer. */
  context: WorkflowContext;
  /** The issue has at least one open issue under it, at any depth. */
  hasSubIssues: boolean;
  /**
   * Set when the issue belongs to an epic with a branch and this folder is
   * not on it: why its workflow buttons are not offered here, in plain
   * words. Null otherwise.
   */
  elsewhere: string | null;
}

/** An issue with nothing particular about where it is worked. */
const PLAIN = (ownBranch: boolean, hasSubIssues: boolean): Place => ({
  context: { ownBranch },
  hasSubIssues,
  elsewhere: null,
});

/**
 * Builds the lookup for one list of issues.
 *
 * @param workflow The repository's workflow; null on the simple one, where
 *   nothing of this applies.
 * @param result The list as last read; null before the first answer.
 * @returns A function giving any issue's place. Cheap to call per row: the
 *   maps are built once here.
 */
export function placesIn(
  workflow: Workflow | null,
  result: IssuesResult | null,
): (issue: Issue) => Place {
  const ownBranch = result?.ownBranch ?? false;
  const here = result?.branch ?? null;
  const issues = result?.issues ?? [];
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  // Every issue that has an open issue somewhere under it.
  const withOpenBelow = new Set<string>();
  for (const issue of issues) {
    if (issue.status === CLOSED_STATUS) continue;
    const seen = new Set<string>();
    let parentId = issue.parentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      withOpenBelow.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return (issue) => {
    const hasSubIssues = withOpenBelow.has(issue.id);
    if (workflow === null) return PLAIN(ownBranch, hasSubIssues);
    const home = epicOver(workflow, issue, (id) => byId.get(id));
    if (home === null) return PLAIN(ownBranch, hasSubIssues);
    const onIt = home.branch !== null && home.branch === here;
    return {
      context: { ownBranch, inEpic: true, inEpicBranch: onIt },
      hasSubIssues,
      elsewhere: onIt
        ? null
        : home.branch === null
          ? `Part of the epic ${home.id}, whose work tree is still being set up.`
          : `Part of the epic ${home.id}: worked on the branch ${home.branch}, in a folder that is on it.`,
    };
  };
}
