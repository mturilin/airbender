// bend/args.test.ts — tests for reading a command line.
//
// What: checks options with values, repeated options, flags, short forms,
// `--`, and the usage errors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../tracker/types.ts";
import { parseArgs, parsePriority } from "./args.ts";

const SPEC = {
  values: ["type", "dir"],
  lists: ["blocked-by"],
  flags: ["json", "top"],
  short: { C: "dir" },
};

test("positionals, values in both forms, lists and flags", () => {
  const parsed = parseArgs(
    ["Fix it", "--type", "bug", "--blocked-by", "a", "--blocked-by=b", "--json", "-C", "/x"],
    SPEC,
  );
  assert.deepEqual(parsed.positionals, ["Fix it"]);
  assert.deepEqual(parsed.values, { type: "bug", dir: "/x" });
  assert.deepEqual(parsed.lists, { "blocked-by": ["a", "b"] });
  assert.deepEqual([...parsed.flags], ["json"]);
});

test("everything after -- is text, and a lone - is a value", () => {
  assert.deepEqual(parseArgs(["id", "--", "-starts", "--with-dashes"], SPEC).positionals, [
    "id",
    "-starts",
    "--with-dashes",
  ]);
  assert.deepEqual(parseArgs(["-"], SPEC).positionals, ["-"]);
});

test("usage errors name the option", () => {
  const fails = (words: string[], pattern: RegExp) =>
    assert.throws(
      () => parseArgs(words, SPEC),
      (cause: unknown) => cause instanceof UsageError && pattern.test(cause.message),
    );
  fails(["--wat"], /Unknown option --wat/u);
  fails(["--type"], /--type needs a value/u);
  fails(["--top=yes"], /--top does not take a value/u);
  fails(["-a comment with a dash"], /put -- before it/u);
});

test("priorities are 0 to 4, with or without a p", () => {
  assert.equal(parsePriority("2"), 2);
  assert.equal(parsePriority("P0"), 0);
  assert.throws(() => parsePriority("5"), UsageError);
  assert.throws(() => parsePriority("high"), UsageError);
});
