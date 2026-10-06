// app/use-focus.ts — which epic a conversation's tab is zoomed in on.
//
// What: a hook that remembers, per conversation, the one issue whose
// sub-issues the tab shows in place of the whole list ("epic mode").
//
// Why: with a large epic its sub-issues are the working list (bead-bb-ha9).
// The user's rule is that the focus is only a way of looking ("you just
// cosmetically show only the issues inside the epic"), that it belongs to
// the conversation, and that it is remembered.
//
// Naming: the product calls this "epic mode", and that is the only name the
// user sees. In the code it is "focus" throughout (the focused epic,
// focusBlock, actions.focus, this file's hook): the same thing, named
// before the product's word was settled. Read "focus" here as "epic mode".
//
// Design notes:
// - Kept in the browser's local storage under the thread's id, like Group
//   and Filter (use-filters.ts) are kept per folder. Nothing but the tab
//   reads it, so the server is not involved. Storing it on the server,
//   beside the thread's current issue, was rejected for that reason.
// - Only the epic's id is stored. Whether the focus may still stand (the
//   epic exists, is open, and the current issue belongs to it) is decided
//   by the panel from the issue list, with focusBlock in issue-model.ts.
//
// - It also remembers the epic last left, so the tab can offer the way
//   back in (bead-bb-fmg). What the two values become on entering, leaving
//   and dismissing is focusAfter in issue-model.ts, where it is tested.
//
// Gotchas:
// - Per browser: the same conversation opened on another machine starts
//   unfocused.

import { useCallback, useEffect, useState } from "react";
import { BEAD_ID_PATTERN } from "../shared/constants.ts";
import { focusAfter } from "./issue-model.ts";
import type { FocusMemory } from "./issue-model.ts";
import type { Scope } from "./use-issues.ts";

/** Where a conversation's focused epic is kept in local storage. */
const threadKey = (threadId: string) =>
  `bb-plugin-airbender:focus:thread:${threadId}`;

/**
 * Puts another conversation into epic mode on an epic, before it is opened
 * (bead-bb-ty5.2: an epic started in a work tree gets a conversation of its
 * own, which opens zoomed in on it).
 *
 * Side effects: writes that conversation's memory in local storage; a
 *   failure (storage full or switched off) only costs the zoom.
 */
export function rememberFocus(threadId: string, epicId: string): void {
  try {
    localStorage.setItem(threadKey(threadId), epicId);
    localStorage.removeItem(`${threadKey(threadId)}:last`);
  } catch {
    // The conversation then opens on the whole list.
  }
}

/**
 * The focused epic for one conversation (or, on the new-conversation
 * screen, for one project).
 *
 * @returns In order: the focused epic's id, or null when the whole list is
 *   shown; a setter for it, where null leaves epic mode and remembers the
 *   epic that was left; the id of the epic last left, or null; and a
 *   function that forgets that one. Stored text is untrusted: anything
 *   that is not an issue id reads as none.
 * Side effects: reads local storage when the scope changes; writes it on
 *   every set.
 */
export function useFocus(scope: Scope) {
  const key =
    scope.threadId !== null
      ? threadKey(scope.threadId)
      : scope.projectId !== null
        ? `bb-plugin-airbender:focus:project:${scope.projectId}`
        : null;
  // The epic last left, kept beside the focus, under a key of its own.
  const lastKey = key === null ? null : `${key}:last`;
  // The memory is kept together with the conversation it was read for.
  // When the tab is handed another conversation, the old memory must not
  // be taken for the new one's during the moment before the new one is
  // read: acting on it (the panel drops a focus that no longer holds)
  // would erase what the new conversation had stored.
  const [held, setHeld] = useState<{ key: string; memory: FocusMemory } | null>(
    null,
  );
  useEffect(() => {
    if (key === null || lastKey === null) {
      setHeld(null);
      return;
    }
    /** One stored id; anything that is not an issue id reads as none. */
    const read = (from: string) => {
      try {
        const stored = localStorage.getItem(from);
        return stored !== null && BEAD_ID_PATTERN.test(stored) ? stored : null;
      } catch {
        // Storage switched off: nothing is remembered.
        return null;
      }
    };
    setHeld({ key, memory: { focus: read(key), last: read(lastKey) } });
  }, [key, lastKey]);
  /** Applies one step to the memory and stores the result. */
  const apply = useCallback(
    (action: Parameters<typeof focusAfter>[1]) => {
      if (key === null || lastKey === null) return;
      setHeld((now) => {
        const before =
          now !== null && now.key === key
            ? now.memory
            : { focus: null, last: null };
        const memory = focusAfter(before, action);
        try {
          for (const [where, id] of [
            [key, memory.focus],
            [lastKey, memory.last],
          ] as const) {
            if (id === null) localStorage.removeItem(where);
            else localStorage.setItem(where, id);
          }
        } catch {
          // Storage can be full or switched off; the memory then lasts
          // only while the tab is open.
        }
        return { key, memory };
      });
    },
    [key, lastKey],
  );
  const setFocus = useCallback(
    (next: string | null) => apply(next === null ? "leave" : { enter: next }),
    [apply],
  );
  const forgetLast = useCallback(() => apply("forget"), [apply]);
  const memory =
    held !== null && held.key === key ? held.memory : { focus: null, last: null };
  return [memory.focus, setFocus, memory.last, forgetLast] as const;
}
