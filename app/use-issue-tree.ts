// app/use-issue-tree.ts — the issue list, arranged for the tab.
//
// What: a hook that takes the list from the backend and works out what the
// tab draws from it: the thread's current issue, the tree of sub-issues, a
// lookup of everything inside an issue, and the types and categories in use.
//
// Why: the panel, the rows' actions and the details window all need the same
// arrangement. Worked out once here, memoised, instead of inside the panel.
//
// Design notes:
// - The arranging itself is in app/issue-model.ts (buildTree and friends),
//   where it is tested; this file only ties it to React.

import { useCallback, useMemo } from "react";
import type { Issue, IssuesResult } from "../server/contract.ts";
import { buildTree, descendantIdsOf } from "./issue-model.ts";
import type { IssueTree } from "./issue-model.ts";

/** What useIssueTree hands back. */
export interface IssueTreeView {
  /** The thread's current issue, drawn in its own group; null when none. */
  currentIssue: Issue | null;
  tree: IssueTree;
  /** The ids of every issue inside `beadId`, at any depth. */
  descendantIds: (beadId: string) => Set<string>;
  /** Issue types that occur among the top-level issues, for the filter. */
  types: string[];
  /** Categories in use anywhere in the folder, in alphabetical order. */
  categories: string[];
}

/**
 * Arranges the backend's answer for drawing.
 *
 * @param result The latest issue list; null before the first answer. A list
 *   in any state but "ok" gives an empty tree.
 */
export function useIssueTree(result: IssuesResult | null): IssueTreeView {
  // The current bead is shown in its own group, so it is left out of the
  // status groups to avoid listing it twice.
  const currentIssue = useMemo(
    () =>
      result?.issues.find((issue) => issue.id === result.currentBeadId) ??
      null,
    [result],
  );
  const tree = useMemo(
    () =>
      buildTree(
        result?.state === "ok" ? result.issues : [],
        currentIssue?.id ?? null,
      ),
    [result, currentIssue],
  );
  const descendantIds = useCallback(
    (beadId: string) => descendantIdsOf(tree.byId, beadId),
    [tree],
  );
  // Types offered in the filter menu: those that actually occur here.
  const types = useMemo(
    () =>
      [
        ...new Set(
          tree.topLevel.flatMap((issue) => (issue.type ? [issue.type] : [])),
        ),
      ].sort(),
    [tree],
  );
  // Categories in use anywhere in the repository (not only at the top
  // level), for the dropdowns and the filter menu.
  const categories = useMemo(
    () =>
      [
        ...new Set(
          (result?.issues ?? []).flatMap((issue) =>
            issue.category === null ? [] : [issue.category],
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [result],
  );
  return { currentIssue, tree, descendantIds, types, categories };
}
