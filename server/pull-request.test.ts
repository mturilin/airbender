import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMergedPullRequest } from "./pull-request.ts";

const sha = "a".repeat(40);
const repo = {
  nameWithOwner: "example/project",
  defaultBranchRef: { name: "trunk" },
  url: "https://github.com/example/project",
};
const merged = {
  state: "MERGED",
  mergedAt: "2026-01-01T00:00:00Z",
  headRefName: "feature",
  headRefOid: sha,
  baseRefName: "trunk",
  isCrossRepository: false,
  headRepository: { nameWithOwner: "example/project" },
  url: "https://github.com/example/project/pull/42",
};

function fixture({
  prs = [merged] as unknown[],
  repository = repo as unknown,
  failure = false,
  changed = false,
  remote = "git@github.com:example/project.git",
} = {}) {
  const commands: string[][] = [];
  let headReads = 0;
  return {
    commands,
    dependencies: {
      git: async (_path: string, args: string[]) => {
        commands.push(["git", ...args]);
        if (args[0] === "symbolic-ref") return "feature";
        if (args[0] === "rev-parse") {
          headReads += 1;
          return changed && headReads > 1 ? "b".repeat(40) : sha;
        }
        if (args[0] === "remote") return remote;
        if (args[0] === "status") return "";
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      gh: async (_path: string, args: string[]) => {
        commands.push(["gh", ...args]);
        if (failure) return { message: "authentication unavailable" };
        return { stdout: JSON.stringify(args[0] === "repo" ? repository : prs) };
      },
    },
  };
}

test("only a merged PR for this repository, branch, HEAD and default base verifies delivery", async () => {
  const { dependencies } = fixture();
  assert.equal((await verifyMergedPullRequest("/checkout", dependencies)).message, null);
});

test("open, queued, closed-unmerged, absent and mismatched PRs remain pending", async () => {
  const candidates = [
    [],
    [{ ...merged, state: "OPEN", mergedAt: null }],
    [{ ...merged, state: "CLOSED", mergedAt: null }],
    [{ ...merged, mergedAt: null }],
    [{ ...merged, headRefOid: "b".repeat(40) }],
    [{ ...merged, headRefName: "other-feature" }],
    [{ ...merged, baseRefName: "release" }],
    [{ ...merged, isCrossRepository: true }],
    [{ ...merged, headRepository: { nameWithOwner: "other/project" } }],
    [{ ...merged, url: "https://github.com/other/project/pull/42" }],
    [{ ...merged, url: "https://other.example/example/project/pull/42" }],
  ];
  for (const prs of candidates) {
    const result = await verifyMergedPullRequest("/checkout", fixture({ prs }).dependencies);
    assert.equal(typeof result.message, "string", JSON.stringify(prs));
  }
});

test("unknown repository, authentication failure and a changing HEAD fail closed", async () => {
  for (const options of [
    { repository: { ...repo, nameWithOwner: "other/project" } },
    { repository: { ...repo, defaultBranchRef: null } },
    { failure: true },
    { changed: true },
    { remote: "not-a-repository-url" },
  ]) {
    assert.equal(
      typeof (await verifyMergedPullRequest("/checkout", fixture(options).dependencies)).message,
      "string",
    );
  }
});

test("malformed and failed command responses cannot verify a merge", async () => {
  const { dependencies } = fixture();
  for (const stdout of ["not json", "null", "{}", "[]"]) {
    const result = await verifyMergedPullRequest("/checkout", {
      ...dependencies,
      gh: async () => ({ stdout }),
    });
    assert.equal(typeof result.message, "string");
  }
  assert.equal(typeof (await verifyMergedPullRequest("/checkout", {
    ...dependencies,
    git: async () => null,
  })).message, "string");
});

test("failed or unreadable PR queries remain pending even after the repository was identified", async () => {
  for (const response of [
    { message: "authentication failed" },
    { stdout: "not JSON" },
    { stdout: "{}" },
    { stdout: "null" },
  ]) {
    const { dependencies } = fixture();
    const result = await verifyMergedPullRequest("/checkout", {
      ...dependencies,
      gh: async (path, args) => args[0] === "pr" ? response : dependencies.gh(path, args),
    });
    assert.equal(typeof result.message, "string");
  }
});

test("a detached checkout, base-branch checkout or changed branch cannot complete delivery", async () => {
  for (const branches of [[null], ["trunk"], ["feature", "other-feature"]]) {
    const { dependencies } = fixture();
    let reads = 0;
    const result = await verifyMergedPullRequest("/checkout", {
      ...dependencies,
      git: async (path, args) => args[0] === "symbolic-ref"
        ? branches[Math.min(reads++, branches.length - 1)]
        : dependencies.git(path, args),
    });
    assert.equal(typeof result.message, "string");
  }
});

test("dirty, unreadable, or concurrently changed checkouts cannot reuse an old merged PR", async () => {
  for (const states of [[" M file.ts"], ["?? new.ts"], [null], ["", " M file.ts"]]) {
    const { dependencies } = fixture();
    let reads = 0;
    const result = await verifyMergedPullRequest("/checkout", {
      ...dependencies,
      git: async (path, args) => args[0] === "status"
        ? states[Math.min(reads++, states.length - 1)]
        : dependencies.git(path, args),
    });
    assert.equal(typeof result.message, "string");
  }
});

test("changing the hosting repository during verification keeps delivery pending", async () => {
  const { dependencies } = fixture();
  let reads = 0;
  const result = await verifyMergedPullRequest("/checkout", {
    ...dependencies,
    git: async (path, args) => args[0] === "remote" && reads++ > 0
      ? "https://github.com/other/project"
      : dependencies.git(path, args),
  });
  assert.equal(typeof result.message, "string");
});

test("merged evidence can be rechecked after tracker I/O before closing", async () => {
  const { dependencies } = fixture();
  let dirty = false;
  const evidence = await verifyMergedPullRequest("/checkout", {
    ...dependencies,
    git: async (path, args) => args[0] === "status"
      ? (dirty ? " M changed.ts" : "")
      : dependencies.git(path, args),
  });
  assert.equal(evidence.message, null);
  dirty = true;
  assert.equal(typeof await evidence.recheck(), "string");
});
