// tracker/detect.test.ts — tests for finding a folder's tracker.
//
// What: checks detectTracker against throwaway folders: a `.beads` folder
// in the folder or above it, a git work tree whose `.beads` is only in the
// repository's main folder, and a folder with no tracker at all.
//
// Why: the work-tree case is easy to lose. Beads itself finds its database
// from a work tree through git, so a caller that ran bd directly saw the
// issues there; detection by folder alone would say there is no tracker.
//
// Gotchas: needs the git program for the work-tree case, which is skipped
// where git is missing. Nothing here runs bd: detection only looks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { detectTracker } from "./detect.ts";
import { NotSetUp, Refused } from "./types.ts";

// Resolved, because git names folders by their real path and the system's
// temporary folder is a link on some machines.
const base = realpathSync(mkdtempSync(join(tmpdir(), "bend-detect-")));
after(() => rmSync(base, { recursive: true, force: true }));

test("a .beads folder is found in the folder or above it", () => {
  const root = join(base, "plain");
  mkdirSync(join(root, ".beads"), { recursive: true });
  mkdirSync(join(root, "deep", "er"), { recursive: true });
  assert.equal(detectTracker(root).root, root);
  assert.equal(detectTracker(join(root, "deep", "er")).root, root);
});

test("a folder with no tracker is 'not set up', and a missing folder is refused", () => {
  const bare = join(base, "bare");
  mkdirSync(bare);
  assert.throws(() => detectTracker(bare), NotSetUp);
  assert.throws(
    () => detectTracker(join(base, "missing")),
    (cause) => cause instanceof Refused && !(cause instanceof NotSetUp),
  );
});

test("a work tree without a .beads folder uses the main folder's", (t) => {
  const main = join(base, "main");
  const tree = join(base, "tree");
  mkdirSync(main);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
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
  try {
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "start");
    git(main, "worktree", "add", "-q", tree, "-b", "tree");
  } catch {
    return t.skip("git is not available");
  }
  // Not checked in, so the work tree has none of its own.
  mkdirSync(join(main, ".beads"));
  assert.equal(detectTracker(main).root, main);
  assert.equal(detectTracker(tree).root, main);
});
