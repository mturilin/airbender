// server/bd.ts — running bd and git in a folder.
//
// What: the one way the plugin runs `bd` (`runBd`) and `git` (`readGit`,
// `runGit`) in a folder, on whichever machine the folder is on, plus two
// helpers for shell commands: quoting text and finding out whether a
// program is installed there.
//
// Why: one place decides the timeout, the output limit and how a missing
// program differs from a failed one; and since a folder may be on another
// machine (bead-bb-fyv), every run goes through that machine
// (server/machine.ts).
//
// Gotchas:
// - A missing program and a missing working folder look the same; callers
//   check the folder first.
// - A machine that cannot be reached is a failed run here ("failed" for bd,
//   null for git): callers already treat those as "cannot tell".

import { machineOf } from "./machine.ts";
import type { Folder } from "./machine.ts";

/** Longest we wait for one `bd` run before giving up. */
const BD_TIMEOUT_MS = 20_000;

/** Upper bound on `bd` output we are willing to buffer (16 MiB). */
const BD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Longest we wait for one `git` command. */
const GIT_TIMEOUT_MS = 10_000;

/** Wraps text in single quotes for a shell, safe for any content. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Whether a program can be found on the machine a folder is on: on its
 * PATH, or in a few places tools are commonly installed that a desktop
 * app's PATH tends to miss.
 */
export function programExists(at: Folder | string, name: string): Promise<boolean> {
  return machineOf(at).hasProgram(name);
}

/** Outcome of one `bd` run: its standard output, or why it did not run. */
export type BdRun =
  | { kind: "ok"; stdout: string; stderr: string }
  | { kind: "not-found" }
  | {
      kind: "failed";
      message: string;
      /** What bd printed, for a caller that reads its own words in it. */
      stdout: string;
      stderr: string;
      /** The machine could not be reached: bd did not run, or may not have. */
      unreachable?: true;
    };

/**
 * Runs one `bd` command in a folder, on the folder's machine.
 *
 * @param command Program name or absolute path to try.
 * @param args Arguments, passed without a shell so nothing is interpreted.
 * @param options Extra environment, a longer timeout, a larger output.
 * @returns "ok" with stdout, "not-found" when the program does not exist
 *   (so the caller can try another location), or "failed" with bd's own
 *   error text. Never throws.
 * Side effects: one short-lived process on that machine; what it changes is
 *   up to the command (most callers pass `--readonly`).
 */
export async function runBd(
  folder: Folder,
  command: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    /** Told what bd prints as it prints it. */
    onOutput?: (text: string) => void;
  } = {},
): Promise<BdRun> {
  const ran = await machineOf(folder).run({
    program: command,
    args,
    cwd: folder.path,
    env: options.env,
    timeoutMs: options.timeoutMs ?? BD_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? BD_MAX_OUTPUT_BYTES,
    onOutput: options.onOutput,
  });
  if (ran.kind === "not-found") return ran;
  if (ran.kind === "unreachable") {
    return { kind: "failed", message: ran.message, stdout: "", stderr: "", unreachable: true };
  }
  if (ran.error === null) return { kind: "ok", stdout: ran.stdout, stderr: ran.stderr };
  // With --json, bd may report its error on standard output instead.
  let detail = ran.stderr.trim() || ran.stdout.trim() || ran.error;
  try {
    // ...as `{ "error": "..." }`; show the sentence, not the JSON.
    const parsed: unknown = JSON.parse(detail);
    const reported = (parsed as { error?: unknown } | null)?.error;
    if (typeof reported === "string") detail = reported;
  } catch {
    // Not JSON: the text is already the message.
  }
  return { kind: "failed", message: detail, stdout: ran.stdout, stderr: ran.stderr };
}

/**
 * Runs one git command that only reads, and gives its trimmed output.
 *
 * @returns The output, or null when git is missing, the folder is not a
 *   repository, the machine cannot be reached, or the command fails for any
 *   other reason. Callers treat null as "cannot tell".
 * Side effects: one short-lived process on the folder's machine. Nothing is
 *   written: callers pass read-only commands only. The plugin changes git in
 *   one place only, through `runGit` (deleteMergedBranch in server/folder.ts).
 */
export async function readGit(folder: Folder, args: string[]): Promise<string | null> {
  const ran = await runGit(folder, args);
  return ran.ok ? ran.stdout.trim() : null;
}

/**
 * Runs one git command in a folder, on the folder's machine.
 *
 * @returns Its output when it exited 0; otherwise git's own words (or why
 *   it could not run).
 */
export async function runGit(
  folder: Folder,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  const ran = await machineOf(folder).run({
    program: "git",
    args,
    cwd: folder.path,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  });
  if (ran.kind === "not-found") return { ok: false, message: "git was not found" };
  if (ran.kind === "unreachable") return { ok: false, message: ran.message };
  if (ran.error === null) return { ok: true, stdout: ran.stdout };
  return { ok: false, message: ran.stderr.trim() || ran.error };
}
