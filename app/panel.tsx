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
  finishedEpicSize,
  shortPath,
  focusBlock,
  matchesFilters,
  pathTo,
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
import { movesFor, stateOf } from "../shared/workflow.ts";
import { DEFAULT_WORKFLOW_ID, workflowFor } from "../shared/workflows.ts";
import { MoveIcon, WorkflowProvider } from "./workflow-controls.tsx";
import { askPanelOnArrival } from "./arrival.ts";
import { GithubSync } from "./github-sync.tsx";
import { EpicBand, EpicReturn } from "./epic-band.tsx";
import { useFocus } from "./use-focus.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

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
  // Whether the "Sync with GitHub" window is open.
  const [syncingGithub, setSyncingGithub] = useState(false);
  // A warning waiting to be read in its message box; null when none is.
  const [warning, setWarning] = useState<string | null>(null);
  const navigate = useBbNavigate();
  const { threadId, projectId } = scope;
  const { currentIssue, tree, descendantIds, types, categories } =
    useIssueTree(result);
  // Epic mode (bead-bb-ha9): the conversation's tab can be zoomed in on one
  // issue, and then lists that issue's direct sub-issues in place of the
  // top-level issues. Everything below (groups, Group, Filter, Closed, the
  // rows) is the same code fed a different list.
  const [focusId, setFocus, lastFocusId, forgetLastFocus] = useFocus(scope);
  const currentBeadId = result?.currentBeadId ?? null;
  const listed = result?.state === "ok";
  // The focus stands only while the user's rule holds: the epic is there
  // and open, and the current issue is none, the epic, or one from inside
  // it. When it stops holding (the agent or anything else made an outside
  // issue current, or the epic was closed or deleted) the tab goes back to
  // the whole list by itself. Checked only against a list that was really
  // read, so a failed or pending load does not throw the focus away.
  const focusHolds =
    focusId !== null &&
    listed &&
    focusBlock(tree.byId, focusId, currentBeadId) === null;
  // Decided only when a list arrives, never on a mere re-draw: when the tab
  // is handed another conversation, the list still on screen is the old
  // conversation's until the new one answers, and must not be used to
  // judge the new conversation's focus.
  // The epic last left, which the tab offers the way back to
  // (bead-bb-fmg). Worth offering only while it is still there and open.
  const lastEpic =
    lastFocusId === null ? null : (tree.byId.get(lastFocusId) ?? null);
  const lastGone =
    lastFocusId !== null &&
    listed &&
    (lastEpic === null || lastEpic.status === CLOSED_STATUS);
  const judge = useRef({ focusId, focusHolds, setFocus, lastGone, forgetLastFocus });
  judge.current = { focusId, focusHolds, setFocus, lastGone, forgetLastFocus };
  useEffect(() => {
    const now = judge.current;
    if (result?.state !== "ok") return;
    if (now.focusId !== null && !now.focusHolds) {
      // Remembered as the epic last left, so the way back is offered.
      now.setFocus(null);
    } else if (now.focusId === null && now.lastGone) {
      // Closed or deleted since: there is nothing to go back to.
      now.forgetLastFocus();
    }
  }, [result]);
  const focused = focusHolds ? (tree.byId.get(focusId) ?? null) : null;
  // Offered only on the whole list. Why it cannot be entered right now, if
  // it cannot: the conversation's current issue is from outside it.
  const returnTo =
    focused === null && lastEpic !== null && !lastGone ? lastEpic : null;
  const returnBlocked =
    returnTo === null
      ? null
      : focusBlock(tree.byId, returnTo.id, currentBeadId);
  const others =
    focused === null ? tree.topLevel : (tree.children.get(focused.id) ?? []);
  // While zoomed in, a new issue belongs in the epic unless the user says
  // otherwise in the field; on the way out the field goes back to the top
  // level.
  const focusedId = focused?.id ?? null;
  // How many issues the epic has under it once all of them are closed; 0
  // while it is not finished. The band then offers to close the epic.
  const focusedDone =
    focused === null ? 0 : finishedEpicSize(tree.byId, focused.id);
  // The epic holds a branch its issues are worked on (bead-bb-ty5.2), and,
  // when this folder is on that branch, the move that closes and merges it.
  const workflowNow = workflowFor(result?.workflow ?? DEFAULT_WORKFLOW_ID);
  const focusedHolds =
    focused !== null &&
    workflowNow !== null &&
    (focused.branch !== null ||
      stateOf(workflowNow, focused.step).holdsBranch === true);
  const landingMove =
    focused === null || workflowNow === null
      ? undefined
      : movesFor(workflowNow, stateOf(workflowNow, focused.step).id, "user").find(
          (move) => move.needsSubIssuesClosed === true,
        );
  const focusedLanding =
    focusedHolds &&
    landingMove !== undefined &&
    focused.branch !== null &&
    focused.branch === (result?.branch ?? null)
      ? { move: landingMove, branch: focused.branch }
      : null;
  // Autopilot for the epic the tab is zoomed in on (bead-bb-8ff): whether
  // it is on, and the one line that says what the run is doing, what it
  // waits for, or why it stopped.
  const autopilotHere =
    focused !== null && result?.autopilot?.epicId === focused.id
      ? result.autopilot
      : null;
  const autopilotOn = autopilotHere?.on === true;
  const autopilotNote = (() => {
    if (autopilotHere === null) return null;
    if (!autopilotOn) {
      return autopilotHere.reason === null
        ? null
        : `Autopilot stopped. ${autopilotHere.reason}`;
    }
    if (currentIssue === null || workflowNow === null) {
      return "Autopilot is on: starting the next ready issue.";
    }
    if (currentIssue.parentId !== focused?.id) {
      return `Autopilot is on, and waits while this conversation is on ${currentIssue.id}.`;
    }
    const step = stateOf(workflowNow, currentIssue.step);
    return step.actor === "user"
      ? `Autopilot is on. Waiting for you: ${currentIssue.id} is at "${step.label}".`
      : `Autopilot is on. The agent is on ${currentIssue.id}, at "${step.label}".`;
  })();
  useEffect(() => {
    setNewIssueParentId(focusedId);
  }, [focusedId]);
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
    askWarn: setWarning,
    openThread: (threadId) => {
      // The conversation's own message box opens the tab on arrival
      // (arrival.ts); what follows the jump below is the older way, kept
      // as a second try.
      askPanelOnArrival(threadId);
      navigate.toThread(threadId);
      // The user wants the Airbender tab open in the new conversation. The
      // server has put the tab among that conversation's tabs; this asks
      // BB to show it, once the app has had a moment to get there. BB
      // opens panels "in the current thread surface", so it must come
      // after the jump; asked twice because how long the jump takes is
      // not known. A refusal is harmless: the tab is in the strip.
      for (const delay of [400, 1500]) {
        window.setTimeout(
          () => navigate.openThreadPanel({ actionId: "issues" }),
          delay,
        );
      }
    },
    openDetails: setDetailsId,
    closeDetails: () => setDetailsId(null),
    addSubIssue: (parentId) => {
      setNewIssueParentId(parentId);
      // The bottom field is behind the details window; get it out of the way.
      setDetailsId(null);
      setFocusNewIssue((count) => count + 1);
    },
    focusId: focusedId,
    setFocus,
  });
  const ok = result?.state === "ok";
  // Null on the simple workflow: no steps are drawn anywhere below.
  const workflow = workflowFor(result?.workflow ?? DEFAULT_WORKFLOW_ID);
  // The scrolling band loses the width of its scrollbar; the pinned bands
  // above and below have no scrollbar, so without this their cards would be
  // that much wider than the cards in the list. Measuring is used rather
  // than a fixed number because scrollbar width differs by system and theme
  // (and is zero where scrollbars float over the content). The pinned bands
  // cannot simply reserve a gutter of their own with CSS: that needs
  // overflow clipping, which would cut off the filter menu that drops down
  // out of the top band.
  // A drop that misses every row moves the dragged issue out to the level
  // the list is showing: the top level, or, in epic mode, directly under
  // the epic. There, "out" must not mean out of the epic: the issue would
  // leave the list the user is looking at.
  const canDropOut = (dragged: string) =>
    focusedId === null
      ? tree.byId.get(dragged)?.parentId != null
      : actions.canNest(dragged, focusedId);
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
    // The rows, at any depth, pick their actions and the repository's
    // workflow up from here.
    <WorkflowProvider value={workflow}>
    <IssueActionsProvider value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Top band, pinned: the toolbar first (the user's layout,
            bead-bb-8j6: folder, refresh and the menu that holds the choice
            of workflow sit above everything), then Current. */}
        <div
          className="shrink-0 space-y-3 border-b border-border p-3"
          style={pinnedStyle}
        >
          <div className="flex items-center gap-1">
            {/* The folder, then the branch it is on (bead-bb-ty5.3; the
                user: "maybe tag branch:aaa-bbb-ccc next to the project
                path?"). Plain text in the path's own hand, no box: it used
                to be a boxed tag in the epic band, where it looked like a
                button beside Autopilot. The path gives way first when
                there is no room; both show whole in their tooltips. */}
            <p className="flex min-w-0 flex-1 items-baseline gap-3 font-mono text-xs text-muted-foreground">
              <span className="min-w-0 truncate" title={result?.path ?? undefined}>
                {result?.path == null ? "" : shortPath(result.path, result.home)}
              </span>
              {/* In a work tree, said first, with the fir of the "start
                  in a work tree" commands (the user: "also mention
                  worktree with fir tree icon there"). */}
              {result?.workTree === true ? (
                <span
                  className="shrink-0 whitespace-nowrap"
                  title="This folder is a work tree of the repository, not its main folder"
                >
                  <MoveIcon
                    name="epic-tree"
                    className="mr-1 inline-block size-3 align-[-1.5px]"
                  />
                  worktree
                </span>
              ) : null}
              {/* The branch: its icon, then its name (the user: "replace
                  branch [with the] branch icon"). */}
              {result?.branch == null ? null : (
                <span
                  className="min-w-0 max-w-[60%] shrink-0 truncate"
                  title={`This folder is on the branch ${result.branch}`}
                >
                  <MoveIcon
                    name="epic-branch"
                    className="mr-1 inline-block size-3 align-[-1.5px]"
                  />
                  {result.branch}
                </span>
              )}
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
              workflow={ok ? result.workflow : null}
              onSyncGithub={ok ? () => setSyncingGithub(true) : undefined}
              onChooseWorkflow={(workflow) => {
                rpc
                  .call("workflow_set", { threadId, projectId, workflow })
                  .then((outcome) => {
                    setActionProblem(outcome.message);
                    refresh();
                  }, reportProblem);
              }}
            />
          </div>
          {/* Epic mode's band, between the toolbar and Current (the user's
              layout): which epic the list is zoomed in on, and the way
              back out. */}
          {focused === null ? null : (
            <EpicBand
              path={pathTo(tree.byId, focused)}
              // Every direct sub-issue, the current one included: the
              // card counts them all.
              subIssues={(result?.issues ?? []).filter(
                (issue) => issue.parentId === focused.id,
              )}
              onGo={actions.focus}
              // An epic whose issues were worked on its own branch is
              // closed by merging that branch, from a folder that is on
              // it; in any other folder the band offers nothing, since a
              // plain close would leave the branch unmerged.
              merging={focusedLanding !== null}
              autopilot={
                // Only in a conversation, and only where issues have steps.
                threadId === null || workflowNow === null
                  ? undefined
                  : {
                      on: autopilotOn,
                      note: autopilotNote,
                      onToggle: () => {
                        rpc
                          .call("autopilot_set", {
                            threadId,
                            epicId: autopilotOn ? null : focused.id,
                          })
                          .then((outcome) => {
                            setActionProblem(outcome.message);
                            refresh();
                          }, reportProblem);
                      },
                    }
              }
              onClose={
                focusedDone === 0 || (focusedHolds && focusedLanding === null)
                  ? undefined
                  : () =>
                      setClosing({
                        issue: focused,
                        moveId: focusedLanding?.move.id ?? null,
                        label: focusedLanding?.move.label ?? null,
                        epicDone: focusedDone,
                        mergeBranch: focusedLanding?.branch,
                      })
              }
            />
          )}
          {/* Out of epic mode for a moment: the way back into the epic
              that was left, in the band's place. */}
          {returnTo === null ? null : (
            <EpicReturn
              epic={returnTo}
              blocked={returnBlocked}
              onReturn={() => actions.focus(returnTo.id)}
              onForget={forgetLastFocus}
            />
          )}
          {ok ? <CurrentSection issue={currentIssue} /> : null}
          {actionProblem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              That did not work: {actionProblem}
            </p>
          )}
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
            if (dragged === null || !canDropOut(dragged)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            const dragged = getDragged();
            setDragged(null);
            if (dragged === null || !canDropOut(dragged)) return;
            event.preventDefault();
            actions.setParent(dragged, focusedId);
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
          ) : focused !== null && others.length === 0 ? (
            <Notice>
              {currentIssue === null
                ? "No issues in this epic yet. Create the first one below."
                : "Nothing else in this epic."}
            </Notice>
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
        {/* A move that was not made because of something the user can put
            right (uncommitted changes before a branch): a message box, as
            the user asked, not the red line of a failed action. */}
        <Dialog
          open={warning !== null}
          onOpenChange={(open) => {
            if (!open) setWarning(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Not yet</DialogTitle>
              <DialogDescription>{warning}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setWarning(null)}>OK</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <SwitchDialog
          from={currentIssue}
          to={switching}
          onConfirm={(to) => actions.setCurrent?.(to.id)}
          onCancel={() => setSwitching(null)}
        />
        <CloseDialog
          closing={closing}
          // Finishing an issue with sub-issues closes the open ones too; the
          // dialog says how many. Cancelling leaves them alone, except on
          // the simple workflow, where a close is the only close there is.
          plain={workflow === null}
          openSubIssues={
            closing === null || (closing.moveId === null && workflow !== null)
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
        <GithubSync
          open={syncingGithub}
          onClose={() => setSyncingGithub(false)}
          scope={scope}
          rpc={rpc}
          issues={result?.issues ?? []}
          onSynced={refresh}
        />
      </div>
    </IssueActionsProvider>
    </WorkflowProvider>
  );
}
