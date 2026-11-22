// host.ts — the plugin's part on each machine (BB's `bb.host` entry).
//
// What: answers the server's calls (server/host-contract.ts) on the machine
// it runs on: runs a program, looks at or reads a file, says what the
// machine is, finds a program, and watches files, telling the server when
// one changes.
//
// Why: a thread's folder may be on any machine enrolled in BB (bead-bb-fyv).
// BB runs this on every one of them, the BB machine included, and the
// server reaches it with `bb.hosts.experimental_client`.
//
// Design notes:
// - The work itself is in server/machine-local.ts, shared with the tests;
//   this file only adapts it to BB's calls, compresses long output, and
//   watches through BB's own watcher (`experimental_watch`) instead of
//   node's.
// - A watch is kept under the id the server gives, so asking again is
//   harmless: the server re-asks now and then, because a machine that
//   restarted has forgotten its watches.
//
// Gotchas:
// - BB bundles this file on its own (`bb plugin build`): it may import only
//   public SDK entry points, node and plugin files that import nothing of
//   BB's server.

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostWatchSubscription } from "@get-bb/plugin-sdk/host";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";
import { PACK_ABOVE_BYTES, hostContract, hostSignals } from "./server/host-contract.ts";
import {
  localHasProgram,
  localRead,
  localRun,
  localStat,
  localSystem,
} from "./server/machine-local.ts";

/** Watches by the server's id, with what each looks at. */
const watches = new Map<string, { at: string; subscription: Promise<ExperimentalHostWatchSubscription | null> }>();

/** Output as sent: compressed when long. */
function pack(text: string): { text: string; packed: boolean } {
  if (Buffer.byteLength(text) <= PACK_ABOVE_BYTES) return { text, packed: false };
  return { text: gzipSync(text).toString("base64"), packed: true };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    run: async ({ stream, ...input }, context) => {
      // Sent in order: each part waits for the one before.
      let sending = Promise.resolve();
      const result = await localRun({
        ...input,
        ...(stream === null
          ? {}
          : {
              onOutput: (text: string) => {
                sending = sending
                  .then(() => context.experimental_emitSignal("output", { stream, text }))
                  .catch(() => {});
              },
            }),
      });
      await sending;
      if (result.kind !== "done") return { kind: "not-found" as const };
      const out = pack(result.stdout);
      return {
        kind: "done" as const,
        exitCode: result.exitCode,
        stdout: out.text,
        // Error text is short; a flood there is cut, not sent.
        stderr: result.stderr.slice(0, 64 * 1024),
        packed: out.packed,
        error: result.error,
      };
    },
    stat: async ({ path }) => ({ stat: localStat(path) }),
    read: async ({ path }) => ({ text: localRead(path) }),
    system: async () => localSystem(),
    hasProgram: async ({ name }) => ({ found: localHasProgram(name) }),
    watch: async ({ id, dir, file }, context) => {
      const at = `${dir}\n${file}`;
      const kept = watches.get(id);
      if (kept !== undefined) {
        if (kept.at === at && (await kept.subscription) !== null) return { watching: true };
        watches.delete(id);
        void kept.subscription.then((subscription) => subscription?.dispose());
      }
      if (localStat(dir)?.kind !== "directory") return { watching: false };
      const ended = () => {
        if (watches.get(id)?.at !== at) return;
        watches.delete(id);
        void context.experimental_emitSignal("ended", { id }).catch(() => {});
      };
      const subscription = context
        .experimental_watch({ rootPath: dir, debounceMs: 200 }, (event) => {
          if (event.kind === "watch-error") return ended();
          // Told to look again: the change may have been the file.
          if (event.kind === "changed" && !event.changes.some((change) => basename(change.path) === file)) return;
          void context.experimental_emitSignal("changed", { id }).catch(() => {});
        })
        .catch(() => null);
      watches.set(id, { at, subscription });
      const started = await subscription;
      if (started === null) watches.delete(id);
      return { watching: started !== null };
    },
    unwatch: async ({ id }) => {
      const kept = watches.get(id);
      watches.delete(id);
      await (await kept?.subscription)?.dispose();
      return {};
    },
  },
  dispose: async () => {
    const all = [...watches.values()];
    watches.clear();
    await Promise.all(all.map(async (kept) => (await kept.subscription)?.dispose()));
  },
});
