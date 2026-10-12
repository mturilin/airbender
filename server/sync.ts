// server/sync.ts — the plugin's side of the issue sync.
//
// What: joins the sync layer (sync/) to the plugin: which source a folder
// has, how that source runs its programs, where the log and the journal
// position are kept, and how the tabs are told.
//
// Why: the sync layer is kept free of BB and of any one tracker, so that
// other sources can be added ("next implementation will be GitHub",
// bead-bb-6a9). Everything that ties it to this plugin is here, and the
// one line that says "this folder's issues are synced by beads" is
// `sourceFor` below: it is what a choice of tracker will replace.
//
// Design notes:
// - A repository, not a folder, is what is synced: all its work trees
//   share one copy of the issues. The key is the repository's shared git
//   directory; programs are run in its main folder.
// - Asking a git remote whether it holds issues goes over the network and
//   is asked on every look at setup, so the answer is kept for a while.

import { execFile } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import { createBeadsSource } from "../sync/beads.ts";
import type { Ran } from "../sync/beads.ts";
import { createBendSource } from "../sync/bend.ts";
import { createSyncService } from "../sync/service.ts";
import type { SyncEntry, SyncSource } from "../sync/types.ts";
import { shellQuote } from "./bd.ts";
import type { About, Trackers } from "./bend.ts";
import type { Folders } from "./folder.ts";
import type { Store } from "./store.ts";

/** Storage keys: the log per repository, and beads' journal positions. */
const LOG_KEY = "syncLog";
const POSITION_KEY = "syncJournalPosition";

/** Longest a quick bd command, and a whole `bd sync`, may take. */
const QUICK_MS = 30_000;
const LONG_MS = 5 * 60_000;

/** How long an answer from a git remote is believed. */
const REMOTE_ASKED_MS = 5 * 60_000;
const REMOTE_EMPTY_MS = 30_000;

/**
 * Builds the plugin's issue sync.
 *
 * @param repositoryKey Gives every work tree of a repository the same key
 *   (server/workflow-choice.ts).
 * @returns `state`, `log`, `changed`, `opened` and `refresh`, each
 *   for a folder.
 * Side effects: reads the plugin's storage now; starts the timed sync,
 *   stopped when the plugin is disposed.
 */
export async function createSync({
  bb,
  folders,
  store,
  trackers,
  repositoryKey,
}: {
  bb: BbPluginApi;
  folders: Folders;
  store: Store;
  /** Which tracker a folder has, and its sync through bend. */
  trackers: Trackers;
  repositoryKey: (path: string) => string;
}) {
  /** Repository key -> its main folder, to name a repository to the tabs. */
  const homes = new Map<string, string>();
  const positions =
    ((await bb.storage.kv.get<Record<string, number>>(POSITION_KEY).catch(() => undefined)) ??
      {}) as Record<string, number>;

  const service = await createSyncService({
    load: async () =>
      ((await bb.storage.kv.get<Record<string, SyncEntry[]>>(LOG_KEY).catch(() => undefined)) ??
        {}) as Record<string, SyncEntry[]>,
    save: (logs) => {
      bb.storage.kv
        .set(LOG_KEY, logs)
        .catch((cause) => bb.log.warn("could not save the sync log: " + cause));
    },
    notify: (key) => {
      const home = homes.get(key);
      if (home === undefined) return;
      // A sync starting or ending: what it brings in changes the list
      // without beads marking it, so the kept list is dropped here.
      store.stale(home);
      bb.realtime.publish(CHANGED_CHANNEL, { path: home });
    },
    info: (message) => bb.log.info("issue " + message),
  });
  const timer = setInterval(() => service.tick(), service.everyMs);
  bb.onDispose(() => {
    clearInterval(timer);
    service.dispose();
  });

  /** Runs a program in a folder and gives how it exited and what it said. */
  const ran = (program: string, args: string[], cwd: string, timeout: number) =>
    new Promise<Ran>((resolve) => {
      execFile(
        program,
        args,
        { cwd, timeout, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) =>
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
            stdout,
            stderr,
          }),
      );
    });

  /** What git remotes said about holding issues, and when, per folder. */
  const remoteAsked = new Map<string, { at: number; said: string | null }>();

  /**
   * The source that syncs a folder's issues.
   *
   * The one place that decides it, by the folder's tracker: where bend
   * queues changes for a hosted tracker (GitHub issues), the sync is
   * bend's own; everywhere else it is beads'. Nothing else in the plugin
   * or the tab has to know.
   *
   * @returns The repository's key, and its source (made once per
   *   repository and made known to the service).
   */
  async function sourceFor(path: string): Promise<{ key: string; source: SyncSource }> {
    const key = repositoryKey(path);
    const home = homes.get(key) ?? (await folders.mainFolder(path)) ?? path;
    homes.set(key, home);
    // Asked every time (it is remembered, and cheap): a repository whose
    // tracker was changed since must not keep the other tracker's sync.
    const found = await trackers.trackerFor(home);
    const about = "state" in found ? null : trackers.aboutOf(home);
    const wanted = about === null ? null : about.queued ? remoteOf(about) : "beads";
    const known = sources.get(key);
    if (known !== undefined && (wanted === null || made.get(key) === wanted)) {
      return { key, source: known };
    }
    sources.delete(key);
    if (!("state" in found) && about !== null && about.queued) {
      const source = createBendSource({
        name: about.tracker,
        remote: remoteOf(about),
        unsent: async () => {
          const read = await store.readIssues(home);
          return read.state === "ok"
            ? read.issues.filter((issue) => issue.unsent > 0).map((issue) => issue.id)
            : null;
        },
        sync: () => found.tracker.sync(),
      });
      sources.set(key, source);
      made.set(key, remoteOf(about));
      service.use(key, source);
      return { key, source };
    }
    const bdPath = await folders.findBd(home);
    const source = createBeadsSource({
      home,
      bd: (args, long = false) =>
        bdPath === null
          ? Promise.resolve({ code: null, stdout: "", stderr: folders.BD_NOT_FOUND_MESSAGE })
          : ran(bdPath, args, home, long ? LONG_MS : QUICK_MS),
      bdCommand: shellQuote(bdPath ?? "bd"),
      git: async (args) => {
        // An answer with something in it is believed for a while; "nothing
        // there" and "no answer" only briefly, since a setup step that
        // has just run changes exactly that.
        const asked = remoteAsked.get(args.join(" "));
        if (
          asked !== undefined &&
          Date.now() - asked.at <
            (asked.said === null || asked.said === "" ? REMOTE_EMPTY_MS : REMOTE_ASKED_MS)
        ) {
          return asked.said;
        }
        const answer = await ran("git", args, home, 10_000);
        const said = answer.code === 0 ? answer.stdout.trim() : null;
        remoteAsked.set(args.join(" "), { at: Date.now(), said });
        return said;
      },
      readIssues: async (fresh = false) => {
        // Anew when the source asks: after a sync, what it brought in does
        // not show in what the kept list goes by.
        const read = await store.readIssues(home, fresh);
        return read.state === "ok"
          ? read.issues.map(({ id, updatedAt, status }) => ({ id, updatedAt, status }))
          : null;
      },
      position: {
        get: async () => positions[key] ?? null,
        set: (seq) => {
          positions[key] = seq;
          bb.storage.kv
            .set(POSITION_KEY, positions)
            .catch((cause) => bb.log.warn("could not save the journal position: " + cause));
        },
      },
    });
    // A source made before beads was installed would never find it: it
    // is kept, and made known to the service, only once the program is
    // there and the folder's tracker is known to be beads. Until then each
    // look makes a fresh one, so that a tracker chosen later is found.
    if (bdPath !== null && about !== null) {
      sources.set(key, source);
      made.set(key, "beads");
      service.use(key, source);
    }
    return { key, source };
  }
  /** Repository key -> its source. */
  const sources = new Map<string, SyncSource>();
  /**
   * Repository key -> what its source was made for: "beads", or the words
   * for a hosted tracker and its repository. A source is used only while
   * the folder's tracker still gives the same.
   */
  const made = new Map<string, string>();
  /** What a hosted tracker's issues are synced with, in words. */
  const remoteOf = (about: About): string =>
    about.tracker === "github" && about.repository !== null
      ? `GitHub issues of ${about.repository}`
      : `the ${about.tracker} tracker`;

  const failed = (what: string) => (cause: unknown) =>
    bb.log.warn(`issue sync (${what}) failed: ${cause}`);

  return {
    /** How a folder's issues stand with their remote. */
    async state(path: string) {
      return service.state((await sourceFor(path)).key);
    },
    /** The log of a folder's repository, newest first. */
    async log(path: string): Promise<SyncEntry[]> {
      return service.log((await sourceFor(path)).key);
    },
    /** The folder's issues changed (the watcher's report). */
    changed(path: string): void {
      void sourceFor(path).then(({ key }) => service.changed(key), failed("changed"));
    },
    /** A tab read the folder's list. */
    opened(path: string): void {
      void sourceFor(path).then(({ key }) => service.opened(key), failed("opened"));
    },
    /**
     * The owner asked for a sync now.
     *
     * @returns `message` null when a sync was started or queued.
     */
    async refresh(path: string): Promise<{ message: string | null }> {
      const asked = await service.refresh((await sourceFor(path)).key);
      return {
        message: asked
          ? null
          : "This folder's issues are not synced with anything yet. See the setup steps in the menu.",
      };
    },
  };
}

/** What createSync returns. */
export type Sync = Awaited<ReturnType<typeof createSync>>;
