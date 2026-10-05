// app/panel.tsx — the Airbender tab.
//
// What: BeadsPanel: the three bands of the tab (Current and toolbar pinned on
// top, the scrolling groups, the new-issue field pinned at the bottom), the
// details window, the close confirmation, and the wiring from the issue list
// to the actions the rows can perform.
//
// Why: this is where the data, the requests to the backend and the layout
// meet. Everything it draws lives in the other app/ files.
//
// Gotchas:
// - This component still does several jobs at once; breaking it up is tracked
//   in bead-bb-dw0.2.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import type { IssueType } from "../shared/constants.ts";
import type { IssueActions } from "./actions.ts";
import { Notice } from "./bits.tsx";
import { CreateIssue } from "./create-issue.tsx";
import { getDragged, setDragged } from "./drag.ts";
import { byUrgency, toSections, toSubGroups, toggled } from "./issue-model.ts";
import { IssueRow } from "./issue-row.tsx";
import { FilterMenu, GroupMenu } from "./menus.tsx";
import { CurrentSection, SectionBlock } from "./section-block.tsx";
import { SetupCard, SetupDialog, SetupMenu, useSetup } from "./setup.tsx";
import type { SetupStep } from "./setup.tsx";
import { useFilters } from "./use-filters.ts";
import { useIssues } from "./use-issues.ts";
import type { Scope } from "./use-issues.ts";

/**
 * The tab body: current bead, create line, then the grouped issues or a
 * plain-language explanation of why there are none.
 */
export function BeadsPanel({ scope }: { scope: Scope }) {
  const { rpc, result, failure, loading, refresh } = useIssues(scope);
  const [filters, setFilters] = useFilters(result?.path ?? null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  // Getting the folder ready: what is missing, what was skipped, and the
  // step whose confirmation is open (see SetupCard, SetupMenu, SetupDialog).
  const setup = useSetup(scope, result?.state ?? null);
  const [confirmingStep, setConfirmingStep] = useState<SetupStep | null>(null);
  // The issue waiting for the user's "yes, close it"; null when none is.
  const [closing, setClosing] = useState<{
    issue: Issue;
    commit: boolean;
  } | null>(null);
  const { threadId, projectId } = scope;
  // The current bead is shown in its own group, so it is left out of the
  // status groups to avoid listing it twice.
  const currentIssue = useMemo(
    () =>
      result?.issues.find((issue) => issue.id === result.currentBeadId) ??
      null,
    [result],
  );
  // The tree. beads gives each issue one parent; everything else is derived.
  const tree = useMemo(() => {
    const all = result?.state === "ok" ? result.issues : [];
    const byId = new Map(all.map((issue) => [issue.id, issue]));
    const currentId = currentIssue?.id ?? null;
    // An issue is drawn under its parent unless:
    // - it has none, or its parent is not in the list;
    // - it is the thread's current bead, which is drawn in Current;
    // - it is still open while its parent is closed: under its parent it
    //   would be hidden inside the folded Closed group.
    const drawnUnderParent = (issue: Issue) => {
      if (issue.parentId === null || issue.id === currentId) return false;
      const parent = byId.get(issue.parentId);
      if (parent === undefined) return false;
      return !(parent.status === CLOSED_STATUS && issue.status !== CLOSED_STATUS);
    };
    const children = new Map<string, Issue[]>();
    for (const issue of all) {
      if (!drawnUnderParent(issue)) continue;
      const list = children.get(issue.parentId!) ?? [];
      list.push(issue);
      children.set(issue.parentId!, list);
    }
    // Open sub-issues first, each part by urgency; closed ones stay listed,
    // struck through, at the end (the user's choice).
    for (const list of children.values()) {
      list.sort(
        (left, right) =>
          Number(left.status === CLOSED_STATUS) - Number(right.status === CLOSED_STATUS) ||
          byUrgency(left, right),
      );
    }
    return {
      byId,
      children,
      // What the status groups hold: everything not drawn somewhere else.
      topLevel: all.filter(
        (issue) => issue.id !== currentId && !drawnUnderParent(issue),
      ),
    };
  }, [result, currentIssue]);
  const others = tree.topLevel;
  /** Every issue inside `beadId`, at any depth (by the stored parents). */
  const descendantIds = useCallback(
    (beadId: string) => {
      const found = new Set<string>();
      const queue = [beadId];
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        for (const issue of tree.byId.values()) {
          if (issue.parentId !== parentId || found.has(issue.id)) continue;
          if (issue.id === beadId) continue;
          found.add(issue.id);
          queue.push(issue.id);
        }
      }
      return found;
    },
    [tree],
  );
  // The issue the details window is showing; null when it is closed. The
  // path shown at its top is worked out from the stored parents, so moving
  // deeper or back up is just changing this one id.
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
  const detailsIssue =
    detailsId === null ? null : (tree.byId.get(detailsId) ?? null);
  const detailsPath = useMemo(() => {
    const path: Issue[] = [];
    const seen = new Set<string>();
    let step = detailsIssue;
    while (step !== null && !seen.has(step.id)) {
      seen.add(step.id);
      path.unshift(step);
      step =
        step.parentId === null ? null : (tree.byId.get(step.parentId) ?? null);
    }
    return path;
  }, [detailsIssue, tree]);
  // Types offered in the filter menu: those that actually occur here.
  const types = useMemo(
    () =>
      [
        ...new Set(others.flatMap((issue) => (issue.type ? [issue.type] : []))),
      ].sort(),
    [others],
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
  // Closed issues are hidden each time the tab opens; the Closed group's
  // own button shows them. Deliberately not remembered, so the tab always
  // starts with the short list.
  const [showClosed, setShowClosed] = useState(false);
  const { openSections, closedSection } = useMemo(() => {
    const matching = others.filter(
      (issue) =>
        (filters.types.length === 0 ||
          (issue.type !== null && filters.types.includes(issue.type))) &&
        (filters.priorities.length === 0 ||
          (issue.priority !== null &&
            filters.priorities.includes(issue.priority))) &&
        // "" in the filter stands for "no category".
        (filters.categories.length === 0 ||
          filters.categories.includes(issue.category ?? "")),
    );
    const sections = toSections(matching);
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
  // Whether the issue in the close dialog is this thread's current bead,
  // the only case in which committing is a meaningful part of the question.
  const closingIsCurrent =
    closing !== null && closing.issue.id === (result?.currentBeadId ?? null);
  // "Close & commit" on an issue with sub-issues closes the open ones too;
  // the dialog says how many, so it is never a surprise.
  const closingOpenSubIssues =
    closing === null || !closing.commit
      ? 0
      : [...descendantIds(closing.issue.id)].filter(
          (id) => tree.byId.get(id)?.status !== CLOSED_STATUS,
        ).length;
  const actions: IssueActions = {
    currentBeadId: result?.currentBeadId ?? null,
    loadComments,
    close: (beadId, commit) => {
      // Confirmed in a dialog first: remember which issue and which kind of
      // close, and let the dialog below call applyOpen when the user agrees.
      const issue = result?.issues.find((candidate) => candidate.id === beadId);
      if (issue !== undefined) setClosing({ issue, commit });
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
    openDetails: setDetailsId,
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
    addSubIssue: (parentId) => {
      setNewIssueParentId(parentId);
      // The bottom field is behind the details window; get it out of the way.
      setDetailsId(null);
      setFocusNewIssue((count) => count + 1);
    },
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
            setDetailsId(null);
            rpc.call("current_start", { threadId, beadId }).then(() => {
              setActionProblem(null);
              refresh();
            }, reportProblem);
          },
    setCurrent:
      threadId === null
        ? null
        : (beadId) => {
            rpc.call("current_set", { threadId, beadId }).then(
              () => {
                setActionProblem(null);
                refresh();
              },
              reportProblem,
            );
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
  // The details window has its own new-issue field, so that adding a
  // sub-issue there stays there (the user's rule: in the panel it stays in
  // the panel, in the window it stays in the window). Its parent is the
  // issue the window shows unless "Add sub-issue" on a row inside the window
  // picked another; moving to a different issue puts it back.
  const [windowParentId, setWindowParentId] = useState<string | null>(null);
  const [focusWindowNewIssue, setFocusWindowNewIssue] = useState(0);
  useEffect(() => {
    setWindowParentId(null);
  }, [detailsId]);
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Top band, pinned: Current, then the toolbar. */}
      <div
        className="shrink-0 space-y-3 border-b border-border p-3"
        style={pinnedStyle}
      >
        {ok ? <CurrentSection issue={currentIssue} actions={actions} /> : null}
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
                actions={actions}
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
              actions={actions}
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
      {/* One dialog, three wordings. Committing is only mentioned where it
          applies, which is the thread's current bead: closing any other
          issue is a plain "are you sure", with Close and Cancel. */}
      <Dialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {closing?.commit
                ? "Close this issue and commit its work?"
                : closingIsCurrent
                  ? "Close this issue without committing?"
                  : "Are you sure you want to close this issue?"}
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono">{closing?.issue.id}</span>{" "}
              {closing?.issue.title}
            </DialogDescription>
          </DialogHeader>
          {closing?.commit ? (
            <p className="text-sm text-muted-foreground">
              The issue is closed, and this thread's agent is asked to commit
              its work.
              {closingOpenSubIssues === 0
                ? ""
                : ` Its ${closingOpenSubIssues} open ${closingOpenSubIssues === 1 ? "sub-issue is" : "sub-issues are"} closed with it.`}
            </p>
          ) : closingIsCurrent ? (
            <p className="text-sm text-muted-foreground">
              The issue is closed and nothing is committed.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (closing !== null) {
                  applyOpen(closing.issue.id, false, closing.commit);
                }
                setClosing(null);
              }}
            >
              {closing?.commit
                ? "Close and commit"
                : closingIsCurrent
                  ? "Close without commit"
                  : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* The details window: one issue with its sub-issues, one level deep,
          in a window wide enough to read a hierarchy. It is a single window
          that is moved through, not a stack: a sub-issue's details button
          changes which issue it shows, and the path at the top goes back
          up. Its rows are the same rows as the list, so everything the list
          can do works here too. */}
      <Dialog
        open={detailsIssue !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
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
                  onClick={() => setDetailsId(null)}
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
                        onClick={() => setDetailsId(step.id)}
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
  );
}
