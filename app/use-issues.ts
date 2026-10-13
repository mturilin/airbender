// app/use-issues.ts — loading the issues for a thread or project.
//
// What: the Scope a surface works from (a thread id or a project id) and the
// hook that loads the issue list for it and keeps it fresh.
//
// Why: the tab and the controls around the message box all need the
// same list, loaded and refreshed the same way.
//
// Design notes:
// - Refreshes on mount, on window focus, and whenever the backend publishes a
//   change. No timer: beads keeps its database in one local store, and polling
//   would compete with an agent writing issues.

import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IssuesResult, rpcContract } from "../server/contract.ts";
import { CHANGED_CHANNEL } from "../shared/constants.ts";

/** Which thread or project the tab is showing; exactly one is usually set. */
export interface Scope {
  threadId: string | null;
  projectId: string | null;
}

/**
 * The last answer for each scope, and the request under way for it, kept
 * outside any one component (bead-bb-3pr).
 *
 * Why: three places on one screen load the same list (the panel, the line
 * above the message box, the buttons in it), and each sent its own request
 * on every switch and every change notice. And a tab switched back to a
 * conversation it had shown before started empty until the answer came.
 * Now the three share one request, and a tab starts from the list that
 * conversation last had and refreshes it behind.
 *
 * What is kept is a scope's own earlier answer, so the rule below still
 * holds: one conversation's list is never shown as another's. It may be a
 * moment old; every action is checked by the server against the real
 * state, as always.
 */
const lastAnswer = new Map<string, IssuesResult>();
const underWay = new Map<string, { sent: Promise<IssuesResult>; at: number }>();

/**
 * How long after a request was sent another caller may join it. Long
 * enough for the three users on one screen, which ask in the same instant;
 * short enough that a request sent before a change is not taken for the
 * answer after it (an action's own reload, or a change notice, comes later
 * than this and sends a request of its own).
 */
const JOIN_MS = 100;

/** The key a scope's answer is kept under. */
const keyOf = (scope: Scope) =>
  scope.threadId !== null
    ? `thread:${scope.threadId}`
    : `project:${scope.projectId ?? ""}`;

/**
 * Loads the issues for a scope and keeps them reasonably fresh.
 *
 * @returns `result` (the scope's last answer at first, null when there is
 *   none yet), `loading` while a request is in flight, `failure` when the
 *   request itself failed (as opposed to the backend answering with a
 *   non-"ok" state), and `refresh` to ask again; `refresh(true)` has the
 *   server read the issues anew whatever it has kept.
 * Side effects: at most one RPC per scope at a time, shared by every user
 *   of this hook; listens for window focus while mounted.
 */
export function useIssues(scope: Scope) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const key = keyOf(scope);
  const [held, setHeld] = useState<{ key: string; result: IssuesResult } | null>(
    () => {
      const known = lastAnswer.get(key);
      return known === undefined ? null : { key, result: known };
    },
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Counts the requests, so that only the answer to the latest one is used.
  // Without it an answer that arrives late could replace a newer one, and,
  // when the tab is handed another conversation, the old conversation's
  // list could be shown, and acted on, as the new one's (epic mode drops a
  // focus that the list says no longer holds).
  const latest = useRef(0);
  const refresh = useCallback(
    (fresh = false, passive = false) => {
      const mine = ++latest.current;
      setLoading(true);
      // One request per scope at a time, shared; a fresh one is always
      // sent, and becomes the one the others join.
      const going = underWay.get(key);
      let asked =
        !fresh && going !== undefined && Date.now() - going.at < JOIN_MS
          ? going.sent
          : undefined;
      if (asked === undefined) {
        const sent: Promise<IssuesResult> = rpc
          .call("issues_list", { threadId, projectId, fresh, passive })
          .then((next) => {
            lastAnswer.set(key, next);
            return next;
          })
          .finally(() => {
            if (underWay.get(key)?.sent === sent) underWay.delete(key);
          });
        underWay.set(key, { sent, at: Date.now() });
        asked = sent;
      }
      asked
        .then(
          (next) => {
            if (mine !== latest.current) return;
            setHeld({ key, result: next });
            setFailure(null);
          },
          (cause: unknown) => {
            if (mine !== latest.current) return;
            setFailure(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          if (mine === latest.current) setLoading(false);
        });
    },
    [rpc, threadId, projectId, key],
  );
  useEffect(() => {
    // Handed another scope: start from what that one last had, if anything.
    const known = lastAnswer.get(key);
    setHeld(known === undefined ? null : { key, result: known });
    refresh();
  }, [refresh, key]);
  useEffect(() => {
    // Coming back to BB after working in a terminal is the moment the list is
    // most likely to be out of date: read anew, whatever the server kept.
    const onFocus = () => refresh(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  // The backend publishes after any change it makes and after any change it
  // sees made outside the plugin (an agent or a terminal running bd), so the
  // tab follows along on its own.
  // Such a read is not the owner looking: it is marked passive, so that
  // bend does not count it as being used (bead-bb-c9l.16).
  const onChanged = useCallback(() => refresh(false, true), [refresh]);
  useRealtime(CHANGED_CHANNEL, onChanged);
  // Never another scope's list, also in the moment before the effect above
  // has run for a new scope.
  const result = held !== null && held.key === key ? held.result : null;
  return { rpc, result, failure, loading, refresh };
}
