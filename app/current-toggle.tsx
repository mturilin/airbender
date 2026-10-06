// app/current-toggle.tsx — making an issue the thread's current one, or not.
//
// What: the target button on an issue that makes it the thread's current
// issue or releases it, and the confirmation shown when that would replace
// another current issue.
//
// Why: which issue a thread is on, and doing the next step of an issue's
// workflow, are two different things (bead-bb-l3m). Before this the only way
// to make an issue current was its workflow button, which also starts the
// agent. The user's words: "Just making a thing current doesn't mean we need
// to move through the workflow. I just wanna move it to current and out of
// current."
//
// Design notes:
// - One button, two states, and two clearly different icons that show what
//   pressing will do, as the words beside them do: a target on an issue
//   that is not current ("aim at this"), an exit door on the issue that is
//   ("leave this"). Tried before and found "the same - too confusing" by
//   the user: a target with its centre filled for the current issue; then a
//   target struck through. The exit door was the user's idea.
// - The door is the "door-exit" icon of Tabler Icons (the user asked for
//   Tabler or Font Awesome instead of a home-made drawing), copied in as
//   its four paths. Tabler Icons is MIT licensed (c) Pawel Kuna. Copied,
//   not installed: one icon does not justify a package, and it is drawn
//   with the same stroke as the target so the two match.
// - It moves no workflow step. The backend tells the agent with a short
//   note, so the agent and the status line above the message box agree.
// - Confirmation only when another issue is current and would be replaced
//   (the user's decision). Making an issue current when there is none, and
//   releasing one, are one click to undo and are not asked about.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import { useActions } from "./actions.ts";

/**
 * The icon for the current-issue button: a target when pressing makes the
 * issue current, an exit door when pressing releases it (`on`).
 *
 * Drawn here because BB's icon set has neither (checked in its bundle), and
 * an unknown name would show BB's fallback icon. The door's paths are
 * Tabler Icons' "door-exit", unchanged (see the design notes).
 */
export function CurrentIcon({ on, className }: { on: boolean; className?: string }) {
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
      {on ? (
        <>
          <path d="M13 12v.01" />
          <path d="M3 21h18" />
          <path d="M5 21v-16a2 2 0 0 1 2 -2h7.5m2.5 10.5v7.5" />
          <path d="M14 7h7m-3 -3l3 3l-3 3" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </>
      )}
    </svg>
  );
}

/**
 * The target button for one issue.
 *
 * Draws nothing where there is no thread (nothing can be current there) and
 * on a closed issue (a closed issue is never current).
 *
 * @param withLabel Show words beside the icon ("Make current", "Release"),
 *   for the opened issue's row of small text buttons. On a row it is the
 *   icon alone.
 * @param className Extra classes, for the row's spacing.
 */
export function CurrentToggle({
  issue,
  withLabel = false,
  className,
}: {
  issue: Issue;
  withLabel?: boolean;
  className?: string;
}) {
  const actions = useActions();
  const { setCurrent, makeCurrent } = actions;
  if (setCurrent === null || makeCurrent === null) return null;
  if (issue.status === CLOSED_STATUS) return null;
  const on = actions.currentBeadId === issue.id;
  const tip = on
    ? "This is the current issue. Press to stop treating it as current; its workflow is not touched."
    : "Make this the current issue. It does not start the agent or move the issue's workflow.";
  const toggle = () => (on ? setCurrent(null) : makeCurrent(issue.id));
  if (withLabel) {
    return (
      <Button
        variant="outline"
        size="sm"
        aria-pressed={on}
        className={className}
        tip={tip}
        onClick={toggle}
      >
        <CurrentIcon on={on} className="size-4" />
        {on ? "Release" : "Make current"}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-pressed={on}
      className={cn(
        "size-7 shrink-0",
        on ? "text-foreground" : "text-muted-foreground",
        className,
      )}
      tip={tip}
      aria-label={
        on
          ? `Stop treating ${issue.id} as the current issue`
          : `Make ${issue.id} the current issue`
      }
      onClick={toggle}
    >
      <CurrentIcon on={on} className="size-4" />
    </Button>
  );
}

/**
 * "Switch the current issue?": asked before one current issue is replaced
 * by another.
 *
 * @param from The issue that is current now; null when it is not in the
 *   list any more (its id is then all that is known, and it is not named).
 * @param to The issue to make current; null keeps the dialog shut.
 * @param onConfirm Called when the user agrees; `onCancel` is called
 *   afterwards as well, to shut the dialog.
 */
export function SwitchDialog({
  from,
  to,
  onConfirm,
  onCancel,
}: {
  from: Issue | null;
  to: Issue | null;
  onConfirm: (to: Issue) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={to !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch the current issue?</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{to?.id}</span> {to?.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {/* Worded as what will happen: nothing has changed while this
              is on screen (the user's correction). */}
          {from === null
            ? "This conversation has another current issue now. "
            : `This conversation is on ${from.id} now: ${from.title}. `}
          If you switch, {to?.id} will become its current issue instead and
          the agent will be told. No work will be started and no issue's
          workflow will be moved.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onCancel()}>
            Keep it
          </Button>
          <Button
            onClick={() => {
              if (to !== null) onConfirm(to);
              onCancel();
            }}
          >
            Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
