// app/workflow-controls.tsx — an issue's workflow, as the tab shows it.
//
// What: the tag that says which step an issue is at, and the buttons for
// what can be done about it there: get the agent going on its step, or make
// one of the user's moves (approve, send back, skip, accept).
//
// Why: every issue goes through a workflow to be closed (bead-bb-e2b).
// Before this, "Define" was a special button, play always started from the
// beginning, and finishing was a third, separate button. Now there is one
// place that asks the workflow what the issue's step offers and draws it.
//
// Design notes:
// - Nothing here names a step. Labels, hints and which moves exist all come
//   from the workflow (shared/workflow.ts); a different workflow would draw
//   different buttons with no change to this file.
// - The buttons are offered on the thread's current issue, or on any open
//   issue while the thread has none. With an issue already chosen, a stray
//   click elsewhere would redirect an agent mid-task; that rule was the play
//   button's and is kept.
// - Which workflow is in force comes from the repository's choice, handed
//   down by WorkflowProvider. On the simple workflow there is none, and
//   everything in this file draws nothing (bead-bb-8j6).
// - An issue's size (S, M, L: how many of the steps it takes) is shown
//   here too, once it has one: a small dropdown beside the step, where the
//   user corrects the agent's choice (bead-bb-4mb). An issue nobody has
//   sized shows nothing (the user: "If it's not there, I'm not showing");
//   it can be given one from the row's menu or inside the opened issue.
// - A move that needs a reason (send back, skip) is not made on the click:
//   the opened issue shows a small field for the reason first (NoteForm).

import { createContext, useContext, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import {
  menuMoves,
  nextWorkOf,
  offeredMoves,
  stateOf,
} from "../shared/workflow.ts";
import type {
  Workflow,
  WorkflowMove,
  WorkflowState,
} from "../shared/workflow.ts";
import { useActions } from "./actions.ts";
import type { IssueActions } from "./actions.ts";
import { PersonIcon, RobotIcon, TAG_SELECT_CLASS, Tag } from "./bits.tsx";

/** The workflow of the repository being shown; null when it has none. */
const WorkflowContext = createContext<Workflow | null>(null);

/**
 * Hands the repository's workflow to everything drawn inside it: the tab's
 * rows and the message box's status line each wrap their content in one.
 * A context of its own, apart from the row actions, because the status
 * line's card draws an issue's facts where there are no row actions.
 */
export const WorkflowProvider = WorkflowContext.Provider;

/**
 * The workflow in force where this component is drawn.
 *
 * @returns Null on the simple workflow, which has no steps, and outside any
 *   WorkflowProvider.
 */
export function useWorkflow(): Workflow | null {
  return useContext(WorkflowContext);
}

/**
 * Whether the workflow buttons are offered on an issue: it is open, and it
 * is the thread's current issue or the thread has none.
 */
function canAct(actions: IssueActions, issue: Issue): boolean {
  return (
    issue.status !== CLOSED_STATUS &&
    (actions.currentBeadId === null || actions.currentBeadId === issue.id)
  );
}

/**
 * The step an open issue is at, as a tag. Nothing for a closed issue, whose
 * step no longer matters.
 *
 * A little more prominent than the facts beside it, and no more. What was
 * tried on the way here: a filled, inverted pill on the title line (far too
 * loud), an outlined tag (looked like a button), plain text (too weak, and
 * it ran into the id). The user settled on a light blue fill, in this spot.
 *
 * The icon says whose move it is, which is what the user wants to see at a
 * glance: a person where the step waits for them, a robot where the next
 * step is the agent's. A new issue counts as the agent's: it waits for the
 * user only to say "go", and what follows is the agent's work.
 */
export function StateTag({ issue }: { issue: Issue }) {
  const workflow = useWorkflow();
  if (workflow === null || issue.status === CLOSED_STATUS) return null;
  const state = stateOf(workflow, issue.step);
  const human = nextWorkOf(state) === "user";
  return (
    <Tip
      label={`${human ? "Needs you" : "The agent's work"}: ${state.hint}`}
    >
      {/* A plain inline span for the tooltip to attach to: the chip takes
          no ref, and anything but plain inline text would upset the line
          (see StateChip). */}
      <span className="shrink-0 cursor-default">
        <StateChip state={state} />
      </span>
    </Tip>
  );
}

/**
 * The chip itself: the step's name on a light blue fill, with the icon for
 * whose work is next. Shared by the tag on an issue (StateTag) and the
 * status line above the message box, so a step looks the same in both.
 *
 * A light blue fill and no outline (the user's choice): the fill sets it
 * apart from the id beside it, and without an outline it is not taken for
 * one of the dropdowns. The blue is a tint over whatever is behind it, so
 * it works in light and dark themes. Same box as the tags beside it (an
 * invisible border makes up the height), and plain inline text, not a flex
 * box: an issue's facts are lined up on their text's baseline, and a flex
 * box would offer the icon's bottom edge as its baseline.
 */
export function StateChip({ state }: { state: WorkflowState }) {
  const human = nextWorkOf(state) === "user";
  return (
    <span className="shrink-0 whitespace-nowrap rounded border border-transparent bg-blue-500/15 px-1.5 py-px text-[11px] font-medium leading-4 text-foreground">
      {human ? (
        <PersonIcon className="mr-1 inline-block size-3 align-[-1.5px]" />
      ) : (
        <RobotIcon className="mr-1 inline-block size-3 align-[-1.5px]" />
      )}
      {state.label}
    </span>
  );
}

/** The offered moves, plus any the workflow wants reachable regardless. */
function withMenuMoves(
  offered: WorkflowMove[],
  always: WorkflowMove[],
): WorkflowMove[] {
  return [
    ...offered,
    ...always.filter((move) => !offered.some((other) => other.id === move.id)),
  ];
}

/**
 * The moves an issue's menu lists: the ones its workflow marks for the
 * menu, at the step it is at. None where the step's buttons are not offered
 * on this issue (see canAct), on a closed issue, or without a workflow.
 */
export function useMenuMoves(issue: Issue): WorkflowMove[] {
  const actions = useActions();
  const workflow = useWorkflow();
  if (workflow === null || !canAct(actions, issue)) return [];
  return menuMoves(workflow, stateOf(workflow, issue.step).id, "user");
}

/**
 * The icon a move is drawn with on a row, by the name the workflow gives.
 *
 * Both are drawn here, from one triangle, so that the pair matches: "play"
 * is Tabler Icons' "player-play" outline (MIT, (c) Pawel Kuna), and
 * "play-branch" is that same triangle at three quarters of its size with,
 * beside it, two dots joined by a line and a small arrow going off. The
 * second is the drawing the user chose (of three) for "start in a new
 * branch": "both icons should have a play button, but the one with branch
 * will have also two dots and small arrow". No icon set has it.
 *
 * The first version took "play" from BB's own icons and drew only the
 * second; the user saw at once that the two triangles were in different
 * hands. A name this does not know gets the plain triangle.
 */
export function MoveIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
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
      {name === "play-branch" ? (
        <>
          {/* The triangle below, scaled by 0.75 and moved to the left. */}
          <path d="M2.5 6v12l9.75 -6l-9.75 -6" />
          <circle cx="16" cy="19" r="1.7" />
          <circle cx="16" cy="5" r="1.7" />
          <path d="M16 6.7v10.6" />
          <path d="M17.7 19h1.3a2 2 0 0 0 2 -2v-5" />
          <path d="M18.8 13.6l2.2 -2.2l2.2 2.2" />
        </>
      ) : (
        <path d="M7 4v16l13 -8l-13 -8" />
      )}
    </svg>
  );
}

/**
 * Whether the user may set or change an issue's size now: the repository's
 * workflow has sizes, the issue is open, and the workflow still allows it
 * at the issue's step (until the work reaches the user for review).
 */
export function useCanResize(issue: Issue): boolean {
  const workflow = useWorkflow();
  return (
    workflow !== null &&
    workflow.sizes !== undefined &&
    issue.status !== CLOSED_STATUS &&
    workflow.canResize?.(stateOf(workflow, issue.step).id) === true
  );
}

/**
 * An issue's size, beside its step. Nothing for an issue without a size,
 * for a closed one, and where the workflow has no sizes.
 *
 * A dropdown while the size may still be changed and `onChange` is given;
 * a plain tag otherwise. Changing it tells the agent to take the new
 * size's path (the backend does that).
 *
 * @param onChange Called with the new size id.
 */
export function SizeTag({
  issue,
  onChange,
}: {
  issue: Issue;
  onChange?: (size: string) => void;
}) {
  const workflow = useWorkflow();
  const canResize = useCanResize(issue);
  const sizes = workflow?.sizes;
  if (sizes === undefined || issue.status === CLOSED_STATUS) return null;
  const current = sizes.find((size) => size.id === issue.size);
  // No size, or one this workflow does not know (written by hand).
  if (current === undefined) return null;
  if (onChange === undefined || !canResize) {
    return (
      <Tip label={`Size ${current.label}. ${current.hint}`}>
        <span className="shrink-0 cursor-default">
          <Tag>{current.label}</Tag>
        </span>
      </Tip>
    );
  }
  return (
    <select
      aria-label={`Size of ${issue.id}`}
      // A plain title, not the app's tooltip: a tooltip over a dropdown
      // covers its own list.
      title={`Size: how much of the workflow this issue takes. ${sizes
        .map((size) => `${size.label}: ${size.hint}`)
        .join(" ")}`}
      value={current.id}
      onChange={(event) => onChange(event.target.value)}
      className={`${TAG_SELECT_CLASS} font-medium text-muted-foreground`}
    >
      {sizes.map((size) => (
        <option key={size.id} value={size.id}>
          {size.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The main button for an issue's step: at one of the agent's steps it gets
 * the agent going ("Define", "Plan", "Implement"…); at one of the user's it
 * is the user's main move ("Approve plan", "Accept").
 *
 * Draws nothing when the buttons are not offered on this issue (see
 * canAct), when the step is the agent's and there is no thread to run it
 * in, or when the user's step has no main move.
 *
 * Where the step's moves have icons and `icons` is set, they are drawn as
 * a group of icon buttons instead: at a step that has not started, the two
 * ways to start (bead-bb-jqn.1).
 *
 * @param className Extra classes, for the row's spacing.
 */
export function WorkflowButton({
  issue,
  className,
  icons = false,
  groupClassName,
}: {
  issue: Issue;
  className?: string;
  /**
   * Draw moves that have an icon as icon buttons, without words. For a
   * row; the opened issue keeps words on its buttons.
   */
  icons?: boolean;
  /** Extra classes for that group of icon buttons: its place on the row. */
  groupClassName?: string;
}) {
  const actions = useActions();
  const workflow = useWorkflow();
  if (workflow === null || !canAct(actions, issue)) return null;
  const state = stateOf(workflow, issue.step);
  if (state.actor === "agent") {
    const { run } = actions;
    if (run === null) return null;
    const { runLabel } = state;
    return (
      <Button
        variant="outline"
        size="sm"
        className={className}
        tip={`${state.hint} Starts the agent on this step and makes this the current issue.`}
        aria-label={`${runLabel}: ${issue.id} ${issue.title}`}
        onClick={() => run(issue.id)}
      >
        <Icon name="Play" className="size-4" />
        {runLabel}
      </Button>
    );
  }
  const offered = offeredMoves(workflow, state.id, "user", {
    ownBranch: actions.ownBranch,
  });
  // Moves the workflow wants drawn without words (the two ways to start an
  // issue): on a row they are a small group of icon buttons, set apart by a
  // soft fill from the row's other icons, each with its hint as a tooltip.
  const drawn = icons ? offered.filter((move) => move.icon !== undefined) : [];
  if (drawn.length > 0) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 overflow-hidden rounded-md bg-foreground/[0.06]",
          groupClassName,
        )}
      >
        {drawn.map((move, index) => (
          <Button
            key={move.id}
            variant="ghost"
            size="icon"
            className={cn(
              "h-6 w-7 rounded-none text-muted-foreground hover:bg-foreground/[0.12] hover:text-foreground",
              index > 0 && "border-l border-border/60",
            )}
            tip={`${move.label}. ${move.hint}`}
            aria-label={`${move.label}: ${issue.id} ${issue.title}`}
            onClick={() => actions.move(issue.id, move.id, "")}
          >
            <MoveIcon name={move.icon!} className="size-4" />
          </Button>
        ))}
      </span>
    );
  }
  const main = offered.find((move) => move.primary === true);
  if (main === undefined) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      tip={main.hint}
      aria-label={`${main.label}: ${issue.id} ${issue.title}`}
      onClick={() => actions.move(issue.id, main.id, "")}
    >
      {/* A tick for an approval; play where the move only sets the agent
          going (a new issue's "Define"). */}
      <Icon
        name={nextWorkOf(state) === "agent" ? "Play" : "CircleCheck"}
        className="size-4"
      />
      {main.label}
    </Button>
  );
}

/**
 * The user's other moves at an issue's step, for the opened issue's row of
 * buttons: "Send back", "Skip", "Mark as done".
 *
 * A move that needs a reason calls `onNeedNote`, so the opened issue can
 * show the field for it; the others are made on the click.
 *
 * Returns the buttons with no wrapper, because the opened issue styles its
 * buttons as direct children of its row.
 */
export function WorkflowMoves({
  issue,
  onNeedNote,
}: {
  issue: Issue;
  onNeedNote: (move: WorkflowMove) => void;
}) {
  const actions = useActions();
  const workflow = useWorkflow();
  if (workflow === null || !canAct(actions, issue)) return null;
  const state = stateOf(workflow, issue.step);
  return (
    <>
      {withMenuMoves(
        offeredMoves(workflow, state.id, "user", {
          ownBranch: actions.ownBranch,
        }),
        menuMoves(workflow, state.id, "user"),
      )
        .filter((move) => move.primary !== true)
        .map((move) => (
          <Button
            key={move.id}
            variant="outline"
            size="sm"
            tip={move.hint}
            onClick={() =>
              move.needsNote === true
                ? onNeedNote(move)
                : actions.move(issue.id, move.id, "")
            }
          >
            {move.label}
          </Button>
        ))}
    </>
  );
}

/**
 * The field for the reason a move needs ("Send back": what is wrong;
 * "Skip": why it is not needed). Enter or the button makes the move; Escape
 * or Cancel drops it. The reason is recorded on the issue and, when the
 * issue goes back to the agent, passed on to it.
 */
export function NoteForm({
  issue,
  move,
  onDone,
}: {
  issue: Issue;
  move: WorkflowMove;
  /** Called after the move was asked for, or cancelled. */
  onDone: () => void;
}) {
  const actions = useActions();
  const [note, setNote] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim() === "") return;
    actions.move(issue.id, move.id, note.trim());
    onDone();
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-1 rounded-lg border border-border p-2"
    >
      <div className="px-1 text-xs text-muted-foreground">{move.hint}</div>
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onDone();
            }
          }}
          placeholder="Why?"
          aria-label={`Reason for "${move.label}" on ${issue.id}`}
        />
        <Button type="submit" size="sm" disabled={note.trim() === ""}>
          {move.label}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
