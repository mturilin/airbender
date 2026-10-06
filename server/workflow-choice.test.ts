// server/workflow-choice.test.ts — tests for the per-repository choice of
// workflow.
//
// What: checks that a folder is traced to its repository (a main checkout,
// a work tree, a folder outside git), and that a choice is remembered,
// defaults to standard, is shared by a repository's work trees and survives
// a reload.
//
// Why: the user's rule is that a work tree continues its repository's
// workflow (bead-bb-8j6). The tracing reads git's files by hand, which is
// the part most likely to be wrong.
//
// Design notes: the repositories are built as plain files in a temporary
// folder, in the layout git itself writes, so no git program is needed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { standardWorkflow } from "../shared/standard-workflow.ts";
import { createWorkflowChoice, repositoryKey } from "./workflow-choice.ts";

const root = mkdtempSync(join(tmpdir(), "airbender-choice-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * Lays out a main checkout with one work tree, as git does.
 *
 * @param relative Write the work tree's pointers as relative paths, as git
 *   does with `worktree.useRelativePaths`; absolute otherwise.
 * @returns The two folders.
 */
function repository(name: string, relative = false) {
  const main = join(root, name);
  const tree = join(main, ".worktrees", "feature");
  const entry = join(main, ".git", "worktrees", "feature");
  mkdirSync(entry, { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(
    join(tree, ".git"),
    `gitdir: ${relative ? "../../.git/worktrees/feature" : entry}\n`,
  );
  writeFileSync(join(entry, "commondir"), "../..\n");
  return { main, tree };
}

/** The part of BB this module uses: a key-value store, kept in `data`. */
function fakeBb(data = new Map<string, unknown>(), failing = false) {
  return {
    storage: {
      kv: {
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => {
          if (failing) throw new Error("disk full");
          data.set(key, value);
        },
      },
    },
  } as unknown as BbPluginApi;
}

test("a work tree has the same key as its repository", () => {
  for (const relative of [false, true]) {
    const { main, tree } = repository(`keys-${relative}`, relative);
    assert.equal(repositoryKey(main), join(main, ".git"));
    assert.equal(repositoryKey(tree), repositoryKey(main));
  }
});

test("a folder outside git, or with unreadable git files, is its own key", () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.equal(repositoryKey(plain), plain);
  const broken = join(root, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, ".git"), "gitdir: /nowhere/at/all\n");
  assert.equal(repositoryKey(broken), broken);
  const odd = join(root, "odd");
  mkdirSync(odd);
  writeFileSync(join(odd, ".git"), "not a pointer\n");
  assert.equal(repositoryKey(odd), odd);
});

test("a repository is on standard until it chooses, and its work trees follow", async () => {
  const { main, tree } = repository("follow");
  const other = repository("other");
  const choice = await createWorkflowChoice(fakeBb());
  assert.equal(choice.idFor(main), "standard");
  assert.equal(choice.workflowFor(tree), standardWorkflow);
  await choice.set(tree, "simple");
  assert.equal(choice.idFor(main), "simple");
  assert.equal(choice.idFor(tree), "simple");
  assert.equal(choice.workflowFor(main), null);
  // Another repository is not touched.
  assert.equal(choice.idFor(other.main), "standard");
  await choice.set(main, "standard");
  assert.equal(choice.idFor(tree), "standard");
});

test("a choice survives a reload, and junk in storage is ignored", async () => {
  const { main } = repository("reload");
  const data = new Map<string, unknown>();
  await (await createWorkflowChoice(fakeBb(data))).set(main, "simple");
  assert.equal((await createWorkflowChoice(fakeBb(data))).idFor(main), "simple");
  const junk = new Map<string, unknown>([
    ["workflowChoices", { [repositoryKey(main)]: "kanban" }],
  ]);
  assert.equal((await createWorkflowChoice(fakeBb(junk))).idFor(main), "standard");
  const wrong = new Map<string, unknown>([["workflowChoices", "simple"]]);
  assert.equal((await createWorkflowChoice(fakeBb(wrong))).idFor(main), "standard");
});

test("a choice that cannot be saved is not taken", async () => {
  const { main } = repository("failing");
  const choice = await createWorkflowChoice(fakeBb(new Map(), true));
  await assert.rejects(choice.set(main, "simple"), /disk full/u);
  assert.equal(choice.idFor(main), "standard");
});
