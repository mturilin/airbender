// server/machine-local.ts — the machine operations, done by this process.
//
// What: running a program, looking at and reading a file, saying what the
// machine is, and finding a program, all with node's own APIs on the
// machine this process runs on; and `localMachine`, a Machine made of them.
//
// Why: the plugin's per-machine part (host.ts) runs these on each machine
// BB has, for the server (bead-bb-fyv); the tests run them directly, so what
// they check is what the machines do.
//
// Design notes:
// - No BB import: host.ts is bundled from this, and the tests run it with
//   plain node.
// - A run never throws: every way it can go is a RunResult.
//
// Gotchas:
// - A missing program and a missing working folder both give ENOENT; both
//   are "not-found", and callers check the folder first.

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { FileStat, Machine, RunRequest, RunResult, SystemInfo } from "./machine.ts";

/** Most text `localRead` reads: the files it is for are small. */
const MAX_READ_BYTES = 1024 * 1024;

/** Runs one program here. Never throws. */
export function localRun(request: RunRequest): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        request.program,
        request.args,
        {
          ...(request.cwd === null ? {} : { cwd: request.cwd }),
          timeout: request.timeoutMs,
          maxBuffer: request.maxBytes,
          env: { ...process.env, ...(request.env ?? {}) },
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ kind: "done", exitCode: 0, stdout, stderr, error: null });
            return;
          }
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            resolve({ kind: "not-found" });
            return;
          }
          const code = (error as { code?: unknown }).code;
          resolve({
            kind: "done",
            exitCode: typeof code === "number" ? code : null,
            stdout: String(stdout),
            stderr: String(stderr),
            error: error.message,
          });
        },
      );
    } catch (cause) {
      resolve({
        kind: "done",
        exitCode: null,
        stdout: "",
        stderr: "",
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (request.onOutput !== undefined) {
      const tell = request.onOutput;
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer | string) => tell(String(chunk)));
      }
    }
    // Always closed, so that no program waits for input it was not sent.
    child.stdin?.on("error", () => {});
    child.stdin?.end(request.input ?? "");
  });
}

/** What is at a path here; null when nothing is, or it cannot be looked at. */
export function localStat(path: string): FileStat | null {
  try {
    const found = statSync(path);
    return {
      kind: found.isFile() ? "file" : found.isDirectory() ? "directory" : "other",
      mtimeMs: found.mtimeMs,
    };
  } catch {
    return null;
  }
}

/** A small text file here; null when it is missing, too big or unreadable. */
export function localRead(path: string): string | null {
  try {
    if ((statSync(path).size ?? 0) > MAX_READ_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** What this machine is. */
export function localSystem(): SystemInfo {
  return { platform: process.platform, arch: process.arch, home: homedir() };
}

/**
 * Whether a program can be found here: in the folders of this process's
 * PATH, or in a few places tools are commonly installed that a desktop
 * app's PATH tends to miss.
 */
export function localHasProgram(name: string): boolean {
  const folders = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".local", "share", "mise", "shims"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
  return folders.some((folder) => {
    if (folder === "") return false;
    try {
      accessSync(join(folder, name), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Watches one file in a folder here with the operating system's watcher.
 * The folder is watched, not the file: a file that is replaced (written to
 * a temporary name and renamed) would end a watch on the old file.
 */
export function localWatch(
  dir: string,
  file: string,
  onChange: () => void,
  onEnd: () => void,
): (() => void) | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename === file) onChange();
    });
  } catch {
    return null;
  }
  let stopped = false;
  watcher.on("error", () => {
    if (stopped) return;
    stopped = true;
    watcher.close();
    onEnd();
  });
  return () => {
    stopped = true;
    watcher.close();
  };
}

/** This process's own machine, as a Machine. */
export const localMachine: Machine = {
  run: localRun,
  stat: async (path) => localStat(path),
  read: async (path) => localRead(path),
  system: async () => localSystem(),
  hasProgram: async (name) => localHasProgram(name),
  watch: async (dir, file, onChange, onEnd) => localWatch(dir, file, onChange, onEnd),
  offline: async () => null,
};
