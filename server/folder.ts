// server/folder.ts — finding the folder and running bd in it.
//
// What: works out which folder on this machine a thread or project works
// in, and runs the beads program there, trying the places it may be
// installed.
//
// Why: every request begins with these two questions, and both have several
// plain-language ways to fail (the thread is on another machine, no project
// is picked, the folder is gone, beads is not installed). Answered once
// here, every caller reports them in the same words.
//
// Design notes:
// - A thread's own checkout wins over the project's default folder, because
//   it may be a worktree.
// - `runBdIn` gives the raw outcome, for the few callers that must tell a
//   missing program from a failed command. `runIn` turns either into a
//   message, which is what nearly every caller wants.
//
// Gotchas:
// - A missing folder and a missing program look the same to the operating
//   system, so `folderFor` checks the folder first; without that a missing
//   folder would be reported as "bd not found".
// - The BB server may have a shorter PATH than a shell, which is why a list
//   of candidate locations is tried.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync } from "node:fs";
import { runBd } from "./bd.ts";
import type { BdRun } from "./bd.ts";

/**
 * Builds the folder and bd helpers for this plugin instance.
 *
 * @param bdCandidates Program names or paths to try for bd, in order.
 * Side effects: none until one of them is called.
 */
export function createFolders({
  bb,
  bdCandidates,
}: {
  bb: BbPluginApi;
  bdCandidates: string[];
}) {
  const BD_NOT_FOUND_MESSAGE =
    "BB could not find the bd command. Install beads, or set its full path under this plugin's settings (bd command) and reload the plugin.";

  /**
   * Finds the folder on the BB server machine that a thread or project works
   * in.
   *
   * A thread's own checkout wins (it may be a worktree); otherwise the
   * project's default folder is used.
   *
   * @returns `{ path }`, or `{ reason }` in plain language when there is no
   *   folder on this machine to look in.
   */
  async function resolveFolder(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<{ path: string } | { reason: string }> {
    const { primaryHostId } = await bb.sdk.system.config();
    let projectId = input.projectId;
    if (input.threadId !== null) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      projectId = thread.projectId;
      if (thread.environmentId !== null) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        if (environment.hostId !== primaryHostId) {
          return {
            reason:
              "This thread works on another machine. The Airbender tab can only read folders on the machine BB itself runs on.",
          };
        }
        if (environment.path !== null) return { path: environment.path };
      }
    }
    if (projectId === null) {
      return { reason: "Pick a project to see its beads issues." };
    }
    const project = await bb.sdk.projects.get({ projectId });
    const local = project.sources.filter(
      (source) => source.hostId === primaryHostId,
    );
    const source = local.find((candidate) => candidate.isDefault) ?? local[0];
    if (source === undefined) {
      return {
        reason:
          "This project has no folder on the machine BB itself runs on, so there is nowhere to look for beads issues.",
      };
    }
    return { path: source.path };
  }

  /**
   * The folder for a request, checked to exist.
   *
   * @returns `{ path }`, or the reason in plain words. `path` comes with the
   *   reason when a folder was found but is not there any more, so the tab
   *   can still show which folder was meant.
   */
  async function folderFor(input: {
    threadId: string | null;
    projectId: string | null;
  }): Promise<{ path: string } | { message: string; path: string | null }> {
    const folder = await resolveFolder(input);
    if ("reason" in folder) return { message: folder.reason, path: null };
    if (!existsSync(folder.path)) {
      return {
        message: `The folder ${folder.path} does not exist on the machine BB runs on.`,
        path: folder.path,
      };
    }
    return folder;
  }

  /**
   * Runs `bd` in a folder, trying each known install location until one
   * exists.
   *
   * @returns The first run that found a program, or "not-found" if none did.
   */
  async function runBdIn(path: string, args: string[]): Promise<BdRun> {
    let run: BdRun = { kind: "not-found" };
    for (const candidate of bdCandidates) {
      run = await runBd(candidate, args, path);
      if (run.kind !== "not-found") break;
    }
    return run;
  }

  /**
   * Runs bd in a folder and turns either kind of failure into a message.
   *
   * @param what When given, a failed command is written to the plugin's log
   *   under this name (e.g. "bd update"). Left out for plain reads, whose
   *   failures are shown to the user and need no log line.
   * @returns bd's standard output, or the reason in plain words.
   */
  async function runIn(
    path: string,
    args: string[],
    what?: string,
  ): Promise<{ stdout: string } | { message: string }> {
    const run: BdRun = await runBdIn(path, args);
    if (run.kind === "not-found") return { message: BD_NOT_FOUND_MESSAGE };
    if (run.kind === "failed") {
      if (what !== undefined) {
        bb.log.warn(what + " failed in " + path + ": " + run.message);
      }
      return { message: run.message };
    }
    return { stdout: run.stdout };
  }

  /**
   * The beads program that works on this machine: the first of the known
   * locations that runs, or null. Used where the program's own path is
   * needed (to put it in a terminal command), not just its output.
   */
  async function findBd(cwd: string): Promise<string | null> {
    for (const candidate of bdCandidates) {
      const run = await runBd(candidate, ["--version"], cwd);
      if (run.kind !== "not-found") return candidate;
    }
    return null;
  }

  return {
    BD_NOT_FOUND_MESSAGE,
    resolveFolder,
    folderFor,
    runBdIn,
    runIn,
    findBd,
  };
}

/** What createFolders returns. */
export type Folders = ReturnType<typeof createFolders>;
