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
// Gotchas:
// - `bd delete` does not rewrite that file, so a deletion made outside the
//   plugin is not noticed.
// - `bd show` does rewrite it, so an agent merely reading an issue causes one
//   harmless reload.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { Watched } from "./bend.ts";

/**
 * Starts the change watcher: restores the folders watched before the last
 * reload and closes every watch when the plugin is disposed.
 *
 * @returns `watchFolder(path)`, which starts watching a folder's beads
 *   directory if it is not watched yet. Safe to call on every list.
 * Side effects: file watches; one read of the plugin's key-value storage
 *   now, and a write whenever a new folder is added.
 */
export async function createWatcher(
  bb: BbPluginApi,
  /**
   * Told the folder whenever its issues changed, beside the tabs: the
   * issue sync listens (server/issue-sync.ts).
   */
  onChange: (path: string) => void = () => {},
) {
  /** Most folders watched at once; the oldest is dropped beyond this. */
  const MAX_WATCHED_FOLDERS = 32;

  /** How long to wait after a change before signalling, to merge bursts. */
  const WATCH_SETTLE_MS = 400;

  /** Storage key for the list of watched folders, kept across reloads. */
  const WATCHED_FOLDERS_KEY = "watchedFolders";

  /** Live watchers by folder path, in the order they were started. */
  const watchers = new Map<string, FSWatcher>();

  /**
   * Starts telling open tabs about beads changes made outside this plugin in
   * one folder. Safe to call on every list: a folder already watched is left
   * alone.
   *
   * Watches the `.beads` directory rather than the `last-touched` file
   * itself, because a file that is replaced (written to a temporary name and
   * renamed) would silently end a watch placed on the old file.
   *
   * Side effects: holds one operating-system file watch per folder until the
   *   plugin is reloaded or disabled (see the dispose hook below), or until
   *   the watch fails, in which case it is dropped and restarted by the next
   *   list.
   */
  function watchFolder(
    path: string,
    watched: Watched = { copy: null, sign: null },
  ): void {
    // Beads' own mark of a change: where bend says it is (the repository's
    // main folder, also for a work tree, whose own `.beads` folder beads
    // never writes to), else in the folder itself.
    const sign = watched.sign ?? join(path, ".beads", "last-touched");
    watchOne(path, dirname(sign), basename(sign), path);
    // bend's copy of the issues (bead-bb-c9l.14): it changes whenever any
    // bend process rereads it and finds something new, whoever made the
    // change.
    if (watched.copy !== null) {
      watchOne(path, watched.copy, "issues.json", `${path}\ncopy`);
    }
  }

  /**
   * Watches one file in one folder and tells the tabs of `path` when it
   * changes.
   *
   * @param key What the watch is kept under; one watch per key.
   */
  function watchOne(path: string, beadsDir: string, file: string, key: string): void {
    if (watchers.has(key)) return;
    if (!existsSync(beadsDir)) return;
    let timer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher;
    try {
      watcher = watch(beadsDir, (_event, filename) => {
        if (filename !== file) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          bb.log.info("beads changed in " + path + "; telling open tabs");
          bb.realtime.publish(CHANGED_CHANNEL, { path });
          onChange(path);
        }, WATCH_SETTLE_MS);
      });
    } catch (cause) {
      bb.log.warn("could not watch " + beadsDir + ": " + cause);
      return;
    }
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      watcher.close();
      if (watchers.get(key) === watcher) watchers.delete(key);
    };
    watcher.on("error", stop);
    watcher.on("close", () => {
      if (timer !== null) clearTimeout(timer);
    });
    watchers.set(key, watcher);
    // A folder has up to two watches; the limit counts folders, and the
    // oldest folder goes with both of its.
    const folders = [...new Set([...watchers.keys()].map((kept) => kept.split("\n")[0]!))];
    if (folders.length > MAX_WATCHED_FOLDERS) {
      const oldest = folders[0]!;
      for (const kept of [oldest, `${oldest}\ncopy`]) {
        watchers.get(kept)?.close();
        watchers.delete(kept);
      }
    }
    // Remember the folder so the watch comes back after the plugin is
    // reloaded or BB restarts. Not awaited: a failed save only costs the
    // watch until some tab next lists this folder.
    bb.storage.kv
      // Folders only: the copy's place is found again from bend.
      .set(
        WATCHED_FOLDERS_KEY,
        [...watchers.keys()].filter((kept) => !kept.includes("\n")),
      )
      .catch((cause) => bb.log.warn("could not save watched folders: " + cause));
  }

  // Watches live in memory, so a reload of the plugin (or a restart of BB)
  // would otherwise leave tabs that are already open deaf to outside changes
  // until something made them list again. Start them again from the saved
  // list; folders that no longer use beads are skipped by watchFolder.
  const savedFolders = await bb.storage.kv
    .get<unknown>(WATCHED_FOLDERS_KEY)
    .catch(() => undefined);

  if (Array.isArray(savedFolders)) {
    for (const folder of savedFolders.slice(-MAX_WATCHED_FOLDERS)) {
      if (typeof folder === "string") watchFolder(folder);
    }
  }

  // Release every file watch when the plugin is reloaded or disabled.
  bb.onDispose(() => {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  });

  return { watchFolder };
}
