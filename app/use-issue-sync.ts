// app/use-issue-sync.ts — how the folder's issues stand with their remote.
//
// What: a hook that asks the server how the folder's issue sync stands and
// offers "sync now", and the words the tab says about it: what a sync did,
// the state for the menu's row, the refresh button's tooltip, and whether
// that button is to be marked as failing.
//
// Why: syncing runs by itself every few minutes and shows nothing while it
// works (bead-bb-0bz). The owner asked to be able to see when the last one
// was and what it did, on the button and in the menu (bead-bb-6a9), and to
// have failures shown prominently, "because ... it can mess up the data"
// (bead-bb-c9l.16): what is wrong is worked out by bend, as `trouble`, and
// every place here that warns goes by it.
//
// Design notes:
// - Nothing here names a tracker. The words come from the sync layer's own
//   terms (sync/types.ts): how a run ended, which issues were sent and
//   brought in. Another source than beads needs no change here.
// - Asked again on every change notice: the server publishes one when a
//   sync it started begins and ends, and when bend's log of syncs changes
//   (a sync made in a terminal, or by bend's helper). Those re-reads are
//   marked passive, so that bend does not take them for the owner using it.

import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import type { RefusedChange, rpcContract } from "../server/contract.ts";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { HelperState, SyncEntry, SyncTrouble } from "../sync/types.ts";
import type { Scope } from "./use-issues.ts";

export type { HelperState, RefusedChange, SyncEntry, SyncTrouble };

/** The answer of `sync_status` (server/contract.ts). */
export interface SyncStatus {
  source: string | null;
  /** What the issues are synced with, in words; null when with nothing. */
  remote: string | null;
  running: boolean;
  halted: boolean;
  last: SyncEntry | null;
  syncedAt: number | null;
  /** The changes the tracker refused for good, oldest first. */
  refused: RefusedChange[];
  /** What is wrong with the syncing now, as bend works it out; else null. */
  trouble: SyncTrouble | null;
  /** bend's helper, which syncs on a clock; null where there is no tracker. */
  helper: HelperState | null;
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

/** "1 issue", "3 issues". */
const issues = (count: number) => `${count} ${count === 1 ? "issue" : "issues"}`;

/** Most ids named in a sentence; the rest are counted. */
const NAMED = 3;

/** "x-1: comment, x-2: created" for the first few, then "and 2 more". */
function named(parts: string[]): string {
  const shown = parts.slice(0, NAMED).join(", ");
  return parts.length > NAMED ? `${shown} and ${parts.length - NAMED} more` : shown;
}

/**
 * What a sync did, in a few words: "nothing new", "sent 1 issue (x-1:
 * comment)", "brought in 2 issues (x-2, x-3), sent 1 issue (x-1: closed)".
 * For a sync that did not work, how it ended.
 *
 * @param withIds Name the issues; left out where there is no room.
 */
export function syncDid(entry: SyncEntry, withIds = true): string {
  switch (entry.end) {
    case "failed":
      return "failed";
    case "busy":
      return "gave way; nothing sent";
    case "conflict":
      return "stopped: changes here and elsewhere cannot be merged";
    case "stuck":
      return "stopped: unfinished changes block every sync";
    default:
  }
  const parts: string[] = [];
  if (entry.broughtIn !== null && entry.broughtIn.length > 0) {
    parts.push(
      `brought in ${issues(entry.broughtIn.length)}${withIds ? ` (${named(entry.broughtIn)})` : ""}`,
    );
  }
  if (entry.sent !== null && entry.sent.length > 0) {
    parts.push(
      `sent ${issues(entry.sent.length)}${
        withIds
          ? ` (${named(entry.sent.map((change) => `${change.id}: ${change.kinds.join(", ")}`))})`
          : ""
      }`,
    );
  }
  if (parts.length > 0) return parts.join(", ");
  // Not known is not nothing.
  return entry.sent === null || entry.broughtIn === null ? "synced" : "nothing new";
}

/**
 * The state for the menu's "Sync log…" row, in a word or two at the right
 * like a setup step's "done", with a longer message for under the row when
 * there is something to read (a failure's own words).
 */
export function syncState(
  status: SyncStatus,
  now: number,
): { state: string; message: string | null } {
  if (status.remote === null) {
    return {
      state: "not synced",
      message: "The issues are on this computer only. See the setup steps below.",
    };
  }
  if (status.running) return { state: "syncing…", message: null };
  const { last } = status;
  if (last === null) return { state: "not yet synced from here", message: null };
  if (last.end === "synced") {
    const count = status.refused.length;
    return {
      state: `synced ${ago(last.at, now)}`,
      // Nothing failed, but something the owner did was not taken: said
      // under the row until they have dealt with it.
      message:
        count === 0
          ? null
          : `${count} ${count === 1 ? "change was" : "changes were"} refused and not sent. See the sync log.`,
    };
  }
  const lastGood =
    status.syncedAt === null ? "" : ` Last synced ${ago(status.syncedAt, now)}.`;
  const said = last.message === "" ? "" : `\n${last.message}`;
  switch (last.end) {
    case "conflict":
      return {
        state: "stopped",
        message: `The issues were changed here and elsewhere in a way that cannot be merged. Settle it, then press refresh.${lastGood}${said}`,
      };
    case "stuck":
      return {
        state: "stopped",
        message: `Unfinished changes block every sync. Clear them, then press refresh.${lastGood}${said}`,
      };
    case "busy":
      return {
        state: status.syncedAt === null ? "waiting" : `synced ${ago(status.syncedAt, now)}`,
        message: null,
      };
    default:
      return {
        state: "failed",
        message: `The last sync failed ${ago(last.at, now)}; it is tried again.${lastGood}${said}`,
      };
  }
}

/**
 * Why the refresh button is marked as failing, or null when it is not.
 *
 * It is marked exactly when bend reports serious trouble: the issues are
 * not being synced. When that is, is bend's rule (bend/internal/kept/
 * report.go), so that the button, the bar above the list and a terminal
 * never disagree.
 *
 * @returns One line for the button's tooltip; the bar has the rest.
 */
export function syncFailing(status: SyncStatus): string | null {
  return status.trouble !== null && status.trouble.serious ? status.trouble.title : null;
}

/**
 * The lines the trouble bar shows under its title: since when and when the
 * issues were last synced well, then what to do.
 */
export function troubleLines(status: SyncStatus, now: number): string[] {
  const { trouble } = status;
  if (trouble === null) return [];
  const times: string[] = [];
  if (trouble.serious && trouble.since > 0) times.push(`Since ${ago(trouble.since, now)}.`);
  if (trouble.serious) {
    times.push(
      status.syncedAt === null
        ? "The issues have never been synced from this computer."
        : `Last synced ${ago(status.syncedAt, now)}.`,
    );
  }
  return [...(times.length === 0 ? [] : [times.join(" ")]), trouble.advice];
}

/**
 * The refresh button's tooltip: what it does, then when the last sync was
 * and what it did (the user: "it should show you the time of the last
 * [sync] as a small tip and the result of it"). When the button is marked
 * as failing, the reason comes first.
 */
export function refreshTip(status: SyncStatus | null, now: number): string {
  if (status === null || status.remote === null) return "Refresh the list";
  // One line: the app's tooltip does not break lines.
  const does = `Refresh the list and sync the issues with ${status.remote}.`;
  const failing = syncFailing(status);
  const { last } = status;
  const lastLine =
    status.running
      ? "Syncing now…"
      : last === null
        ? "Not yet synced from here."
        : `Last sync ${ago(last.at, now)}: ${syncDid(last, false)}.`;
  return `${failing ?? does} ${lastLine}`;
}

/**
 * How long after a failed sync that is not yet called trouble the state is
 * asked for again: a little more than bend's four minutes.
 */
const TROUBLE_RECHECK_MS = 4.5 * 60_000;

/**
 * The sync status of the tab's folder.
 *
 * @returns `status` (null until the first answer), `reload`, `syncNow`,
 *   which resolves to a message when the sync could not be started,
 *   `loadLog`, the runs newest first (only the failed ones when asked),
 *   and `settleRefused`.
 */
export function useIssueSync(scope: Scope, active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const read = useCallback(
    (passive: boolean) => {
      if (!active) return;
      rpc.call("sync_status", { threadId, projectId, passive }).then(setStatus, () => {
        // Without an answer the tab says nothing about syncing.
      });
    },
    [rpc, threadId, projectId, active],
  );
  const reload = useCallback(() => read(false), [read]);
  // When syncs fail, bend calls it trouble only once that has gone on for
  // a few minutes, and nothing changes on disk at that moment to bring a
  // re-read about: so after a failed sync that is not yet trouble, the
  // state is asked for once more, a little after it would become one.
  const pendingTrouble =
    status !== null &&
    status.trouble === null &&
    status.last !== null &&
    status.last.end !== "synced";
  useEffect(() => {
    if (!pendingTrouble) return;
    const timer = setTimeout(() => read(true), TROUBLE_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [pendingTrouble, read, status?.last?.at]);
  useEffect(reload, [reload]);
  // Told that something changed: not the owner looking.
  const onChanged = useCallback(() => read(true), [read]);
  useRealtime(CHANGED_CHANNEL, onChanged);
  const syncNow = useCallback(
    () =>
      rpc
        .call("sync_now", { threadId, projectId })
        .then((outcome) => outcome.message),
    [rpc, threadId, projectId],
  );
  const loadLog = useCallback(
    (failed = false) =>
      rpc
        .call("sync_log", { threadId, projectId, failed })
        .then((answer) => answer.entries),
    [rpc, threadId, projectId],
  );
  /** Dismisses a refused change, or has it sent again; a message when it could not. */
  const settleRefused = useCallback(
    (seq: number, again: boolean) =>
      rpc
        .call("sync_refused_settle", { threadId, projectId, seq, again })
        .then((outcome) => {
          reload();
          return outcome.message;
        }),
    [rpc, threadId, projectId, reload],
  );
  return { status, reload, syncNow, loadLog, settleRefused };
}
