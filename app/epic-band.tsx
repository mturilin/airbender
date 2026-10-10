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
// - EpicReturn, further down, is the same place on the whole list: one line
//   that goes back into the epic last left.
//
// Naming: the product calls this "epic mode", and that is the only name the
// user sees. In the code it is "focus" throughout (the focused epic,
// focusBlock, actions.focus, the hook in use-focus.ts): the same thing, named
// before the product's word was settled. Read "focus" here as "epic mode".
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
// - The icons are Tabler Icons' "arrow-back-up" and "arrow-down-to-arc" (MIT, (c)
//   Pawel Kuna), copied in as their paths: BB's icon set has neither, and
//   the user asked for Tabler or Font Awesome over home-made drawings.

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
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
 * An arrow going down into an open ring: go into this epic. The icon for
 * entering epic mode, everywhere it can be entered (the user's choice,
 * bead-bb-0ai, after a magnifier with a plus was used first). Tabler Icons'
 * "arrow-down-to-arc". Not a target, which is the icon for making an issue
 * current.
 */
export function EnterEpicIcon({ className }: { className?: string }) {
  return (
    <svg {...STROKE} className={className}>
      <path d="M12 3v12" />
      <path d="M16 11l-4 4l-4 -4" />
      <path d="M3 12a9 9 0 0 0 18 0" />
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
  merging = false,
  autopilot,
}: {
  path: Issue[];
  subIssues: Issue[];
  onGo: (beadId: string | null) => void;
  /**
   * Given when the epic is finished (every issue under it closed): the
   * band then offers to close it, and this is called on a press.
   */
  onClose?: () => void;
  /**
   * The epic's issues were worked on a branch of its own (bead-bb-ty5.2):
   * closing it also merges that branch, and the button says so.
   */
  merging?: boolean;
  /**
   * Autopilot for this epic in this conversation (bead-bb-8ff); left out
   * where there is none to offer (no conversation, the simple workflow).
   * `note` is the one line under the band: what the run is doing or
   * waiting for, or why it stopped; null for nothing to say.
   */
  autopilot?: { on: boolean; note: string | null; onToggle: () => void };
}) {
  const card = useHoverCard("below");
  const epic = path[path.length - 1]!;
  const above = path.slice(0, -1);
  const parent = above[above.length - 1] ?? null;
  return (
    <div className="rounded-lg bg-foreground/[0.05]">
    <div className="flex items-center gap-1.5 py-1 pl-1 pr-2">
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
          tip={
            merging
              ? "Every issue in this epic is closed. The agent merges the epic's branch into the main one, and the epic closes."
              : "Every issue in this epic is closed. Close the epic itself."
          }
          onClick={onClose}
        >
          <Icon name="CircleCheck" className="size-4" />
          {merging ? "Close & merge" : "Close epic"}
        </Button>
      )}
      {/* Autopilot: the epic's issues are started one after another, each
          review still the owner's. A switch, lit while it is on. */}
      {autopilot === undefined ? null : (
        // A switch, not a button (the user's choice, bead-bb-ty5.3): on
        // or off is a state, and as a bordered button beside a bordered
        // tag it made the band look like a row of buttons. Drawn by hand:
        // a pill with a knob, the whole of it, word included, one target.
        <Tip
          label={
            autopilot.on
              ? "Autopilot is on: when an issue of this epic is closed, the next ready one starts by itself. Every review is still yours. Click to turn it off; the agent finishes what it is doing."
              : "Autopilot: start this epic's ready issues one after another, most urgent first. Every review stays yours, and it stops and says so if an issue gets stuck."
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={autopilot.on}
            onClick={autopilot.onToggle}
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm"
          >
            Autopilot
            <span
              aria-hidden="true"
              className={cn(
                "relative h-4 w-7 rounded-full transition-colors",
                autopilot.on ? "bg-blue-500" : "bg-foreground/25",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-[left]",
                  autopilot.on ? "left-3.5" : "left-0.5",
                )}
              />
            </span>
          </button>
        </Tip>
      )}
    </div>
      {autopilot === undefined || autopilot.note === null ? null : (
        <div className="px-2 pb-1.5 pl-9 text-xs text-muted-foreground">
          {autopilot.note}
        </div>
      )}
    </div>
  );
}

/**
 * The way back into the epic that was last left: one quiet line in the
 * band's place while the tab is on the whole list (bead-bb-fmg: "return to
 * epic mode button - when you exited temporarily and want to go back
 * without scanning all epics").
 *
 * Quieter than the band itself, with no fill: it is an offer, not where
 * the tab is. A small cross dismisses it.
 *
 * @param blocked Why epic mode cannot be entered on it right now (the
 *   conversation's current issue is from outside it); null when it can.
 *   The line is then greyed out and says so in its tooltip.
 * @param onReturn Called on a press, when not blocked.
 * @param onForget Called by the cross.
 */
export function EpicReturn({
  epic,
  blocked,
  onReturn,
  onForget,
}: {
  epic: Issue;
  blocked: string | null;
  onReturn: () => void;
  onForget: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        // Greyed out by hand, not `disabled`, so the tooltip with the
        // reason still shows; a press then does nothing. The pointer stays
        // the plain arrow (see the same button in IssueRow).
        className={
          "h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground" +
          (blocked === null ? "" : " cursor-default opacity-40 hover:bg-transparent")
        }
        aria-disabled={blocked !== null}
        tip={blocked ?? `Back into epic mode on ${epic.id}`}
        onClick={() => {
          if (blocked === null) onReturn();
        }}
      >
        <EnterEpicIcon className="size-4 shrink-0" />
        {/* The words, the id and the title share one baseline. The id is
            in the monospace font, whose letters sit at a different height
            in their line: centred box against box, as a button lays its
            content out, it rode visibly off the line of the words beside
            it (the user's screenshot). So the text parts are a row of
            their own, lined up on the baseline, and only the icon is
            centred against that row. The rule is in the spec. */}
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0">Back to epic</span>
          {/* Exactly on the baseline, and left there. It can look as if it
              rides high: a one-pixel nudge down was tried at the user's
              request and taken back by them ("it was okay before - just
              visual illusion"). */}
          <span className="shrink-0 font-mono">{epic.id}</span>
          <span className="min-w-0 truncate text-foreground">{epic.title}</span>
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground"
        tip="Forget this epic: stop offering the way back"
        aria-label={`Stop offering the way back to ${epic.id}`}
        onClick={onForget}
      >
        <Icon name="X" className="size-3.5" />
      </Button>
    </div>
  );
}
