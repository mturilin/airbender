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

const { hasUncommittedChanges } = createFolders({
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

test("a folder that is not a git repository counts as clean", async () => {
  assert.equal(await hasUncommittedChanges(tmpdir()), false);
});
