// tracker/memory.test.ts — tests for remembered facts in a file.
//
// What: checks reading and changing the facts in a file's text, saving and
// recalling facts in a real folder, and moving facts out of the section of
// AGENTS.md they used to be kept in.
//
// Why: this writes into files the owner also edits by hand (FACTS.md, and
// once AGENTS.md, to take the old section out); it
// must never disturb anything outside its own section.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  keyFor,
  moveOldFacts,
  readFacts,
  recall,
  remember,
  splitOldFacts,
  withFact,
} from "./memory.ts";
import { UsageError } from "./types.ts";

/** An AGENTS.md with facts in the section they used to be kept in. */
const OLD_AGENTS = `# Rules

Hand-written text.

<!-- bend:facts:start -->
## Remembered facts

Standing facts for every session, kept by \`bend remember\`. One line per fact; do not edit the markers.

- **build** — Run npm test
- **deploys** — Tuesdays
<!-- bend:facts:end -->

## After

More of the owner's text.
`;

test("a fact saved into an empty text makes a facts file with its heading", () => {
  const { text, replaced } = withFact("", { key: "build", text: "Run npm test" });
  assert.equal(replaced, false);
  assert.match(text, /^# Facts\n\nStanding facts about this project/u);
  assert.ok(text.endsWith("\n\n- **build** — Run npm test\n"));
  assert.deepEqual(readFacts(text), [{ key: "build", text: "Run npm test" }]);
});

test("a fact is added after the last line, or replaces its own line; nothing else changes", () => {
  const file = "# Facts\n\nMy own words.\n\n- **a** — one\n- **b** — two\n";
  const added = withFact(file, { key: "c", text: "three" });
  assert.equal(added.text, `${file}- **c** — three\n`);
  const replaced = withFact(added.text, { key: "a", text: "ONE" });
  assert.equal(replaced.replaced, true);
  assert.equal(
    replaced.text,
    "# Facts\n\nMy own words.\n\n- **a** — ONE\n- **b** — two\n- **c** — three\n",
  );
});

test("a line added by hand with a colon or a plain dash is a fact too; other lines are not", () => {
  assert.deepEqual(
    readFacts("# Facts\n\n- **a**: one\n- **b** - two\n- not a fact\nplain text\n- **c** — three\n"),
    [
      { key: "a", text: "one" },
      { key: "b", text: "two" },
      { key: "c", text: "three" },
    ],
  );
  assert.deepEqual(readFacts("# Rules\n"), []);
});

test("a key is made from the first words", () => {
  assert.equal(keyFor("Run npm test, then hand over!"), "run-npm-test-then-hand-over");
});

test("the old section of AGENTS.md is taken out whole, and the rest is untouched", () => {
  const { facts, rest } = splitOldFacts(OLD_AGENTS);
  assert.deepEqual(facts, [
    { key: "build", text: "Run npm test" },
    { key: "deploys", text: "Tuesdays" },
  ]);
  assert.equal(rest, "# Rules\n\nHand-written text.\n\n## After\n\nMore of the owner's text.\n");
  // No section: the very same text, so nothing is rewritten.
  const plain = "# Rules\n\nKeep me.\n";
  assert.equal(splitOldFacts(plain).rest, plain);
});

test("saving under the same key replaces; recall filters by words; AGENTS.md is not written", () => {
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
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Rules\n\nKeep me.\n");
  assert.match(readFileSync(join(root, "FACTS.md"), "utf8"), /^# Facts\n/u);
  assert.throws(() => remember(root, "   "), UsageError);
});

test("a folder without any file has no facts, and gets FACTS.md on first save", () => {
  const root = mkdtempSync(join(tmpdir(), "bend-memory-"));
  assert.deepEqual(recall(root), []);
  remember(root, "First fact");
  assert.deepEqual(recall(root).map((fact) => fact.text), ["First fact"]);
});

test("facts in the old section are still recalled, and move to FACTS.md on the next save", () => {
  const root = mkdtempSync(join(tmpdir(), "bend-memory-"));
  writeFileSync(join(root, "AGENTS.md"), OLD_AGENTS);
  // Reading moves nothing.
  assert.deepEqual(recall(root).map((fact) => fact.key), ["build", "deploys"]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), OLD_AGENTS);
  // A fact FACTS.md already holds under the same key is the newer one.
  writeFileSync(join(root, "FACTS.md"), "# Facts\n\n- **deploys** — Wednesdays\n");
  assert.deepEqual(recall(root), [
    { key: "deploys", text: "Wednesdays" },
    { key: "build", text: "Run npm test" },
  ]);
  remember(root, "Ids are monospace", "ids");
  assert.deepEqual(recall(root), [
    { key: "deploys", text: "Wednesdays" },
    { key: "build", text: "Run npm test" },
    { key: "ids", text: "Ids are monospace" },
  ]);
  assert.equal(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    "# Rules\n\nHand-written text.\n\n## After\n\nMore of the owner's text.\n",
  );
  assert.equal(moveOldFacts(root), 0, "nothing left to move");
});
