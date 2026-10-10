// app/use-issue-sync.ts — how the folder's issues stand with their remote.
//
// What: a hook that asks the server whether the folder's beads issues are
// synced with the repository's remote, when the last sync was and how it
// ended, and offers "sync now"; the line the tab's menu says about it;
// and whether the refresh button is to be marked as failing.
//
// Why: the issues used to live on one computer with nothing saying so
// (bead-bb-0bz). The syncing itself is the server's (server/issue-sync.ts);
// the tab only shows where things stand and lets the owner ask for a sync.
//
// Design notes:
// - Asked again on every change notice, like the setup status: the server
//   publishes one when a sync starts and when it ends.

import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import type { rpcContract } from "../server/contract.ts";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { Scope } from "./use-issues.ts";

/** The answer of `sync_status` (server/contract.ts). */
export interface SyncStatus {
  enabled: boolean;
  running: boolean;
  halted: boolean;
  last: {
    at: number;
    end: "synced" | "error" | "conflict" | "busy" | "stuck";
    message: string;
    syncedAt: number | null;
  } | null;
}

/** "3 minutes ago", for a moment in the past. */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * What the menu says about the sync, in one or two lines.
 *
 * @param now The present moment, passed in so that it can be tested.
 */
export function syncLine(status: SyncStatus, now: number): string {
  if (!status.enabled) {
    return "Not synced anywhere: the issues are on this computer only. See the setup steps below.";
  }
  if (status.running) return "Syncing with the repository's remote…";
  const { last } = status;
  if (last === null) return "Synced with the repository's remote; not yet synced from here.";
  const lastGood =
    last.syncedAt === null ? "" : ` Last synced ${ago(last.syncedAt, now)}.`;
  switch (last.end) {
    case "synced":
      return `Synced ${ago(last.at, now)}.`;
    case "conflict":
      return `Stopped: the issues were changed here and on another computer in a way beads cannot merge. Settle it with bd, then sync again.${lastGood}\n${last.message}`;
    case "stuck":
      return `Stopped: beads has unfinished changes that block every sync. Clear them with bd, then sync again.${lastGood}\n${last.message}`;
    case "busy":
      return `The last sync gave up because the issues were being changed; it is tried again.${lastGood}`;
    default:
      return `The last sync failed ${ago(last.at, now)}; it is tried again.${lastGood}\n${last.message}`;
  }
}

/** A sync that has not worked for this long shows on the refresh button. */
const OVERDUE_MS = 10 * 60_000;

/**
 * Why the refresh button is marked as failing, or null when it is not.
 *
 * Syncing happens every five minutes by itself, so there is nothing to
 * show while it works (the user: "This way we don't have to show the timer
 * at all"). The button is marked only when "the sync was failing and we
 * didn't sync for more than, let's say, ten minutes", or when syncing has
 * stopped on a conflict. Not while a folder is synced nowhere: nothing is
 * failing then, and the setup card says it. Not on a fresh start either,
 * when the last sync is old only because the app was closed: the latest
 * attempt has to have failed. A folder that has never synced from this
 * computer has no last success to count from, so there one failed attempt
 * is enough.
 *
 * @returns One line for the button's tooltip; the menu has the rest.
 */
export function syncFailing(status: SyncStatus, now: number): string | null {
  const { last } = status;
  if (!status.enabled || last === null || last.end === "synced") return null;
  if (status.halted) {
    return "Syncing with the repository's remote has stopped. See the menu.";
  }
  const since = last.syncedAt;
  if (since !== null && now - since <= OVERDUE_MS) return null;
  return since === null
    ? "The issues could not be synced with the repository's remote. See the menu."
    : `The issues have not been synced with the repository's remote for ${ago(since, now).replace(" ago", "")}. See the menu.`;
}

/**
 * The sync status of the tab's folder.
 *
 * @returns `status` (null until the first answer) and `syncNow`, which
 *   resolves to a message when the sync could not be started.
 */
export function useIssueSync(scope: Scope, active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const reload = useCallback(() => {
    if (!active) return;
    rpc.call("sync_status", { threadId, projectId }).then(setStatus, () => {
      // Without an answer the menu says nothing about syncing.
    });
  }, [rpc, threadId, projectId, active]);
  useEffect(reload, [reload]);
  useRealtime(CHANGED_CHANNEL, reload);
  const syncNow = useCallback(
    () =>
      rpc
        .call("sync_now", { threadId, projectId })
        .then((outcome) => outcome.message),
    [rpc, threadId, projectId],
  );
  return { status, reload, syncNow };
}
