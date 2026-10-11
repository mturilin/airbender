// server/folder.ts — finding the folder, the beads and bend programs, and
// what git says about the folder.
//
// What: works out which folder on this machine a thread or project works
// in, finds the beads program among the places it may be installed, and
// reads the folder's git state (branch, work tree, uncommitted changes).
//
// Why: every request begins with the first two questions, and both have
// several plain-language ways to fail (the thread is on another machine, no
// project is picked, the folder is gone, beads is not installed). Answered
// once here, every caller reports them in the same words.
//
// Design notes:
// - A thread's own checkout wins over the project's default folder, because
//   it may be a worktree.
// - Issues are not read or changed here: that goes through the bend
//   program (server/bend.ts), which is handed what `findBd` and `findBend`
//   find.
//
// Gotchas:
// - A missing folder and a missing program look the same to the operating
//   system, so `folderFor` checks the folder first; without that a missing
//   folder would be reported as "bd not found".
// - The BB server may have a shorter PATH than a shell, which is why a list
//   of candidate locations is tried.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readGit, runBd } from "./bd.ts";
import { findBendAmong } from "./bend.ts";

/**
 * Builds the folder and bd helpers for this plugin instance.
 *
 * @param bdCandidates Program names or paths to try for bd, in order.
 * Side effects: none until one of them is called.
 */
export function createFolders({
  bb,
  bdCandidates,
  bendCandidates,
}: {
  bb: BbPluginApi;
  bdCandidates: string[];
  /** Program names or paths to try for bend, in order. */
  bendCandidates: string[];
}) {
  const BD_NOT_FOUND_MESSAGE =
    "BB could not find the bd command. Install beads, or set its full path under this plugin's settings (bd command) and reload the plugin.";

  /** What the tab says when there is no bend program, or only an old one. */
  const BEND_MESSAGES = {
    missing:
      "BB could not find the bend command, which Airbender reads and changes issues with. Build it with the setup step \"Build bend\", or set its full path under this plugin's settings (bend command) and reload the plugin.",
    old: "The bend command on this machine is older than this version of Airbender needs. Build it again with the setup step \"Build bend\".",
  };

  /**
   * The bend program that works on this machine: the first of the known
   * locations that runs and is new enough; else "missing" or "old".
   */
  const findBend = (cwd: string) => findBendAmong(bendCandidates, cwd);

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

  /**
   * Whether a folder is on a branch other than the repository's main one.
   *
   * The main branch is the remote's default where git knows it, else a
   * local branch called main or master. A work tree of the same repository
   * on its own branch counts as "own branch", which is the point: its work
   * has to be merged, not only committed.
   *
   * @returns False when on the main branch and when it cannot be told.
   * Side effects: up to three read-only git commands.
   */
  async function onOwnBranch(path: string): Promise<boolean> {
    const current = await readGit(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // "HEAD" is what git answers when no branch is checked out.
    if (current === null || current === "" || current === "HEAD") return false;
    const main = await mainBranch(path);
    return main !== null && main !== current;
  }

  /**
   * The branch a folder is on.
   *
   * @returns Null when no branch is checked out, and when it cannot be
   *   told (not a git folder).
   * Side effects: one read-only git command.
   */
  async function currentBranch(path: string): Promise<string | null> {
    const current = await readGit(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // "HEAD" is what git answers when no branch is checked out.
    return current === null || current === "" || current === "HEAD"
      ? null
      : current;
  }

  /**
   * The name of the repository's main branch: the remote's default where
   * git knows it, else a local branch called main or master.
   *
   * @returns Null when it cannot be told (not a git folder, neither found).
   * Side effects: up to two read-only git commands.
   */
  async function mainBranch(path: string): Promise<string | null> {
    const remoteDefault = await readGit(path, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    let main = remoteDefault?.replace(/^origin\//u, "") ?? null;
    if (main === null || main === "") {
      const local = await readGit(path, [
        "branch",
        "--list",
        "--format=%(refname:short)",
        "main",
        "master",
      ]);
      main = local?.split("\n")[0]?.trim() ?? null;
    }
    return main === null || main === "" ? null : main;
  }

  /**
   * The repository's main folder: the one a work tree belongs to, or the
   * folder itself when it is the main one. It outlives every work tree, so
   * it is the place to run something from later.
   *
   * @returns Null when it cannot be told (not a git folder).
   * Side effects: one read-only git command.
   */
  async function mainFolder(path: string): Promise<string | null> {
    // The main work tree is always listed first.
    const listed = await readGit(path, ["worktree", "list", "--porcelain"]);
    const first = listed?.split("\n")[0] ?? "";
    return first.startsWith("worktree ") ? first.slice("worktree ".length) : null;
  }

  /**
   * Whether a folder is a work tree of its repository and not the
   * repository's main folder.
   *
   * @returns False also when it cannot be told (not a git folder).
   * Side effects: two read-only git commands.
   */
  async function isWorkTree(path: string): Promise<boolean> {
    // Compared as git itself names them, so that a link in either path
    // does not make one folder look like two.
    const [top, main] = await Promise.all([
      readGit(path, ["rev-parse", "--show-toplevel"]),
      mainFolder(path),
    ]);
    return top !== null && top !== "" && main !== null && top !== main;
  }

  /**
   * Deletes a local branch whose every commit is already on the main
   * branch. The one git command of the plugin's that changes anything (see
   * server/work-trees.ts for why it cannot be left to the agent).
   *
   * The check is made here, against the main branch, and not left to
   * `git branch -d`: that one compares with whatever branch the folder
   * happens to be on, and would refuse a branch that is fully on main
   * whenever the folder is on some other branch. So: only when git confirms
   * the branch is an ancestor of the main branch is it deleted; nothing
   * that is not on main can be lost. Never the main branch itself; git
   * still refuses a branch a work tree holds.
   *
   * @returns Null when the branch is gone (deleted now, or not there);
   *   otherwise why it was left.
   * Side effects: up to four git commands; at most one branch deleted.
   */
  async function deleteMergedBranch(
    path: string,
    branch: string,
  ): Promise<string | null> {
    const main = await mainBranch(path);
    if (main === null) return "the main branch could not be found";
    if (branch === "" || branch === main) return "that is the main branch";
    const exists = await readGit(path, [
      "branch",
      "--list",
      "--format=%(refname:short)",
      branch,
    ]);
    if (exists === null) return "git could not be run in that folder";
    if (exists === "") return null;
    // Exit status 0 (an answer, though an empty one) means "is an ancestor".
    const onMain = await readGit(path, [
      "merge-base",
      "--is-ancestor",
      branch,
      main,
    ]);
    if (onMain === null) return `${branch} is not fully on ${main}`;
    return new Promise((resolve) => {
      execFile(
        "git",
        ["branch", "-D", "--", branch],
        { cwd: path, timeout: 10_000, maxBuffer: 64 * 1024 },
        (error, _stdout, stderr) =>
          resolve(error === null ? null : stderr.trim() || error.message),
      );
    });
  }

  /**
   * Whether the folder has uncommitted changes to files git tracks, staged
   * or not. Files git does not track at all are not counted: they belong
   * to no branch, and a repository with a few of them (editor settings,
   * local agent settings) would otherwise never count as clean.
   *
   * @returns False also when it cannot be told (not a git folder).
   * Side effects: one read-only git command.
   */
  async function hasUncommittedChanges(path: string): Promise<boolean> {
    const status = await readGit(path, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    return status !== null && status !== "";
  }

  return {
    onOwnBranch,
    currentBranch,
    isWorkTree,
    mainBranch,
    mainFolder,
    deleteMergedBranch,
    hasUncommittedChanges,
    BD_NOT_FOUND_MESSAGE,
    BEND_MESSAGES,
    findBend,
    resolveFolder,
    folderFor,
    findBd,
  };
}

/** What createFolders returns. */
export type Folders = ReturnType<typeof createFolders>;
