// tracker/memory.test.ts — tests for remembered facts in a file.
//
// What: checks reading and rewriting the facts section of a file's text,
// and saving and recalling facts in a real folder.
//
// Why: this writes into AGENTS.md, a file the owner maintains by hand; it
// must never disturb anything outside its own section.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keyFor, readFacts, recall, remember, writeFacts } from "./memory.ts";
import { UsageError } from "./types.ts";

test("facts written into a text are read back, and the rest is untouched", () => {
  const before = "# Rules\n\nHand-written text.\n";
  const after = writeFacts(before, [
    { key: "build", text: "Run npm test" },
    { key: "deploys", text: "Tuesdays" },
  ]);
  assert.ok(after.startsWith(before.trimEnd()));
  assert.deepEqual(readFacts(after), [
    { key: "build", text: "Run npm test" },
    { key: "deploys", text: "Tuesdays" },
  ]);
});

test("rewriting the section keeps the text before and after it", () => {
  const first = writeFacts("Above.\n", [{ key: "a", text: "one" }]) + "\nBelow.\n";
  const second = writeFacts(first, [{ key: "a", text: "two" }]);
  assert.ok(second.startsWith("Above."));
  assert.ok(second.trimEnd().endsWith("Below."));
  assert.deepEqual(readFacts(second), [{ key: "a", text: "two" }]);
  assert.equal(second.match(/bend:facts:start/gu)?.length, 1);
});

test("a file without the section has no facts", () => {
  assert.deepEqual(readFacts("# Rules\n"), []);
});

test("a key is made from the first words", () => {
  assert.equal(keyFor("Run npm test, then hand over!"), "run-npm-test-then-hand-over");
});

test("saving under the same key replaces; recall filters by words", () => {
  const root = mkdtempSync(join(tmpdir(), "bend-memory-"));
  writeFileSync(join(root, "AGENTS.md"), "# Rules\n\nKeep me.\n");
  assert.deepEqual(remember(root, "Deploys go out\non Mondays", "deploys"), {
    key: "deploys",
    replaced: false,
  });
  assert.equal(remember(root, "Deploys go out on Tuesdays", "deploys").replaced, true);
  assert.equal(remember(root, "Run npm test").key, "run-npm-test");
  assert.deepEqual(recall(root), [
    { key: "deploys", text: "Deploys go out on Tuesdays" },
    { key: "run-npm-test", text: "Run npm test" },
  ]);
  assert.deepEqual(recall(root, ["TUESDAY"]).map((fact) => fact.key), ["deploys"]);
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /^# Rules\n\nKeep me\./u);
  assert.throws(() => remember(root, "   "), UsageError);
});

test("a folder without AGENTS.md has no facts, and gets the file on first save", () => {
  const root = mkdtempSync(join(tmpdir(), "bend-memory-"));
  assert.deepEqual(recall(root), []);
  remember(root, "First fact");
  assert.deepEqual(recall(root).map((fact) => fact.text), ["First fact"]);
});
