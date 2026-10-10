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
 * Loads the issues for a scope and keeps them reasonably fresh.
 *
 * @returns `result` (null until the first answer), `loading` while a request
 *   is in flight, `failure` when the request itself failed (as opposed to
 *   the backend answering with a non-"ok" state), and `refresh` to ask again.
 * Side effects: one RPC per refresh; listens for window focus while mounted;
 *   where the issues are on GitHub, also a timer and a listener for the tab
 *   coming back into view.
 */
/**
 * How often a list kept on a hosted tracker is read again while the tab is
 * in view. Three minutes is the owner's figure ("every 3 min syncs").
 */
const HOSTED_REFRESH_MS = 3 * 60_000;

export function useIssues(scope: Scope) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const [result, setResult] = useState<IssuesResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Counts the requests, so that only the answer to the latest one is used.
  // Without it an answer that arrives late could replace a newer one, and,
  // when the tab is handed another conversation, the old conversation's
  // list could be shown, and acted on, as the new one's (epic mode drops a
  // focus that the list says no longer holds).
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++latest.current;
    setLoading(true);
    rpc
      .call("issues_list", { threadId, projectId })
      .then(
        (next) => {
          if (mine !== latest.current) return;
          setResult(next);
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
  }, [rpc, threadId, projectId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    // Coming back to BB after working in a terminal is the moment the list is
    // most likely to be out of date.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  // The backend publishes after any change it makes and after any change it
  // sees made outside the plugin (an agent or a terminal running bd), so the
  // tab follows along on its own.
  useRealtime(CHANGED_CHANNEL, refresh);
  // Issues on GitHub (bead-bb-c9l.6): nothing on this machine changes when
  // someone edits an issue there, so there is nothing for the backend to
  // watch. The tab asks again by itself: when it comes back into view, and
  // every few minutes while it is in view. Not while hidden: each reload
  // reads the whole list over the network, and nobody is looking.
  const hosted = result?.tracker === "github";
  useEffect(() => {
    if (!hosted) return;
    const whenShown = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", whenShown);
    const timer = window.setInterval(whenShown, HOSTED_REFRESH_MS);
    return () => {
      document.removeEventListener("visibilitychange", whenShown);
      window.clearInterval(timer);
    };
  }, [hosted, refresh]);
  return { rpc, result, failure, loading, refresh };
}
