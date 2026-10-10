// tracker/detect.test.ts — tests for finding a folder's tracker.
//
// What: checks detectTracker against throwaway folders: a `.beads` folder
// in the folder or above it, a git work tree whose `.beads` is only in the
// repository's main folder, a folder with no tracker at all, and the order
// in which a repository's setting file, a `.beads` folder and a GitHub
// remote decide which tracker is used.
//
// Why: the work-tree case is easy to lose. Beads itself finds its database
// from a work tree through git, so a caller that ran bd directly saw the
// issues there; detection by folder alone would say there is no tracker.
//
// Gotchas: needs the git program for the work-tree case, which is skipped
// where git is missing. Nothing here runs bd: detection only looks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readSetting } from "./config.ts";
import { detectTracker, parseGithubRemote } from "./detect.ts";
import { createFakeGitHub } from "./github-fake.ts";
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

// --- Which tracker, when a repository could use more than one (c9l.1) ---

/** A folder under the test's base with these files; ".beads/" makes a folder. */
function folder(name: string, files: Record<string, string> = {}): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith("/")) mkdirSync(join(root, file), { recursive: true });
    else writeFileSync(join(root, file), text);
  }
  return root;
}

/** The stand-in's connection, so that nothing is sent to GitHub. */
const githubClient = (repository: string) => createFakeGitHub({ repository });

/** "beads", or for GitHub which repository, for the tracker found. */
async function found(
  dir: string,
  accept?: readonly ("beads" | "github")[],
): Promise<string> {
  const { tracker } = detectTracker(dir, undefined, { accept, githubClient });
  // For beads this may try to run bd, which the adapter survives when bd
  // is missing or the folder holds no database; only the name is read.
  const capabilities = await tracker.capabilities();
  return capabilities.tracker === "beads" ? "beads" : capabilities.where;
}

test("a remote's address on github.com is read in every form git accepts", () => {
  for (const url of [
    "https://github.com/someone/thing.git",
    "https://github.com/someone/thing",
    "https://token@github.com/someone/thing.git",
    "git@github.com:someone/thing.git",
    "ssh://git@github.com/someone/thing.git",
    "https://github.com/someone/thing/",
  ]) {
    assert.equal(parseGithubRemote(url), "someone/thing", url);
  }
  assert.equal(parseGithubRemote("git@github.com:some.one/a-b_c.d.git"), "some.one/a-b_c.d");
  for (const url of [
    "https://gitlab.com/someone/thing.git",
    "git@example.com:someone/thing.git",
    "https://github.com/someone",
    "https://notgithub.com/someone/thing",
    "",
  ]) {
    assert.equal(parseGithubRemote(url), null, url);
  }
});

test("the setting file decides; without it beads wins over a GitHub remote", async (t) => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  const both = folder("both", { ".beads/": "" });
  const remoteOnly = folder("remote-only");
  try {
    for (const root of [both, remoteOnly]) {
      git(root, "init", "-q");
      git(root, "remote", "add", "origin", "git@github.com:someone/thing.git");
    }
  } catch {
    return t.skip("git is not available");
  }
  // Both a .beads folder and a GitHub remote: beads, as before.
  assert.equal(await found(both), "beads");
  // No .beads folder: the remote says GitHub.
  assert.match(await found(remoteOnly), /^someone\/thing on GitHub/u);
  // The repository says so itself: GitHub, though .beads is there.
  writeFileSync(join(both, ".bend.json"), '{"tracker": "github"}');
  assert.match(await found(both), /^someone\/thing on GitHub/u);
  // ...and it can name another repository than its remote.
  writeFileSync(
    join(both, ".bend.json"),
    '{"tracker": "github", "repository": "team/board"}',
  );
  assert.match(await found(both), /^team\/board on GitHub/u);
  assert.match(await found(join(folder("both/deep/er"))), /^team\/board on GitHub/u);
  // Only the repository is named: the remote still says "GitHub", the
  // setting says which repository.
  writeFileSync(join(remoteOnly, ".bend.json"), '{"repository": "team/board"}');
  assert.match(await found(remoteOnly), /^team\/board on GitHub/u);
  // Saying beads keeps beads, whatever the remote is.
  writeFileSync(join(remoteOnly, ".bend.json"), '{"tracker": "beads"}');
  assert.equal(await found(remoteOnly), "beads");

  // A caller that accepts beads only (the Airbender tab) is never given
  // GitHub: the setting is passed over, and a GitHub-only folder has no
  // tracker for it.
  assert.equal(await found(both, ["beads"]), "beads");
  rmSync(join(remoteOnly, ".bend.json"));
  assert.throws(
    () => detectTracker(remoteOnly, undefined, { accept: ["beads"], githubClient }),
    NotSetUp,
  );
});

test("a setting file that cannot be understood is refused, naming the file", () => {
  const cases: [string, string, RegExp][] = [
    ["bad-json", "{tracker: github", /not valid JSON/u],
    ["bad-shape", '["github"]', /must hold one object/u],
    ["bad-tracker", '{"tracker": "linear"}', /names the tracker "linear"/u],
    ["bad-repo", '{"tracker": "github", "repository": "just-a-name"}', /owner\/name/u],
  ];
  for (const [name, text, pattern] of cases) {
    const root = folder(name, { ".bend.json": text });
    assert.throws(
      () => readSetting(root),
      (cause) =>
        cause instanceof Refused &&
        pattern.test(cause.message) &&
        cause.message.includes(join(root, ".bend.json")),
      name,
    );
  }
  assert.equal(readSetting(folder("no-setting")), null);
  assert.deepEqual(readSetting(folder("empty-setting", { ".bend.json": "{}" })), {
    tracker: undefined,
    repository: undefined,
  });
  // GitHub is asked for, but nothing says which repository.
  const nowhere = folder("github-nowhere", { ".bend.json": '{"tracker": "github"}' });
  assert.throws(
    () => detectTracker(nowhere, undefined, { githubClient }),
    (cause) => cause instanceof Refused && /which repository cannot be told/u.test(cause.message),
  );
});
