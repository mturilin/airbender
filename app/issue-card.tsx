// app/issue-card.tsx — an issue's card, opened by hovering its name.
//
// What: the read-only card that shows one issue at a glance (title, facts,
// description, what "done" means, sub-issues), and the hook that opens it
// when the pointer rests on a trigger and closes it again.
//
// Why: first built for the line above the message box, so the user can see
// what the thread is on without opening the tab (bead-bb-3l4, bead-bb-eg0).
// The epic band in the tab shows the same card for the epic (the user,
// bead-bb-ha9: "it can show the same card as it shows when you focus on ID
// of the current issue in the main window"), so both live here.
//
// Design notes:
// - Two ways of opening, two ways of closing. Opened by a click, the card
//   stays until a press outside it or Escape. Opened by hovering, it goes
//   away shortly after the pointer leaves both the trigger and the card.
//   A click while a hover-opened card is showing keeps it.
// - The card is placed from the trigger's position when it opens: above it
//   for the message box, which is at the bottom of the window, below it for
//   the epic band, which is near the top.
//
// Gotchas:
// - The card is drawn at the top level of the page (a portal), at a fixed
//   place in the window. Positioned against its trigger it was cut off:
//   BB's message box, and the tab's bands, clip what sticks out of them.
//   Content moved out like this loses the plugin's styles unless it carries
//   usePortalScopeProps().

import { Markdown } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { IssueFacts } from "./issue-facts.tsx";
import { formatWhen } from "./issue-model.ts";
import { useMenu } from "./menus.tsx";

/** How long the pointer must rest on the trigger before the card opens. */
const HOVER_OPEN_MS = 100;

/** How long a hover-opened card stays after the pointer leaves it. */
const HOVER_CLOSE_MS = 300;

/** The card's width in pixels (30rem), for keeping it inside the window. */
const CARD_WIDTH = 480;

/** What useHoverCard hands back: for the trigger, and for IssueCard. */
export interface HoverCard {
  open: boolean;
  /** Goes on the element that wraps the trigger. */
  root: RefObject<HTMLDivElement | null>;
  /** Goes on the card's own element (IssueCard does this). */
  panel: RefObject<HTMLDivElement | null>;
  /**
   * Goes on the trigger as its `ref`, whatever kind of element it is: the
   * card is placed from where that element is.
   */
  trigger: (element: HTMLElement | null) => void;
  /** Fixed position and height limit for the card. */
  place: CSSProperties;
  /** For the trigger's wrapper and for the card: pointer came on / left. */
  onEnter: () => void;
  onLeave: () => void;
  /** For the trigger: a click opens the card to stay, or closes it. */
  onClick: () => void;
}

/**
 * Opens a card on hover or click (see the design notes for the rules).
 *
 * @param side Where the card goes relative to the trigger.
 * Side effects: timers while the pointer comes and goes; none left running
 *   after the component is gone.
 */
export function useHoverCard(side: "above" | "below"): HoverCard {
  const { open, setOpen, root, panel } = useMenu();
  const [place, setPlace] = useState<CSSProperties>({});
  const element = useRef<HTMLElement | null>(null);
  // True while the card is open only because of hovering; a click clears it.
  const hoverOpened = useRef(false);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  /** Works out where the card goes from where the trigger is right now. */
  const placeCard = () => {
    const box = element.current?.getBoundingClientRect();
    if (box === undefined) return;
    // Left edges together, but never off the right edge of the window.
    const width = Math.min(CARD_WIDTH, window.innerWidth * 0.85);
    const left = Math.max(
      8,
      Math.min(box.left, window.innerWidth - width - 8),
    );
    // Never taller than the room on that side; it scrolls inside.
    setPlace(
      side === "above"
        ? {
            left,
            bottom: window.innerHeight - box.top + 8,
            maxHeight: Math.max(160, box.top - 16),
          }
        : {
            left,
            top: box.bottom + 8,
            maxHeight: Math.max(160, window.innerHeight - box.bottom - 16),
          },
    );
  };
  const onEnter = () => {
    window.clearTimeout(closeTimer.current);
    if (open) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      hoverOpened.current = true;
      placeCard();
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  const onLeave = () => {
    window.clearTimeout(openTimer.current);
    if (!hoverOpened.current) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      hoverOpened.current = false;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  const onClick = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (open && hoverOpened.current) {
      // Already showing because of hovering: the click keeps it.
      hoverOpened.current = false;
      return;
    }
    hoverOpened.current = false;
    placeCard();
    setOpen((current) => !current);
  };
  // No timer may fire after the trigger is gone.
  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );
  return {
    open,
    root,
    panel,
    trigger: (next) => {
      element.current = next;
    },
    place,
    onEnter,
    onLeave,
    onClick,
  };
}

/**
 * The card: one issue at a glance, without opening it in the tab.
 *
 * Top to bottom: a heading line ("Current issue", "Epic") with when the
 * issue last changed; the
 * parent, when it is a sub-issue; the title; the id (click to copy) with
 * status, priority, type and category tags, drawn by the same IssueFacts
 * the tab uses so the two never disagree; the description as formatted
 * text; what "done" means, when the issue says; and its sub-issues with a
 * progress bar, closed ones struck through as in the tab.
 *
 * Read-only: changing the issue is the tab's job. Long text scrolls inside
 * its own block so the card keeps a bounded height.
 *
 * Drawn at the top level of the page (a portal), at a fixed place in the
 * window. The first version was positioned against its trigger, inside the
 * message box, and the user saw nothing happen on a click: BB's message box
 * cuts off whatever sticks out of it. Content moved out like this loses the
 * plugin's styles unless it carries usePortalScopeProps().
 *
 * @param card What useHoverCard gave the trigger: where the card goes, and
 *   the handlers that keep a hover-opened card while the pointer is on it.
 * @param heading What the issue is to the user here: "Current issue", "Epic".
 * @param parent The issue this one is a sub-issue of, if any.
 * @param subIssues Direct sub-issues only, in the order the list gave them.
 */
export function IssueCard({
  card,
  heading,
  issue,
  parent,
  subIssues,
}: {
  card: HoverCard;
  heading: string;
  issue: Issue;
  parent: Issue | null;
  subIssues: Issue[];
}) {
  const closed = subIssues.filter((sub) => sub.status === CLOSED_STATUS).length;
  const scopeProps = usePortalScopeProps();
  return createPortal(
    <div
      {...scopeProps}
      ref={card.panel}
      role="dialog"
      aria-label={`${heading} ${issue.id}`}
      style={card.place}
      onMouseEnter={card.onEnter}
      onMouseLeave={card.onLeave}
      // 30rem wide: it was 24rem, and the user asked for a little wider.
      className="fixed z-50 w-[30rem] max-w-[85vw] overflow-y-auto rounded-xl border border-border bg-popover text-left text-popover-foreground shadow-lg"
    >
      {/* A thin green line on top: the same colour the tab gives Current. */}
      <div className="h-0.5 bg-success/60" />
      <div className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-1.5 rounded-full bg-success" />
            {heading}
          </span>
          {issue.updatedAt === null ? null : (
            <span>Changed {formatWhen(issue.updatedAt)}</span>
          )}
        </div>
        {parent === null ? null : (
          <p className="truncate text-xs text-muted-foreground">
            Part of {parent.title}
          </p>
        )}
        <h4 className="text-base font-semibold leading-snug">{issue.title}</h4>
        <IssueFacts issue={issue} showStatus />
      </div>
      <div className="max-h-48 overflow-y-auto border-t border-border px-4 py-3">
        {issue.description.trim() === "" ? (
          <p className="text-sm text-muted-foreground">No description yet.</p>
        ) : (
          <Markdown content={issue.description} className="text-sm" />
        )}
      </div>
      {issue.acceptance.trim() === "" ? null : (
        <div className="max-h-32 overflow-y-auto border-t border-border px-4 py-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Done means
          </div>
          <Markdown content={issue.acceptance} className="text-sm" />
        </div>
      )}
      {subIssues.length === 0 ? null : (
        <div className="border-t border-border px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Sub-issues</span>
            <span>
              {closed} of {subIssues.length} closed
            </span>
          </div>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-success/70"
              style={{ width: `${(closed / subIssues.length) * 100}%` }}
            />
          </div>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm">
            {subIssues.map((sub) => (
              <li
                key={sub.id}
                className={cn(
                  "truncate",
                  sub.status === CLOSED_STATUS &&
                    "text-muted-foreground line-through",
                )}
              >
                {sub.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>,
    document.body,
  );
}

