// server/watch.ts — noticing changes made outside the plugin.
//
// What: watches the beads folder of every folder the tab has shown, and tells
// open tabs to reload when beads writes there.
//
// Why: issues are changed by agents and by people running bd in a terminal as
// much as through the tab; without this the tab would show stale issues until
// refreshed by hand.
//
// Design notes:
// - Watches one small file that beads rewrites on every write (.beads/last-
//   touched), not the database, and waits a moment so a burst of writes causes
//   one reload.
// - The watched folders are remembered across plugin reloads, so a tab that
//   was open before a reload keeps following along.
//
// - The file is watched on the machine the folder is on (bead-bb-fyv),
//   through server/machine.ts; folders are kept by folderKey, so the same
//   path on two machines is two watches. A watch that ends by itself (the
//   machine restarted, an error) is dropped and started again by the next
//   list.
//
// Gotchas:
// - `bd delete` does not rewrite that file, so a deletion made outside the
//   plugin is not noticed.
// - `bd show` does rewrite it, so an agent merely reading an issue causes one
//   harmless reload.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { basename, dirname, join } from "node:path";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { Watched } from "./bend.ts";
import { folderKey, folderOfKey, machineOf, noteServerHost } from "./machine.ts";
import type { Folder, Unwatch } from "./machine.ts";

/**
 * Starts the change watcher: restores the folders watched before the last
 * reload and closes every watch when the plugin is disposed.
 *
 * @returns `watchFolder(folder)`, which starts watching a folder's beads
 *   directory if it is not watched yet. Safe to call on every list.
 * Side effects: file watches; one read of the plugin's key-value storage
 *   now, and a write whenever a new folder is added.
 */
export async function createWatcher(
  bb: BbPluginApi,
  /** How long after loading the saved watches are started again. */
  restoreAfterMs = 3_000,
) {
  /** Most folders watched at once; the oldest is dropped beyond this. */
  const MAX_WATCHED_FOLDERS = 32;

  /** How long to wait after a change before signalling, to merge bursts. */
  const WATCH_SETTLE_MS = 400;

  /** Storage key for the list of watched folders, kept across reloads. */
  const WATCHED_FOLDERS_KEY = "watchedFolders";

  /**
   * Live watches, in the order they were started, by "<folderKey>" for
   * beads' mark and "<folderKey>\ncopy" / "\nruns" for bend's files.
   */
  const watchers = new Map<string, { stop: Unwatch | null; target: string }>();
  let disposed = false;

  /**
   * Starts telling open tabs about beads changes made outside this plugin in
   * one folder. Safe to call on every list: a folder already watched is left
   * alone.
   *
   * Watches the `.beads` directory rather than the `last-touched` file
   * itself, because a file that is replaced (written to a temporary name and
   * renamed) would silently end a watch placed on the old file.
   *
   * Side effects: holds one file watch per watched file on the folder's
   *   machine until the plugin is reloaded or disabled (see the dispose hook
   *   below), or until the watch ends, in which case it is dropped and
   *   restarted by the next list.
   */
  function watchFolder(
    folder: Folder,
    watched: Watched = { copy: null, sign: null },
  ): void {
    const key = folderKey(folder);
    // Beads' own mark of a change: where bend says it is (the repository's
    // main folder, also for a work tree, whose own `.beads` folder beads
    // never writes to), else in the folder itself.
    const sign = watched.sign ?? join(folder.path, ".beads", "last-touched");
    watchOne(folder, dirname(sign), basename(sign), key);
    // bend's copy of the issues (bead-bb-c9l.14): it changes whenever any
    // bend process rereads it and finds something new, whoever made the
    // change.
    if (watched.copy !== null) {
      watchOne(folder, watched.copy, "issues.json", `${key}\ncopy`);
      // bend's log of syncs, kept beside the copy (bead-bb-c9l.16): a sync
      // made in a terminal or by bend's helper then shows in an open tab,
      // with no timer here.
      watchOne(folder, watched.copy, "sync-runs.json", `${key}\nruns`);
    }
  }

  /** Stops and forgets one watch. */
  function drop(key: string): void {
    watchers.get(key)?.stop?.();
    watchers.delete(key);
  }

  /**
   * Watches one file in one folder and tells the tabs of `folder` when it
   * changes.
   *
   * @param key What the watch is kept under; one watch per key.
   */
  function watchOne(folder: Folder, beadsDir: string, file: string, key: string): void {
    const target = join(beadsDir, file);
    const kept = watchers.get(key);
    if (kept !== undefined) {
      if (kept.target === target) return;
      // Another place for the same folder: the old watch would go on
      // telling of changes that are no longer this folder's, and miss the
      // ones that are.
      drop(key);
    }
    // Held at once, so that lists arriving together start one watch.
    const entry: { stop: Unwatch | null; target: string } = { stop: null, target };
    watchers.set(key, entry);
    let timer: NodeJS.Timeout | null = null;
    const onChange = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        bb.log.info("beads changed in " + folderKey(folder) + "; telling open tabs");
        bb.realtime.publish(CHANGED_CHANNEL, { path: folder.path });
      }, WATCH_SETTLE_MS);
    };
    const onEnd = () => {
      if (timer !== null) clearTimeout(timer);
      if (watchers.get(key) === entry) watchers.delete(key);
    };
    machineOf(folder)
      .watch(beadsDir, file, onChange, onEnd)
      .then(
        (stop) => {
          if (stop === null || disposed || watchers.get(key) !== entry) {
            stop?.();
            if (watchers.get(key) === entry) watchers.delete(key);
            return;
          }
          entry.stop = stop;
        },
        (cause) => {
          bb.log.warn("could not watch " + beadsDir + ": " + cause);
          if (watchers.get(key) === entry) watchers.delete(key);
        },
      );
    // A folder has up to three watches; the limit counts folders, and the
    // oldest folder goes with all of its.
    const folders = [...new Set([...watchers.keys()].map((held) => held.split("\n")[0]!))];
    if (folders.length > MAX_WATCHED_FOLDERS) {
      const oldest = folders[0]!;
      for (const held of [oldest, `${oldest}\ncopy`, `${oldest}\nruns`]) drop(held);
    }
    // Remember the folder so the watch comes back after the plugin is
    // reloaded or BB restarts. Not awaited: a failed save only costs the
    // watch until some tab next lists this folder.
    bb.storage.kv
      // Folders only: the copy's place is found again from bend.
      .set(
        WATCHED_FOLDERS_KEY,
        [...watchers.keys()].filter((held) => !held.includes("\n")),
      )
      .catch((cause) => bb.log.warn("could not save watched folders: " + cause));
  }

  // Watches live in memory, so a reload of the plugin (or a restart of BB)
  // would otherwise leave tabs that are already open deaf to outside changes
  // until something made them list again. Start them again from the saved
  // list, a moment after loading: a machine cannot be asked while the plugin
  // loads, and which machine BB is on must be known to read the keys.
  // Folders that no longer use beads are skipped by watchFolder.
  const savedFolders = await bb.storage.kv
    .get<unknown>(WATCHED_FOLDERS_KEY)
    .catch(() => undefined);

  if (Array.isArray(savedFolders)) {
    const restore = setTimeout(() => {
      void bb.sdk.system
        .config()
        .then(({ primaryHostId }) => {
          noteServerHost(primaryHostId);
          if (disposed) return;
          for (const saved of savedFolders.slice(-MAX_WATCHED_FOLDERS)) {
            if (typeof saved === "string") watchFolder(folderOfKey(saved));
          }
        })
        .catch((cause) => bb.log.warn("watched folders were not restored: " + cause));
    }, restoreAfterMs);
    bb.onDispose(() => clearTimeout(restore));
  }

  // Release every file watch when the plugin is reloaded or disabled.
  bb.onDispose(() => {
    disposed = true;
    for (const entry of watchers.values()) entry.stop?.();
    watchers.clear();
  });

  return { watchFolder };
}
