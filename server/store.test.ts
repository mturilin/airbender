// server/store.test.ts — the tab's issue operations, against a real beads
// folder.
//
// What: runs the store's operations (server/store.ts) in a throwaway
// repository, through the tracker core and the real `bd`, and checks what
// the tab would then list.
//
// Why: the tab reads and changes issues through the tracker core
// (bead-bb-c9l.2). What must not change is what the tab shows and does, and
// that is decided by three layers together: the store, the core's beads
// adapter, and bd itself. Only a test through all three catches a mismatch
// between them.
//
// Design notes:
// - The pieces of BB the store is built with are replaced by a few lines
//   each: a folder that is always the throwaway one, a current issue held
//   in a variable, a log and a reload signal that are only collected.
//
// Gotchas:
// - Needs `bd` and `git` on the PATH. Where bd is missing the tests are
//   skipped, not failed, so the pure tests still run anywhere.
// - Each bd command takes a noticeable fraction of a second; the scenarios
//   are grouped to keep the run short.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LINK_KINDS } from "../shared/constants.ts";
import type { Issue } from "./contract.ts";
import type { CurrentBead } from "./current-bead.ts";
import type { Folders } from "./folder.ts";
import { createStore } from "./store.ts";
import { createTrackers } from "./trackers.ts";
import type { WorkflowChoice } from "./workflow-choice.ts";

let root = "";
let empty = "";
let skip: string | false = false;

before(() => {
  try {
    root = mkdtempSync(join(tmpdir(), "airbender-store-"));
    empty = mkdtempSync(join(tmpdir(), "airbender-store-empty-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("bd", ["init", "--prefix", "t", "--non-interactive"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    skip = "bd or git is not available";
  }
});
after(() => {
  for (const folder of [root, empty]) {
    if (folder !== "") rmSync(folder, { recursive: true, force: true });
  }
});

/** How many times open tabs were told to reload. */
let reloads = 0;
/** The thread's current issue, as the store would keep it in BB. */
let current: string | null = null;

/**
 * Builds a store whose folder is `path`.
 *
 * @param bd The beads program the store is told works here; null stands
 *   for a machine without beads.
 */
function storeIn(path: string, bd: string | null = "bd") {
  return createStore({
    bb: {
      log: { warn: () => {} },
      realtime: { publish: () => void (reloads += 1) },
    } as unknown as BbPluginApi,
    folders: {
      folderFor: async () => ({ path }),
      onOwnBranch: async () => false,
      currentBranch: async () => null,
      isWorkTree: async () => false,
    } as unknown as Folders,
    trackers: createTrackers({
      findBd: async () => bd,
      notFoundMessage: "no bd here",
      warn: () => {},
    }),
    currentBead: {
      read: async () => current,
      store: async (_threadId: string, id: string | null) => {
        current = id;
      },
    } as unknown as CurrentBead,
    watchFolder: () => {},
    workflowChoice: { idFor: () => "standard" } as unknown as WorkflowChoice,
  });
}

/** The request every operation carries: which thread's folder it is about. */
const here = { threadId: "thr_1", projectId: null };

/** The folder's issues as the tab lists them, by id. */
async function listed(
  store: ReturnType<typeof storeIn>,
): Promise<Map<string, Issue>> {
  const result = await store.listIssues(here);
  assert.equal(result.state, "ok", result.message ?? "");
  return new Map(result.issues.map((issue) => [issue.id, issue]));
}

/** Creates an issue that must be created, and gives its id. */
async function create(
  store: ReturnType<typeof storeIn>,
  title: string,
  extra: { parentId?: string; category?: string; description?: string } = {},
): Promise<string> {
  const made = await store.createIssue({
    ...here,
    title,
    description: extra.description ?? "",
    type: null,
    priority: null,
    parentId: extra.parentId ?? null,
    category: extra.category ?? null,
  });
  assert.equal(made.message, null);
  return made.id!;
}

test("create and edit: a sub-issue takes its parent's category and nothing else", async (t) => {
  if (skip) return t.skip(skip);
  const store = storeIn(root);
  const epic = await create(store, "Checkout", { category: "  UX  Polish " });
  assert.match(epic, /^t-/u);
  assert.equal((await store.setStep(root, null, epic, "plan")).message, null);
  assert.equal((await store.setSize(root, null, epic, "l")).message, null);
  assert.equal(
    (await store.setBranch(root, null, epic, "t-1-checkout")).message,
    null,
  );
  const child = await create(store, "-starts with a dash", { parentId: epic });
  const other = await create(store, "Own category", {
    parentId: epic,
    category: "api",
  });
  let issues = await listed(store);
  assert.deepEqual(
    [issues.get(epic)!.category, issues.get(epic)!.step, issues.get(epic)!.size, issues.get(epic)!.branch],
    ["ux polish", "plan", "l", "t-1-checkout"],
  );
  // The step, the size and the branch are labels; a sub-issue must not
  // start with its parent's (bead-bb-ty5.4).
  assert.deepEqual(
    [issues.get(child)!.parentId, issues.get(child)!.category, issues.get(child)!.step, issues.get(child)!.size, issues.get(child)!.branch],
    [epic, "ux polish", null, null, null],
  );
  assert.equal(issues.get(child)!.title, "-starts with a dash");
  assert.equal(issues.get(other)!.category, "api");
  assert.deepEqual(issues.get(epic)!.labels, []);

  // A step replaces the one before it: never two.
  assert.equal((await store.setStep(root, null, epic, "implement")).message, null);
  const before = reloads;
  assert.equal((await store.setStep(root, null, epic, "implement")).message, null);
  assert.equal(reloads, before, "setting the same step again reloads nothing");
  assert.equal((await store.setBranch(root, null, epic, null)).message, null);

  assert.equal(
    (
      await store.updateIssue({
        ...here,
        beadId: child,
        type: "bug",
        priority: 1,
        title: "Guest checkout",
        description: "-also starts with a dash",
      })
    ).message,
    null,
  );
  assert.equal(
    (await store.setCategory({ ...here, beadId: other, category: null })).message,
    null,
  );
  assert.match(
    (await store.setCategory({ ...here, beadId: other, category: "a,b" })).message ?? "",
    /comma/u,
  );
  issues = await listed(store);
  assert.deepEqual(
    [issues.get(epic)!.step, issues.get(epic)!.size, issues.get(epic)!.branch],
    ["implement", "l", null],
  );
  const edited = issues.get(child)!;
  assert.deepEqual(
    [edited.title, edited.type, edited.priority, edited.description],
    ["Guest checkout", "bug", 1, "-also starts with a dash"],
  );
  assert.equal(issues.get(other)!.category, null);
});

test("the description is one text in the tab, with the requirements kept inside it", async (t) => {
  if (skip) return t.skip(skip);
  const store = storeIn(root);
  const id = await create(store, "With requirements", { description: "Wanted." });
  const withSection =
    "Wanted, reworded.\n\n<!-- bend:requirements -->\n## Requirements\n\n1. Guest checkout\n<!-- /bend:requirements -->";
  const write = (description: string) =>
    store.updateIssue({ ...here, beadId: id, type: null, priority: null, title: null, description });
  assert.equal((await write(withSection)).message, null);
  assert.equal((await listed(store)).get(id)!.description, withSection);
  // Sent back with only the text above the section changed.
  assert.equal(
    (await write(withSection.replace("reworded", "again"))).message,
    null,
  );
  assert.equal(
    (await listed(store)).get(id)!.description,
    withSection.replace("reworded", "again"),
  );
  // The section deleted in the tab's editor: the requirements go.
  assert.equal((await write("Only this.")).message, null);
  assert.equal((await listed(store)).get(id)!.description, "Only this.");
  // An empty description is a value: it clears the text.
  assert.equal((await write("")).message, null);
  assert.equal((await listed(store)).get(id)!.description, "");
});

test("links of every kind, what blocks what, and moving", async (t) => {
  if (skip) return t.skip(skip);
  const store = storeIn(root);
  const a = await create(store, "A");
  const b = await create(store, "B");
  const link = (fromId: string, toId: string, kind: (typeof LINK_KINDS)[number]) =>
    store.link({ ...here, fromId, toId, kind });
  assert.equal((await link(a, b, "blocks")).message, null);
  let issues = await listed(store);
  assert.deepEqual(issues.get(a)!.blockedBy, [{ id: b, title: "B" }]);
  assert.deepEqual(issues.get(b)!.blocks, [{ id: a, title: "A" }]);
  assert.deepEqual(
    issues.get(a)!.links.map((found) => [found.direction, found.kind, found.id, found.closed]),
    [["out", "blocks", b, false]],
  );
  assert.deepEqual(
    issues.get(b)!.links.map((found) => [found.direction, found.kind, found.id]),
    [["in", "blocks", a]],
  );
  assert.notEqual((await link(a, a, "blocks")).message, null);
  assert.notEqual((await link(a, "t-nope", "blocks")).message, null);
  assert.match((await link(a, "--force", "blocks")).message ?? "", /not a beads issue id/u);

  // A link the other way round is a second link; removing one leaves it.
  assert.equal((await link(b, a, "discovered-from")).message, null);
  assert.equal(
    (await store.unlink({ ...here, fromId: a, toId: b, kind: "blocks" })).message,
    null,
  );
  issues = await listed(store);
  assert.deepEqual(issues.get(a)!.blockedBy, []);
  assert.deepEqual(
    issues.get(a)!.links.map((found) => [found.direction, found.kind, found.id]),
    [["in", "discovered-from", b]],
  );
  assert.equal(
    (await store.unlink({ ...here, fromId: b, toId: a, kind: "discovered-from" })).message,
    null,
  );

  // Every kind the tab offers can be added, shows under the tab's name for
  // it, and can be removed again.
  for (const kind of LINK_KINDS) {
    assert.equal((await link(a, b, kind)).message, null, kind);
    const shown = (await listed(store)).get(a)!.links;
    const name = kind === "related" ? "relates-to" : kind;
    assert.deepEqual(
      shown.map((found) => [found.direction, found.kind, found.id]),
      [["out", name, b]],
      kind,
    );
    if (kind === "related") {
      // Two-way: shown once on the other issue too, as its own.
      assert.deepEqual(
        (await listed(store)).get(b)!.links.map((found) => [found.direction, found.kind]),
        [["out", "relates-to"]],
      );
    }
    assert.equal(
      (await store.unlink({ ...here, fromId: a, toId: b, kind: name })).message,
      null,
      kind,
    );
    const after = await listed(store);
    assert.deepEqual(after.get(a)!.links, [], kind);
    assert.deepEqual(after.get(b)!.links, [], kind);
  }

  // A kind beads does not have is refused in plain words, not passed to bd.
  assert.match(
    (await link(a, b, "duplicates" as (typeof LINK_KINDS)[number])).message ?? "",
    /Beads has no "duplicates" link/u,
  );

  // Moving in and out; never inside itself or its own sub-issue.
  assert.equal((await store.setParent({ ...here, beadId: b, parentId: a })).message, null);
  assert.equal((await listed(store)).get(b)!.parentId, a);
  assert.match(
    (await store.setParent({ ...here, beadId: a, parentId: b })).message ?? "",
    /inside itself/u,
  );
  assert.match(
    (await store.setParent({ ...here, beadId: a, parentId: a })).message ?? "",
    /inside itself/u,
  );
  assert.equal((await store.setParent({ ...here, beadId: b, parentId: null })).message, null);
  assert.equal((await listed(store)).get(b)!.parentId, null);
});

test("comments, closing and reopening", async (t) => {
  if (skip) return t.skip(skip);
  const store = storeIn(root);
  const id = await create(store, "To close");
  assert.equal((await store.addComment(root, id, "-first, with a dash")).message, null);
  assert.equal((await store.addComment(root, id, "second")).message, null);
  const read = await store.listComments({ ...here, beadId: id });
  assert.equal(read.message, null);
  assert.deepEqual(read.comments.map((comment) => comment.text), ["-first, with a dash", "second"]);
  assert.equal((await listed(store)).get(id)!.commentCount, 2);
  assert.notEqual((await store.listComments({ ...here, beadId: "t-nope" })).message, null);

  current = id;
  assert.equal((await store.setIssueOpen("close", { ...here, beadId: id })).message, null);
  assert.equal(current, null, "closing the thread's current issue clears it");
  assert.equal((await listed(store)).get(id)!.status, "closed");
  assert.equal((await store.setIssueOpen("reopen", { ...here, beadId: id })).message, null);
  assert.equal((await listed(store)).get(id)!.status, "open");
  assert.notEqual(
    (await store.setIssueOpen("close", { ...here, beadId: "t-nope" })).message,
    null,
  );

  const found = await store.issuesIn(here, id);
  assert.ok("path" in found);
  assert.deepEqual(await store.issuesIn(here, "t-nope"), {
    message: "Issue t-nope is no longer in the list.",
  });
});

test("a folder without beads and a machine without bd are told apart", async (t) => {
  if (skip) return t.skip(skip);
  const none = await storeIn(empty).listIssues(here);
  assert.equal(none.state, "no-beads");
  assert.match(none.message ?? "", /does not use beads yet/u);
  const noProgram = await storeIn(root, null).listIssues(here);
  assert.deepEqual([noProgram.state, noProgram.message], ["no-bd", "no bd here"]);
  // Found by name, gone when run: the same answer, not a raw error.
  const vanished = await storeIn(root, "bd-that-is-not-installed").listIssues(here);
  assert.deepEqual([vanished.state, vanished.message], ["no-bd", "no bd here"]);
  assert.equal(
    (await storeIn(empty).setIssueOpen("close", { ...here, beadId: "t-1" })).message,
    none.message,
  );
});
