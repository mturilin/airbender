// app/arrival.ts — opening the Airbender tab in a conversation on arrival.
//
// What: one conversation's tab leaves a note that another conversation
// should show the Airbender tab when the user gets there, and that
// conversation's message box, which is always on screen, acts on it.
//
// Why: an issue or an epic started in a work tree gets a conversation of
// its own, the panel takes the user there, and the user wants the tab open
// there (bead-bb-ak0). The first way, asking BB from the tab that was just
// left, a moment after the jump, did not show the tab (the user, on
// bead-bb-ty5.2: "airbender tab is not showing up automatically for
// worktree mode"): BB opens a panel "in the current thread surface", and a
// request from the surface being left has nothing reliable to go by. The
// message box of the new conversation is in the right surface by
// construction.
//
// Design notes:
// - The note is kept in the browser's local storage, like epic mode
//   (use-focus.ts): both ends are the same browser, moments apart.
// - It is used once and expires, so a conversation opened again later is
//   not interfered with.
// - BB may decline while the conversation is still being drawn, so the
//   request is repeated a few times until it is accepted.
//
// Gotchas:
// - The tab itself must be among the conversation's tabs already; the
//   server puts it there (server/work-trees.ts).

import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";

/** The id of the tab's panel, as registered in app.tsx. */
const PANEL_ACTION = "issues";

/** How long a note stays valid: the jump takes seconds, not minutes. */
const VALID_MS = 2 * 60_000;

/** When, after arrival, BB is asked; it stops at the first acceptance. */
const TRIES_MS = [0, 300, 1000, 2500];

const keyFor = (threadId: string) =>
  `bb-plugin-airbender:open-panel:thread:${threadId}`;

/**
 * Leaves the note for a conversation the user is about to be taken to.
 *
 * Side effects: one local storage write; a failure only costs the tab not
 *   opening by itself.
 */
export function askPanelOnArrival(threadId: string): void {
  try {
    localStorage.setItem(keyFor(threadId), String(Date.now()));
  } catch {
    // Storage full or switched off: the tab is still in the strip.
  }
}

/**
 * Acts on the note, in the conversation it was left for: asks BB to show
 * the Airbender tab, once.
 *
 * @param threadId The conversation this is drawn in; null draws nothing
 *   and does nothing.
 * Side effects: removes the note; up to a few requests to BB.
 */
export function usePanelOnArrival(threadId: string | null): void {
  const navigate = useBbNavigate();
  useEffect(() => {
    if (threadId === null) return;
    let left: string | null = null;
    try {
      left = localStorage.getItem(keyFor(threadId));
      if (left !== null) localStorage.removeItem(keyFor(threadId));
    } catch {
      return;
    }
    if (left === null || Date.now() - Number(left) > VALID_MS) return;
    let opened = false;
    const timers = TRIES_MS.map((delay) =>
      window.setTimeout(() => {
        if (!opened) opened = navigate.openThreadPanel({ actionId: PANEL_ACTION });
      }, delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // `navigate` is left out on purpose: the note is acted on once per
    // conversation, not again whenever BB hands out a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
}
