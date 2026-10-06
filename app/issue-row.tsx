// app/issue-row.tsx — one issue in the list.
//
// What: IssueRow: the collapsed line for an issue, its drag and drop
// behaviour, its row buttons, the opened issue underneath, and its sub-issues
// one level deep.
//
// Why: this is the spec's "An issue row" and the row half of "Sub-issues" in
// one place.
//
// Design notes:
// - Nesting is drawn one level deep only (the user's rule); deeper levels are
//   reached through the details window.
//
// Gotchas:
// - The id of the issue being dragged lives in app/drag.ts, shared with the
//   list's drop zone; do not keep a second copy here.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { useActions } from "./actions.ts";
import { StatusTag, Tag } from "./bits.tsx";
import { getDragged, setDragged } from "./drag.ts";
import { IssueDetails } from "./issue-details.tsx";
import { IssueFacts } from "./issue-facts.tsx";
import {
  StateTag,
  WorkflowButton,
  useWorkflow,
} from "./workflow-controls.tsx";
import { RowMenu } from "./row-menu.tsx";
import type { RowAsk } from "./row-menu.tsx";
import { CurrentToggle } from "./current-toggle.tsx";
import { ZoomInIcon } from "./epic-band.tsx";

/**
 * One issue: a compact line that opens to show its details, with its
 * sub-issues drawn indented underneath.
 *
 * Nesting is drawn one level deep only (the user's rule): a top-level row
 * shows its direct sub-issues, and those show none of their own. Any row
 * that has sub-issues carries a details button that opens the details
 * window on it, which is how deeper levels are reached.
 *
 * The line is a drop target: dropping another issue on it moves that issue
 * inside this one. Dragging starts only from the grip at its left edge.
 *
 * State kept in the row (so it resets when the tab is closed): whether the
 * issue is opened. Opening shows both its details and its sub-issues.
 */
export function IssueRow({
  issue,
  detailsClassName,
  nested = false,
  showSubIssues = true,
  subIssuesClassName,
  isDetailsRoot = false,
  lean = false,
  hoverClassName = "hover:bg-state-hover",
}: {
  issue: Issue;
  /** Extra classes for the opened area, e.g. a height cap for pinned rows. */
  detailsClassName?: string;
  /** This row is a sub-issue drawn under its parent. */
  nested?: boolean;
  /** Draw this issue's direct sub-issues under it. False for nested rows. */
  showSubIssues?: boolean;
  /** Extra classes for the sub-issue list, e.g. a height cap when pinned. */
  subIssuesClassName?: string;
  /**
   * This row is the issue the details window is showing, so it needs no
   * button to open the details window on itself. Its sub-issues are drawn
   * as full-size rows: the window has the room (bead-bb-zty.2).
   */
  isDetailsRoot?: boolean;
  /**
   * Draw this row as the lean one-line sub-issue row. Set by a parent row in
   * the panel for its sub-issues.
   */
  lean?: boolean;
  /**
   * The background a row's line takes while the pointer is on it. The
   * default is the app's gray hover. Current passes a green one: the gray,
   * laid over Current's green background, came out gray-green.
   */
  hoverClassName?: string;
}) {
  const actions = useActions();
  const subIssues = actions.childrenOf(issue.id);
  const hasSubIssues = showSubIssues && subIssues.length > 0;
  // One chevron opens everything about the issue: its description and its
  // sub-issues. It starts open for an issue that has sub-issues (the user's
  // rule), so the nesting is visible without clicking, and for the issue the
  // details window is showing, which was opened to be read.
  const [open, setOpen] = useState(isDetailsRoot || hasSubIssues);
  // What the "more" menu has asked the opened issue to show (its edit form,
  // or the Move to or Link box); null once the opened issue has taken it.
  const [asked, setAsked] = useState<RowAsk | null>(null);
  // Whether this issue offers epic mode, and whether it may be entered.
  const focusOffer = actions.focusOffer(issue.id);
  // The repository is on the simple workflow, which has no steps.
  const simple = useWorkflow() === null;
  // An issue that gains its first sub-issue while on screen opens too;
  // otherwise the new sub-issue would be created out of sight.
  useEffect(() => {
    if (hasSubIssues) setOpen(true);
  }, [hasSubIssues]);
  // True while a draggable issue hovers over this row and may be dropped.
  const [dropTarget, setDropTarget] = useState(false);
  // The row's line, used as the picture that follows the pointer in a drag.
  const line = useRef<HTMLDivElement>(null);
  const closed = issue.status === CLOSED_STATUS;
  // A sub-issue drawn under its parent in the panel is a leaner row than a
  // top-level one (the user's request: they looked the same and were as
  // tall): one line, smaller text, only status and priority beside the
  // title, no buttons on the row at all, and the grip shown only while the
  // pointer or the keyboard is on the row. In the details window sub-issues
  // are full-size rows instead, so `lean` is passed down, not worked out
  // from `nested`.
  const compact = lean;
  const openCount = subIssues.filter(
    (subIssue) => subIssue.status !== CLOSED_STATUS,
  ).length;
  return (
    <li>
      <div
        ref={line}
        onDragOver={(event) => {
          // Always stop here, valid or not: an invalid drop on a row must not
          // fall through to the list behind it and be taken as "move out".
          event.stopPropagation();
          const dragged = getDragged();
          if (dragged === null || !actions.canNest(dragged, issue.id)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => {
          event.stopPropagation();
          setDropTarget(false);
          const dragged = getDragged();
          setDragged(null);
          if (dragged === null || !actions.canNest(dragged, issue.id)) return;
          event.preventDefault();
          actions.setParent(dragged, issue.id);
        }}
        className={cn(
          "group/row relative flex",
          hoverClassName,
          compact ? "items-center" : "items-start",
          dropTarget && "bg-state-active outline outline-1 outline-ring",
        )}
      >
        {/* The drag anchor. Only this grip starts a drag, so that selecting
            the title's text, using the dropdowns and clicking buttons on the
            row never drags it by accident. The whole line is shown as the
            thing being dragged. */}
        <Tip label="Drag onto another issue to nest it, or onto a group heading to move it out">
        <span
          draggable
          role="img"
          aria-label={`Drag ${issue.id} to move it into or out of another issue`}
          onDragStart={(event) => {
            setDragged(issue.id);
            event.dataTransfer.effectAllowed = "move";
            // Some browsers will not start a drag without data.
            event.dataTransfer.setData("text/plain", issue.id);
            if (line.current !== null) {
              event.dataTransfer.setDragImage(line.current, 12, 12);
            }
          }}
          onDragEnd={() => {
            setDragged(null);
          }}
          className={cn(
            "cursor-grab pl-2 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing",
            // Kept in the layout while invisible, so the title does not
            // jump sideways when the grip appears.
            compact
              ? "py-1 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
              : "py-2",
          )}
        >
          <Icon
            name="DragDropVertical"
            className={cn("size-4 shrink-0", !compact && "mt-0.5")}
          />
        </span>
        </Tip>
        {/* The chevron and the title both open the issue. They are two
            separate buttons with the facts line outside them, because the
            priority and type dropdowns on that line are controls of their
            own and may not sit inside a button. */}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          onClick={() => setOpen((current) => !current)}
          className={cn("cursor-pointer pl-1 pr-2", compact ? "py-1" : "py-2")}
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              !compact && "mt-0.5",
            )}
          />
        </button>
        {compact ? (
          // One line: the title, then status and priority. The id and the
          // type are inside the opened issue (see IssueDetails).
          <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-[13px]">
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              className={cn(
                "min-w-0 flex-1 cursor-pointer truncate text-left",
                closed && "text-muted-foreground line-through",
              )}
            >
              {issue.title}
            </button>
            {hasSubIssues ? <Tag>{subIssues.length} sub</Tag> : null}
            <StateTag issue={issue} />
            <StatusTag issue={issue} />
            {issue.priority === null ? null : (
              <Tag strong={issue.priority <= 1}>P{issue.priority}</Tag>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1 py-2 pr-1 text-sm">
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              className={cn(
                "block w-full cursor-pointer text-left",
                closed && "text-muted-foreground line-through",
              )}
            >
              {issue.title}
            </button>
            {/* Closed issues are finished business: their facts stay fixed. */}
            <IssueFacts
              issue={issue}
              onEdit={closed ? undefined : actions.edit}
              onSize={closed ? undefined : actions.setSize}
              category={
                closed
                  ? undefined
                  : {
                      choices: actions.categories,
                      onChange: actions.setCategory,
                    }
              }
              showStatus={nested}
            />
            {/* Says that there is something nested here even while the row
                is closed up. Not a control: the chevron opens it. */}
            {hasSubIssues ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {subIssues.length}{" "}
                {subIssues.length === 1 ? "sub-issue" : "sub-issues"}
                {openCount === subIssues.length
                  ? ""
                  : `, ${subIssues.length - openCount} closed`}
              </span>
            ) : null}
          </div>
        )}
        {/* The row's buttons. A compact sub-issue row has none (the user's
            rule: no buttons on hover for sub-issues); everything they did is
            inside the opened sub-issue instead (see IssueDetails). Only the
            drag grip appears on hover, since it is a handle, not an action. */}
        <div className={compact ? "hidden" : "contents"}>
        {/* Opens the details window on this issue: the roomy view of an
            issue, with its sub-issues if it has any, and the only way to
            levels deeper than the one drawn here. On every issue (the
            user's request, bead-bb-2oy); it used to be only on issues with
            sub-issues. Not on the issue the window is already showing. */}
        {isDetailsRoot ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0 text-muted-foreground"
            tip={
              subIssues.length === 0
                ? "Open this issue in the details window"
                : "Open this issue and its sub-issues in the details window"
            }
            aria-label={`Open ${issue.id} in the details window`}
            onClick={() => actions.openDetails(issue.id)}
          >
            <Icon name="Maximize2" className="size-4" />
          </Button>
        )}
        {/* Epic mode: zoom the tab in on this issue's sub-issues. Beside
            the details-window button because the two are the ways into an
            issue with sub-issues: a look in a window, or the list itself.
            Shown disabled, with the reason, while the thread's current
            issue is not from this epic (the user's rule, bead-bb-ha9). */}
        {focusOffer === null || isDetailsRoot ? null : (
          <Button
            variant="ghost"
            size="icon"
            // Greyed out by hand instead of `disabled`: a disabled button
            // takes no pointer at all, so its tooltip, which is where the
            // reason is, would never show. A press then does nothing. The
            // pointer stays the plain arrow: a "forbidden" cursor was tried
            // and the user found it far too much.
            className={cn(
              "m-1 size-7 shrink-0 text-muted-foreground",
              focusOffer.blocked !== null &&
                "cursor-default opacity-40 hover:bg-transparent",
            )}
            aria-disabled={focusOffer.blocked !== null}
            tip={
              focusOffer.blocked ??
              "Epic mode: show only this issue's sub-issues in the list"
            }
            aria-label={`Show only the sub-issues of ${issue.id} in the list`}
            onClick={() => actions.focus(issue.id)}
          >
            <ZoomInIcon className="size-4" />
          </Button>
        )}
        {/* What the issue's step in its workflow offers: the agent's run
            button ("Define", "Plan"…) or the user's main move ("Approve
            plan", "Accept"). Not on a compact sub-issue row, which
            has no buttons; there it is inside the opened sub-issue. */}
        {compact ? null : (
          <WorkflowButton
            issue={issue}
            // Full size on the thread's current issue, where it is the one
            // thing to press. Everywhere else it is small and quiet (the
            // user's request, bead-bb-q9v): when the thread has no current
            // issue every open row carries one, and as bordered, full-size
            // buttons they crowded the titles and made rows grow. The quiet
            // look is the one the buttons inside an opened issue have: low,
            // small text, no border, a soft fill. The top margin puts its
            // middle on the title's line, level with the icon buttons
            // beside it, and its height keeps it inside a one-line row.
            className={
              actions.currentBeadId === issue.id
                ? "m-1 h-7 shrink-0 px-2"
                : "mx-1 mt-1.5 h-6 shrink-0 gap-1 rounded border-0 bg-foreground/[0.06] px-1.5 text-xs font-normal text-muted-foreground shadow-none hover:bg-foreground/[0.12] hover:text-foreground [&_[data-icon-root]]:size-3.5"
            }
          />
        )}
        {/* Everything else one does to an issue is in the "more" menu:
            make current, edit, add a sub-issue, move, link, close; reopen
            for a closed one. Not on a compact sub-issue row (the user's
            decision, for now): there everything is inside the opened
            sub-issue. Edit, Move to and Link open the row and are shown
            there. */}
        {/* On the simple workflow there is no step button, and making an
            issue current, releasing it and closing it are all there is to
            do with one: they are buttons on the row, not menu entries (the
            user: "select and release and close should be prominent, not on
            menu"). Close is an icon so the title keeps its room. */}
        {compact || !simple ? null : (
          <CurrentToggle
            issue={issue}
            withLabel
            className="m-1 h-7 shrink-0 px-2"
          />
        )}
        {compact || !simple || closed ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0 text-muted-foreground"
            tip="Close this issue"
            aria-label={`Close ${issue.id}: ${issue.title}`}
            onClick={() => actions.close(issue.id)}
          >
            <Icon name="CircleX" className="size-4" />
          </Button>
        )}
        {compact ? null : (
          <RowMenu
            issue={issue}
            lean={simple}
            canMaximize={!isDetailsRoot}
            className="m-1"
            onAsk={(what) => {
              setOpen(true);
              setAsked(what);
            }}
          />
        )}
        </div>
      </div>
      {open ? (
        <div
          className="border-t border-border px-3 py-3 pl-14"
        >
          <IssueDetails
            issue={issue}
            // A cap on the height applies to the text only: the buttons
            // under it stay in view.
            bodyClassName={detailsClassName}
            asked={asked}
            onAsked={() => setAsked(null)}
            fullDescription={isDetailsRoot}
            showFacts={compact}
          />
        </div>
      ) : null}
      {hasSubIssues && open ? (
        <ul
          className={cn(
            // A rail down the left edge, so the sub-issues read as "inside"
            // the row above them. In the panel the block is also slightly
            // darker than the rows around it (the user asked for a slight
            // difference); in the details window the rows are full size and
            // need no tint to be told apart.
            "ml-6 divide-y divide-border border-l-2 border-t border-border border-l-foreground/25",
            !isDetailsRoot && "bg-black/[0.035]",
            subIssuesClassName,
          )}
        >
          {subIssues.map((subIssue) => (
            <IssueRow
              key={subIssue.id}
              issue={subIssue}
              nested
              showSubIssues={false}
              lean={!isDetailsRoot}
              hoverClassName={hoverClassName}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
