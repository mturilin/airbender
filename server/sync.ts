// server/sync.ts — the plugin's side of the issue sync: it shows, and asks.
//
// What: reads from bend how a folder's issues stand with their remote and
// the log of syncs, and starts a sync when the owner presses Refresh.
//
// Why: syncing is bend's, for every tracker: bend runs the syncs, keeps
// time with a helper process of its own, keeps the log, and works out what
// is wrong (bead-bb-c9l.16). The plugin used to do all of that, which put
// it on the path the owner's issues take; the owner: "asking plugin to do
// critical data management path is kind of smelly". What is left here is
// what a screen needs.
//
// Design notes:
// - No timer, no lock, no choice by tracker, nothing kept in the plugin's
//   storage. A sync made in a terminal or by the helper shows in an open
//   tab because the watcher (server/watch.ts) watches bend's log file.
// - A sync asked for from here is not waited for by the request: it is
//   started, the tabs are told, and they are told again when it ends.
// - "Running" is bend's word (it tries the sync's lock), plus the one this
//   module started and has not yet seen end.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { HelperState, SyncEntry, SyncState } from "../sync/types.ts";
import type { Trackers } from "./bend.ts";
import type { Store } from "./store.ts";

/** Storage keys the plugin's own sync used to keep; removed once. */
const OLD_KEYS = ["syncLog", "syncJournalPosition"];

/** bend's answer, or the empty one for a folder with no tracker to ask. */
type Shown = Omit<SyncState, "helper"> & { helper: HelperState | null };

/** How a folder with no tracker to ask stands. */
const NOTHING: Shown = {
  source: "",
  remote: null,
  running: false,
  halted: false,
  last: null,
  syncedAt: null,
  pending: null,
  trouble: null,
  helper: null,
};

/**
 * Builds the plugin's issue sync.
 *
 * @returns `state`, `log` and `refresh`, each for a folder.
 * Side effects: removes what the plugin's earlier sync kept in storage.
 */
export function createSync({
  bb,
  store,
  trackers,
}: {
  bb: BbPluginApi;
  store: Store;
  /** The folder's tracker, as calls on bend. */
  trackers: Trackers;
}) {
  for (const key of OLD_KEYS) {
    bb.storage.kv.delete(key).catch(() => {
      // Left behind: it is read by nothing.
    });
  }
  /** Folders with a sync started from here that has not ended. */
  const asked = new Set<string>();

  return {
    /**
     * How a folder's issues stand with their remote.
     *
     * @param passive See RunOptions in server/bend.ts.
     * @returns bend's answer; the empty state where the folder has no
     *   tracker or bend could not be asked.
     */
    async state(path: string, passive = false): Promise<Shown> {
      const found = await trackers.trackerFor(path);
      if ("state" in found) return NOTHING;
      try {
        const state = await found.tracker.syncState(passive);
        return asked.has(path) ? { ...state, running: true } : state;
      } catch (cause) {
        bb.log.warn(`issue sync: the state of ${path} could not be read: ${cause}`);
        return NOTHING;
      }
    },

    /** The syncs of a folder's repository, newest first. */
    async log(path: string, failed = false): Promise<SyncEntry[]> {
      const found = await trackers.trackerFor(path);
      if ("state" in found) return [];
      return found.tracker.syncLog(failed);
    },

    /**
     * The owner asked for a sync now.
     *
     * @returns `message` null when a sync was started or is under way.
     * Side effects: one `bend sync`, not waited for; the tabs are told
     *   when it starts and when it ends.
     */
    async refresh(path: string): Promise<{ message: string | null }> {
      const found = await trackers.trackerFor(path);
      if ("state" in found) return { message: found.message };
      if (asked.has(path)) return { message: null };
      let state: SyncState;
      try {
        state = await found.tracker.syncState();
      } catch (cause) {
        return { message: cause instanceof Error ? cause.message : String(cause) };
      }
      if (state.remote === null) {
        return {
          message:
            "This folder's issues are not synced with anything yet. See the setup steps in the menu.",
        };
      }
      asked.add(path);
      bb.realtime.publish(CHANGED_CHANNEL, { path });
      void found.tracker
        .sync()
        .then(
          (entry) => bb.log.info(`issue sync of ${path}: ${entry.end}`),
          (cause: unknown) => bb.log.warn(`issue sync of ${path} could not be run: ${cause}`),
        )
        .finally(() => {
          asked.delete(path);
          // What it brought in is in bend's copy; the list is read anew.
          store.stale(path);
          bb.realtime.publish(CHANGED_CHANNEL, { path });
        });
      return { message: null };
    },
  };
}

/** What createSync returns. */
export type Sync = ReturnType<typeof createSync>;
