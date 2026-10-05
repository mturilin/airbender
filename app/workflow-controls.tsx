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
// - A move that needs a reason (send back, skip) is not made on the click:
//   the opened issue shows a small field for the reason first (NoteForm).

import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tip";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { workflow } from "../shared/current-workflow.ts";
import { movesFor, stateOf } from "../shared/workflow.ts";
import type { WorkflowMove } from "../shared/workflow.ts";
import { useActions } from "./actions.ts";
import type { IssueActions } from "./actions.ts";
import { RobotIcon } from "./bits.tsx";

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
 * A little more prominent than the tags beside it, and no more: the same
 * outlined shape, with darker text in medium weight. (A filled, inverted
 * pill on the title line was tried and the user found it far too loud.)
 *
 * The icon says whose move it is, which is what the user wants to see at a
 * glance: a person where the step waits for them, a robot where the next
 * step is the agent's.
 */
export function StateTag({ issue }: { issue: Issue }) {
  if (issue.status === CLOSED_STATUS) return null;
  const state = stateOf(workflow, issue.step);
  const human = state.actor === "user";
  return (
    <Tip
      label={`${human ? "Waiting for you" : "The agent's step"}: ${state.hint}`}
    >
      <span className="flex shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded border border-foreground/30 px-1.5 py-px text-[11px] font-medium leading-4 text-foreground">
        {human ? (
          <Icon name="UserRound" className="size-3" />
        ) : (
          <RobotIcon className="size-3" />
        )}
        {state.label}
      </span>
    </Tip>
  );
}

/**
 * The main button for an issue's step: at one of the agent's steps it gets
 * the agent going ("Define", "Plan", "Implement"…); at one of the user's it
 * is the user's main move ("Approve plan", "Accept & commit").
 *
 * Draws nothing when the buttons are not offered on this issue (see
 * canAct), when the step is the agent's and there is no thread to run it
 * in, or when the user's step has no main move.
 *
 * @param className Extra classes, for the row's spacing.
 */
export function WorkflowButton({
  issue,
  className,
}: {
  issue: Issue;
  className?: string;
}) {
  const actions = useActions();
  if (!canAct(actions, issue)) return null;
  const state = stateOf(workflow, issue.step);
  if (state.actor === "agent") {
    const { run } = actions;
    if (run === null) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        className={className}
        tip={`${state.hint} Starts the agent on this step and makes this the current issue.`}
        aria-label={`${state.runLabel}: ${issue.id} ${issue.title}`}
        onClick={() => run(issue.id)}
      >
        <Icon name="Play" className="size-4" />
        {state.runLabel}
      </Button>
    );
  }
  const main = movesFor(workflow, state.id, "user").find(
    (move) => move.primary === true,
  );
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
      <Icon name="CircleCheck" className="size-4" />
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
  if (!canAct(actions, issue)) return null;
  const state = stateOf(workflow, issue.step);
  return (
    <>
      {movesFor(workflow, state.id, "user")
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
