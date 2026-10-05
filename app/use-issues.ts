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
import { useCallback, useEffect, useState } from "react";
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
 * Side effects: one RPC per refresh; listens for window focus while mounted.
 */
export function useIssues(scope: Scope) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const [result, setResult] = useState<IssuesResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    rpc
      .call("issues_list", { threadId, projectId })
      .then(
        (next) => {
          setResult(next);
          setFailure(null);
        },
        (cause: unknown) => {
          setFailure(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => setLoading(false));
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
  return { rpc, result, failure, loading, refresh };
}
