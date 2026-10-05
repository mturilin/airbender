// app/panel.tsx — the Airbender tab.
//
// What: BeadsPanel: the three bands of the tab (Current and toolbar pinned on
// top, the scrolling groups, the new-issue field pinned at the bottom), the
// details window, the close confirmation, and the wiring from the issue list
// to the actions the rows can perform.
//
// Why: this is where the data, the requests to the backend and the layout
// meet. Everything it draws lives in the other app/ files.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { IssueActionsProvider, useIssueActions } from "./actions.ts";
import { Notice } from "./bits.tsx";
import { CloseDialog } from "./close-dialog.tsx";
import type { PendingClose } from "./close-dialog.tsx";
import { CreateIssue } from "./create-issue.tsx";
import { SwitchDialog } from "./current-toggle.tsx";
import { IssueDetailsWindow } from "./details-window.tsx";
import { getDragged, setDragged } from "./drag.ts";
import {
  matchesFilters,
  toSections,
  toSubGroups,
  toggled,
} from "./issue-model.ts";
import { FilterMenu, GroupMenu } from "./menus.tsx";
import { CurrentSection, SectionBlock } from "./section-block.tsx";
import { SetupCard, SetupDialog, SetupMenu, useSetup } from "./setup.tsx";
import type { SetupStep } from "./setup.tsx";
import { useFilters } from "./use-filters.ts";
import { useIssueTree } from "./use-issue-tree.ts";
import { useIssues } from "./use-issues.ts";
import type { Scope } from "./use-issues.ts";

/**
 * The tab body: current bead, create line, then the grouped issues or a
 * plain-language explanation of why there are none.
 */
export function BeadsPanel({ scope }: { scope: Scope }) {
  const { rpc, result, failure, loading, refresh } = useIssues(scope);
  const [filters, setFilters] = useFilters(result?.path ?? null);
  // Getting the folder ready: what is missing, what was skipped, and the
  // step whose confirmation is open (see SetupCard, SetupMenu, SetupDialog).
  const setup = useSetup(scope, result?.state ?? null);
  const [confirmingStep, setConfirmingStep] = useState<SetupStep | null>(null);
  // The issue waiting for the user's "yes, close it"; null when none is.
  const [closing, setClosing] = useState<PendingClose | null>(null);
  // The issue waiting for the user's "yes, switch to it", when making it
  // current would replace another current issue; null when none is.
  const [switching, setSwitching] = useState<Issue | null>(null);
  const { threadId, projectId } = scope;
  const { currentIssue, tree, descendantIds, types, categories } =
    useIssueTree(result);
  const others = tree.topLevel;
  // The issue the details window is showing; null when it is closed.
  const [detailsId, setDetailsId] = useState<string | null>(null);
  // The parent selected in the new-issue field at the bottom, and a counter
  // that asks that field to take the cursor (see CreateIssue).
  const [newIssueParentId, setNewIssueParentId] = useState<string | null>(null);
  const [focusNewIssue, setFocusNewIssue] = useState(0);
  // A parent that has since been closed or deleted is no longer a parent to
  // create into; the field falls back to the top level.
  const newIssueParent =
    newIssueParentId === null
      ? null
      : (tree.byId.get(newIssueParentId) ?? null);
  const newIssueParentOpen =
    newIssueParent !== null && newIssueParent.status !== CLOSED_STATUS
      ? newIssueParent
      : null;
  // Closed issues are hidden each time the tab opens; the Closed group's
  // own button shows them. Deliberately not remembered, so the tab always
  // starts with the short list.
  const [showClosed, setShowClosed] = useState(false);
  const { openSections, closedSection } = useMemo(() => {
    const sections = toSections(
      others.filter((issue) => matchesFilters(issue, filters)),
    );
    return {
      openSections: sections.filter(
        // Ready stays even when empty: its heading carries the Group and
        // Filter buttons, and a filter that emptied Ready must still be
        // reachable to undo.
        (section) =>
          section.id === "ready" ||
          (section.id !== "closed" && section.issues.length > 0),
      ),
      // Always present, even when empty, so the Closed heading never moves.
      closedSection: sections.find((section) => section.id === "closed")!,
    };
  }, [others, filters]);
  const narrowed =
    filters.types.length +
      filters.priorities.length +
      filters.categories.length >
    0;
  const {
    actions,
    createIn,
    confirmClose,
    actionProblem,
    setActionProblem,
    reportProblem,
  } = useIssueActions({
    scope,
    rpc,
    result,
    tree,
    descendantIds,
    categories,
    refresh,
    // Confirmed in a dialog first: remember which issue and which kind of
    // close, and let CloseDialog call confirmClose when the user agrees.
    askClose: setClosing,
    askSwitch: setSwitching,
    openDetails: setDetailsId,
    closeDetails: () => setDetailsId(null),
    addSubIssue: (parentId) => {
      setNewIssueParentId(parentId);
      // The bottom field is behind the details window; get it out of the way.
      setDetailsId(null);
      setFocusNewIssue((count) => count + 1);
    },
  });
  const ok = result?.state === "ok";
  // The scrolling band loses the width of its scrollbar; the pinned bands
  // above and below have no scrollbar, so without this their cards would be
  // that much wider than the cards in the list. Measuring is used rather
  // than a fixed number because scrollbar width differs by system and theme
  // (and is zero where scrollbars float over the content). The pinned bands
  // cannot simply reserve a gutter of their own with CSS: that needs
  // overflow clipping, which would cut off the filter menu that drops down
  // out of the top band.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () =>
      setScrollbarWidth(element.offsetWidth - element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // 12px is the bands' own padding (p-3), kept and added to.
  const pinnedStyle = { paddingRight: 12 + scrollbarWidth };
  return (
    // The rows, at any depth, pick their actions up from here.
    <IssueActionsProvider value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Top band, pinned: Current, then the toolbar. */}
        <div
          className="shrink-0 space-y-3 border-b border-border p-3"
          style={pinnedStyle}
        >
          {ok ? <CurrentSection issue={currentIssue} /> : null}
          {actionProblem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              That did not work: {actionProblem}
            </p>
          )}
          <div className="flex items-center gap-1">
            <p
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              title={result?.path ?? undefined}
            >
              {result?.path ?? ""}
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              tip="Refresh the list"
              aria-label="Refresh"
              disabled={loading}
              // Also re-checks what is set up for the folder. The user expects
              // Refresh to refresh everything on the tab; the setup check is
              // otherwise only repeated when it is likely to have changed.
              onClick={() => {
                refresh();
                setup.reload();
              }}
            >
              <Icon
                name="ArrowReloadHorizontal"
                className={cn("size-4", loading && "animate-spin")}
              />
            </Button>
            <SetupMenu
              status={setup.status}
              onOpen={setup.reload}
              onStart={setConfirmingStep}
            />
          </div>
        </div>
        {/* Middle band, the only part that scrolls: the grouped issues. */}
        {/* Dropping a dragged sub-issue anywhere in this band that is not a
            row (a group heading, the gaps, the empty space below) moves it
            out to the top level. Rows stop the event themselves, so this only
            sees drops that missed every row. */}
        <div
          ref={scroller}
          onDragOver={(event) => {
            const dragged = getDragged();
            if (dragged === null || tree.byId.get(dragged)?.parentId == null) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            const dragged = getDragged();
            setDragged(null);
            if (dragged === null || tree.byId.get(dragged)?.parentId == null) {
              return;
            }
            event.preventDefault();
            actions.setParent(dragged, null);
          }}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 [scrollbar-gutter:stable]"
        >
          {failure === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              Could not load issues: {failure}
            </p>
          )}
          {/* What is missing for this folder, offered here in the middle of
              the tab (the user's rule), above whatever else is shown. */}
          {setup.status === null || setup.status.unavailable !== null ? null : (
            <SetupCard
              status={setup.status}
              skipped={setup.skipped}
              onSkip={setup.skip}
              onStart={setConfirmingStep}
            />
          )}
          {result === null ? (
            failure === null ? (
              <Notice>Loading issues…</Notice>
            ) : null
          ) : result.state !== "ok" ? (
            <Notice>{result.message}</Notice>
          ) : result.issues.length === 0 ? (
            <Notice>No issues yet. Create the first one below.</Notice>
          ) : (
            <>
              {openSections.map((section) => (
                <SectionBlock
                  key={section.id}
                  section={section}
               
                  // Only Ready is divided (the user's choice): it is the long
                  // group, the backlog to choose from.
                  subGroups={
                    section.id === "ready"
                      ? toSubGroups(section.issues, filters.groupBy)
                      : []
                  }
                  collapsedSubGroups={filters.collapsed}
                  onToggleSubGroup={(key) =>
                    setFilters({
                      ...filters,
                      collapsed: toggled(filters.collapsed, key),
                    })
                  }
                  emptyNote={
                    section.id !== "ready"
                      ? undefined
                      : narrowed
                        ? "No ready issues match the filter."
                        : "No ready issues."
                  }
                  // Group and Filter sit on the Ready heading (the owner's
                  // choice). Group only affects Ready; Filter still narrows
                  // every group below Current.
                  headerActions={
                    section.id !== "ready" ? null : (
                      <div className="flex shrink-0 items-center gap-1">
                        <GroupMenu
                          groupBy={filters.groupBy}
                          onChange={(groupBy) =>
                            setFilters({ ...filters, groupBy })
                          }
                        />
                        <FilterMenu
                          filters={filters}
                          onChange={setFilters}
                          types={types}
                          categories={categories}
                        />
                      </div>
                    )
                  }
                />
              ))}
              {/* The Closed heading is always here; its issues are folded
                  away until Show is pressed. */}
              <SectionBlock
                section={closedSection}
             
                collapsed={!showClosed}
                headerActions={
                  closedSection.issues.length === 0 ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={showClosed}
                      onClick={() => setShowClosed((current) => !current)}
                    >
                      {showClosed ? "Hide" : "Show"}
                    </Button>
                  )
                }
              />
            </>
          )}
        </div>
        <SetupDialog
          step={confirmingStep}
          status={setup.status}
          onClose={() => setConfirmingStep(null)}
          onRun={(step, option) => {
            setConfirmingStep(null);
            rpc
              .call("setup_run", {
                threadId,
                projectId,
                action: step.action,
                option,
              })
              .then((outcome) => {
                setActionProblem(outcome.message);
                setup.reload();
                refresh();
              }, reportProblem);
          }}
        />
        <SwitchDialog
          from={currentIssue}
          to={switching}
          onConfirm={(to) => actions.setCurrent?.(to.id)}
          onCancel={() => setSwitching(null)}
        />
        <CloseDialog
          closing={closing}
          // Finishing an issue with sub-issues closes the open ones too; the
          // dialog says how many. Cancelling leaves them alone.
          openSubIssues={
            closing === null || closing.moveId === null
              ? 0
              : [...descendantIds(closing.issue.id)].filter(
                  (id) => tree.byId.get(id)?.status !== CLOSED_STATUS,
                ).length
          }
          onConfirm={confirmClose}
          onCancel={() => setClosing(null)}
        />
        <IssueDetailsWindow
          issueId={detailsId}
          onNavigate={setDetailsId}
          tree={tree}
          descendantIds={descendantIds}
       
          createIn={createIn}
          categories={categories}
        />
        {/* Bottom band, pinned: the field for a new issue. */}
        {ok ? (
          <div
            className="shrink-0 border-t border-border p-3"
            style={pinnedStyle}
          >
            <CreateIssue
              onCreate={(draft) =>
                createIn(newIssueParentOpen?.id ?? null, draft)
              }
              parent={newIssueParentOpen}
              onParentChange={setNewIssueParentId}
              parentChoices={(result?.issues ?? []).filter(
                (issue) => issue.status !== CLOSED_STATUS,
              )}
              focusRequest={focusNewIssue}
              categories={categories}
            />
          </div>
        ) : null}
      </div>
    </IssueActionsProvider>
  );
}
