// server/machine.ts — the one door to the machine a folder is on.
//
// What: the `Folder` the rest of the server works on (a machine and a path
// on it), the `Machine` operations every program run, file check and file
// watch goes through, and the registry that gives the machine for a
// machine id.
//
// Why: a thread's folder may be on any machine enrolled in BB, not only on
// the one BB runs on (bead-bb-fyv). Before, the server ran bend, git and bd
// as its own child processes and read files with node:fs, which only ever
// reached the BB machine. Everything that touches a machine now asks the
// `Machine` of the folder's machine, so there is one way to it.
//
// Design notes:
// - The BB machine goes through the same door as every other machine (the
//   plugin's `bb.host` part, see server/machine-host.ts): one path to keep
//   correct.
// - The registry is module state, set once per plugin load (`useMachines`).
//   Without it every machine is this process's own (server/machine-local.ts),
//   which is what the tests use: their folders are on "the" machine.
// - `folderKey` keeps a folder on the BB machine under its bare path, as
//   before, and a folder elsewhere under "<machine id>:<path>". So nothing
//   stored before this change (workflow choices, watched folders, sizing)
//   needs moving, and two machines with the same path are kept apart.
//
// Gotchas:
// - The BB machine's id is learnt from BB (`noteServerHost`) the first time a
//   folder is resolved; until then the id of this process's own machine is
//   "local", which is what tests run with.

import { localMachine } from "./machine-local.ts";

/** A folder: a path on one machine. Plain data, safe to store. */
export interface Folder {
  /** BB's id of the machine the folder is on. */
  hostId: string;
  /** Absolute path on that machine. */
  path: string;
}

/** One run of a program on a machine. */
export interface RunRequest {
  /** Program name (found on the machine's PATH) or absolute path. */
  program: string;
  args: string[];
  /** Folder to run in; null for the machine's default. */
  cwd: string | null;
  /** Text for standard input; standard input is always closed after it. */
  input?: string;
  /** Added to the machine's environment for this run. */
  env?: Record<string, string>;
  timeoutMs: number;
  /** Most output kept from each of stdout and stderr, in bytes. */
  maxBytes: number;
  /**
   * Told what the program prints, on either channel, as it prints it: for
   * a long run the owner watches. The whole output still comes at the end.
   */
  onOutput?: (text: string) => void;
}

/**
 * How a run went.
 *
 * done: the program ran. `exitCode` is its status, null when it was ended
 * (a timeout, too much output); `error` is null exactly when it exited 0.
 * not-found: there is no such program, or no such folder to run it in.
 * unreachable: the machine could not be reached; the run did not happen,
 * or it is not known whether it did.
 */
export type RunResult =
  | {
      kind: "done";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      error: string | null;
    }
  | { kind: "not-found" }
  | { kind: "unreachable"; message: string };

/** What is known of a file or folder. */
export interface FileStat {
  kind: "file" | "directory" | "other";
  mtimeMs: number;
}

/** What the plugin needs to know about a machine itself. */
export interface SystemInfo {
  /** Node's names: "linux", "darwin", "win32". */
  platform: string;
  /** Node's names: "x64", "arm64". */
  arch: string;
  /** The home folder of the user BB runs as there. */
  home: string;
}

/** Stops one watch. Safe to call more than once. */
export type Unwatch = () => void;

/** The operations on one machine. Every one is safe to call often. */
export interface Machine {
  run(request: RunRequest): Promise<RunResult>;
  /** Null when there is nothing at the path, or it cannot be looked at. */
  stat(path: string): Promise<FileStat | null>;
  /** A small text file; null when it is missing or cannot be read. */
  read(path: string): Promise<string | null>;
  system(): Promise<SystemInfo>;
  /** Whether a program can be found there (its PATH and the usual places). */
  hasProgram(name: string): Promise<boolean>;
  /**
   * Calls `onChange` when the file `file` in the folder `dir` changes, and
   * `onEnd` once if the watch stops by itself (an error, the machine's
   * worker restarting); it is then for the caller to watch again.
   *
   * @returns How to stop it; null when the folder cannot be watched (it
   *   is missing, or the machine cannot be reached).
   */
  watch(
    dir: string,
    file: string,
    onChange: () => void,
    onEnd: () => void,
  ): Promise<Unwatch | null>;
  /**
   * Whether the machine can be reached now; null when it can, else the
   * reason in plain words, naming the machine.
   */
  offline(): Promise<string | null>;
}

/** The id this process's own machine goes by until BB names it. */
export const LOCAL_HOST_ID = "local";

let serverHostId: string = LOCAL_HOST_ID;
let machines: (hostId: string) => Machine = () => localMachine;

/**
 * Sets where machines come from, for this plugin load.
 *
 * @param of The machine for a machine id.
 */
export function useMachines(of: (hostId: string) => Machine): void {
  machines = of;
}

/** Records BB's id of the machine BB runs on (see folderKey). */
export function noteServerHost(hostId: string | null): void {
  if (hostId !== null) serverHostId = hostId;
}

/** The machine a folder, or a machine id, is on. */
export function machineOf(at: Folder | string): Machine {
  return machines(typeof at === "string" ? at : at.hostId);
}

/** A folder on this process's own machine: for tests and local tools. */
export function localFolder(path: string): Folder {
  return { hostId: LOCAL_HOST_ID, path };
}

/**
 * The key a folder is kept under, in memory and in storage: the bare path
 * on the BB machine (as before folders could be elsewhere), else
 * "<machine id>:<path>".
 */
export function folderKey(folder: Folder): string {
  return folder.hostId === serverHostId
    ? folder.path
    : `${folder.hostId}:${folder.path}`;
}

/** The folder a key from `folderKey` stands for. */
export function folderOfKey(key: string): Folder {
  const colon = key.indexOf(":");
  // Paths are absolute: a key that starts with "/" (or a drive letter, whose
  // colon comes second) is a bare path on the BB machine.
  if (key.startsWith("/") || colon <= 1) {
    return { hostId: serverHostId, path: key };
  }
  return { hostId: key.slice(0, colon), path: key.slice(colon + 1) };
}

/** Whether two folders are the same folder. */
export function sameFolder(a: Folder, b: Folder): boolean {
  return a.hostId === b.hostId && a.path === b.path;
}

/** The folder at another path on the same machine. */
export function onSameMachine(folder: Folder, path: string): Folder {
  return { hostId: folder.hostId, path };
}

/**
 * A program path as the machine will run it: a leading "~/" is the home
 * folder of the user BB runs as there.
 */
export async function expandHome(folder: Folder | string, program: string): Promise<string> {
  if (!program.startsWith("~/")) return program;
  const { home } = await machineOf(folder).system();
  return `${home.replace(/\/$/u, "")}/${program.slice(2)}`;
}
