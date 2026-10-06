// app/composer.tsx — controls in a thread's message box.
//
// What: the controls around a thread's message box. Above it, one line: the
// step the current issue is at, its id, and what is asked now; hovering it
// opens the issue's card. Inside it: the current step's buttons as text,
// and the "Agree & continue" icon.
//
// Why: the user reads the agent's work in the chat, so the state of that
// work and the decision about it belong there, not only in the side panel
// (bead-bb-3l4, bead-bb-eg0).
//
// Design notes:
// - The step button makes the real workflow move. Its wording comes from
//   the workflow in shared/; nothing here names a step.
// - "Agree & continue" is sent by the backend, not through the message box,
//   so whatever the user has typed there is left alone.
// - The line above the box and the step buttons each load the issue list for the
//   thread (useIssues), as the tab does. Three loads per change is more than
//   needed; sharing one would mean a store outside React, not worth it yet.
//
// Gotchas:
// - Anything that must show outside the message box (the card) has to be drawn
//   at the top level of the page with usePortalScopeProps: BB cuts off what
//   sticks out of the box.

import {
  Markdown,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { Issue, rpcContract } from "../server/contract.ts";
import { CLOSED_STATUS, QUICK_REPLIES } from "../shared/constants.ts";
import { IssueFacts } from "./issue-facts.tsx";
import { formatWhen } from "./issue-model.ts";
import { useMenu } from "./menus.tsx";
import { useIssues } from "./use-issues.ts";
import {
  CLOSED,
  offeredMoves,
  nextWorkOf,
  stateOf,
} from "../shared/workflow.ts";
import { DEFAULT_WORKFLOW_ID, workflowFor } from "../shared/workflows.ts";
import { StateChip, WorkflowProvider } from "./workflow-controls.tsx";

/** How long the pointer must rest on the status line before its card opens. */
const HOVER_OPEN_MS = 100;

/** How long a hover-opened card stays after the pointer leaves it. */
const HOVER_CLOSE_MS = 300;

/**
 * The thread a message-box control belongs to, or null when the message box
 * is not a thread's own (a queued-message editor, a side chat, the New
 * thread screen). The controls below draw nothing in that case.
 */
function useComposerThreadId(): string | null {
  const { scope } = useComposer();
  return scope.kind === "thread" ? scope.threadId : null;
}

/**
 * One quick-reply button in the message box (bead-bb-lit): a click sends the
 * thread's agent a fixed reply, so the user does not have to type "yes, go
 * ahead" after every plan.
 *
 * The message goes through server.ts, not through the message box, so text
 * the user has typed there stays untouched. Disabled while there is text
 * in the message box, and while the agent is
 * working or a send is under way: a go-ahead queued behind a running turn
 * would answer a question the agent has not asked yet.
 *
 * An icon with a tooltip, not a text button: the user asked for that, to
 * keep the message box's row quiet. The tooltip names the button and shows
 * the exact message, since an icon alone cannot say what will be sent.
 *
 * Side effects: one RPC per click, which sends a message to the thread; a
 * toast if that fails.
 */
export function QuickReplyButton({
  kind,
  label,
  icon,
}: {
  kind: keyof typeof QUICK_REPLIES;
  /** The button's name, for the tooltip and for screen readers. */
  label: string;
  /** A BB icon name; an unknown one shows BB's fallback icon. */
  icon: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const threadId = useComposerThreadId();
  const { run, draft } = useComposerView();
  const [sending, setSending] = useState(false);
  // With something typed (or attached), the user is writing their own
  // answer; a quick reply would go out beside it and contradict it. The
  // user asked for the buttons to be off then.
  const typing = !draft.isEmpty || draft.attachmentCount > 0;
  if (threadId === null) return null;
  return (
    <Button
      // A gray filled square button (the user's request: gray like BB's own
      // send button, and square, not round).
      variant="secondary"
      size="icon"
      className="size-8 shrink-0 rounded-md bg-foreground/10 text-foreground hover:bg-foreground/20"
      aria-label={label}
      tip={`${label}: sends "${QUICK_REPLIES[kind]}"`}
      disabled={sending || typing || run.isRunning || run.isSubmitting}
      onClick={() => {
        setSending(true);
        rpc
          .call("thread_reply", { threadId, kind })
          .catch((cause: unknown) =>
            toast.error(
              `Could not send: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          )
          .finally(() => setSending(false));
      }}
    >
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

/**
 * The one line above the message box, for the thread's current issue: the
 * step it is at, on the same blue chip as in the side panel; its id; and the
 * workflow's friendly sentence saying what is asked now ("Please review the
 * results and give feedback."), stronger when it is the user's turn.
 *
 * Hovering anywhere on the line opens a card with the issue's details
 * almost at once (CurrentIssueCard); so does a click.
 *
 * How it got here, so the same ground is not covered again: a pill with the
 * title inside the box; a line above the box with the title; two lines
 * above the box (the user found them ugly); the id as a pill inside the box
 * with this line above it; and finally, at the user's suggestion, the id on
 * this line, which they called the cleanest. The sentence could not go
 * where the user first wanted it, as the grey hint text of the empty
 * message box: BB gives a plugin no way to set that.
 *
 * Draws nothing when the thread has no current issue or the folder has no
 * beads. It follows changes through useIssues, the same loading and change
 * notifications the tab uses.
 *
 * Two ways of opening the card, two ways of closing it. Opened by a click,
 * it stays until a press outside it or Escape. Opened by hovering, it goes
 * away shortly after the pointer leaves both the line and the card.
 * Clicking while a hover-opened card is showing keeps it. The card opens
 * upwards, because the message box is at the bottom of the window.
 */
function StatusLine({ threadId }: { threadId: string }) {
  const { result } = useIssues({ threadId, projectId: null });
  const { open, setOpen, root, panel } = useMenu();
  // Where the card goes, in window coordinates, worked out from the line
  // when it is clicked. See CurrentIssueCard for why it is not simply
  // positioned against the line.
  const [place, setPlace] = useState<CSSProperties>({});
  const line = useRef<HTMLButtonElement>(null);
  // True while the card is open only because of hovering; a click clears it.
  const hoverOpened = useRef(false);
  // The pending "open after 2 s" and "close shortly after leaving" timers.
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  /** Works out where the card goes from where the line is right now. */
  const placeCard = () => {
    const box = line.current?.getBoundingClientRect();
    if (box === undefined) return;
    // Above the line, left edges together, but never off the right edge of
    // the window (the card is at most 24rem wide).
    const width = Math.min(384, window.innerWidth * 0.85);
    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - box.top + 8,
      // Never taller than the room above the line; it scrolls inside.
      maxHeight: Math.max(160, box.top - 16),
    });
  };
  /** The pointer came onto the line or the card. */
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
  /** The pointer left the line or the card. */
  const onLeave = () => {
    window.clearTimeout(openTimer.current);
    if (!hoverOpened.current) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      hoverOpened.current = false;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  // No timer may fire after the line is gone.
  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const issue =
    result?.state === "ok" && result.currentBeadId !== null
      ? (result.issues.find(
          (candidate) => candidate.id === result.currentBeadId,
        ) ?? null)
      : null;
  if (issue === null || result === null) return null;
  const issues = result.issues;
  // On the simple workflow there is no step: the line then names the issue
  // by its title instead of saying what the step asks for (bead-bb-8j6).
  const workflow = workflowFor(result.workflow);
  const state = workflow === null ? null : stateOf(workflow, issue.step);
  return (
    <WorkflowProvider value={workflow}>
    <div
      ref={root}
      className="relative min-w-0"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <Button
        ref={line}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        // No tooltip: the card opens almost at once on hover and says more.
        aria-label={`Current issue ${issue.id}: ${issue.title}`}
        // The whole line is the trigger: hovering anywhere on it opens the
        // card (the user's layout). Its three parts are lined up on the
        // baseline of their text, not on the middle of their boxes: the id
        // is in the monospace font, whose letters sit at a different height
        // in their line, and centred it rode visibly above the sentence.
        className="h-auto w-full items-baseline justify-start gap-1.5 px-2 py-1 text-left text-xs font-normal"
        onClick={() => {
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
        }}
      >
        {state === null ? null : <StateChip state={state} />}
        <span className="shrink-0 font-mono text-muted-foreground">
          {issue.id}
        </span>
        <span
          className={cn(
            // A little more room after the id than between the other parts.
            "ml-1.5 min-w-0 truncate",
            state !== null && nextWorkOf(state) === "user"
              ? "text-foreground"
              : "text-muted-foreground",
          )}
        >
          {state === null ? issue.title : state.ask}
        </span>
      </Button>
      {open ? (
        <CurrentIssueCard
          panel={panel}
          place={place}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          issue={issue}
          parent={
            issue.parentId === null
              ? null
              : (issues.find((other) => other.id === issue.parentId) ?? null)
          }
          subIssues={issues.filter((other) => other.parentId === issue.id)}
        />
      ) : null}
    </div>
    </WorkflowProvider>
  );
}

/**
 * The card the status line opens: what this thread is working on, at
 * a glance, without opening the Airbender tab.
 *
 * Top to bottom: a "Current issue" line with when it last changed; the
 * parent, when it is a sub-issue; the title; the id (click to copy) with
 * status, priority, type and category tags, drawn by the same IssueFacts
 * the tab uses so the two never disagree; the description as formatted
 * text; what "done" means, when the issue says; and its sub-issues with a
 * progress bar, closed ones struck through as in the tab.
 *
 * Read-only: changing the issue is the tab's job. Long text scrolls inside
 * its own block so the card keeps a bounded height above the message box.
 * It opens upwards because the message box sits at the bottom of the window.
 *
 * Drawn at the top level of the page (a portal), at a fixed place in the
 * window. The first version was positioned against its trigger, inside the
 * message box, and the user saw nothing happen on a click: BB's message box
 * cuts off whatever sticks out of it. Content moved out like this loses the
 * plugin's styles unless it carries usePortalScopeProps().
 *
 * @param panel Ref for the card's element, so useMenu knows a press inside
 *   the card is not a press "outside".
 * @param place Fixed position and height limit, from the line's position.
 * @param parent The issue this one is a sub-issue of, if any.
 * @param subIssues Direct sub-issues only, in the order the list gave them.
 */
function CurrentIssueCard({
  panel,
  place,
  onMouseEnter,
  onMouseLeave,
  issue,
  parent,
  subIssues,
}: {
  panel: React.RefObject<HTMLDivElement | null>;
  place: CSSProperties;
  /** Tell the line the pointer is on / off the card (hover-opened cards). */
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  issue: Issue;
  parent: Issue | null;
  subIssues: Issue[];
}) {
  const closed = subIssues.filter((sub) => sub.status === CLOSED_STATUS).length;
  const scopeProps = usePortalScopeProps();
  return createPortal(
    <div
      {...scopeProps}
      ref={panel}
      role="dialog"
      aria-label={`Current issue ${issue.id}`}
      style={place}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 w-96 max-w-[85vw] overflow-y-auto rounded-xl border border-border bg-popover text-left text-popover-foreground shadow-lg"
    >
      {/* A thin green line on top: the same colour the tab gives Current. */}
      <div className="h-0.5 bg-success/60" />
      <div className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-1.5 rounded-full bg-success" />
            Current issue
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

/** The status line for whichever thread the message box belongs to, if any. */
export function ComposerStatusLine() {
  const threadId = useComposerThreadId();
  return threadId === null ? null : <StatusLine threadId={threadId} />;
}

/**
 * The buttons for the current issue's step, inside the message box
 * (bead-bb-eg0). What is expected is said in the line above the box;
 * a sentence was tried here, beside the buttons, and the user moved it up.
 *
 * At one of the user's steps, their answers: the main move ("Approve plan",
 * "Accept"), any other choice the step has ("Commit & merge" beside
 * "Commit"), and "Send back". Text buttons, because what they do
 * changes with the step. At one of the agent's steps, none.
 *
 * They make the real workflow moves, which is the point: before, the reply
 * that felt natural beside the agent's message ("go") moved nothing, and the
 * buttons that did were in the side panel, away from what they approved.
 *
 * "Send back" was first left out, as the same thing as sending a message,
 * and put back at the user's request: seeing both answers shows what is
 * expected of them. It takes its reason from what is typed in the message
 * box and clears it; with nothing typed it asks for the reason.
 *
 * The "Agree & continue" button is drawn here too, whenever the user's
 * answer buttons are not: when there is no current issue, and at an
 * agent's step.
 * Side effects: one RPC per click; a toast if a move is refused.
 */
function StepButton({ threadId }: { threadId: string }) {
  const { rpc, result, refresh } = useIssues({ threadId, projectId: null });
  const composer = useComposer();
  const [busy, setBusy] = useState(false);
  const issue =
    result?.state === "ok" && result.currentBeadId !== null
      ? (result.issues.find(
          (candidate) => candidate.id === result.currentBeadId,
        ) ?? null)
      : null;
  // "Agree & continue" is shown whenever the user's answer buttons are not
  // (the user's rule): with "Accept" and "Send back" on show it would be a
  // third, vaguer way of saying yes.
  const agree = (
    <QuickReplyButton kind="agree" label="Agree & continue" icon="Check" />
  );
  if (issue === null || result === null) return agree;
  // No steps, so no answers to a step, on the simple workflow.
  const workflow = workflowFor(result.workflow ?? DEFAULT_WORKFLOW_ID);
  if (workflow === null) return agree;
  const state = stateOf(workflow, issue.step);
  /** Shows a refusal, or reloads after a move that worked. */
  const settle = (asked: Promise<{ message: string | null }>) => {
    setBusy(true);
    asked
      .then(
        (outcome) => {
          if (outcome.message !== null) toast.error(outcome.message);
          refresh();
        },
        (cause: unknown) =>
          toast.error(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setBusy(false));
  };
  // Nothing for an agent's step (the user's decision): a start button there
  // was disabled whenever the agent was working, which is nearly always, so
  // it was never of use. A stalled step can be started from the side panel.
  if (state.actor === "agent") return agree;
  // The user's answers at this step: every move that can be made on a
  // click, plus "Send back", whose reason is what is typed in the box. Left
  // for the side panel: moves that close the issue, and forward moves that
  // need a reason (skipping a step).
  const stepIndex = workflow.states.indexOf(state);
  const offered = offeredMoves(workflow, state.id, "user", {
    ownBranch: result.ownBranch,
  }).filter(
    (move) =>
      move.to !== CLOSED &&
      (move.needsNote !== true ||
        workflow.states.findIndex((other) => other.id === move.to) < stepIndex),
  );
  if (offered.length === 0) return agree;
  /** Asks the backend for a move; `note` is the reason where one is needed. */
  const make = (moveId: string, note: string) =>
    settle(
      rpc.call("workflow_move", {
        threadId,
        projectId: null,
        beadId: issue.id,
        moveId,
        note,
      }),
    );
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {offered.map((move) => (
        <Button
          key={move.id}
          variant="outline"
          size="sm"
          className={cn("shrink-0", move.primary === true && "font-medium")}
          tip={
            move.needsNote === true
              ? `${move.hint} Type what should change in the message box first: it is sent with this.`
              : move.hint
          }
          disabled={busy}
          onClick={() => {
            if (move.needsNote !== true) {
              make(move.id, "");
              return;
            }
            // The reason is what the user has typed, which is where they
            // would write it anyway; the move hands it to the agent, so it
            // is taken out of the box and not sent a second time.
            const reason = composer.text.trim();
            if (reason === "") {
              toast.message(
                `Type what should change, then press ${move.label}.`,
              );
              composer.focus();
              return;
            }
            make(move.id, reason);
            composer.clear();
          }}
        >
          {move.label}
        </Button>
      ))}
    </div>
  );
}

/** The buttons for whichever thread the message box belongs to, if any. */
export function ComposerStepButton() {
  const threadId = useComposerThreadId();
  return threadId === null ? null : <StepButton threadId={threadId} />;
}
