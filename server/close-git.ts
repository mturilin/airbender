// close-git.ts — read-only Git evidence for an explicitly requested close.
//
// The panel never stages, commits or pushes. A supplied SHA must name a new
// commit on the requested branch and identify the issue (bead-bb-o6j). This
// proves where the commit is, not who owns every diff: the agent reviews that.
// The git commands run on the machine the folder is on (bead-bb-fyv); a
// stored request names its folder by folderKey.
import { readGit } from "./bd.ts";
import { folderOfKey } from "./machine.ts";
import type { Folder } from "./machine.ts";
import { readRepositoryKey } from "./workflow-choice.ts";
import { hasCloseChanges } from "./folder.ts";
import type { CloseGitState, CloseRequest } from "./simple-close.ts";

/** Identifies the whole issue id and title on one line, allowing repository
 * prefixes and punctuation. A longer issue id must not match its prefix. */
function identifiesIssue(text: string, id: string, title: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identity = new RegExp(`(^|[^a-zA-Z0-9_.-])${escaped}($|[^a-zA-Z0-9_.-])`);
  return text.split("\n").some((line) => identity.test(line) && line.includes(title));
}

/** Resolves a Standard workflow's reported commit, including abbreviated
 * SHAs. An absent SHA means no commit; an invalid report refuses closure. */
export async function reportedCloseCommit(path: Folder, note: string, id: string, title: string): Promise<string | undefined> {
  const candidates = note.match(/\b[a-f0-9]{7,64}\b/g) ?? [];
  for (const candidate of candidates) {
    const sha = await readGit(path, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (sha === null || await readGit(path, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) continue;
    // Standard permits a combined commit whose body lists each issue.
    const message = await readGit(path, ["show", "--no-patch", "--format=%B", sha]);
    if (message !== null && identifiesIssue(message, id, title)) return sha;
  }
  if (candidates.length > 0) throw new Error("The reported commit could not be verified for this issue on the current branch. Give its commit SHA, or explain that there was nothing to commit.");
  return undefined;
}

/** Returns the current branch/HEAD and all non-ignored changes, or null
 * outside Git. Refuses status read failures rather than treating them clean. */
export async function closeGitState(path: Folder): Promise<CloseGitState | null> {
  if (await readGit(path, ["rev-parse", "--show-toplevel"]) === null) return null;
  const changes = await hasCloseChanges(path);
  return { repository: await readRepositoryKey(path), branch: await readGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    head: await readGit(path, ["rev-parse", "--verify", "HEAD"]), changes };
}

/** Verifies a full SHA without relying on HEAD alone or requiring unrelated
 * work to be committed. All commands are argument arrays, without a shell. */
export async function verifyCloseCommit(request: CloseRequest, sha: string): Promise<string | null> {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) return "Give the full commit SHA.";
  const folder = folderOfKey(request.path);
  if (await readGit(folder, ["rev-parse", "--verify", `${sha}^{commit}`]) !== sha) return "That commit does not exist in the working repository.";
  if (await readGit(folder, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) return "The commit is not on the working branch.";
  if (request.baseline !== null && (sha === request.baseline || await readGit(folder, ["merge-base", "--is-ancestor", request.baseline, sha]) === null)) return "The commit predates this close request.";
  const subject = await readGit(folder, ["show", "--no-patch", "--format=%s", sha]);
  const expected = `${request.scope.beadId}: ${request.title}`;
  if (subject === null || !identifiesIssue(subject, request.scope.beadId, request.title)) return `The commit subject must identify this issue with its id and title: ${expected}`;
  return null;
}
