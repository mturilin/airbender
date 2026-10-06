// app/row-menu.tsx — the "more" menu on an issue's row.
//
// What: the three-dots button at the end of a row and its menu of the
// ordinary things one does to an issue: make it current or release it,
// edit, add a sub-issue, move, link, close; for a closed issue, reopen.
//
// Why: the row used to carry a cancel cross as its one permanent button,
// though closing is not what one does most (the user's point, bead-bb-l3m).
// One menu holds every such action and keeps the row to the workflow button
// and this. The same actions stay available inside the opened issue, so
// there are two ways to each.
//
// Design notes:
// - Workflow moves are not here: they are the workflow button and, inside
//   the opened issue, send back / skip / mark as done.
// - Edit, Move to and Link need the opened issue, where their form and
//   search boxes are drawn. Choosing one opens the row and asks the opened
//   issue to show it (`onAsk`). A floating search box was considered and
//   put off: the user wants to try this first.
// - The menu is drawn at the top level of the page, at a fixed place worked
//   out from the button: the list the rows sit in cuts off anything that
//   hangs outside it. Content moved out like this loses the plugin's styles
//   unless it carries usePortalScopeProps().
//
// Gotchas:
// - In the details window the menu is drawn inside the window instead. The
//   window is a modal: anything outside it cannot be clicked, and a press
//   outside it closes it. The window is also moved into place with a
//   transform, so "fixed" would be measured from the window, not the page;
//   there the menu is placed relative to the window.

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { stateOf } from "../shared/workflow.ts";
import { useActions } from "./actions.ts";
import { LinkIcon } from "./bits.tsx";
import { CurrentIcon } from "./current-toggle.tsx";
import { useMenu } from "./menus.tsx";
import { useCanResize, useWorkflow } from "./workflow-controls.tsx";

/** What the menu can ask the opened issue to show. */
export type RowAsk = "edit" | "move" | "link";

/** One entry of the menu. */
function Entry({
  icon,
  onPick,
  children,
}: {
  /** Drawn before the words: the same icon the action has as a button
   *  inside the opened issue, so the two are recognised as one. */
  icon: ReactNode;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-state-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * Arrows along two sides of a box: its measurements. For the size row.
 * Tabler Icons' "dimensions" (MIT, (c) Pawel Kuna), copied in as its
 * paths: BB's icon set has nothing for size.
 */
function SizeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 5h11" />
      <path d="M12 7l2 -2l-2 -2" />
      <path d="M5 3l-2 2l2 2" />
      <path d="M19 10v11" />
      <path d="M17 19l2 2l2 -2" />
      <path d="M21 12l-2 -2l-2 2" />
      <path d="M3 12a2 2 0 0 1 2 -2h7a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-7a2 2 0 0 1 -2 -2l0 -7" />
    </svg>
  );
}

/**
 * The three-dots button and its menu, for one issue.
 *
 * @param onAsk Called for Edit, Move to and Link: the row opens the issue
 *   and passes the request on to it.
 * @param lean Leave out "Make current" and "Close": on the simple
 *   workflow they are buttons on the row itself (the user's decision,
 *   bead-bb-8j6), and listing them twice side by side would be noise.
 * @param className Extra classes, for the row's spacing.
 */
export function RowMenu({
  issue,
  onAsk,
  lean = false,
  className,
}: {
  issue: Issue;
  onAsk: (what: RowAsk) => void;
  lean?: boolean;
  className?: string;
}) {
  const actions = useActions();
  const { open, setOpen, root, panel } = useMenu();
  const scopeProps = usePortalScopeProps();
  // Where the menu is drawn: the element it is put into, and its position
  // within it. Worked out when the button is pressed.
  const [place, setPlace] = useState<{
    into: HTMLElement;
    style: CSSProperties;
  } | null>(null);
  const closed = issue.status === CLOSED_STATUS;
  const workflow = useWorkflow();
  const sizes = workflow?.sizes;
  const notStarted =
    workflow !== null &&
    stateOf(workflow, issue.step).id === workflow.initial;
  const canResize = useCanResize(issue);
  const current = actions.currentBeadId === issue.id;
  /** Runs an entry's action and shuts the menu. */
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const { setCurrent, makeCurrent } = actions;
  return (
    <div ref={root} className={cn("shrink-0", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        tip={
          open
            ? undefined
            : lean
              ? "More: edit, add a sub-issue, move, link"
              : "More: make current, edit, move, link, close"
        }
        aria-label={`More actions for ${issue.id}`}
        aria-expanded={open}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const dialog =
            event.currentTarget.closest<HTMLElement>('[role="dialog"]');
          const edge =
            dialog === null
              ? { top: 0, right: window.innerWidth, bottom: window.innerHeight }
              : dialog.getBoundingClientRect();
          // Under the button, right edges together; above it when there is
          // not enough room below.
          const below = edge.bottom - box.bottom > 240;
          setPlace({
            into: dialog ?? document.body,
            style: {
              position: dialog === null ? "fixed" : "absolute",
              right: Math.max(8, edge.right - box.right),
              ...(below
                ? { top: box.bottom - edge.top + 4 }
                : { bottom: edge.bottom - box.top + 4 }),
            },
          });
          setOpen((now) => !now);
        }}
      >
        {/* Three dots, drawn here: BB's icon set has no "more" icon. */}
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="size-4"
        >
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </Button>
      {open && place !== null
        ? createPortal(
            <div
              {...scopeProps}
              ref={panel}
              role="menu"
              style={place.style}
              className="z-[60] w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {closed ? (
                <Entry
                  icon={<Icon name="RotateCcw" className="size-4 shrink-0 text-muted-foreground" />}
                  onPick={pick(() => actions.reopen(issue.id))}
                >
                  Reopen
                </Entry>
              ) : (
                <>
                  {lean || setCurrent === null || makeCurrent === null ? null : (
                    <Entry
                      icon={<CurrentIcon on={current} />}
                      onPick={pick(() =>
                        current ? setCurrent(null) : makeCurrent(issue.id),
                      )}
                    >
                      {current ? "Release from current" : "Make current"}
                    </Entry>
                  )}
                  <Entry
                    icon={<Icon name="EditFile" className="size-4 shrink-0 text-muted-foreground" />}
                    onPick={pick(() => onAsk("edit"))}
                  >Edit</Entry>
                  <Entry
                    icon={<Icon name="Plus" className="size-4 shrink-0 text-muted-foreground" />}
                    onPick={pick(() => actions.addSubIssue(issue.id))}
                  >
                    Add sub-issue
                  </Entry>
                  <Entry
                    icon={<Icon name="MoveTo" className="size-4 shrink-0 text-muted-foreground" />}
                    onPick={pick(() => onAsk("move"))}
                  >Move to…</Entry>
                  {/* The issue's size, in one row: the sizes to set it by
                      hand, and "Auto" to have the background agent size
                      it now. One row with an icon, after the user found a
                      separate text entry for the second "horrible". Shown
                      while the size may still change; "Auto" only before
                      the issue is started, since afterwards its size is
                      the user's and the agent's. */}
                  {sizes === undefined || !canResize ? null : (
                    <div className="flex items-center gap-2 px-2 py-1 text-sm">
                      <SizeIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1">Size</span>
                      {sizes.map((size) => (
                        <button
                          key={size.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={issue.size === size.id}
                          title={size.hint}
                          onClick={pick(() => actions.setSize(issue.id, size.id))}
                          className={cn(
                            "w-7 cursor-pointer rounded border border-border py-px text-center text-xs hover:bg-state-hover",
                            issue.size === size.id &&
                              "border-foreground/40 bg-foreground/10 font-medium",
                          )}
                        >
                          {size.label}
                        </button>
                      ))}
                      {notStarted ? (
                        <button
                          type="button"
                          role="menuitem"
                          title="Have the background agent size this issue now. It replaces the size the issue has."
                          onClick={pick(() => actions.requestSizing(issue.id))}
                          className="cursor-pointer rounded border border-border px-1.5 py-px text-xs hover:bg-state-hover"
                        >
                          Auto
                        </button>
                      ) : null}
                    </div>
                  )}
                  <Entry
                    icon={<LinkIcon />}
                    onPick={pick(() => onAsk("link"))}
                  >Link…</Entry>
                  {lean ? null : (
                    <>
                      <div className="my-1 border-t border-border" />
                      <Entry
                        icon={<Icon name="CircleX" className="size-4 shrink-0 text-muted-foreground" />}
                        onPick={pick(() => actions.close(issue.id))}
                      >
                        Close
                      </Entry>
                    </>
                  )}
                </>
              )}
            </div>,
            place.into,
          )
        : null}
    </div>
  );
}
