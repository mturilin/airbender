// server/bd.ts — running programs on the machine.
//
// What: running one `bd` command and reporting how it went, plus two helpers
// for shell commands: quoting text and finding out whether a program is
// installed.
//
// Why: every request ends in a `bd` run; one place decides the timeout, the
// output limit and how a missing program differs from a failed one.
//
// Gotchas:
// - ENOENT is reported both for a missing program and a missing working
//   folder; callers check the folder first.

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Longest we wait for one `bd` run before giving up. */
const BD_TIMEOUT_MS = 20_000;

/** Upper bound on `bd` output we are willing to buffer (16 MiB). */
const BD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Wraps text in single quotes for a shell, safe for any content. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Whether a program can be found on this machine: in the folders of the
 * server's own PATH, or in a few places tools are commonly installed that a
 * desktop app's PATH tends to miss.
 */
export function programExists(name: string): boolean {
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

/** Outcome of one `bd` run: its standard output, or why it did not run. */
export type BdRun =
  | { kind: "ok"; stdout: string }
  | { kind: "not-found" }
  | { kind: "failed"; message: string };

/**
 * Runs one `bd` command.
 *
 * @param command Program name or absolute path to try.
 * @param args Arguments, passed without a shell so nothing is interpreted.
 * @param cwd Folder to run in; bd finds the beads database from here upward.
 * @returns "ok" with stdout, "not-found" when the program does not exist
 *   (so the caller can try another location), or "failed" with bd's own
 *   error text. Never throws.
 * Side effects: spawns a short-lived child process; none on disk, because
 *   callers pass `--readonly`.
 */
export function runBd(command: string, args: string[], cwd: string): Promise<BdRun> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: BD_TIMEOUT_MS, maxBuffer: BD_MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: "ok", stdout });
          return;
        }
        // ENOENT is reported both for a missing program and a missing cwd;
        // callers check the folder separately, so here it means the program.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ kind: "not-found" });
          return;
        }
        // With --json, bd may report its error on standard output instead.
        let detail = stderr.trim() || stdout.trim() || error.message;
        try {
          // ...as `{ "error": "..." }`; show the sentence, not the JSON.
          const parsed: unknown = JSON.parse(detail);
          const reported = (parsed as { error?: unknown } | null)?.error;
          if (typeof reported === "string") detail = reported;
        } catch {
          // Not JSON: the text is already the message.
        }
        resolve({ kind: "failed", message: detail });
      },
    );
  });
}

/**
 * Runs one git command that only reads, and gives its trimmed output.
 *
 * @returns The output, or null when git is missing, the folder is not a
 *   repository, or the command fails for any other reason. Callers treat
 *   null as "cannot tell".
 * Side effects: spawns a short-lived child process. Nothing is written:
 *   callers pass read-only commands only. The plugin never changes git.
 */
export function readGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error === null ? stdout.trim() : null),
    );
  });
}
