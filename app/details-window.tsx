// app/details-window.tsx — one issue with its sub-issues, in a window.
//
// What: the details window: an issue and its sub-issues one level deep, the
// path to it at the top, and the window's own new-issue field at the bottom.
//
// Why: the panel draws only one level of sub-issues (the user's rule); this
// window is how deeper levels are read and worked on, wide enough to read a
// hierarchy.
//
// Design notes:
// - It is a single window that is moved through, not a stack: a sub-issue's
//   details button changes which issue it shows, and the path at the top
//   goes back up. The panel owns which issue that is.
// - Its rows are the same rows as the list, so everything the list can do
//   works here too.
// - A fixed, large size: the window is the same whether the issue has one
//   sub-issue or fifty (the user's rule), so it does not jump about while
//   moving through the hierarchy. The list scrolls inside it.
// - The window has its own new-issue field, so that adding a sub-issue
//   there stays there (the user's rule: in the panel it stays in the panel,
//   in the window it stays in the window).

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import type { IssueActions, IssueActionsView } from "./actions.ts";
import { CreateIssue } from "./create-issue.tsx";
import { pathTo } from "./issue-model.ts";
import type { IssueTree } from "./issue-model.ts";
import { IssueRow } from "./issue-row.tsx";

/**
 * The details window.
 *
 * @param issueId The issue the window shows; null keeps it closed. An id
 *   that is no longer in the list closes it too.
 * @param onNavigate Moves the window to another issue, or closes it (null).
 * @param actions The panel's actions; "Add sub-issue" is replaced inside
 *   the window so that it readies the window's own field.
 * @param createIn Creates an issue inside a parent (see useIssueActions).
 */
export function IssueDetailsWindow({
  issueId,
  onNavigate,
  tree,
  descendantIds,
  actions,
  createIn,
  categories,
}: {
  issueId: string | null;
  onNavigate: (beadId: string | null) => void;
  tree: IssueTree;
  descendantIds: (beadId: string) => Set<string>;
  actions: IssueActions;
  createIn: IssueActionsView["createIn"];
  categories: string[];
}) {
  const detailsIssue =
    issueId === null ? null : (tree.byId.get(issueId) ?? null);
  // The path shown at the top is worked out from the stored parents, so
  // moving deeper or back up is just a change of `issueId`.
  const detailsPath = useMemo(
    () => pathTo(tree.byId, detailsIssue),
    [detailsIssue, tree],
  );
  // The parent in the window's new-issue field is the issue the window
  // shows unless "Add sub-issue" on a row inside the window picked another;
  // moving to a different issue puts it back.
  const [windowParentId, setWindowParentId] = useState<string | null>(null);
  const [focusWindowNewIssue, setFocusWindowNewIssue] = useState(0);
  useEffect(() => {
    setWindowParentId(null);
  }, [issueId]);
  const windowPicked =
    windowParentId === null ? null : (tree.byId.get(windowParentId) ?? null);
  const windowParent =
    windowPicked !== null && windowPicked.status !== CLOSED_STATUS
      ? windowPicked
      : detailsIssue;
  // Inside the window, "Add sub-issue" readies the window's own field
  // instead of closing the window and going to the panel's.
  const windowActions: IssueActions = {
    ...actions,
    addSubIssue: (parentId) => {
      setWindowParentId(parentId);
      setFocusWindowNewIssue((count) => count + 1);
    },
  };
  return (
    <Dialog
      open={detailsIssue !== null}
      onOpenChange={(open) => {
        if (!open) onNavigate(null);
      }}
    >
      {/* A fixed, large size: the window is the same whether the issue has
          one sub-issue or fifty (the user's rule), so it does not jump
          about while moving through the hierarchy. The list scrolls
          inside it. */}
      <DialogContent className="flex h-[85vh] w-[min(64rem,92vw)] max-w-none flex-col">
        <DialogHeader>
          <DialogTitle>Issue details</DialogTitle>
          <DialogDescription asChild>
            <nav
              aria-label="Path to this issue"
              className="flex flex-wrap items-center gap-1 text-sm"
            >
              <button
                type="button"
                className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => onNavigate(null)}
              >
                All issues
              </button>
              {detailsPath.map((step, index) => (
                <span key={step.id} className="flex items-center gap-1">
                  <Icon
                    name="ChevronRight"
                    className="size-3.5 text-muted-foreground"
                  />
                  {index === detailsPath.length - 1 ? (
                    <span className="text-foreground">{step.title}</span>
                  ) : (
                    <button
                      type="button"
                      className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
                      onClick={() => onNavigate(step.id)}
                    >
                      {step.title}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          </DialogDescription>
        </DialogHeader>
        {detailsIssue === null ? null : (
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
            <IssueRow
              // A fresh row per issue, so moving deeper does not carry the
              // previous issue's opened or folded state along.
              key={detailsIssue.id}
              issue={detailsIssue}
              actions={windowActions}
              nested
              isDetailsRoot
            />
          </ul>
        )}
        {/* The window's own new-issue field, fixed at its bottom like the
            panel's. Closed issues take no new sub-issues. */}
        {detailsIssue === null || detailsIssue.status === CLOSED_STATUS ? null : (
          <div className="shrink-0">
            <CreateIssue
              onCreate={(draft) =>
                createIn(windowParent?.id ?? detailsIssue.id, draft)
              }
              parent={windowParent}
              onParentChange={setWindowParentId}
              parentChoices={[
                detailsIssue,
                ...[...descendantIds(detailsIssue.id)]
                  .map((id) => tree.byId.get(id))
                  .filter(
                    (issue): issue is Issue =>
                      issue !== undefined && issue.status !== CLOSED_STATUS,
                  ),
              ]}
              focusRequest={focusWindowNewIssue}
              categories={categories}
              allowTopLevel={false}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
