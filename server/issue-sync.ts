// server/issue-sync.ts — keeping a repository's beads issues on its remote.
//
// What: runs beads' own sync (`bd sync`: pull, check for conflicts, push)
// for a repository at the right moments, one run at a time, and remembers
// how the last one went.
//
// Why: the issues are the project's memory, and `bd init` leaves them on
// one computer. The user cloned this repository elsewhere and found no
// issues there (bead-bb-0bz). Of three ways to close the gap they chose
// this one, with a condition: "make sure that multiple open tabs on the
// same repo don't have a race condition. So we need some form of mutex."
//
// Design notes:
// - One at a time, in two layers.
//   In this process: every tab and conversation of a BB instance talks to
//   one plugin server, so a queue here covers them all. It is keyed by the
//   repository (its shared git directory), not the folder: every work tree
//   of a repository works on the same database. A request during a run
//   starts nothing; it makes exactly one more run follow.
//   Across processes: a lock file in the repository's `.beads` folder, for
//   what the queue cannot see: a plugin reload whose old instance is still
//   finishing, or a second BB on this machine. A lock older than a run may
//   take was left behind by a crash and is taken over.
//   Another computer cannot be locked out from here; `bd sync` retries by
//   itself when it loses that race.
// - Beads' own automatic push (`dolt.auto-push`) is not used: beads calls
//   it unsafe with more than one writer, and it never pulls.
// - When: a while after issues stop changing (agents write in bursts),
//   every five minutes while the plugin runs (the user: "Why don't we sync
//   every five minutes? This way we don't have to show the timer at all"),
//   on a list read when the last sync is older than that (the plugin has
//   just started), and when the owner presses refresh.
// - The outcome is read from `bd sync`'s exit code, which beads documents
//   for exactly this: 0 synced, 1 error, 2 conflict, 3 busy, 4 stuck.
//   After a conflict or a stuck state nothing is synced by itself again
//   until a sync the owner asks for succeeds: retrying would only repeat
//   the message, and beads says a person has to settle it.
// - A sync writes to the database, which the folder watcher reports like
//   any change. Changes reported during a run and just after it are this
//   file's own doing and ask for nothing.
//
// Gotchas:
// - Syncing happens only while BB runs with the plugin loaded.
// - Whether a repository is synced at all is its beads configuration
//   (a remote), not something stored here.

import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import type { Folders } from "./folder.ts";

/**
 * Runs a job for one key at a time.
 *
 * @param job What a run does; told the key. Its failures are its own to
 *   handle: one that throws is treated as finished.
 * @returns `request(key)`: asks for a run. With none running for that key
 *   one starts now; with one running, exactly one more follows it, however
 *   many requests arrive meanwhile. `running(key)` says whether one is.
 */
export function createQueue(job: (key: string) => Promise<void>) {
  /** Keys with a run under way; true when another was asked for meanwhile. */
  const active = new Map<string, boolean>();
  async function drain(key: string): Promise<void> {
    do {
      active.set(key, false);
      try {
        await job(key);
      } catch {
        // The job reports its own failures.
      }
    } while (active.get(key) === true);
    active.delete(key);
  }
  return {
    request(key: string): void {
      if (active.has(key)) {
        active.set(key, true);
        return;
      }
      void drain(key);
    },
    running: (key: string) => active.has(key),
  };
}

/**
 * Takes a lock file, for the time of one run.
 *
 * @param file Where the lock is. Created only if it is not there ("wx"),
 *   which the file system does as one step, so two processes cannot both
 *   succeed.
 * @param staleMs A lock older than this was left behind and is taken over.
 * @returns A function that gives the lock back, or null when someone else
 *   holds it.
 */
export function takeLock(file: string, staleMs: number): (() => void) | null {
  const create = () => {
    const handle = openSync(file, "wx");
    writeSync(handle, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(handle);
  };
  try {
    create();
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs <= staleMs) return null;
      // Left behind: remove it and try once more. If another process does
      // the same at this moment, only one of the two creations succeeds.
      unlinkSync(file);
      create();
    } catch {
      return null;
    }
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone: nothing to give back.
    }
  };
}

/** How a sync ended, from `bd sync`'s exit code. */
export type SyncEnd = "synced" | "error" | "conflict" | "busy" | "stuck";

/** What `bd sync`'s exit code means (documented by beads for this use). */
export function endOf(exitCode: number | null): SyncEnd {
  switch (exitCode) {
    case 0:
      return "synced";
    case 2:
      return "conflict";
    case 3:
      return "busy";
    case 4:
      return "stuck";
    default:
      return "error";
  }
}

/** Whether automatic syncing stops after this end until the owner syncs. */
export const haltsOn = (end: SyncEnd) => end === "conflict" || end === "stuck";

/** What is remembered of a repository's last sync. */
export interface LastSync {
  /** When it ended (milliseconds since 1970). */
  at: number;
  end: SyncEnd;
  /** What beads said, for anything but "synced"; "" otherwise. */
  message: string;
  /** When the last successful one ended; null when there was none. */
  syncedAt: number | null;
}

/** How long after the last change a sync is started. */
const QUIET_MS = 2 * 60_000;
/**
 * How often a repository is synced while the plugin runs; a list read
 * asks for a sync when the last one is older than this.
 */
const EVERY_MS = 5 * 60_000;
/** Longest one run may take; also when a lock counts as left behind. */
const RUN_TIMEOUT_MS = 5 * 60_000;
/** Changes reported this long after a run are the run's own. */
const OWN_CHANGES_MS = 8_000;
/** How long to wait before trying again when another process holds the lock. */
const LOCKED_RETRY_MS = 30_000;
/** Storage key for the last sync per repository. */
const LAST_KEY = "issueSync";
/** The lock file's name, in the repository's main .beads folder. */
const LOCK_FILE = "airbender-sync.lock";

/**
 * Builds the issue sync for this plugin instance.
 *
 * @param repositoryKey Gives every work tree of a repository the same key
 *   (server/workflow-choice.ts).
 * @returns `status`, `changed`, `listed` and `now`.
 * Side effects: one read of the plugin's storage now.
 */
export async function createIssueSync({
  bb,
  folders,
  repositoryKey,
}: {
  bb: BbPluginApi;
  folders: Folders;
  repositoryKey: (path: string) => string;
}) {
  /** Repository key -> its last sync. */
  const last = new Map<string, LastSync>();
  const saved = await bb.storage.kv.get<unknown>(LAST_KEY).catch(() => undefined);
  if (typeof saved === "object" && saved !== null) {
    for (const [key, entry] of Object.entries(saved)) {
      const { at, end, message, syncedAt } = (entry ?? {}) as Partial<LastSync>;
      if (typeof at === "number" && typeof end === "string") {
        last.set(key, {
          at,
          end: end as SyncEnd,
          message: typeof message === "string" ? message : "",
          syncedAt: typeof syncedAt === "number" ? syncedAt : null,
        });
      }
    }
  }
  const save = () =>
    bb.storage.kv
      .set(LAST_KEY, Object.fromEntries(last))
      .catch((cause) => bb.log.warn("could not save issue sync state: " + cause));

  /** Repository key -> the folder a run is made in (its main folder). */
  const homes = new Map<string, string>();
  /** Repositories known to have a remote: asked of beads once. */
  const enabled = new Set<string>();
  /** Timers waiting for the changes to go quiet, by repository key. */
  const quiet = new Map<string, NodeJS.Timeout>();
  /** Until when reported changes are a run's own, by repository key. */
  const ownUntil = new Map<string, number>();

  /**
   * Whether a folder's issues have a remote to sync with.
   *
   * @returns False also when beads cannot say. Remembered once true.
   * Side effects: one `bd dolt remote list` until it is known to be true.
   */
  async function isEnabled(path: string): Promise<boolean> {
    const key = repositoryKey(path);
    if (enabled.has(key)) return true;
    const run = await folders.runBdIn(path, ["dolt", "remote", "list", "--json"]);
    if (run.kind !== "ok") return false;
    try {
      const remotes: unknown = JSON.parse(run.stdout);
      if (Array.isArray(remotes) && remotes.length > 0) enabled.add(key);
    } catch {
      return false;
    }
    return enabled.has(key);
  }

  /** One run of `bd sync` in a repository's main folder; never throws. */
  async function run(key: string): Promise<void> {
    const home = homes.get(key);
    if (home === undefined) return;
    const lockDir = join(home, ".beads");
    let release: (() => void) | null = null;
    try {
      mkdirSync(lockDir, { recursive: true });
      release = takeLock(join(lockDir, LOCK_FILE), RUN_TIMEOUT_MS);
    } catch {
      release = null;
    }
    if (release === null) {
      // Another process is syncing this repository: come back later.
      bb.log.info(`issue sync of ${home}: another process holds the lock`);
      setTimeout(() => queue.request(key), LOCKED_RETRY_MS);
      return;
    }
    bb.log.info(`issue sync of ${home}: started`);
    ownUntil.set(key, Number.POSITIVE_INFINITY);
    bb.realtime.publish(CHANGED_CHANNEL, { path: home });
    try {
      const bd = await folders.findBd(home);
      const outcome = await new Promise<{ code: number | null; said: string }>(
        (resolve) => {
          if (bd === null) {
            resolve({ code: 1, said: folders.BD_NOT_FOUND_MESSAGE });
            return;
          }
          execFile(
            bd,
            ["sync"],
            { cwd: home, timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) =>
              resolve({
                code:
                  error === null
                    ? 0
                    : typeof error.code === "number"
                      ? error.code
                      : 1,
                said: (stderr.trim() || stdout.trim() || error?.message || "")
                  .split("\n")
                  .slice(-8)
                  .join("\n"),
              }),
          );
        },
      );
      const end = endOf(outcome.code);
      const now = Date.now();
      last.set(key, {
        at: now,
        end,
        message: end === "synced" ? "" : outcome.said,
        syncedAt: end === "synced" ? now : (last.get(key)?.syncedAt ?? null),
      });
      void save();
      bb.log.info(`issue sync of ${home}: ${end}`);
    } finally {
      release();
      ownUntil.set(key, Date.now() + OWN_CHANGES_MS);
      bb.realtime.publish(CHANGED_CHANNEL, { path: home });
    }
  }

  const queue = createQueue(run);

  /** The repository key of a folder, with its main folder remembered. */
  async function keyOf(path: string): Promise<string> {
    const key = repositoryKey(path);
    if (!homes.has(key)) homes.set(key, (await folders.mainFolder(path)) ?? path);
    return key;
  }

  /** Whether syncing by itself is stopped for a repository (see haltsOn). */
  const halted = (key: string) => {
    const end = last.get(key)?.end;
    return end !== undefined && haltsOn(end);
  };

  // Every five minutes, each repository a tab has shown since the plugin
  // started: what another computer changed arrives without anything
  // being touched here, and a sync that keeps failing is noticed.
  const every = setInterval(() => {
    for (const [key, home] of homes) {
      if (halted(key) || queue.running(key)) continue;
      void isEnabled(home).then((on) => {
        if (on) queue.request(key);
      });
    }
  }, EVERY_MS);

  bb.onDispose(() => {
    clearInterval(every);
    for (const timer of quiet.values()) clearTimeout(timer);
    quiet.clear();
  });

  return {
    /**
     * How a folder's issues stand with their remote, for the tab.
     *
     * @returns `enabled` false when they are synced nowhere.
     */
    async status(path: string): Promise<{
      enabled: boolean;
      running: boolean;
      halted: boolean;
      last: LastSync | null;
    }> {
      const key = await keyOf(path);
      return {
        enabled: await isEnabled(path),
        running: queue.running(key),
        halted: halted(key),
        last: last.get(key) ?? null,
      };
    },

    /**
     * The folder's issues changed (the watcher's report): sync once they
     * have been quiet for a while. Returns at once; never throws.
     */
    changed(path: string): void {
      void (async () => {
        const key = await keyOf(path);
        if (Date.now() < (ownUntil.get(key) ?? 0) || halted(key)) return;
        if (!(await isEnabled(path))) return;
        const waiting = quiet.get(key);
        if (waiting !== undefined) clearTimeout(waiting);
        quiet.set(
          key,
          setTimeout(() => {
            quiet.delete(key);
            queue.request(key);
          }, QUIET_MS),
        );
      })().catch((cause) => bb.log.warn("issue sync (changed) failed: " + cause));
    },

    /**
     * The tab read the folder's list: sync if the last one is old (the tab
     * was just opened, or BB just started). Returns at once.
     */
    listed(path: string): void {
      void (async () => {
        const key = await keyOf(path);
        if (halted(key) || queue.running(key) || quiet.has(key)) return;
        if (Date.now() - (last.get(key)?.at ?? 0) < EVERY_MS) return;
        if (!(await isEnabled(path))) return;
        queue.request(key);
      })().catch((cause) => bb.log.warn("issue sync (listed) failed: " + cause));
    },

    /**
     * The owner asked for a sync now. It waits its turn if one is running,
     * and is allowed also after a conflict: it is how syncing by itself is
     * taken up again.
     *
     * @returns `message` null when a sync was started or queued.
     */
    async now(path: string): Promise<{ message: string | null }> {
      const key = await keyOf(path);
      if (!(await isEnabled(path))) {
        return {
          message:
            `This folder's issues have no remote to sync with yet. Use "Sync issues to the repository's remote" in the setup steps first.`,
        };
      }
      const waiting = quiet.get(key);
      if (waiting !== undefined) clearTimeout(waiting);
      quiet.delete(key);
      queue.request(key);
      return { message: null };
    },
  };
}

/** What createIssueSync returns. */
export type IssueSync = Awaited<ReturnType<typeof createIssueSync>>;
