// sync/service.ts — when a repository's issues are synced, one run at a
// time, and the log of it; for any source.
//
// What: everything about syncing that is the same whatever holds the
// issues: one run at a time per repository, the moments a sync is asked
// for, skipping one that has nothing to send, stopping after a conflict,
// and the log of what each run did.
//
// Why: the owner wants the sync as a layer of its own with several
// implementations, GitHub next (bead-bb-6a9). This is the part none of
// them should have to write again; it was the plugin's beads-only sync
// (bead-bb-0bz) with the beads parts taken out into sync/beads.ts.
//
// Design notes:
// - One at a time, in two layers (the owner's condition, bead-bb-0bz:
//   "multiple open tabs on the same repo don't have a race condition").
//   In this process a queue per repository: a request during a run starts
//   nothing and makes exactly one more run follow. Across processes the
//   source's lock file, where it names one; a lock older than a run may
//   take was left behind and is taken over.
// - When: every few minutes (`tick`, called by a timer of the host's), a
//   while after the issues stop changing, when a tab is opened and the
//   last run is old, and when the owner asks.
// - A sync set off by a change first asks the source what is pending. If
//   that is nothing, it does not run: reading an issue can look like a
//   change to the watcher. The timed sync always runs; it is what brings
//   in the other side's changes.
// - After a conflict or a stuck state nothing runs by itself until a sync
//   the owner asks for succeeds.
// - A sync changes the local copy, which the host reports like any
//   change. Changes reported during a run and just after are the run's
//   own and ask for nothing.
//
// Gotchas:
// - Free of BB and of any tracker: the host hands in storage, a log and a
//   way to tell the tabs. Timers are the only ambient thing used.

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { haltsOn } from "./types.ts";
import type { SyncCause, SyncEntry, SyncSource } from "./types.ts";

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

/** How a repository's sync stands, for whoever shows it. */
export interface SyncState {
  /** The source's name; null when the repository has no source. */
  source: string | null;
  /** What it syncs with, in words; null when syncing is not switched on. */
  remote: string | null;
  running: boolean;
  /** Syncing by itself has stopped until a sync asked for succeeds. */
  halted: boolean;
  /** The last run; null when there has been none from here. */
  last: SyncEntry | null;
  /** When the last run that ended `synced` ended; null when none did. */
  syncedAt: number | null;
}

/** The times the service works by; changed in tests. */
export interface SyncTimes {
  /** How long after the last change a sync is started. */
  quietMs: number;
  /** A tab being opened asks for a sync when the last run is older. */
  everyMs: number;
  /** Longest a run may take; also when a lock counts as left behind. */
  runTimeoutMs: number;
  /** Changes reported this long after a run are the run's own. */
  ownChangesMs: number;
  /** How long before trying again when another process holds the lock. */
  lockedRetryMs: number;
}

const DEFAULT_TIMES: SyncTimes = {
  quietMs: 2 * 60_000,
  everyMs: 5 * 60_000,
  runTimeoutMs: 5 * 60_000,
  ownChangesMs: 8_000,
  lockedRetryMs: 30_000,
};

/** Most runs kept in a repository's log. */
export const LOG_LENGTH = 200;

/**
 * Builds the sync service.
 *
 * @param load, save The log of every repository, kept by the host across
 *   restarts: `load` once now, `save` after every run.
 * @param notify Tells whoever shows the state that a repository's sync
 *   started or ended.
 * @returns `use`, `state`, `log`, `changed`, `opened`, `refresh`, `tick`
 *   and `dispose`. A repository is named by a key of the host's choosing
 *   (one per repository, not per folder), and made known with `use`.
 */
export async function createSyncService({
  load,
  save,
  notify,
  info,
  times = {},
}: {
  load: () => Promise<Record<string, SyncEntry[]>>;
  save: (logs: Record<string, SyncEntry[]>) => void;
  notify: (key: string) => void;
  info: (message: string) => void;
  times?: Partial<SyncTimes>;
}) {
  const t: SyncTimes = { ...DEFAULT_TIMES, ...times };
  /** Repository key -> its log, oldest first. */
  const logs = new Map<string, SyncEntry[]>(Object.entries(await load()));
  /** Repository key -> the source that syncs it. */
  const sources = new Map<string, SyncSource>();
  /** What set off the run that is waiting or under way, by key. */
  const causes = new Map<string, SyncCause>();
  /** Timers waiting for the changes to go quiet, by key. */
  const quiet = new Map<string, ReturnType<typeof setTimeout>>();
  /** Other timers, to be cleared on dispose. */
  const retries = new Set<ReturnType<typeof setTimeout>>();
  /** Until when reported changes are a run's own, by key. */
  const ownUntil = new Map<string, number>();

  const lastOf = (key: string) => logs.get(key)?.at(-1) ?? null;
  const halted = (key: string) => {
    const last = lastOf(key);
    return last !== null && haltsOn(last.end);
  };

  /** One run for a repository; never throws. */
  async function run(key: string): Promise<void> {
    const source = sources.get(key);
    if (source === undefined) return;
    const cause = causes.get(key) ?? "change";
    causes.delete(key);
    let release: (() => void) | null = () => {};
    if (source.lockFile !== null) {
      try {
        mkdirSync(dirname(source.lockFile), { recursive: true });
        release = takeLock(source.lockFile, t.runTimeoutMs);
      } catch {
        release = null;
      }
    }
    if (release === null) {
      // Another process is syncing this repository: come back later.
      info(`sync of ${key}: another process holds the lock`);
      const retry = setTimeout(() => {
        retries.delete(retry);
        ask(key, cause);
      }, t.lockedRetryMs);
      retries.add(retry);
      return;
    }
    info(`sync of ${key}: started (${cause})`);
    ownUntil.set(key, Number.POSITIVE_INFINITY);
    notify(key);
    const startedAt = Date.now();
    try {
      const result = await source.run().catch((cause_: unknown) => ({
        end: "failed" as const,
        message: cause_ instanceof Error ? cause_.message : String(cause_),
        sent: null,
        broughtIn: null,
      }));
      const now = Date.now();
      const log = logs.get(key) ?? [];
      log.push({
        ...result,
        at: now,
        seconds: Math.round((now - startedAt) / 1000),
        cause,
      });
      logs.set(key, log.slice(-LOG_LENGTH));
      save(Object.fromEntries(logs));
      info(`sync of ${key}: ${result.end}`);
    } finally {
      release();
      ownUntil.set(key, Date.now() + t.ownChangesMs);
      notify(key);
    }
  }

  const queue = createQueue(run);

  /** Asks for a run, remembering what set off the one that will start. */
  function ask(key: string, cause: SyncCause): void {
    // The cause of a run is the first request's; one asked for while a run
    // is under way is for the run that follows it.
    if (!causes.has(key)) causes.set(key, cause);
    queue.request(key);
  }

  /** Whether syncing is switched on for a repository; false if it throws. */
  const isOn = async (key: string) =>
    (await sources.get(key)?.remote().catch(() => null)) != null;

  return {
    /** Makes a repository and its source known; safe to call every time. */
    use(key: string, source: SyncSource): void {
      if (!sources.has(key)) sources.set(key, source);
    },

    /** How a repository's sync stands. */
    async state(key: string): Promise<SyncState> {
      const source = sources.get(key) ?? null;
      const log = logs.get(key) ?? [];
      return {
        source: source?.name ?? null,
        remote: source === null ? null : await source.remote().catch(() => null),
        running: queue.running(key),
        halted: halted(key),
        last: log.at(-1) ?? null,
        syncedAt:
          [...log].reverse().find((entry) => entry.end === "synced")?.at ?? null,
      };
    },

    /** A repository's log, newest first. */
    log: (key: string): SyncEntry[] => [...(logs.get(key) ?? [])].reverse(),

    /**
     * The repository's issues changed on this side: sync once they have
     * been quiet for a while, if there is then anything to send. Returns
     * at once; never throws.
     */
    changed(key: string): void {
      if (Date.now() < (ownUntil.get(key) ?? 0) || halted(key)) return;
      void isOn(key).then((on) => {
        if (!on) return;
        const waiting = quiet.get(key);
        if (waiting !== undefined) clearTimeout(waiting);
        quiet.set(
          key,
          setTimeout(() => {
            quiet.delete(key);
            void (async () => {
              // Nothing to send: what looked like a change was not one.
              // "Not known" is not "nothing": then it runs.
              const pending = await sources
                .get(key)
                ?.pending()
                .catch(() => null);
              if (pending != null && pending.length === 0) {
                info(`sync of ${key}: nothing to send, not run`);
                return;
              }
              ask(key, "change");
            })();
          }, t.quietMs),
        );
      });
    },

    /**
     * A tab was opened on the repository: sync if the last run is old (the
     * host has just started). Returns at once.
     */
    opened(key: string): void {
      if (halted(key) || queue.running(key) || quiet.has(key)) return;
      if (Date.now() - (lastOf(key)?.at ?? 0) < t.everyMs) return;
      void isOn(key).then((on) => {
        if (on) ask(key, "opened");
      });
    },

    /**
     * The owner asked for a sync now. It waits its turn behind a running
     * one, and is allowed also after a conflict: it is how syncing by
     * itself is taken up again.
     *
     * @returns False when syncing is not switched on, and nothing was asked.
     */
    async refresh(key: string): Promise<boolean> {
      if (!(await isOn(key))) return false;
      const waiting = quiet.get(key);
      if (waiting !== undefined) clearTimeout(waiting);
      quiet.delete(key);
      ask(key, "refresh");
      return true;
    },

    /**
     * The timed sync: every known repository that is switched on and not
     * stopped. Called by the host every `everyMs`.
     */
    tick(): void {
      for (const key of sources.keys()) {
        if (halted(key) || queue.running(key)) continue;
        void isOn(key).then((on) => {
          if (on) ask(key, "timer");
        });
      }
    },

    /** The interval `tick` is meant to be called at. */
    everyMs: t.everyMs,

    /** Stops every waiting timer. */
    dispose(): void {
      for (const timer of quiet.values()) clearTimeout(timer);
      quiet.clear();
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
    },
  };
}

/** What createSyncService returns. */
export type SyncService = Awaited<ReturnType<typeof createSyncService>>;
