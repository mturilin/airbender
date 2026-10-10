// server/github-comments.ts — copying the comments of GitHub issues into
// the beads issues they were imported as.
//
// What: for issues that "Sync with GitHub" has brought in from GitHub,
// reads the comments on the GitHub issue and adds to the beads issue the
// ones it does not have yet, each under its GitHub author's name and
// marked with where it comes from.
//
// Why: the user wants old projects that lived in GitHub issues imported
// with their discussion, which "may contain important context"
// (bead-bb-apc). Beads' own `bd github sync` carries no comments, so this
// is a step of the plugin's on top of that command, run after it.
//
// Design notes:
// - A file of its own, at the user's wish ("Does it go in a separate
//   TypeScript file? So I don't want to make the whole application heavy
//   because this additional syncing code"). server/github.ts calls
//   `copyComments` once per batch and knows nothing else of it. Nothing
//   here runs unless a sync is started with "Copy comments" ticked.
// - The mark of a copied comment is its last line, which gives the address
//   of the original on GitHub. A comment is "already here" when one of the
//   beads issue's comments contains that address. Kept in the text, not in
//   the plugin's storage, so that it travels with the issue to another
//   computer. It names the origin, not merely "imported": copying in the
//   other direction, if it is ever built, can tell by it which comments
//   came from GitHub and must not be sent back.
// - One direction only: nothing is written to GitHub (the user: "I don't
//   need conversion in any different direction yet").
// - The author of a copied comment is the GitHub author (beads takes the
//   author from who acts). Its time in beads is the time of the copy:
//   beads cannot be given a past time, so the original time is in the
//   last line, and comments are added oldest first to keep their order.
//
// Gotchas:
// - A comment edited or deleted on GitHub after it was copied is not
//   followed.
// - One request to GitHub per issue at least: a large import is many.

import type { Repository } from "./github.ts";

/** A comment on a GitHub issue, as much of it as is copied. */
export interface RemoteComment {
  /** Its address on GitHub (ends in `#issuecomment-<id>`); the mark. */
  url: string;
  /** The author's login; "ghost" for an account that is gone. */
  author: string;
  /** When it was written (ISO, UTC). */
  at: string;
  text: string;
}

/**
 * The last line of a copied comment: who wrote it on GitHub, when, and the
 * original's address.
 */
export function commentMark(comment: RemoteComment): string {
  const when = comment.at.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/u, " UTC");
  return `— @${comment.author} on GitHub, ${when}: ${comment.url}`;
}

/** A comment's text as it is added to beads: the text, then its mark. */
export function copiedText(comment: RemoteComment): string {
  const text = comment.text.trim();
  return `${text === "" ? "(no text)" : text}\n\n${commentMark(comment)}`;
}

/**
 * The comments still to be copied, oldest first.
 *
 * @param remote The GitHub issue's comments, in any order.
 * @param local The texts of the beads issue's comments.
 * @returns Those whose address appears in none of `local`.
 */
export function missingComments(
  remote: readonly RemoteComment[],
  local: readonly string[],
): RemoteComment[] {
  // The address ends in a number: one comment's must not be found inside
  // another's that merely starts with the same digits (…-1 in …-10).
  const carries = (text: string, url: string) => {
    for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
      if (!/\d/u.test(text.charAt(at + url.length))) return true;
    }
    return false;
  };
  return remote
    .filter((comment) => !local.some((text) => carries(text, comment.url)))
    .sort((left, right) => left.at.localeCompare(right.at));
}

/** "1 comment", "3 comments". */
export const comments = (count: number) =>
  `${count} ${count === 1 ? "comment" : "comments"}`;

/**
 * Reads every comment of one GitHub issue.
 *
 * @throws With GitHub's refusal in plain words; the token is never in it.
 * Side effects: one request per hundred comments; nothing is written.
 */
async function read(
  repository: Repository,
  token: string,
  number: number,
): Promise<RemoteComment[]> {
  const found: RemoteComment[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository.owner}/${repository.name}/issues/${number}/comments?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "airbender-bb-plugin",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const rows = (await response.json()) as {
      html_url: string;
      body?: string | null;
      created_at: string;
      user?: { login?: string } | null;
    }[];
    for (const row of rows) {
      found.push({
        url: row.html_url,
        author: row.user?.login ?? "ghost",
        at: row.created_at,
        text: row.body ?? "",
      });
    }
    if (rows.length < 100) return found;
  }
}

/** What a run of `copyComments` did, or would do. */
export interface CommentsCopied {
  /** Comments added to beads (0 in a preview). */
  copied: number;
  /** For a preview: what would be copied, a line per issue that has any. */
  would: string[];
  /** What went wrong, per issue or comment; the rest still went through. */
  warnings: string[];
}

/**
 * Copies the comments of some GitHub issues into their beads issues.
 *
 * @param issues Each GitHub issue with the beads issue it is imported as;
 *   `beadId` null for one that is not in beads (only in a preview, where
 *   every one of its comments counts as still to copy).
 * @param preview Only count; add nothing.
 * @param readLocal The texts of a beads issue's comments, or null when
 *   they cannot be read (the issue is then passed over, with a warning).
 * @param add Adds one comment to a beads issue under an author's name;
 *   resolves to why it could not, or null.
 * @param readRemote Reads a GitHub issue's comments; replaced in tests.
 * @returns What was done. Never throws: a failure is a warning.
 * Side effects: read requests to GitHub; without `preview`, one comment
 *   added to beads per missing comment. Nothing is written to GitHub.
 */
export async function copyComments({
  repository,
  token,
  issues,
  preview,
  readLocal,
  add,
  readRemote = read,
}: {
  repository: Repository;
  token: string;
  issues: { number: number; beadId: string | null }[];
  preview: boolean;
  readLocal: (beadId: string) => Promise<string[] | null>;
  add: (beadId: string, author: string, text: string) => Promise<string | null>;
  readRemote?: typeof read;
}): Promise<CommentsCopied> {
  const done: CommentsCopied = { copied: 0, would: [], warnings: [] };
  for (const { number, beadId } of issues) {
    let remote: RemoteComment[];
    try {
      remote = await readRemote(repository, token, number);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      done.warnings.push(
        `The comments of #${number} could not be read: ${why.split(token).join("***")}`,
      );
      continue;
    }
    if (remote.length === 0) continue;
    const local = beadId === null ? [] : await readLocal(beadId);
    if (local === null) {
      done.warnings.push(
        `The comments of ${beadId} could not be read, so none were copied from #${number}.`,
      );
      continue;
    }
    const missing = missingComments(remote, local);
    if (missing.length === 0) continue;
    if (preview || beadId === null) {
      done.would.push(
        `${comments(missing.length)} to copy from #${number}${beadId === null ? "" : ` to ${beadId}`}`,
      );
      continue;
    }
    for (const comment of missing) {
      const failed = await add(beadId, comment.author, copiedText(comment));
      if (failed === null) done.copied += 1;
      else {
        done.warnings.push(
          `A comment by @${comment.author} on #${number} could not be copied to ${beadId}: ${failed}`,
        );
      }
    }
  }
  return done;
}
