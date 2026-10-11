// server/github-comments.test.ts — tests for copying GitHub comments.
//
// What: checks the mark of a copied comment, which comments count as
// missing, and a whole run against made-up comments on both sides.
// Why: an import that copies a discussion twice, or loses its order or its
// authors, would spoil the context it is meant to bring (bead-bb-apc).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commentMark,
  copiedText,
  copyComments,
  missingComments,
} from "./github-comments.ts";
import type { RemoteComment } from "./github-comments.ts";

const repository = { owner: "me", name: "repo" };

/** A GitHub comment with unremarkable values. */
const remote = (id: number, at: string, text = `text ${id}`, author = "ann"): RemoteComment => ({
  url: `https://github.com/me/repo/issues/12#issuecomment-${id}`,
  author,
  at,
  text,
});

test("the mark says who wrote it on GitHub, when, and where the original is", () => {
  const comment = remote(501, "2025-03-04T14:20:31Z");
  assert.equal(
    commentMark(comment),
    "— @ann on GitHub, 2025-03-04 14:20 UTC: https://github.com/me/repo/issues/12#issuecomment-501",
  );
  assert.equal(copiedText(comment), `text 501\n\n${commentMark(comment)}`);
  // A comment with nothing in it still says where it is from.
  assert.match(copiedText(remote(502, "2025-03-04T14:20:31Z", "  ")), /^\(no text\)\n\n— @ann/u);
});

test("missing are the comments whose address no local comment carries, oldest first", () => {
  const first = remote(1, "2025-01-01T00:00:00Z");
  const second = remote(2, "2025-01-02T00:00:00Z");
  const third = remote(3, "2025-01-03T00:00:00Z");
  assert.deepEqual(
    missingComments([third, first, second], [copiedText(second), "a comment made in beads"]),
    [first, third],
  );
  assert.deepEqual(missingComments([first], [copiedText(first)]), []);
  // Comment 1's address is not found inside comment 10's.
  const tenth = remote(10, "2025-01-04T00:00:00Z");
  assert.deepEqual(missingComments([first], [copiedText(tenth)]), [first]);
});

/** A run over made-up comments; records what was added. */
async function run(
  onGithub: Record<number, RemoteComment[] | Error>,
  inBeads: Record<string, string[] | null>,
  issues: { number: number; beadId: string | null }[],
  preview = false,
  failing: string[] = [],
) {
  const added: { beadId: string; author: string; text: string }[] = [];
  const done = await copyComments({
    repository,
    token: "secret-token",
    issues,
    preview,
    readLocal: async (beadId) => inBeads[beadId] ?? null,
    add: async (beadId, author, text) => {
      if (failing.some((part) => text.includes(part))) return "bd said no";
      added.push({ beadId, author, text });
      (inBeads[beadId] ??= []).push(text);
      return null;
    },
    readRemote: async (_repository, _token, number) => {
      const found = onGithub[number] ?? [];
      if (found instanceof Error) throw found;
      return found;
    },
  });
  return { done, added };
}

test("comments are copied in their order, under their authors, and never twice", async () => {
  const onGithub = {
    12: [
      remote(2, "2025-01-02T00:00:00Z", "second", "bob"),
      remote(1, "2025-01-01T00:00:00Z", "first", "ann"),
    ],
  };
  const inBeads: Record<string, string[]> = { "x-1": ["made in beads"] };
  const issues = [{ number: 12, beadId: "x-1" }];
  const first = await run(onGithub, inBeads, issues);
  assert.equal(first.done.copied, 2);
  assert.deepEqual(
    first.added.map(({ author, text }) => [author, text.split("\n")[0]]),
    [
      ["ann", "first"],
      ["bob", "second"],
    ],
  );
  // Again: nothing new.
  const again = await run(onGithub, inBeads, issues);
  assert.equal(again.done.copied, 0);
  assert.deepEqual(again.added, []);
  // A comment added on GitHub since: only that one.
  onGithub[12].push(remote(3, "2025-01-03T00:00:00Z", "third", "ann"));
  const later = await run(onGithub, inBeads, issues);
  assert.equal(later.done.copied, 1);
  assert.equal(later.added[0]!.text.split("\n")[0], "third");
});

test("a preview counts and adds nothing; an issue not yet in beads counts all its comments", async () => {
  const onGithub = {
    12: [remote(1, "2025-01-01T00:00:00Z"), remote(2, "2025-01-02T00:00:00Z")],
    13: [remote(9, "2025-01-01T00:00:00Z")],
    14: [],
  };
  const { done, added } = await run(
    onGithub,
    { "x-1": [copiedText(onGithub[12][0]!)] },
    [
      { number: 12, beadId: "x-1" },
      { number: 13, beadId: null },
      { number: 14, beadId: null },
    ],
    true,
  );
  assert.equal(done.copied, 0);
  assert.deepEqual(added, []);
  assert.deepEqual(done.would, [
    "1 comment to copy from #12 to x-1",
    "1 comment to copy from #13",
  ]);
});

test("what goes wrong is a warning, and the rest still goes through", async () => {
  const { done, added } = await run(
    {
      12: new Error("GitHub answered 403 for secret-token"),
      13: [remote(1, "2025-01-01T00:00:00Z", "stays"), remote(2, "2025-01-02T00:00:00Z", "fails")],
      14: [remote(3, "2025-01-01T00:00:00Z")],
    },
    { "x-2": [], "x-3": null },
    [
      { number: 12, beadId: "x-1" },
      { number: 13, beadId: "x-2" },
      { number: 14, beadId: "x-3" },
    ],
    false,
    ["fails"],
  );
  assert.equal(done.copied, 1);
  assert.equal(added[0]!.text.split("\n")[0], "stays");
  assert.equal(done.warnings.length, 3);
  // The token never appears in a message.
  assert.ok(done.warnings.every((warning) => !warning.includes("secret-token")));
  assert.match(done.warnings[0]!, /#12 could not be read: GitHub answered 403 for \*\*\*/u);
  assert.match(done.warnings[1]!, /by @ann on #13 could not be copied to x-2: bd said no/u);
  assert.match(done.warnings[2]!, /comments of x-3 could not be read/u);
});
