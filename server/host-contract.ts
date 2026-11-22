// server/host-contract.ts — what the server may ask of the plugin's part on
// each machine.
//
// What: the typed calls and signals between the server (server/machine-host.ts)
// and the per-machine part BB runs on every enrolled machine (host.ts).
//
// Why: a folder may be on any machine BB has (bead-bb-fyv); this is the one
// way the server reaches it. Shared by both sides, so they cannot disagree.
//
// Design notes:
// - Few, plain calls: run a program, look at or read a file, say what the
//   machine is, find a program, watch a file. What bend, git and bd are
//   asked stays in the server.
// - A run's output is sent compressed when it is large: BB carries at most
//   8 MiB per answer, and a long issue list is several hundred kilobytes of
//   JSON.
//
// Gotchas:
// - Imported by host.ts, which BB bundles on its own: nothing here may
//   import BB's server or the rest of the plugin.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

const statSchema = z.object({
  kind: z.enum(["file", "directory", "other"]),
  mtimeMs: z.number(),
});

export const hostContract = defineRpcContract({
  run: {
    input: z.object({
      program: z.string(),
      args: z.array(z.string()),
      cwd: z.string().nullable(),
      input: z.string(),
      env: z.record(z.string(), z.string()),
      timeoutMs: z.number().int().positive(),
      maxBytes: z.number().int().positive(),
      /** When set, what the program prints is sent as it prints, as "output" signals under this id. */
      stream: z.string().nullable(),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("done"),
        exitCode: z.number().nullable(),
        /** Base64 of gzip when `packed`, else the text itself. */
        stdout: z.string(),
        stderr: z.string(),
        packed: z.boolean(),
        error: z.string().nullable(),
      }),
      z.object({ kind: z.literal("not-found") }),
    ]),
  },
  stat: {
    input: z.object({ path: z.string() }),
    output: z.object({ stat: statSchema.nullable() }),
  },
  read: {
    input: z.object({ path: z.string() }),
    output: z.object({ text: z.string().nullable() }),
  },
  system: {
    input: z.object({}),
    output: z.object({ platform: z.string(), arch: z.string(), home: z.string() }),
  },
  hasProgram: {
    input: z.object({ name: z.string() }),
    output: z.object({ found: z.boolean() }),
  },
  /** Starts watching, or confirms an existing watch under the same id. */
  watch: {
    input: z.object({ id: z.string(), dir: z.string(), file: z.string() }),
    output: z.object({ watching: z.boolean() }),
  },
  unwatch: {
    input: z.object({ id: z.string() }),
    output: z.object({}),
  },
});

export const hostSignals = {
  /** The watched file changed. */
  changed: { payload: z.object({ id: z.string() }) },
  /** The watch stopped by itself; the server may start it again. */
  ended: { payload: z.object({ id: z.string() }) },
  /** Part of what a streamed run printed, in order. */
  output: { payload: z.object({ stream: z.string(), text: z.string() }) },
} satisfies ExperimentalHostSignals;

/** Runs whose output is longer than this are sent compressed. */
export const PACK_ABOVE_BYTES = 256 * 1024;
