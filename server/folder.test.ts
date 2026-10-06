// server/folder.test.ts — tests for what the plugin reads from git.
//
// What: checks hasUncommittedChanges, which decides whether an issue may be
// started in a new branch, against a real throwaway git repository.
//
// Why: the user's rule (bead-bb-jqn.1) is that a branch cannot be started
// over uncommitted changes. Files git does not track must not count, or a
// repository that keeps a few of them around could never start a branch.
//
// Gotchas: needs the git program; the repository is made in the system's
// temporary folder and removed afterwards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFolders } from "./folder.ts";

const root = mkdtempSync(join(tmpdir(), "airbender-folder-"));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      // The user's own git settings (hooks that run on every commit, a
      // signing key) must not reach this throwaway repository.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

const { hasUncommittedChanges, mainBranch, mainFolder, deleteMergedBranch } =
  createFolders({
  bb: {} as BbPluginApi,
  bdCandidates: [],
});

test("a folder is clean until a tracked file changes; untracked files do not count", async () => {
  git("init", "-q");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git("add", "tracked.txt");
  git("commit", "-q", "-m", "first");
  assert.equal(await hasUncommittedChanges(root), false);
  // A file git has never been told about is not a change to any branch.
  writeFileSync(join(root, "local-settings.json"), "{}\n");
  assert.equal(await hasUncommittedChanges(root), false);
  // An edit to a tracked file is, staged or not.
  writeFileSync(join(root, "tracked.txt"), "two\n");
  assert.equal(await hasUncommittedChanges(root), true);
  git("add", "tracked.txt");
  assert.equal(await hasUncommittedChanges(root), true);
  git("commit", "-q", "-m", "second");
  assert.equal(await hasUncommittedChanges(root), false);
});

test("a branch is deleted only when everything on it is on the main branch", async () => {
  // Continues in the repository the test above made.
  const main = await mainBranch(root);
  assert.ok(main === "main" || main === "master", String(main));
  const branches = () => git("branch", "--format=%(refname:short)").toString().trim().split("\n");
  // A branch with a commit of its own is left alone, and says why.
  git("switch", "-q", "-c", "unmerged");
  writeFileSync(join(root, "tracked.txt"), "three\n");
  git("commit", "-q", "-am", "third");
  git("switch", "-q", main!);
  assert.match((await deleteMergedBranch(root, "unmerged")) ?? "", /not fully on/u);
  assert.ok(branches().includes("unmerged"));
  // Once the main branch has it, the branch goes, even while the folder
  // itself is on some other branch.
  git("merge", "-q", "--ff-only", "unmerged");
  git("switch", "-q", "-c", "elsewhere", "HEAD~1");
  assert.equal(await deleteMergedBranch(root, "unmerged"), null);
  assert.ok(!branches().includes("unmerged"));
  // The main branch is never deleted; a branch that is not there is fine.
  assert.match((await deleteMergedBranch(root, main!)) ?? "", /main branch/u);
  assert.equal(await deleteMergedBranch(root, "never-existed"), null);
  assert.ok(branches().includes(main!));
});

test("a work tree knows the repository's main folder", async () => {
  // Continues in the repository the tests above made.
  const tree = join(root, "..", `airbender-tree-${process.pid}`);
  git("worktree", "add", "-q", "-b", "in-a-tree", tree);
  try {
    assert.equal(await mainFolder(tree), await mainFolder(root));
    assert.ok((await mainFolder(root))?.endsWith(root.split("/").pop()!));
  } finally {
    git("worktree", "remove", "--force", tree);
  }
});

test("a folder that is not a git repository counts as clean", async () => {
  assert.equal(await hasUncommittedChanges(tmpdir()), false);
});
