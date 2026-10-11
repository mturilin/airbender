// bend/github.e2e.test.ts — the whole command, against real GitHub issues.
//
// What: runs every `bend` command through `run` in a folder set to use a
// scratch repository on GitHub, and checks what they print, what they
// change and the exit status. Then deletes every issue it made.
//
// Why: the adapter's tests (tracker/github.test.ts) run against a stand-in
// that imitates GitHub. Only this test finds out when GitHub behaves
// differently from the stand-in, or changes.
//
// How to run it: it is skipped unless the environment names the scratch
// repository, so `npm test` stays offline:
//
//   BEND_GITHUB_SCRATCH=mturilin/bend-scratch npm test
//
// It needs a login that owns that repository (GH_TOKEN, or `gh auth login`).
//
// Gotchas:
// - It creates and DELETES real issues. As a guard it refuses any
//   repository whose name does not contain "scratch", and it deletes only
//   the issues it created itself, by number.
// - Deleting an issue needs the owner's rights; with less, the issues are
//   left closed and the test says so.
// - Each command is one to four requests over the network; the whole run
//   takes about a minute and stays far below GitHub's limits (about 60
//   content-creating requests against 80 a minute).
// - GitHub's search runs behind, so the search check waits and retries.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { findToken } from "../tracker/github-api.ts";
import type { Issue } from "../tracker/types.ts";
import { run } from "./main.ts";

const repository = process.env.BEND_GITHUB_SCRATCH?.trim() ?? "";
let skip: string | false = false;
let root = "";
let token = "";
/** Numbers of the issues this run created, for the clean-up. */
const made: string[] = [];

before(async () => {
  if (repository === "") {
    skip = "BEND_GITHUB_SCRATCH is not set";
    return;
  }
  if (!/^[\w.-]+\/[\w.-]*scratch[\w.-]*$/iu.test(repository)) {
    throw new Error(
      `BEND_GITHUB_SCRATCH is ${repository}. This test deletes issues, so it only runs against a repository with "scratch" in its name.`,
    );
  }
  try {
    token = await findToken();
  } catch {
    skip = "not signed in to GitHub";
    return;
  }
  root = mkdtempSync(join(tmpdir(), "bend-github-"));
  writeFileSync(
    join(root, ".bend.json"),
    JSON.stringify({ tracker: "github", repository }),
  );
});

/** Sends one GraphQL request to GitHub with the test's own login. */
async function graphql(query: string, variables: Record<string, unknown>) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "bend-test" },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as {
    data?: { repository?: { issue?: { id: string } | null } };
    errors?: { message: string }[];
  };
}

after(async () => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  const [owner, name] = repository.split("/");
  const left: string[] = [];
  for (const number of made) {
    const found = await graphql(
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}",
      { owner, name, number: Number(number) },
    );
    const id = found.data?.repository?.issue?.id;
    if (id === undefined) continue;
    const gone = await graphql(
      "mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}",
      { id },
    );
    if (gone.errors !== undefined) left.push(number);
  }
  if (left.length > 0) {
    console.error(
      `bend's GitHub test could not delete its issues ${left.join(", ")} in ${repository}; delete them by hand.`,
    );
  }
});

/** Runs one bend command in the folder set to the scratch repository. */
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

/** Creates an issue and remembers it for the clean-up. */
async function create(...argv: string[]): Promise<string> {
  const id = await ok("create", ...argv);
  assert.match(id, /^\d+$/u);
  made.push(id);
  return id;
}

const show = async (id: string) => JSON.parse(await ok("show", id, "--json")) as Issue;

test("status says the tracker is GitHub and what is kept another way", async (t) => {
  if (skip) return t.skip(skip);
  const status = await ok("status");
  assert.match(status, /Tracker\s+github/u);
  assert.ok(status.includes(`${repository} on GitHub, signed in as `));
  assert.match(status, /type, priority, category\s+kept as the labels/u);
  assert.match(status, /requirements, done, plan, notes\s+kept as marked sections/u);
  assert.match(status, /links: discovered-from, related\s+kept as a marked Links section/u);
});

test("create, write, edit and show an issue", async (t) => {
  if (skip) return t.skip(skip);
  const id = await create(
    "Checkout flow", "--type", "epic", "--priority", "p1",
    "--description", "-starts with a dash", "--done", "Orders go through",
    "--category", "  UX  Polish ",
  );
  await ok("write", id, "requirements", "1. Guest checkout");
  await ok("write", id, "description", "Rewritten.");
  await ok("write", id, "plan", "--text-file", "-");
  await ok("write", id, "notes", "A note");
  await ok("edit", id, "--title", "Checkout", "--priority", "0");
  const issue = await show(id);
  assert.deepEqual(
    [issue.title, issue.status, issue.type, issue.priority, issue.category],
    ["Checkout", "open", "epic", 0, "ux polish"],
  );
  assert.deepEqual(
    [issue.description, issue.requirements, issue.done, issue.plan, issue.notes],
    ["Rewritten.", "1. Guest checkout", "Orders go through", "text from standard input", "A note"],
  );
  assert.deepEqual(issue.labels, []);
  await ok("write", id, "notes", "");
  assert.equal((await show(id)).notes, "");
});

test("sub-issues, links of every kind, moving, and what blocks what", async (t) => {
  if (skip) return t.skip(skip);
  const epic = await create("Epic", "--category", "api");
  const child = await create("Child", "--parent", epic, "--from", epic);
  const blocker = await create("Blocker");
  let shown = await show(child);
  assert.deepEqual([shown.parentId, shown.category], [epic, "api"]);
  assert.deepEqual(
    shown.links.map((link) => [link.kind, link.direction, link.id]),
    [["discovered-from", "out", epic]],
  );
  const parent = await show(epic);
  assert.deepEqual(parent.subIssues.map((ref) => ref.id), [child]);
  assert.deepEqual(
    parent.links.map((link) => [link.kind, link.direction, link.id]),
    [["discovered-from", "in", child]],
  );

  await ok("link", epic, blocker, "--kind", "blocked-by");
  await ok("link", child, blocker, "--kind", "related");
  // What the epic waits for, its sub-issue waits for too.
  shown = await show(child);
  assert.deepEqual(shown.blockedBy.map((ref) => ref.id), [blocker]);
  assert.deepEqual(
    (await show(blocker)).links.map((link) => [link.kind, link.direction, link.id]).sort(),
    [["blocked-by", "in", epic], ["related", "out", child]],
  );
  const ready = JSON.parse(await ok("ready", "--json")) as Issue[];
  const readyIds = ready.map((issue) => issue.id);
  assert.ok(readyIds.includes(blocker));
  assert.ok(!readyIds.includes(epic) && !readyIds.includes(child));
  assert.equal((await bend("link", epic, blocker, "--kind", "blocked-by")).status, 1);
  assert.equal((await bend("link", child, child, "--kind", "related")).status, 1);

  await ok("unlink", child, blocker);
  await ok("unlink", epic, blocker);
  assert.deepEqual((await show(blocker)).links, []);
  assert.deepEqual((await show(child)).blockedBy, []);
  assert.equal((await bend("unlink", epic, blocker)).status, 1);

  assert.equal((await bend("move", epic, "--under", child)).status, 1);
  await ok("move", child, "--top");
  assert.equal((await show(child)).parentId, null);
  await ok("move", child, "--under", blocker);
  assert.equal((await show(child)).parentId, blocker);
  const children = JSON.parse(await ok("list", "--parent", blocker, "--json")) as Issue[];
  assert.deepEqual(children.map((issue) => issue.id), [child]);
});

test("comments, decisions, starting, handing over, closing and reopening", async (t) => {
  if (skip) return t.skip(skip);
  const id = await create("To hand over");
  // Text that starts with a dash goes after "--", as bend asks.
  await ok("comment", id, "--", "-a comment that starts with a dash");
  await ok("decide", id, "Use the queue", "--as", "agent-7");
  await ok("start", id);
  let issue = await show(id);
  assert.equal(issue.status, "in_progress");
  assert.notEqual(issue.assignee, null);
  await ok(
    "handover", id, "--done", "Built it", "--checked", "Ran the tests",
    "--not-checked", "Nothing", "--as", "agent-7",
  );
  const comments = JSON.parse(await ok("comments", id, "--json")) as {
    author: string;
    text: string;
  }[];
  assert.equal(comments.length, 3);
  assert.equal(comments[0]!.text, "-a comment that starts with a dash");
  assert.deepEqual([comments[1]!.author, comments[1]!.text], ["agent-7", "Decision: Use the queue"]);
  assert.equal(comments[2]!.author, "agent-7");
  assert.match(comments[2]!.text, /^Hand-over/u);

  await ok("close", id, "--reason", "Shipped");
  issue = await show(id);
  assert.deepEqual([issue.status, issue.closeReason, issue.commentCount], ["closed", "completed", 4]);
  const all = JSON.parse(await ok("list", "--status", "all", "--json")) as Issue[];
  assert.equal(all.find((found) => found.id === id)?.status, "closed");
  const open = JSON.parse(await ok("list", "--json")) as Issue[];
  assert.ok(!open.some((found) => found.id === id));
  await ok("reopen", id);
  assert.equal((await show(id)).status, "open");
});

test("search finds an issue by its words", async (t) => {
  if (skip) return t.skip(skip);
  const word = `zebra${Date.now()}`;
  const id = await create(`Searchable ${word}`);
  // GitHub's search runs behind; give it up to half a minute.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const found = JSON.parse(await ok("search", word, "--json")) as Issue[];
    if (found.some((issue) => issue.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  assert.fail(`search did not find issue ${id} within 30 seconds`);
});

test("problems end with the right status and a plain reason", async (t) => {
  if (skip) return t.skip(skip);
  const missing = await bend("show", "999999");
  assert.deepEqual([missing.status, missing.err], [1, "bend: There is no issue with id 999999."]);
  const notANumber = await bend("show", "abc");
  assert.equal(notANumber.status, 1);
  assert.match(notANumber.err, /not a GitHub issue number/u);
  assert.equal((await bend("create", "x", "--parent", "999999")).status, 1);
  assert.equal((await bend("list", "--nope")).status, 2);
  // Standing facts live in the folder's FACTS.md, whatever the tracker.
  await ok("remember", "Deploys go out on Mondays", "--key", "deploys");
  assert.equal(await ok("recall", "monday"), "deploys: Deploys go out on Mondays");
});
