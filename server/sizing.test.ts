// server/sizing.test.ts — tests for which issues the background sizes.
//
// What: checks what counts as a change to an issue (fingerprint), which
// issues need a size (needsSizing, toSize), and what the worker is told.
//
// Why: these are the user's rules (bead-bb-zkc), and getting one wrong
// either overwrites a size the user chose or sizes the same issue for
// ever: a size they chose is never touched; a started issue is never
// touched; a change re-sizes only what the background sized itself; the
// sizing's own label and comment are not a change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { standardWorkflow as flow } from "../shared/standard-workflow.ts";
import type { Issue } from "./contract.ts";
import {
  BATCH_SIZE,
  REPORT_TOOL,
  fingerprint,
  needsSizing,
  sizingPrompt,
  toSize,
} from "./sizing.ts";

/** An open, not started, unsized issue, changed by `over`. */
const issue = (id: string, over: Partial<Issue> = {}) =>
  ({
    id,
    title: id,
    description: "",
    design: "",
    acceptance: "",
    notes: "",
    type: "task",
    parentId: null,
    step: null,
    size: null,
    branch: null,
    conversationId: null,
    createdAt: null,
    status: "open",
    commentCount: 0,
    priority: 2,
    category: null,
    ...over,
  }) as Issue;

const print = (subject: Issue) => fingerprint(subject, []);

test("the issue's own content is what counts as a change", () => {
  const base = issue("a");
  for (const change of [
    { title: "other" },
    { description: "more" },
    { acceptance: "done when" },
    { design: "how" },
    { notes: "note" },
    { type: "bug" },
  ] as Partial<Issue>[]) {
    assert.notEqual(print(issue("a", change)), print(base), JSON.stringify(change));
  }
  // A sub-issue added or removed counts; their order does not.
  assert.notEqual(fingerprint(base, ["a.1"]), print(base));
  assert.equal(fingerprint(base, ["a.1", "a.2"]), fingerprint(base, ["a.2", "a.1"]));
});

test("what the sizing itself writes, and what the workflow moves, is not a change", () => {
  const base = issue("a");
  for (const change of [
    { size: "m" },
    { commentCount: 5 },
    { step: "implement" },
    { status: "in_progress" },
    { priority: 0 },
    { category: "ux" },
  ] as Partial<Issue>[]) {
    assert.equal(print(issue("a", change)), print(base), JSON.stringify(change));
  }
});

test("a new issue is sized, once", () => {
  const fresh = issue("a");
  assert.equal(needsSizing(flow, fresh, print(fresh), undefined), true);
  // Tried as it is and nothing came of it: not again until it changes.
  const tried = { fingerprint: print(fresh), size: null };
  assert.equal(needsSizing(flow, fresh, print(fresh), tried), false);
  const edited = issue("a", { description: "now with detail" });
  assert.equal(needsSizing(flow, edited, print(edited), tried), true);
});

test("a change re-sizes only a size the background gave", () => {
  const before = issue("a", { size: "s" });
  const mine = { fingerprint: print(before), size: "s" };
  // Unchanged: leave it.
  assert.equal(needsSizing(flow, before, print(before), mine), false);
  // Changed: size it again.
  const edited = issue("a", { size: "s", description: "grew" });
  assert.equal(needsSizing(flow, edited, print(edited), mine), true);
  // A size nobody here remembers giving is the user's, or an agent's.
  assert.equal(needsSizing(flow, edited, print(edited), undefined), false);
  // The user changed it to another size since: theirs now.
  const theirs = issue("a", { size: "l", description: "grew" });
  assert.equal(needsSizing(flow, theirs, print(theirs), mine), false);
  // Its size was taken away: size it again.
  const cleared = issue("a", { size: null });
  assert.equal(needsSizing(flow, cleared, print(cleared), mine), true);
});

test("an issue that has started, or is closed, is never sized", () => {
  for (const over of [
    { step: "define" },
    { step: "implement" },
    { step: "user-review" },
    { status: "closed" },
  ] as Partial<Issue>[]) {
    const subject = issue("a", over);
    assert.equal(needsSizing(flow, subject, print(subject), undefined), false);
    const sized = issue("a", { ...over, size: "s", title: "changed" });
    assert.equal(
      needsSizing(flow, sized, print(sized), { fingerprint: "old", size: "s" }),
      false,
    );
  }
  // "Not started" written out is the same as no step at all.
  const explicit = issue("a", { step: "not-started" });
  assert.equal(needsSizing(flow, explicit, print(explicit), undefined), true);
});

test("a list is searched for what needs a size, sub-issues included", () => {
  const epic = issue("epic", { size: "m" });
  const list = [
    epic,
    issue("epic.1", { parentId: "epic" }),
    issue("done", { status: "closed" }),
    issue("mine", { size: "l" }),
    issue("started", { step: "plan" }),
  ];
  const memory = { epic: { fingerprint: fingerprint(epic, []), size: "m" } };
  // The epic was sized by the background before it had a sub-issue.
  assert.deepEqual(
    toSize(flow, list, memory).map((entry) => entry.issue.id),
    ["epic", "epic.1"],
  );
  assert.ok(BATCH_SIZE >= 1);
});

test("the worker is given the issues' text, told to run nothing, and to report once", () => {
  const text = sizingPrompt(
    [
      issue("a-1", { title: 'Fix "it"', description: "It breaks.", acceptance: "It works." }),
      issue("a-2", { title: "Again", size: "s", design: "x".repeat(5000) }),
    ],
    flow.sizeGuide ?? "",
    (flow.sizes ?? []).map((size) => size.id),
  );
  assert.match(text, /- S, small/u);
  assert.match(text, /- L, large/u);
  assert.match(text, /### a-1: Fix "it"/u);
  assert.match(text, /Description:\nIt breaks\./u);
  assert.match(text, /Acceptance criteria:\nIt works\./u);
  // Long text is cut, and says so.
  assert.match(text, /\[cut here; 3000 more characters\]/u);
  assert.ok(text.length < 6000);
  assert.ok(text.includes(`\`${REPORT_TOOL}\``));
  assert.match(text, /do not run any commands/u);
  assert.match(text, /In doubt between two, take the larger/u);
  assert.match(text, /"s", "m", "l"/u);
});
