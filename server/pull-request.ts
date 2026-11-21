// Read-only delivery evidence. Repository policy remains responsible for CI,
// reviews and merge queues; this boundary never requests or performs a merge.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { readGit } from "./bd.ts";

type CommandResult = { stdout: string } | { message: string };
interface Dependencies {
  git: (path: string, args: string[]) => Promise<string | null>;
  gh: (path: string, args: string[]) => Promise<CommandResult>;
}

const execFileAsync = promisify(execFile);

async function readGh(path: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd: path, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    return { stdout };
  } catch (cause) {
    return { message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Accept HTTPS and SSH origin URLs without guessing a repository from cwd. */
function repositoryAt(remote: string): { url: string; name: string } | null {
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/u.exec(remote);
  try {
    const url = new URL(scp !== null && !remote.includes("://")
      ? `ssh://${scp[1]}/${scp[2]}`
      : remote);
    if (!["https:", "ssh:", "http:"].includes(url.protocol)) return null;
    const name = url.pathname.replace(/^\//u, "").replace(/\.git\/?$/u, "").replace(/\/$/u, "");
    if (!/^[^/]+\/[^/]+$/u.test(name) || url.search !== "" || url.hash !== "") return null;
    return { url: `https://${url.hostname}/${name}`, name };
  } catch {
    return null;
  }
}

const repositorySchema = z.object({
  nameWithOwner: z.string(),
  defaultBranchRef: z.object({ name: z.string().min(1) }),
  url: z.string(),
});
const pullRequestsSchema = z.array(z.object({
  state: z.string(),
  mergedAt: z.string().nullable(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  url: z.string(),
}));

/**
 * Verifies a merged PR for origin's repository, the checked-out branch and
 * exact HEAD, targeting the repository's current default branch. Unknown or
 * unsupported hosting/auth state leaves delivery pending with a visible reason.
 * Only read-only git and gh queries are made; branches/worktrees are untouched.
 */
export async function verifyMergedPullRequest(
  path: string,
  { git, gh }: Dependencies = { git: readGit, gh: readGh },
): Promise<{ message: string } | { message: null; commit: string; recheck: () => Promise<string | null> }> {
  const pending = (why: string) => ({ message: `PR delivery is still pending: ${why}` });
  try {
    const [branch, head, remote, status] = await Promise.all([
      git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(path, ["rev-parse", "--verify", "HEAD"]),
      git(path, ["remote", "get-url", "origin"]),
      git(path, ["status", "--porcelain", "--untracked-files=normal"]),
    ]);
    if (!branch || !head || !/^[a-f0-9]{40,64}$/u.test(head) || !remote) {
      return pending("the current branch, commit or origin could not be read. Keep the checkout intact.");
    }
    if (status !== "") {
      return pending("the checkout has uncommitted changes or its status could not be read. Commit and deliver all work first.");
    }
    const origin = repositoryAt(remote);
    if (origin === null) return pending("origin's hosting repository could not be identified.");
    const repository = await gh(path, [
      "repo", "view", origin.url, "--json", "nameWithOwner,defaultBranchRef,url",
    ]);
    if ("message" in repository) return pending(`the repository could not be queried: ${repository.message}`);
    const repo = repositorySchema.parse(JSON.parse(repository.stdout));
    const base = repo.defaultBranchRef.name;
    const actual = repositoryAt(repo.url);
    if (
      repo.nameWithOwner.toLowerCase() !== origin.name.toLowerCase() ||
      actual?.url.toLowerCase() !== origin.url.toLowerCase()) {
      return pending("the repository identity or expected target branch could not be verified.");
    }
    if (branch === base) return pending("the checkout is on the target branch, not the PR's work branch.");
    const result = await gh(path, [
      "pr", "list", "--repo", origin.url, "--head", branch, "--state", "all", "--limit", "100",
      "--json", "state,mergedAt,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository,url",
    ]);
    if ("message" in result) return pending(`pull requests could not be queried: ${result.message}`);
    const pulls = pullRequestsSchema.parse(JSON.parse(result.stdout));
    const merged = pulls.some((pr) => {
      const source = pr.headRepository;
      return pr.state === "MERGED" &&
        pr.mergedAt !== null && Number.isFinite(Date.parse(pr.mergedAt)) &&
        pr.headRefName === branch && pr.headRefOid === head && pr.baseRefName === base &&
        pr.isCrossRepository === false && typeof source?.nameWithOwner === "string" &&
        source.nameWithOwner.toLowerCase() === origin.name.toLowerCase() &&
        typeof pr.url === "string" && pr.url.toLowerCase().startsWith(`${origin.url.toLowerCase()}/pull/`) &&
        /^\d+$/u.test(pr.url.slice(`${origin.url}/pull/`.length));
    });
    if (!merged) {
      return pending("no merged PR matches this repository, source branch, current commit and target. An open PR, review, checks or merge queue is not completion; keep the issue and checkout open.");
    }
    // The workflow also calls this after its tracker reread, immediately
    // before closing, so slow tracker I/O cannot stale the checkout evidence.
    const recheck = async (): Promise<string | null> => {
      try {
        const [nowBranch, nowHead, nowRemote, nowStatus] = await Promise.all([
          git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          git(path, ["rev-parse", "--verify", "HEAD"]),
          git(path, ["remote", "get-url", "origin"]),
          git(path, ["status", "--porcelain", "--untracked-files=normal"]),
        ]);
        return nowBranch !== branch || nowHead !== head || nowRemote !== remote || nowStatus !== ""
          ? pending("the checkout changed while delivery was being verified. Check the current branch, commit and uncommitted work again.").message
          : null;
      } catch (cause) {
        return pending(`the checkout could not be rechecked: ${cause instanceof Error ? cause.message : String(cause)}`).message;
      }
    };
    const changed = await recheck();
    return changed === null ? { message: null, commit: head, recheck } : { message: changed };
  } catch (cause) {
    return pending(`merge evidence could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
