// app/current-toggle.tsx — making an issue the thread's current one, or not.
//
// What: the current-issue control and switch confirmation. Simple offers
// Start or Finish; Standard offers Make current or Unselect.
//
// Why: which issue a thread is on, and doing the next step of an issue's
// workflow, are two different things (bead-bb-l3m). Before this the only way
// to make an issue current was its workflow button, which also starts the
// agent. The user's words: "Just making a thing current doesn't mean we need
// to move through the workflow. I just wanna move it to current and out of
// current."
//
// Design notes:
// - The user chose a target for selection and a crossed target for Unselect
//   (bead-bb-o6j). The latter clears selection only. On Simple it belongs
//   in the menu; the prominent current-issue action is Finish instead.
// - Finish opens the existing ending/Git dialog. It never unselects or
//   closes directly. Start asks the agent to work without moving a step.
// - Confirmation only when another issue is current and would be replaced
//   (the user's decision). Making an issue current when there is none, and
//   releasing one, are one click to undo and are not asked about.

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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
import { useWorkflow } from "./workflow-controls.tsx";

/**
 * The icon for the current-issue button: a target when pressing makes the
 * issue current, a crossed target when pressing unselects it (`on`).
 * Both share the same target geometry; the slash marks clearing selection.
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
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
      {on ? <path d="M3 3l18 18" /> : null}
    </svg>
  );
}

/**
 * The main current-issue control: Simple Start/Finish, Standard selection.
 *
 * Draws nothing where there is no thread (nothing can be current there) and
 * on a closed issue (a closed issue is never current).
 *
 * @param withLabel Show the action's words beside its icon,
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
  const simple = useWorkflow() === null;
  const { setCurrent, makeCurrent } = actions;
  if (setCurrent === null || makeCurrent === null) return null;
  if (issue.status === CLOSED_STATUS) return null;
  const on = actions.currentBeadId === issue.id;
  if (simple && on) {
    return (
      <Button
        variant="outline"
        size={withLabel ? "sm" : "icon"}
        className={className}
        tip="Finish this issue: choose how it ended and what to do with its Git work."
        aria-label={`Finish ${issue.id}`}
        onClick={() => actions.close(issue.id)}
      >
        <Icon name="Check" className="size-4" />
        {withLabel ? "Finish" : null}
      </Button>
    );
  }
  const tip = on
    ? "Unselect this issue. It stays open and its workflow is not touched."
    : simple ? "Start the agent on this issue." : "Make this the current issue. It does not start the agent or move the issue's workflow.";
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
        {on ? "Unselect" : simple ? "Start" : "Make current"}
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
          ? `Unselect ${issue.id}`
          : simple ? `Start ${issue.id}` : `Make ${issue.id} the current issue`
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
  simple = false,
}: {
  from: Issue | null;
  to: Issue | null;
  onConfirm: (to: Issue) => void;
  onCancel: () => void;
  simple?: boolean;
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
          {simple
            ? `If you switch, ${to?.id} becomes current and the agent starts working on it.`
            : `If you switch, ${to?.id} becomes current and the agent is told. No work is started and no workflow step is moved.`}
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
