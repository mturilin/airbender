// close-git.test.ts — real Git evidence in disposable, hook-free repos.
// Tests never stage or commit anything in the user's checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeGitState, verifyCloseCommit, reportedCloseCommit } from "./close-git.ts";
import type { CloseRequest } from "./simple-close.ts";

test("completion verifies the issue commit and preserves unrelated dirty work", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "airbender-close-git-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: path, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" },
  }).trim();
  git("init", "-q", "--initial-branch=main");
  git("commit", "--allow-empty", "-qm", "Baseline");
  const baseline = git("rev-parse", "HEAD");
  writeFileSync(join(path, "issue.txt"), "work\n");
  const state = await closeGitState(path); assert.equal(state?.changes, true);
  const request = { path, title: "Work", scope: { beadId: "issue-1" }, baseline } as CloseRequest;
  assert.match((await verifyCloseCommit(request, baseline))!, /predates/);
  git("add", "--", "issue.txt"); git("commit", "-qm", "issue-1: Work");
  const commit = git("rev-parse", "HEAD");
  assert.equal(await reportedCloseCommit(path, `Committed ${commit.slice(0, 8)}`, "issue-1", "Work"), commit);
  assert.equal(await reportedCloseCommit(path, "No files changed", "issue-1", "Work"), undefined);
  await assert.rejects(reportedCloseCommit(path, "Committed deadbeef", "issue-1", "Work"), /could not be verified/);
  writeFileSync(join(path, "unrelated.txt"), "keep\n");
  assert.equal(await verifyCloseCommit(request, commit), null);
  assert.equal((await closeGitState(path))?.changes, true);
  git("commit", "--allow-empty", "-qm", "fix(issue-1): Work");
  assert.equal(await verifyCloseCommit(request, git("rev-parse", "HEAD")), null);
  git("commit", "--allow-empty", "-qm", "issue-12: Work");
  assert.match((await verifyCloseCommit(request, git("rev-parse", "HEAD")))!, /subject/);
  git("commit", "--allow-empty", "-qm", "Shared parent work", "-m", "issue-1: Work\nissue-2: Shared fix");
  const combined = git("rev-parse", "HEAD");
  assert.equal(await reportedCloseCommit(path, `Committed ${combined}`, "issue-2", "Shared fix"), combined);
  assert.match((await verifyCloseCommit(request, combined))!, /subject/);
  git("commit", "--allow-empty", "-qm", "Some other issue");
  assert.match((await verifyCloseCommit(request, git("rev-parse", "HEAD")))!, /subject/);
  assert.match((await verifyCloseCommit(request, "c".repeat(40)))!, /does not exist/);
});
