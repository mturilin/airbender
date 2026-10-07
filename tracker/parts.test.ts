// tracker/parts.test.ts — tests for the pure text helpers.
//
// What: checks keeping a part as a marked section inside another text,
// tidying category names, and the shape of a hand-over.
//
// Why: requirements live inside the description on trackers without a field
// for them; a slip here would lose or duplicate an issue's text.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanCategory,
  handoverText,
  joinSection,
  splitSection,
} from "./parts.ts";
import { Refused, UsageError } from "./types.ts";

test("a section put into a text comes back out unchanged", () => {
  const joined = joinSection("What is wanted.", "requirements", "Requirements", "1. A\n2. B");
  assert.match(joined, /^What is wanted\./u);
  assert.match(joined, /## Requirements/u);
  assert.deepEqual(splitSection(joined, "requirements"), {
    rest: "What is wanted.",
    section: "1. A\n2. B",
  });
});

test("a text without the section is all 'rest'", () => {
  assert.deepEqual(splitSection("  Just text.\n", "requirements"), {
    rest: "Just text.",
    section: "",
  });
});

test("an empty section leaves no markers behind", () => {
  assert.equal(joinSection("Text.", "requirements", "Requirements", "  "), "Text.");
});

test("a section can stand alone, with nothing around it", () => {
  const alone = joinSection("", "requirements", "Requirements", "Only this");
  assert.deepEqual(splitSection(alone, "requirements"), { rest: "", section: "Only this" });
});

test("rewriting either half keeps the other", () => {
  const first = joinSection("Old description.", "requirements", "Requirements", "R1");
  const { section } = splitSection(first, "requirements");
  const second = joinSection("New description.", "requirements", "Requirements", section);
  assert.deepEqual(splitSection(second, "requirements"), {
    rest: "New description.",
    section: "R1",
  });
});

test("category names are tidied, and bad ones refused", () => {
  assert.equal(cleanCategory("  UX   Polish "), "ux polish");
  assert.throws(() => cleanCategory("  "), Refused);
  assert.throws(() => cleanCategory("a,b"), Refused);
  assert.throws(() => cleanCategory("x".repeat(41)), Refused);
});

test("a hand-over must say all three things", () => {
  const text = handoverText({ done: "Built it", checked: "Tests", notChecked: "nothing" });
  assert.match(text, /^Hand-over:/u);
  assert.match(text, /What was done: Built it/u);
  assert.match(text, /Not checked: nothing/u);
  assert.throws(
    () => handoverText({ done: "Built it", checked: "Tests", notChecked: " " }),
    (cause: unknown) => cause instanceof UsageError && /--not-checked/u.test(cause.message),
  );
});
