// app/epic-band.tsx — the band that says which epic the tab is zoomed in on.
//
// What: one line between the toolbar and Current, shown in epic mode: a
// back arrow, the word "Epic", the path of issues above the epic and the
// epic itself; and the two small icons epic mode uses.
//
// Why: the user's layout (bead-bb-ha9): "between current and the header
// with project path ... additional elements, like current epic ... And next
// to the epic, there is a sign with an arrow back ... Similar how getting
// out of the folder."
//
// Design notes:
// - The arrow goes up one level: to the issue the epic is inside when there
//   is one, otherwise to the whole list. Epic mode goes down one level at a
//   time, so this is the way back out of each. No history of the way in is
//   kept: the parent is the same place whenever the user came down a level.
// - The issues above the epic are shown as a path and can be clicked, like
//   the path in the details window.
// - Resting the pointer on the epic's id or title opens the same card the
//   line above the message box opens for the current issue (the user's
//   request); a click keeps it open. It opens downwards: the band is near
//   the top of the tab.
// - The icons are Tabler Icons' "arrow-back-up" and "zoom-in" (MIT, (c)
//   Pawel Kuna), copied in as their paths: BB's icon set has neither, and
//   the user asked for Tabler or Font Awesome over home-made drawings.

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Issue } from "../server/contract.ts";
import { IssueCard, useHoverCard } from "./issue-card.tsx";

/** Shared look of the two outline icons below. */
const STROKE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** An arrow turning back and up: leave this level. */
export function BackUpIcon({ className }: { className?: string }) {
  return (
    <svg {...STROKE} className={className}>
      <path d="M9 14l-4 -4l4 -4" />
      <path d="M5 10h11a4 4 0 1 1 0 8h-1" />
    </svg>
  );
}

/**
 * A magnifier with a plus: zoom in on this epic. Not a target, which is
 * the icon for making an issue current.
 */
export function ZoomInIcon({ className }: { className?: string }) {
  return (
    <svg {...STROKE} className={className}>
      <path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
      <path d="M7 10l6 0" />
      <path d="M10 7l0 6" />
      <path d="M21 21l-6 -6" />
    </svg>
  );
}

/**
 * The epic band.
 *
 * @param path The issues from the top level down to the epic, the epic
 *   last (never empty).
 * @param subIssues The epic's direct sub-issues, every one of them, for the
 *   card.
 * @param onGo Called with the id of an issue of the path to zoom to it, or
 *   with null to leave epic mode for the whole list.
 * @param onClose See the prop.
 */
export function EpicBand({
  path,
  subIssues,
  onGo,
  onClose,
}: {
  path: Issue[];
  subIssues: Issue[];
  onGo: (beadId: string | null) => void;
  /**
   * Given when the epic is finished (every issue under it closed): the
   * band then offers to close it, and this is called on a press.
   */
  onClose?: () => void;
}) {
  const card = useHoverCard("below");
  const epic = path[path.length - 1]!;
  const above = path.slice(0, -1);
  const parent = above[above.length - 1] ?? null;
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-foreground/[0.05] py-1 pl-1 pr-2">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        tip={
          parent === null
            ? "Leave this epic: back to the whole list"
            : `Up one level, to ${parent.id}`
        }
        aria-label={
          parent === null ? "Back to the whole list" : `Up to ${parent.id}`
        }
        onClick={() => onGo(parent?.id ?? null)}
      >
        <BackUpIcon className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          Epic
        </span>
        {above.map((issue) => (
          <span
            key={issue.id}
            className="flex min-w-0 shrink items-baseline gap-1.5"
          >
            <button
              type="button"
              title={issue.title}
              onClick={() => onGo(issue.id)}
              className="min-w-0 cursor-pointer truncate text-muted-foreground hover:text-foreground hover:underline"
            >
              {issue.title}
            </button>
            <span className="shrink-0 text-muted-foreground">/</span>
          </span>
        ))}
        {/* The epic's id and title: hovering or clicking them opens its
            card. No tooltip on the title: the card says more. */}
        <div
          ref={card.root}
          className="min-w-0 flex-1"
          onMouseEnter={card.onEnter}
          onMouseLeave={card.onLeave}
        >
          <button
            ref={card.trigger}
            type="button"
            aria-expanded={card.open}
            aria-label={`Epic ${epic.id}: ${epic.title}`}
            onClick={card.onClick}
            className="flex w-full min-w-0 cursor-pointer items-baseline gap-1.5 rounded text-left"
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {epic.id}
            </span>
            <span className="min-w-0 truncate font-medium">{epic.title}</span>
          </button>
          {card.open ? (
            <IssueCard
              card={card}
              heading="Epic"
              issue={epic}
              parent={parent}
              subIssues={subIssues}
            />
          ) : null}
        </div>
      </div>
      {/* Everything under the epic is closed: nothing is left to do here
          but close the epic itself (bead-bb-ty5.1). It asks first. */}
      {onClose === undefined ? null : (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2"
          tip="Every issue in this epic is closed. Close the epic itself."
          onClick={onClose}
        >
          <Icon name="CircleCheck" className="size-4" />
          Close epic
        </Button>
      )}
    </div>
  );
}
