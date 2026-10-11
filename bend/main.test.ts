// bend/main.test.ts — the whole command, against a real beads folder.
//
// What: runs `bend` commands through `run` in a throwaway repository and
// checks what they print, what they change and the exit status.
//
// Why: the adapter's value is in how it drives the real `bd`. These tests
// catch a change in bd's behaviour as well as a mistake in ours.
//
// Gotchas:
// - Needs `bd` and `git` on the PATH. Where bd is missing the tests are
//   skipped, not failed, so the pure tests still run anywhere.
// - Each bd command takes a noticeable fraction of a second; the scenarios
//   are grouped to keep the run short.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { detectTracker } from "../tracker/detect.ts";
import type { Issue } from "../tracker/types.ts";
import { run } from "./main.ts";

let root = "";
let skip: string | false = false;

before(() => {
  try {
    root = mkdtempSync(join(tmpdir(), "bend-test-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("bd", ["init", "--prefix", "t", "--non-interactive"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    skip = "bd or git is not available";
  }
});

/** Runs one bend command in the throwaway repository. */
async function bend(
  ...argv: string[]
): Promise<{ status: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const status = await run(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    stdin: () => "text from standard input",
    cwd: root,
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

/** Runs a command that must succeed and gives what it printed. */
async function ok(...argv: string[]): Promise<string> {
  const result = await bend(...argv);
  assert.equal(result.status, 0, `${argv.join(" ")}: ${result.err}`);
  return result.out;
}

const show = async (id: string) => JSON.parse(await ok("show", id, "--json")) as Issue;

test("create, write, edit and show an issue", async (t) => {
  if (skip) return t.skip(skip);
  const id = await ok(
    "create", "Checkout flow", "--type", "epic", "--priority", "p1",
    "--description", "-starts with a dash", "--done", "Orders go through",
    "--category", "  UX  Polish ",
  );
  assert.match(id, /^t-/u);
  await ok("write", id, "requirements", "1. Guest checkout");
  await ok("write", id, "description", "Rewritten.");
  await ok("write", id, "plan", "--text-file", "-");
  await ok("edit", id, "--title", "Checkout", "--priority", "0");
  const issue = await show(id);
  assert.equal(issue.title, "Checkout");
  assert.equal(issue.priority, 0);
  assert.equal(issue.type, "epic");
  assert.equal(issue.category, "ux polish");
  assert.equal(issue.description, "Rewritten.");
  assert.equal(issue.requirements, "1. Guest checkout");
  assert.equal(issue.done, "Orders go through");
  assert.equal(issue.plan, "text from standard input");
  await ok("write", id, "requirements", "");
  assert.equal((await show(id)).requirements, "");
  assert.equal((await show(id)).description, "Rewritten.");
  await ok("edit", id, "--no-category");
  assert.equal((await show(id)).category, null);
  assert.match(await ok("show", id), /Checkout/u);
});

test("sub-issues, links, moving, and what blocks what", async (t) => {
  if (skip) return t.skip(skip);
  const parent = await ok("create", "Parent", "--category", "api");
  const child = await ok("create", "Child", "--parent", parent);
  const other = await ok("create", "Other", "--from", parent);
  assert.equal((await show(child)).parentId, parent);
  assert.equal((await show(child)).category, "api", "a sub-issue takes its parent's category");
  assert.deepEqual((await show(parent)).subIssues.map((sub) => sub.id), [child]);
  assert.deepEqual(
    (await show(other)).links.map((link) => [link.kind, link.direction, link.id]),
    [["discovered-from", "out", parent]],
  );

  await ok("link", child, other, "--kind", "blocked-by");
  assert.deepEqual((await show(child)).blockedBy.map((ref) => ref.id), [other]);
  assert.match(await ok("list"), new RegExp(`${child}\\s+blocked`, "u"));
  const ready = JSON.parse(await ok("ready", "--json")) as Issue[];
  assert.ok(!ready.some((issue) => issue.id === child));

  assert.equal((await bend("link", child, other, "--kind", "related")).status, 1);
  assert.equal((await bend("link", child, child, "--kind", "related")).status, 1);
  assert.equal((await bend("link", child, other, "--kind", "nonsense")).status, 2);
  assert.equal((await bend("link", child, other)).status, 2);

  await ok("unlink", other, child);
  assert.deepEqual((await show(child)).blockedBy, []);
  assert.equal((await bend("unlink", child, other)).status, 1);

  await ok("move", child, "--top");
  assert.equal((await show(child)).parentId, null);
  await ok("move", child, "--under", parent);
  assert.equal((await bend("move", parent, "--under", child)).status, 1);
  assert.equal((await bend("move", child)).status, 2);

  const listed = JSON.parse(await ok("list", "--parent", parent, "--json")) as Issue[];
  assert.deepEqual(listed.map((issue) => issue.id), [child]);
  const found = JSON.parse(await ok("search", "Other", "--json")) as Issue[];
  assert.deepEqual(found.map((issue) => issue.id), [other]);
});

test("comments, decisions, starting, handing over and closing", async (t) => {
  if (skip) return t.skip(skip);
  const id = await ok("create", "Work item");
  await ok("comment", id, "--", "-a comment that starts with a dash");
  await ok("decide", id, "Keep it simple, because it is enough");
  assert.equal((await bend("handover", id, "--done", "x", "--checked", "y")).status, 2);
  assert.equal((await show(id)).status, "open", "a refused hand-over changes nothing");
  await ok("handover", id, "--done", "Built it", "--checked", "Tests", "--not-checked", "nothing");
  assert.equal((await show(id)).status, "in_progress");
  const comments = await ok("comments", id);
  assert.match(comments, /-a comment that starts with a dash/u);
  assert.match(comments, /Decision: Keep it simple/u);
  assert.match(comments, /Hand-over: ready for the owner to validate/u);
  assert.equal((await show(id)).commentCount, 3);

  await ok("close", id, "--reason", "validated");
  assert.equal((await show(id)).status, "closed");
  assert.equal((await show(id)).closeReason, "validated");
  assert.ok(!(await ok("list")).includes(id), "closed issues are not listed by default");
  assert.ok((await ok("list", "--status", "closed")).includes(id));
  assert.equal((await bend("start", id)).status, 1);
  await ok("reopen", id);
  await ok("start", id, "--as", "agent-7");
  assert.equal((await show(id)).assignee, "agent-7");
});

test("problems are reported with the right exit status, in text and in JSON", async (t) => {
  if (skip) return t.skip(skip);
  const missing = await bend("show", "t-nope");
  assert.equal(missing.status, 1);
  assert.match(missing.err, /no issue with id t-nope/u);
  const asJson = await bend("show", "t-nope", "--json");
  assert.deepEqual(JSON.parse(asJson.out), {
    ok: false,
    status: 1,
    error: "There is no issue with id t-nope.",
  });
  assert.equal((await bend("bogus")).status, 2);
  assert.equal((await bend("list", "--wat")).status, 2);
  assert.equal((await bend()).status, 2);
  assert.equal((await bend("--help")).status, 0);
  assert.match((await bend("create", "--help")).out, /--blocked-by <id>/u);
  const nowhere = await bend("-C", mkdtempSync(join(tmpdir(), "bend-empty-")), "list");
  assert.equal(nowhere.status, 1);
  assert.match(nowhere.err, /No supported issue tracker/u);
});

test("status says what the tracker supports; facts are kept in FACTS.md", async (t) => {
  if (skip) return t.skip(skip);
  const status = await ok("status");
  assert.match(status, /Tracker\s+beads/u);
  assert.match(status, /requirements\s+kept as a marked section/u);
  assert.match(status, /not synced anywhere/u);
  await ok("remember", "Deploys go out on Mondays", "--key", "deploys");
  assert.match(await ok("remember", "Deploys go out on Tuesdays", "--key", "deploys"), /Replaced/u);
  assert.equal(await ok("recall", "tuesday"), "deploys: Deploys go out on Tuesdays");
  assert.match(readFileSync(join(root, "FACTS.md"), "utf8"), /^# Facts\n[\s\S]*- \*\*deploys\*\* — Deploys go out on Tuesdays\n$/u);
});

test("a list can be narrowed to what changed since a moment", async (t) => {
  if (skip) return t.skip(skip);
  const { tracker } = detectTracker(root);
  const everything = await tracker.list({ status: "all" });
  assert.ok(everything.length > 0);
  const ids = async (changedSince: string) =>
    (await tracker.list({ status: "all", changedSince })).map((issue) => issue.id);
  // Everything in this throwaway folder was made a moment ago.
  assert.deepEqual(await ids("2000-01-01T00:00:00Z"), everything.map((issue) => issue.id));
  assert.deepEqual(await ids(new Date(Date.now() + 3_600_000).toISOString()), []);
});
