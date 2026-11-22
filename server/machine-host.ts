// server/machine-host.ts — reaching a machine through the plugin's part
// there.
//
// What: the Machine for each machine id, made of calls to the plugin's
// per-machine part (host.ts) through `bb.hosts.experimental_client`; and
// what BB knows of whether that machine can be reached.
//
// Why: a folder may be on any machine enrolled in BB (bead-bb-fyv). This is
// the server's half of the door server/machine.ts describes.
//
// Design notes:
// - A call that fails because of BB or the network (the machine offline,
//   asleep, its worker gone) is "unreachable", never a program's failure:
//   callers say "not done", and the tab says the machine is offline.
// - Before a read, `offline()` asks BB whether the machine is connected, so
//   an offline machine is named at once instead of after a timeout.
// - Watches are kept here as well as on the machine, and asked for again
//   every minute and after the machine's worker exited: a machine that
//   restarted or reconnected has forgotten them, and BB does not say so.
// - What a machine is (its system and home folder) is asked once and kept
//   until its worker exits.
//
// Gotchas:
// - BB's own limits: a call may run 30 minutes at most, and an answer may
//   be 8 MiB (see PACK_ABOVE_BYTES).
// - Host calls are refused while the plugin is still loading; nothing here
//   calls one before the first request.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gunzipSync } from "node:zlib";
import { hostContract, hostSignals } from "./host-contract.ts";
import type { Machine, RunResult, SystemInfo } from "./machine.ts";

/** Longest one call may be given, BB's own cap. */
const MAX_CALL_MS = 30 * 60_000;
/** Added to a run's own timeout, so the run is ended there, not here. */
const CALL_GRACE_MS = 15_000;
/** Timeout of a quick call (a file check, a read). */
const QUICK_CALL_MS = 20_000;
/** How often the watches are asked for again. */
const REWATCH_MS = 60_000;
/** How long BB's word on a machine's connection is believed. */
const STATUS_MS = 5_000;

/** The reason in plain words, from whatever was thrown. */
const reasonOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Builds the machines for this plugin load.
 *
 * @returns `machineFor(hostId)`, for `useMachines`.
 * Side effects: subscribes to the per-machine part's signals and worker
 *   exits; a timer that asks for the watches again. All undone on dispose.
 */
export function createHostMachines(bb: BbPluginApi): (hostId: string) => Machine {
  const client = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  /** Each live watch: where, and whom to tell. */
  const watches = new Map<
    string,
    { hostId: string; dir: string; file: string; onChange: () => void; onEnd: () => void }
  >();
  let nextWatch = 0;
  /** Who is told what a streamed run prints, by stream id. */
  const streams = new Map<string, (text: string) => void>();
  let nextStream = 0;
  const systems = new Map<string, Promise<SystemInfo>>();
  const statuses = new Map<string, { at: number; answer: Promise<string | null> }>();

  bb.onDispose(
    client.experimental_onSignal("changed", ({ payload }) => {
      watches.get(payload.id)?.onChange();
    }),
  );
  bb.onDispose(
    client.experimental_onSignal("output", ({ payload }) => {
      streams.get(payload.stream)?.(payload.text);
    }),
  );
  bb.onDispose(
    client.experimental_onSignal("ended", ({ payload }) => {
      const watch = watches.get(payload.id);
      if (watch === undefined) return;
      watches.delete(payload.id);
      watch.onEnd();
    }),
  );
  bb.onDispose(
    client.experimental_onWorkerExit(({ hostId }) => {
      systems.delete(hostId);
      for (const [id, watch] of watches) {
        if (watch.hostId === hostId) void rewatch(id);
      }
    }),
  );

  /** Asks the machine for a watch again; ends it when that fails for good. */
  async function rewatch(id: string): Promise<void> {
    const watch = watches.get(id);
    if (watch === undefined) return;
    try {
      const { watching } = await client.call(
        "watch",
        { id, dir: watch.dir, file: watch.file },
        { hostId: watch.hostId, timeoutMs: QUICK_CALL_MS },
      );
      if (!watching && watches.get(id) === watch) {
        watches.delete(id);
        watch.onEnd();
      }
    } catch {
      // Unreachable now: kept, and asked for again on the next round.
    }
  }
  const timer = setInterval(() => {
    for (const id of watches.keys()) void rewatch(id);
  }, REWATCH_MS);
  timer.unref?.();
  bb.onDispose(() => {
    clearInterval(timer);
    for (const [id, watch] of watches) {
      void client.call("unwatch", { id }, { hostId: watch.hostId, timeoutMs: QUICK_CALL_MS }).catch(() => {});
    }
    watches.clear();
  });

  /** What BB says of a machine: null when it can be reached. */
  async function askStatus(hostId: string): Promise<string | null> {
    try {
      const host = await bb.sdk.hosts.get({ hostId });
      if (host.status === "connected" && host.lifecycle.phase === "active") return null;
      return `${host.name} is offline. Its issues show here again when it is back.`;
    } catch (cause) {
      return `The machine this folder is on cannot be reached: ${reasonOf(cause)}`;
    }
  }

  return (hostId) => {
    const quick = { hostId, timeoutMs: QUICK_CALL_MS };
    const machine: Machine = {
      async run(request): Promise<RunResult> {
        const stream = request.onOutput === undefined ? null : `s${nextStream++}`;
        if (stream !== null) streams.set(stream, request.onOutput!);
        try {
          const ran = await client.call(
            "run",
            {
              program: request.program,
              args: request.args,
              cwd: request.cwd,
              input: request.input ?? "",
              env: request.env ?? {},
              timeoutMs: request.timeoutMs,
              maxBytes: request.maxBytes,
              stream,
            },
            { hostId, timeoutMs: Math.min(request.timeoutMs + CALL_GRACE_MS, MAX_CALL_MS) },
          );
          if (ran.kind === "not-found") return ran;
          return {
            kind: "done",
            exitCode: ran.exitCode,
            stdout: ran.packed ? gunzipSync(Buffer.from(ran.stdout, "base64")).toString("utf8") : ran.stdout,
            stderr: ran.stderr,
            error: ran.error,
          };
        } catch (cause) {
          statuses.delete(hostId);
          return { kind: "unreachable", message: (await machine.offline()) ?? reasonOf(cause) };
        } finally {
          if (stream !== null) streams.delete(stream);
        }
      },
      async stat(path) {
        try {
          return (await client.call("stat", { path }, quick)).stat;
        } catch {
          return null;
        }
      },
      async read(path) {
        try {
          return (await client.call("read", { path }, quick)).text;
        } catch {
          return null;
        }
      },
      system() {
        let known = systems.get(hostId);
        if (known === undefined) {
          known = client.call("system", {}, quick);
          systems.set(hostId, known);
          // Not kept when it failed: asked again next time.
          known.catch(() => systems.delete(hostId));
        }
        return known;
      },
      async hasProgram(name) {
        try {
          return (await client.call("hasProgram", { name }, quick)).found;
        } catch {
          return false;
        }
      },
      async watch(dir, file, onChange, onEnd) {
        const id = `w${nextWatch++}`;
        watches.set(id, { hostId, dir, file, onChange, onEnd });
        try {
          const { watching } = await client.call("watch", { id, dir, file }, quick);
          if (!watching) {
            watches.delete(id);
            return null;
          }
        } catch {
          // Unreachable now: kept, and asked for again every minute, so it
          // starts once the machine is back.
        }
        return () => {
          if (!watches.delete(id)) return;
          void client.call("unwatch", { id }, quick).catch(() => {});
        };
      },
      offline() {
        const known = statuses.get(hostId);
        if (known !== undefined && Date.now() - known.at < STATUS_MS) return known.answer;
        const answer = askStatus(hostId);
        statuses.set(hostId, { at: Date.now(), answer });
        return answer;
      },
    };
    return machine;
  };
}
