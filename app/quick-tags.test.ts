// app/quick-tags.test.ts — tests for quick tags in a new issue's title.
//
// What: checks reading tags out of a typed title (parseQuickTags), finding
// the tag under the caret (tagAtCaret) and suggesting completions
// (suggestTags).
//
// Why: the tags change what gets created (type, priority, category) and
// what is left as the title, so a slip here creates wrong issues quietly.
//
// Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuickTags, suggestTags, tagAtCaret } from "./quick-tags.ts";

test("type and priority tags are taken out of the title", () => {
  assert.deepEqual(parseQuickTags("Fix login #bug #p1"), {
    title: "Fix login",
    type: "bug",
    priority: 1,
    category: null,
  });
});

test("a word after # that is not a tag stays in the title", () => {
  assert.deepEqual(parseQuickTags("Fix #login now"), {
    title: "Fix #login now",
    type: null,
    priority: null,
    category: null,
  });
});

test("tags work anywhere, in any case; the last of a kind wins", () => {
  assert.deepEqual(parseQuickTags("#task #feature thing #P0"), {
    title: "thing",
    type: "feature",
    priority: 0,
    category: null,
  });
});

test("a title without tags is unchanged", () => {
  assert.deepEqual(parseQuickTags("plain title"), {
    title: "plain title",
    type: null,
    priority: null,
    category: null,
  });
});

test("$name sets the category", () => {
  const tags = parseQuickTags("x $ux");
  assert.equal(tags.category, "ux");
  assert.equal(tags.title, "x");
});

test("the tag under the caret is found only when the word starts with # or $", () => {
  assert.deepEqual(tagAtCaret("Fix #bu", 7), { start: 4, token: "#bu" });
  assert.deepEqual(tagAtCaret("Fix $u", 6), { start: 4, token: "$u" });
  assert.equal(tagAtCaret("Fix bu", 6), null);
  assert.equal(tagAtCaret("Fix #bug now", 12), null);
});

test("suggestions complete types and priorities after #, categories after $", () => {
  assert.deepEqual(suggestTags("#b", ["backend"]), [
    { label: "#bug", kind: "type", value: "bug" },
  ]);
  assert.deepEqual(
    suggestTags("#p", []).map((suggestion) => suggestion.label),
    ["#p0", "#p1", "#p2", "#p3", "#p4"],
  );
  assert.deepEqual(
    suggestTags("$", ["ux", "api"]).map((suggestion) => suggestion.value),
    ["ux", "api"],
  );
});
