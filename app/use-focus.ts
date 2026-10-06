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
// Design notes:
// - Kept in the browser's local storage under the thread's id, like Group
//   and Filter (use-filters.ts) are kept per folder. Nothing but the tab
//   reads it, so the server is not involved. Storing it on the server,
//   beside the thread's current issue, was rejected for that reason.
// - Only the epic's id is stored. Whether the focus may still stand (the
//   epic exists, is open, and the current issue belongs to it) is decided
//   by the panel from the issue list, with focusBlock in issue-model.ts.
//
// Gotchas:
// - Per browser: the same conversation opened on another machine starts
//   unfocused.

import { useCallback, useEffect, useState } from "react";
import { BEAD_ID_PATTERN } from "../shared/constants.ts";
import type { Scope } from "./use-issues.ts";

/**
 * The focused epic for one conversation (or, on the new-conversation
 * screen, for one project).
 *
 * @returns The epic's id, or null when the whole list is shown, and a
 *   setter; null clears it. Stored text is untrusted: anything that is not
 *   an issue id reads as "no focus".
 * Side effects: reads local storage when the scope changes; writes it on
 *   every set.
 */
export function useFocus(scope: Scope) {
  const owner =
    scope.threadId !== null
      ? `thread:${scope.threadId}`
      : scope.projectId !== null
        ? `project:${scope.projectId}`
        : null;
  const key = owner === null ? null : `bb-plugin-airbender:focus:${owner}`;
  // The focus is kept together with the conversation it was read for. When
  // the tab is handed another conversation, the old focus must not be taken
  // for the new one's during the moment before the new one is read: acting
  // on it (the panel drops a focus that no longer holds) would erase what
  // the new conversation had stored.
  const [held, setHeld] = useState<{ key: string; id: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (key === null) {
      setHeld(null);
      return;
    }
    let id: string | null = null;
    try {
      const stored = localStorage.getItem(key);
      id = stored !== null && BEAD_ID_PATTERN.test(stored) ? stored : null;
    } catch {
      // Storage switched off: no focus is remembered.
    }
    setHeld({ key, id });
  }, [key]);
  const setFocus = useCallback(
    (next: string | null) => {
      if (key === null) return;
      setHeld({ key, id: next });
      try {
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
      } catch {
        // Storage can be full or switched off; the focus then lasts only
        // while the tab is open.
      }
    },
    [key],
  );
  const focusId = held !== null && held.key === key ? held.id : null;
  return [focusId, setFocus] as const;
}
