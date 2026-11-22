// server/machine.test.ts — tests for reaching a folder on another machine.
//
// What: checks the per-machine part (host.ts) through BB's own harness for
// it, the server's client for it (server/machine-host.ts), the keys that
// keep two machines' folders apart, how a folder is chosen and refused, and
// what a machine that cannot be reached does to a read and to a change.
//
// Why: a thread's folder may be on any machine enrolled in BB
// (bead-bb-fyv). The owner decided: follow the thread's machine, with no
// thread the project's default folder wherever it is; an offline machine
// is said so in plain words; each machine's copy of a project is separate.
//
// Gotchas: runs real programs (sh, printf) on this machine through the
// host entry, as BB's daemon would.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk/host";
import hostEntry from "../host.ts";
import { BendFailure, createRun, createTrackers, trackerOver } from "./bend.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Folders } from "./folder.ts";
import { createStore } from "./store.ts";
import type { WorkflowChoice } from "./workflow-choice.ts";
import { createFolders } from "./folder.ts";
import { createHostMachines } from "./machine-host.ts";
import { localMachine } from "./machine-local.ts";
import { folderKey, folderOfKey, noteServerHost, useMachines } from "./machine.ts";
import type { Machine } from "./machine.ts";

const root = mkdtempSync(join(tmpdir(), "airbender-machine-"));
after(() => rmSync(root, { recursive: true, force: true }));
// Every test leaves the machines as the other tests expect them.
afterEach(() => {
  useMachines(() => localMachine);
  noteServerHost("local");
});

/** A plugin with the fake BB, whose machines answer through host.ts. */
function hostedPlugin(hostsStatus: Record<string, "connected" | "disconnected"> = {}) {
  let listener: ExperimentalHostWatchListener | null = null;
  const entry = experimental_createHostEntryHarness(hostEntry, {
    experimental_watch: (_options, heard) => {
      listener = heard;
      return { dispose: async () => void (listener = null) };
    },
  });
  const calls: { method: string; hostId: string }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "airbender",
    experimental_callHostRpc: (call) => {
      calls.push({ method: call.method, hostId: call.hostId });
      if (hostsStatus[call.hostId] === "disconnected") throw new Error("host not connected");
      return entry.experimental_call(call.method as never, call.input as never);
    },
    sdk: {
      hosts: {
        get: async ({ hostId }: { hostId: string }) => ({
          id: hostId,
          name: hostId === "host_zangetsu" ? "zangetsu" : hostId,
          status: hostsStatus[hostId] ?? "connected",
          lifecycle: { phase: "active" },
        }),
      },
    } as never,
  });
  return { bb, harness, calls, entry, heard: () => listener };
}

test("a folder on the BB machine keeps its bare path as key; one elsewhere names its machine", () => {
  noteServerHost("host_kitchen");
  const here = { hostId: "host_kitchen", path: "/home/me/project" };
  const there = { hostId: "host_zangetsu", path: "/home/me/project" };
  assert.equal(folderKey(here), "/home/me/project");
  assert.equal(folderKey(there), "host_zangetsu:/home/me/project");
  assert.notEqual(folderKey(here), folderKey(there), "the same path on two machines is two folders");
  assert.deepEqual(folderOfKey(folderKey(here)), here);
  assert.deepEqual(folderOfKey(folderKey(there)), there);
});

test("host.ts runs a program, tells a missing one apart, and packs long output", async () => {
  const { bb, calls } = hostedPlugin();
  const machine = createHostMachines(bb)("host_zangetsu");
  const ran = await machine.run({
    program: "sh", args: ["-c", "printf hi; printf oops >&2; exit 3"], cwd: root,
    input: "", timeoutMs: 5_000, maxBytes: 1024,
  });
  assert.equal(ran.kind, "done");
  assert.ok(ran.kind === "done");
  assert.deepEqual([ran.exitCode, ran.stdout, ran.stderr, ran.error === null], [3, "hi", "oops", false]);
  const input = await machine.run({
    program: "sh", args: ["-c", "cat"], cwd: null, input: "from stdin", timeoutMs: 5_000, maxBytes: 1024,
  });
  assert.ok(input.kind === "done" && input.stdout === "from stdin");
  assert.deepEqual(
    await machine.run({ program: join(root, "no-such"), args: [], cwd: null, timeoutMs: 5_000, maxBytes: 1024 }),
    { kind: "not-found" },
  );
  // Longer than one answer may be uncompressed: sent packed, read whole.
  const big = await machine.run({
    program: "sh", args: ["-c", "head -c 3000000 /dev/zero | tr '\\0' a"], cwd: null,
    timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024,
  });
  assert.ok(big.kind === "done" && big.stdout.length === 3_000_000 && big.stdout.startsWith("aaa"));
  assert.ok(calls.every((call) => call.hostId === "host_zangetsu"), "every call goes to the folder's machine");
});

test("what a run prints is told as it prints, here and through host.ts", async () => {
  const heard: string[] = [];
  const ran = await localMachine.run({
    program: "sh", args: ["-c", "echo one; echo two >&2"], cwd: null, timeoutMs: 5_000, maxBytes: 1024,
    onOutput: (text) => heard.push(text),
  });
  assert.ok(ran.kind === "done");
  assert.deepEqual(heard.join("").split("\n").filter(Boolean).sort(), ["one", "two"]);
  // On another machine: sent as signals under the run's stream id.
  const { bb, entry } = hostedPlugin();
  await createHostMachines(bb)("host_zangetsu").run({
    program: "sh", args: ["-c", "echo streamed"], cwd: null, timeoutMs: 5_000, maxBytes: 1024,
    onOutput: () => {},
  });
  const output = entry.experimental_getSignals().filter((signal) => signal.signal === "output");
  assert.equal(output.map((signal) => (signal.payload as { text: string }).text).join(""), "streamed\n");
});

test("host.ts looks at and reads files, and says what the machine is", async () => {
  const { bb } = hostedPlugin();
  const machine = createHostMachines(bb)("host_zangetsu");
  writeFileSync(join(root, "note.txt"), "text");
  assert.equal((await machine.stat(join(root, "note.txt")))?.kind, "file");
  assert.equal((await machine.stat(root))?.kind, "directory");
  assert.equal(await machine.stat(join(root, "missing")), null);
  assert.equal(await machine.read(join(root, "note.txt")), "text");
  assert.equal(await machine.read(join(root, "missing")), null);
  const system = await machine.system();
  assert.equal(system.platform, process.platform);
  assert.ok(system.home.startsWith("/"));
  assert.equal(await machine.hasProgram("sh"), true);
  assert.equal(await machine.hasProgram("no-such-program-anywhere"), false);
});

test("a watch on another machine tells of its file, and only of it", async () => {
  const { bb, harness, entry, heard } = hostedPlugin();
  const machine = createHostMachines(bb)("host_zangetsu");
  const beads = join(root, "watched", ".beads");
  mkdirSync(beads, { recursive: true });
  let changed = 0;
  let ended = 0;
  const stop = await machine.watch(beads, "last-touched", () => void (changed += 1), () => void (ended += 1));
  assert.ok(stop !== null);
  // The machine's watcher saw changes: the signal it sends reaches the watch.
  heard()?.({ kind: "changed", changes: [{ path: join(beads, "other"), type: "update" }] });
  heard()?.({ kind: "changed", changes: [{ path: join(beads, "last-touched"), type: "update" }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sent = entry.experimental_getSignals();
  assert.equal(sent.length, 1, "a change to another file is not told");
  for (const signal of sent) {
    await harness.behavior.experimental_emitHostSignal("host_zangetsu", signal.signal, signal.payload);
  }
  assert.equal(changed, 1);
  // A folder that is not there cannot be watched.
  assert.equal(await machine.watch(join(root, "nowhere"), "last-touched", () => {}, () => {}), null);
  stop();
  assert.equal(ended, 0);
});

test("an offline machine is named; a call to it is 'unreachable', not a failed program", async () => {
  const { bb } = hostedPlugin({ host_zangetsu: "disconnected" });
  const machine = createHostMachines(bb)("host_zangetsu");
  assert.match((await machine.offline()) ?? "", /^zangetsu is offline\./u);
  const ran = await machine.run({ program: "sh", args: [], cwd: null, timeoutMs: 1_000, maxBytes: 1024 });
  assert.equal(ran.kind, "unreachable");
  assert.ok(ran.kind === "unreachable" && /zangetsu is offline/u.test(ran.message));
  // bend's runner says so as its own kind, and the tab's state is "offline".
  useMachines(() => machine);
  const run = createRun({ hostId: "host_zangetsu", path: root }, "bend");
  await assert.rejects(run(["list"]), (cause) => cause instanceof BendFailure && cause.kind === "unreachable");
  const trackers = createTrackers({
    findBd: async () => "bd",
    findBend: async () => "bend",
    notFoundMessage: "",
    bendMessages: { missing: "", old: "" },
    warn: () => {},
  });
  const said = trackers.problem({ hostId: "host_zangetsu", path: root }, new BendFailure("unreachable", "zangetsu is offline."));
  assert.deepEqual(said, { state: "offline", message: "zangetsu is offline." });
});

/** A machine that answers stat for any folder and reports `offline`. */
function fakeMachine(offline: string | null): Machine {
  return {
    ...localMachine,
    stat: async () => ({ kind: "directory", mtimeMs: 0 }),
    offline: async () => offline,
  };
}

/** Folders over a fake BB: a thread on `threadHost`, a project with two folders. */
function foldersFor(threadHost: string | null) {
  return createFolders({
    bb: {
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_kitchen" }) },
        threads: {
          get: async () => ({ projectId: "p", environmentId: threadHost === null ? null : "env" }),
        },
        environments: { get: async () => ({ hostId: threadHost, path: "/work/tree" }) },
        projects: {
          get: async () => ({
            sources: [
              { hostId: "host_kitchen", path: "/home/me/project", isDefault: false },
              { hostId: "host_zangetsu", path: "/home/me/project", isDefault: true },
            ],
          }),
        },
      },
    } as unknown as BbPluginApi,
    bdCandidates: [],
    bendCandidates: [],
  });
}

test("the folder follows the thread's machine; with no thread, the project's default folder", async () => {
  useMachines(() => fakeMachine(null));
  // A thread on another machine is no longer refused: its own folder there.
  assert.deepEqual(await foldersFor("host_zangetsu").resolveFolder({ threadId: "t", projectId: null }), {
    hostId: "host_zangetsu",
    path: "/work/tree",
  });
  assert.deepEqual(await foldersFor("host_kitchen").resolveFolder({ threadId: "t", projectId: null }), {
    hostId: "host_kitchen",
    path: "/work/tree",
  });
  // No thread, or a thread with no folder: the default folder, on its machine.
  assert.deepEqual(await foldersFor(null).resolveFolder({ threadId: null, projectId: "p" }), {
    hostId: "host_zangetsu",
    path: "/home/me/project",
  });
});

test("a folder whose machine is offline is said so, and says which machine", async () => {
  useMachines((hostId) =>
    fakeMachine(hostId === "host_zangetsu" ? "zangetsu is offline. Its issues show here again when it is back." : null),
  );
  const found = await foldersFor("host_zangetsu").folderFor({ threadId: "t", projectId: null });
  assert.deepEqual(found, {
    message: "zangetsu is offline. Its issues show here again when it is back.",
    path: "/work/tree",
    offline: true,
  });
  const fine = await foldersFor("host_kitchen").folderFor({ threadId: "t", projectId: null });
  assert.deepEqual(fine, { hostId: "host_kitchen", path: "/work/tree" });
});

test("a change cut off by an offline machine is reported as not done", async () => {
  useMachines(() => ({
    ...localMachine,
    run: async () => ({ kind: "unreachable", message: "zangetsu is offline." }),
  }));
  const folder = { hostId: "host_zangetsu", path: root };
  const trackers = createTrackers({
    findBd: async () => "bd",
    findBend: async () => "bend",
    notFoundMessage: "",
    bendMessages: { missing: "", old: "" },
    warn: () => {},
  });
  let told = 0;
  const store = createStore({
    bb: { log: { warn: () => {} }, realtime: { publish: () => void (told += 1) } } as unknown as BbPluginApi,
    folders: { folderFor: async () => folder } as unknown as Folders,
    trackers: { ...trackers, trackerFor: async () => ({ tracker: trackerOver(createRun(folder, "bend")) }) },
    currentBead: { read: async () => null, store: async () => {} } as unknown as CurrentBead,
    watchFolder: () => {},
    workflowChoice: { idFor: () => "standard" } as unknown as WorkflowChoice,
  });
  const outcome = await store.setIssueOpen("close", { threadId: null, projectId: "p", beadId: "bb-x1" });
  assert.deepEqual(outcome, { message: "zangetsu is offline." });
  assert.equal(told, 0, "the tabs are not told of a change that was not made");
});
