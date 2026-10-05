// app/composer.tsx — controls in a thread's message box.
//
// What: the current-issue pill with its card, and the two quick-reply buttons,
// for the row of controls inside BB's message box.
//
// Why: the user wanted to see the thread's current issue and to answer the
// agent with one click without opening the tab (bead-bb-3l4).
//
// Design notes:
// - Quick replies are sent by the backend, not through the message box, so
//   whatever the user has typed there is left alone.
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

/** How long the pointer must rest on the pill before its card opens. */
const HOVER_OPEN_MS = 2000;

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
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
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
 * The current-issue pill in the message box (bead-bb-prr): shows the title
 * of the issue this thread is working on; a click, or resting the pointer
 * on it for two seconds, opens a card with the issue's details
 * (CurrentIssueCard).
 *
 * Two ways of opening, two ways of closing. Opened by a click, the card
 * stays until a press outside it or Escape. Opened by hovering (the user
 * asked for this, with the two-second wait so that merely passing over the
 * pill does nothing), it goes away shortly after the pointer leaves both
 * the pill and the card; the short wait lets the pointer cross the gap
 * between them. Clicking while a hover-opened card is showing keeps it.
 *
 * Draws nothing when the thread has no current issue or the folder has no
 * beads: the play button in the Airbender tab stays the way to choose one
 * (the user's decision). It follows changes through useIssues, the same
 * loading and change notifications the tab uses.
 *
 * The card opens upwards, because the message box is at the bottom of the
 * window.
 */
function CurrentIssuePill({ threadId }: { threadId: string }) {
  const { result } = useIssues({ threadId, projectId: null });
  const { open, setOpen, root, panel } = useMenu();
  // Where the card goes, in window coordinates, worked out from the pill
  // when it is clicked. See CurrentIssueCard for why it is not simply
  // positioned against the pill.
  const [place, setPlace] = useState<CSSProperties>({});
  const pill = useRef<HTMLButtonElement>(null);
  // True while the card is open only because of hovering; a click clears it.
  const hoverOpened = useRef(false);
  // The pending "open after 2 s" and "close shortly after leaving" timers.
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  /** Works out where the card goes from where the pill is right now. */
  const placeCard = () => {
    const box = pill.current?.getBoundingClientRect();
    if (box === undefined) return;
    // Above the pill, left edges in line, but never off the right edge of
    // the window (the card is at most 24rem wide).
    const width = Math.min(384, window.innerWidth * 0.85);
    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - box.top + 8,
      // Never taller than the room above the pill; it scrolls inside.
      maxHeight: Math.max(160, box.top - 16),
    });
  };
  /** The pointer came onto the pill or the card. */
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
  /** The pointer left the pill or the card. */
  const onLeave = () => {
    window.clearTimeout(openTimer.current);
    if (!hoverOpened.current) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      hoverOpened.current = false;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  // No timer may fire after the pill is gone.
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
  return (
    <div
      ref={root}
      className="relative min-w-0 shrink"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <Button
        ref={pill}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        tip={open ? undefined : `Current issue: ${issue.title}`}
        // Subtle on purpose (the user's request): no border, muted text, a
        // faint dot. It is a reminder, not a call to action.
        className="max-w-48 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
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
        <span className="size-1.5 shrink-0 rounded-full bg-success/60" />
        <span className="truncate">{issue.title}</span>
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
  );
}

/**
 * The card the current-issue pill opens: what this thread is working on, at
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
 * window. The first version was positioned against the pill, inside the
 * message box, and the user saw nothing happen on a click: BB's message box
 * cuts off whatever sticks out of it. Content moved out like this loses the
 * plugin's styles unless it carries usePortalScopeProps().
 *
 * @param panel Ref for the card's element, so useMenu knows a press inside
 *   the card is not a press "outside".
 * @param place Fixed position and height limit, from the pill's position.
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
  /** Tell the pill the pointer is on / off the card (hover-opened cards). */
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

/** The pill for whichever thread the message box belongs to, if any. */
export function ComposerCurrentIssue() {
  const threadId = useComposerThreadId();
  return threadId === null ? null : <CurrentIssuePill threadId={threadId} />;
}
