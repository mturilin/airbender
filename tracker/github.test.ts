// tracker/github.test.ts — tests for the GitHub adapter, without a network.
//
// What: checks where each thing is kept on GitHub (labels, sections of the
// description, links written on both issues), what blocks what, who a
// comment is from, what each operation refuses, and what a read costs in
// requests; and the plain words for each way a request can fail.
//
// Why: these are the adapter's own rules, and none of them needs GitHub to
// be checked. They run against an in-memory stand-in (github-fake.ts).
// What GitHub really does is checked by bend/github.e2e.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubClient, explainFailure } from "./github-api.ts";
import { createFakeGitHub } from "./github-fake.ts";
import {
  createGitHubTracker,
  joinBody,
  readComment,
  signComment,
  splitBody,
} from "./github.ts";
import { Refused, Unsupported } from "./types.ts";

/** A fresh stand-in repository and an adapter on it. */
function fresh(actor?: string) {
  const github = createFakeGitHub({ login: "octo" });
  return { github, tracker: createGitHubTracker({ client: github, actor }) };
}

/** A rejection that is a Refused whose message matches. */
const refused = (pattern: RegExp) => (cause: unknown) =>
  cause instanceof Refused && pattern.test(cause.message);

test("a description is taken apart into its parts and put back the same", () => {
  const parts = {
    description: "Wanted.",
    requirements: "1. One",
    done: "It works",
    plan: "Do it",
    notes: "A note",
    links: [
      { kind: "discovered-from" as const, direction: "out" as const, id: "12" },
      { kind: "discovered-from" as const, direction: "in" as const, id: "15" },
      { kind: "related" as const, direction: "out" as const, id: "7" },
    ],
  };
  const body = joinBody(parts);
  assert.deepEqual(splitBody(body), parts);
  // A person reading it on github.com sees headings and plain lines.
  assert.match(body, /^Wanted\.\n\n<!-- bend:requirements -->\n## Requirements\n\n1\. One\n/u);
  assert.match(body, /## Done when\n\nIt works/u);
  assert.match(body, /## Links\n\n- discovered from #12\n- led to #15\n- related to #7\n/u);
  // Nothing but a description: no markers at all.
  assert.equal(
    joinBody({ ...parts, requirements: "", done: "", plan: "", notes: "", links: [] }),
    "Wanted.",
  );
  // A line a person added to the Links section is ignored, not an error.
  assert.deepEqual(
    splitBody("x\n\n<!-- bend:links -->\n## Links\n\n- see also the wiki\n- related to #3\n<!-- /bend:links -->").links,
    [{ kind: "related", direction: "out", id: "3" }],
  );
});

test("type, priority, category and 'in progress' are labels; the parts are sections", async () => {
  const { github, tracker } = fresh();
  const id = await tracker.create({
    title: "Checkout flow",
    description: "-starts with a dash",
    done: "Orders go through",
    type: "epic",
    priority: 1,
    category: "  UX  Polish ",
  });
  assert.equal(id, "1");
  assert.deepEqual(github.labelsOf(1).sort(), ["category:ux polish", "priority:1", "type:epic"]);
  await tracker.write(id, "requirements", "1. Guest checkout");
  await tracker.write(id, "plan", "The plan");
  await tracker.write(id, "notes", "A note");
  await tracker.write(id, "description", "Rewritten.");
  await tracker.edit(id, {
    title: "Checkout",
    priority: 0,
    addLabels: ["urgent"],
    assignee: "kim",
  });
  let issue = await tracker.show(id);
  assert.deepEqual(
    [issue.title, issue.status, issue.type, issue.priority, issue.category, issue.assignee],
    ["Checkout", "open", "epic", 0, "ux polish", "kim"],
  );
  assert.deepEqual(
    [issue.description, issue.requirements, issue.done, issue.plan, issue.notes],
    ["Rewritten.", "1. Guest checkout", "Orders go through", "The plan", "A note"],
  );
  // The labels that hold a field are not shown as plain labels.
  assert.deepEqual(issue.labels, ["urgent"]);
  // One priority label, never two.
  assert.deepEqual(
    github.labelsOf(1).filter((label) => label.startsWith("priority:")),
    ["priority:0"],
  );
  // Clearing a part removes its section; clearing a category its label.
  await tracker.write(id, "plan", "");
  await tracker.edit(id, { category: null, removeLabels: ["urgent"], assignee: null });
  issue = await tracker.show(id);
  assert.deepEqual([issue.plan, issue.category, issue.labels, issue.assignee], ["", null, [], null]);
  assert.doesNotMatch(github.bodyOf(1), /bend:plan/u);

  await tracker.start(id);
  issue = await tracker.show(id);
  assert.deepEqual([issue.status, issue.assignee], ["in_progress", "octo"]);
  assert.ok(github.labelsOf(1).includes("in-progress"));
  await assert.rejects(tracker.edit(id, { priority: 7 }), refused(/whole number from 0/u));
  // GitHub has no place for free-form data kept with an issue.
  assert.deepEqual([issue.metadata, issue.externalRef], [{}, null]);
  await assert.rejects(
    tracker.edit(id, { metadata: { branch: "x" } }),
    (cause) => cause instanceof Unsupported,
  );
  await assert.rejects(tracker.edit(id, { category: "a,b" }), refused(/comma/u));
});

test("sub-issues, what blocks what, and moving", async () => {
  const { tracker } = fresh();
  const epic = await tracker.create({ title: "Epic", category: "ux", type: "epic" });
  const child = await tracker.create({ title: "Child", parentId: epic });
  const grandchild = await tracker.create({ title: "Grandchild", parentId: child });
  const blocker = await tracker.create({ title: "Blocker" });
  // A sub-issue takes its parent's category and nothing else.
  let shown = await tracker.show(child);
  assert.deepEqual([shown.parentId, shown.category, shown.type], [epic, "ux", null]);
  assert.deepEqual((await tracker.show(epic)).subIssues.map((ref) => ref.id), [child]);

  await tracker.link(epic, blocker, "blocked-by");
  assert.deepEqual(
    (await tracker.show(epic)).links.map((link) => [link.kind, link.direction, link.id]),
    [["blocked-by", "out", blocker]],
  );
  assert.deepEqual(
    (await tracker.show(blocker)).links.map((link) => [link.kind, link.direction, link.id]),
    [["blocked-by", "in", epic]],
  );
  // What the epic waits for, the issues inside it wait for too, at any depth.
  for (const id of [epic, child, grandchild]) {
    assert.deepEqual((await tracker.show(id)).blockedBy.map((ref) => ref.id), [blocker], id);
  }
  assert.deepEqual((await tracker.ready()).map((issue) => issue.id), [blocker]);
  await assert.rejects(tracker.link(epic, blocker, "blocked-by"), refused(/already linked/u));
  // A finished blocker no longer blocks, but the link is still shown.
  await tracker.close(blocker);
  shown = await tracker.show(child);
  assert.deepEqual(shown.blockedBy, []);
  assert.deepEqual((await tracker.show(epic)).links.map((link) => link.status), ["closed"]);
  assert.deepEqual(
    (await tracker.ready()).map((issue) => issue.id),
    [epic, child, grandchild],
  );

  await assert.rejects(tracker.move(epic, epic), refused(/inside itself/u));
  await assert.rejects(tracker.move(epic, grandchild), refused(/inside itself/u));
  await tracker.move(grandchild, epic);
  assert.equal((await tracker.show(grandchild)).parentId, epic);
  await tracker.move(grandchild, null);
  assert.equal((await tracker.show(grandchild)).parentId, null);
  await tracker.move(grandchild, null); // Already at the top: nothing to do.
});

test("links GitHub has no place for are written on both issues", async () => {
  const { github, tracker } = fresh();
  const origin = await tracker.create({ title: "Origin" });
  const follow = await tracker.create({ title: "Follow-up", from: origin });
  const other = await tracker.create({ title: "Other" });
  const kinds = async (id: string) =>
    (await tracker.show(id)).links.map((link) => `${link.kind} ${link.direction} ${link.id}`);
  assert.deepEqual(await kinds(follow), [`discovered-from out ${origin}`]);
  assert.deepEqual(await kinds(origin), [`discovered-from in ${follow}`]);
  assert.match(github.bodyOf(Number(follow)), /- discovered from #1/u);
  assert.match(github.bodyOf(Number(origin)), /- led to #2/u);

  await tracker.link(follow, other, "related");
  assert.deepEqual(await kinds(other), [`related out ${follow}`]);
  assert.deepEqual(await kinds(follow), [
    `discovered-from out ${origin}`,
    `related out ${other}`,
  ]);
  await assert.rejects(tracker.link(follow, other, "related"), refused(/already linked/u));
  await assert.rejects(tracker.link(follow, follow, "related"), refused(/to itself/u));
  await assert.rejects(tracker.link(follow, "99", "related"), refused(/no issue with id 99/u));
  await assert.rejects(
    tracker.link(follow, other, "tracks"),
    (cause) => cause instanceof Unsupported,
  );

  // Showing one issue never reads the list: a fixed, small number of
  // requests, whatever the repository holds.
  for (let extra = 0; extra < 30; extra += 1) {
    await tracker.create({ title: `Filler ${extra}` });
  }
  let before = github.requests();
  await tracker.show(follow);
  assert.equal(github.requests() - before, 2, "show: the issue, and the titles its text links name");
  before = github.requests();
  await tracker.show(other);
  assert.equal(github.requests() - before, 2);
  before = github.requests();
  await tracker.comments(follow);
  assert.equal(github.requests() - before, 2, "comments: the issue, and its comments");

  // Removing a link removes both lines.
  await tracker.unlink(other, follow);
  assert.deepEqual(await kinds(other), []);
  assert.deepEqual(await kinds(follow), [`discovered-from out ${origin}`]);
  // "Only the link recorded on this issue": the origin's "led to" line is
  // about the follow-up, so it stays; from the follow-up's side it goes.
  await assert.rejects(tracker.unlink(origin, follow, true), refused(/no link between/u));
  await tracker.unlink(follow, origin, true);
  assert.deepEqual(await kinds(follow), []);
  assert.deepEqual(await kinds(origin), []);
  assert.doesNotMatch(github.bodyOf(Number(origin)), /bend:links/u);
  await assert.rejects(tracker.unlink(follow, origin), refused(/no link between/u));
});

test("comments say who wrote them; closing with a reason; reopening", async () => {
  const { tracker } = fresh("agent-7");
  const id = await tracker.create({ title: "To close" });
  await tracker.comment(id, "Decision: use the queue");
  await tracker.start(id);
  await tracker.close(id, "Shipped in 2.1");
  const comments = await tracker.comments(id);
  assert.deepEqual(
    comments.map((comment) => [comment.author, comment.text]),
    [
      ["agent-7", "Decision: use the queue"],
      ["agent-7", "Closed: Shipped in 2.1"],
    ],
  );
  let issue = await tracker.show(id);
  assert.deepEqual([issue.status, issue.closeReason, issue.commentCount], ["closed", "completed", 2]);
  await assert.rejects(tracker.start(id), refused(/is closed/u));
  await tracker.reopen(id);
  issue = await tracker.show(id);
  // Not "in progress" again: closing took that label off.
  assert.deepEqual([issue.status, issue.closeReason], ["open", ""]);

  // Written as the signed-in account itself: nothing is added.
  const own = fresh("octo");
  const mine = await own.tracker.create({ title: "Mine" });
  await own.tracker.comment(mine, "plain");
  assert.deepEqual(
    (await own.tracker.comments(mine)).map((comment) => [comment.author, comment.text]),
    [["octo", "plain"]],
  );
  // A name cannot break out of the marker it is kept in.
  const signed = signComment("a --> b\nc", "text");
  assert.deepEqual(readComment("octo", signed), { author: "a   b c", text: "text" });
});

test("lists: open by default, narrowed in memory, and only what changed since", async () => {
  const { github, tracker } = fresh();
  const bug = await tracker.create({ title: "Bug", type: "bug", priority: 1, category: "api" });
  const task = await tracker.create({ title: "Task", type: "task", parentId: bug });
  const done = await tracker.create({ title: "Done" });
  await tracker.close(done);
  await tracker.start(task);
  const ids = async (filter: Parameters<typeof tracker.list>[0]) =>
    (await tracker.list(filter)).map((issue) => issue.id);
  assert.deepEqual(await ids({}), [bug, task]);
  assert.deepEqual(await ids({ status: "all" }), [bug, task, done]);
  assert.deepEqual(await ids({ status: "closed" }), [done]);
  assert.deepEqual(await ids({ status: "in_progress" }), [task]);
  assert.deepEqual(await ids({ status: "open" }), [bug]);
  assert.deepEqual(await ids({ type: "bug" }), [bug]);
  assert.deepEqual(await ids({ priority: 1 }), [bug]);
  assert.deepEqual(await ids({ category: " API " }), [bug, task]);
  assert.deepEqual(await ids({ assignee: "octo" }), [task]);
  assert.deepEqual(await ids({ parentId: `#${bug}` }), [task]);
  assert.deepEqual((await tracker.search("bug")).map((issue) => issue.id), [bug]);

  github.setClock("2026-03-01T00:00:00Z");
  await tracker.edit(bug, { title: "Bug, renamed" });
  assert.deepEqual(
    await ids({ status: "all", changedSince: "2026-02-01T00:00:00Z" }),
    [bug],
  );
  // A list is one request, however it is narrowed.
  const before = github.requests();
  await tracker.list({ status: "all" });
  assert.equal(github.requests() - before, 1);
});

test("an id is GitHub's number; anything else is refused before GitHub is asked", async () => {
  const { github, tracker } = fresh();
  const id = await tracker.create({ title: "One" });
  assert.equal((await tracker.show(`#${id}`)).id, id);
  const before = github.requests();
  for (const bad of ["abc", "", "0", "-1", "1.5", "owner/repo#1", "--force"]) {
    await assert.rejects(tracker.show(bad), refused(/not a GitHub issue number/u), bad);
  }
  assert.equal(github.requests(), before);
  await assert.rejects(tracker.show("42"), refused(/no issue with id 42/u));
  await assert.rejects(tracker.create({ title: "x", parentId: "42" }), refused(/no issue with id 42/u));
  // Nothing was created by the refused create.
  assert.deepEqual((await tracker.list({ status: "all" })).map((issue) => issue.id), [id]);
});

test("status names the repository, the account, and what is kept another way", async () => {
  const { tracker } = fresh();
  const capabilities = await tracker.capabilities();
  assert.equal(capabilities.tracker, "github");
  assert.match(capabilities.where, /someone\/scratch on GitHub, signed in as octo/u);
  assert.deepEqual(capabilities.linkKinds, ["blocked-by", "discovered-from", "related"]);
  const level = (name: RegExp) =>
    capabilities.supports.find((item) => name.test(item.name))?.level;
  assert.equal(level(/sub-issues/u), "yes");
  assert.equal(level(/type, priority, category/u), "another way");
  assert.equal(level(/requirements/u), "another way");
  assert.equal(level(/discovered-from/u), "another way");
  assert.equal(level(/acting as another name/u), "no");
});

test("every way a request can fail is said in plain words", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  assert.match(
    explainFailure(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791603725" }), ""),
    /hourly limit .* lifts at /u,
  );
  assert.match(
    explainFailure(403, headers({ "retry-after": "30" }), "You have exceeded a secondary rate limit"),
    /slow down .* 30 seconds/u,
  );
  assert.match(explainFailure(401, headers({}), "Bad credentials"), /did not accept the login/u);
  assert.match(explainFailure(403, headers({}), "Resource not accessible"), /may not do that here/u);
  assert.match(explainFailure(404, headers({}), "Not Found"), /no such repository or issue/u);
  assert.match(explainFailure(410, headers({}), ""), /switched off/u);
  assert.match(explainFailure(502, headers({}), ""), /having trouble/u);
  assert.equal(explainFailure(422, headers({}), "Validation Failed"), "GitHub refused: Validation Failed");
});

test("the real client: no login, no network, and a refusal from GitHub", async () => {
  const secret = "ghp_not_a_real_token";
  const client = (send: typeof fetch, token = async () => secret) =>
    createGitHubClient({ repository: "someone/scratch", token, send });
  // No login: said before anything is sent.
  let sent = 0;
  await assert.rejects(
    client(
      async () => {
        sent += 1;
        return new Response("{}");
      },
      async () => {
        throw new Refused("Not signed in to GitHub.");
      },
    ).hasIssues(),
    refused(/Not signed in/u),
  );
  assert.equal(sent, 0);
  // The network fails: a plain sentence, and never the token.
  await assert.rejects(
    client(async () => {
      throw new TypeError(`fetch failed for Bearer ${secret}`);
    }).hasIssues(),
    (cause) =>
      cause instanceof Refused &&
      /could not be reached/u.test(cause.message) &&
      !cause.message.includes(secret),
  );
  // GitHub says no: its own words are passed on.
  await assert.rejects(
    client(
      async () =>
        new Response(
          JSON.stringify({ message: "Validation Failed", errors: [{ message: "Sub-issue already has a parent" }] }),
          { status: 422 },
        ),
    ).setParent(1, 2),
    refused(/Validation Failed Sub-issue already has a parent/u),
  );
  // The request carries the login and asks the right place.
  let seen: { url: string; authorization: string | null; body: unknown } | undefined;
  await client(async (url, init) => {
    seen = {
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    return new Response("{}", { status: 201 });
  }).addBlockedBy(5, 1006);
  assert.deepEqual(seen, {
    url: "https://api.github.com/repos/someone/scratch/issues/5/dependencies/blocked_by",
    authorization: `Bearer ${secret}`,
    body: { issue_id: 1006 },
  });
  // A search answer is narrowed to this repository, whatever the text asked.
  const node = (number: number, nameWithOwner: string) => ({
    number, title: `T${number}`, state: "OPEN", databaseId: number, body: "", stateReason: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0 },
    subIssues: { nodes: [] }, blockedBy: { nodes: [] }, blocking: { nodes: [] }, parent: null,
    repository: { nameWithOwner },
  });
  let asked = "";
  const found = await client(async (_url, init) => {
    asked = (JSON.parse(String(init?.body)) as { variables: { query: string } }).variables.query;
    return new Response(
      JSON.stringify({ data: { search: { nodes: [node(1, "Someone/Scratch"), node(7, "other/secret"), {}] } } }),
    );
  }).search("crash repo:other/secret");
  assert.equal(asked, "repo:someone/scratch is:issue crash repo:other/secret");
  assert.deepEqual(found.map((issue) => issue.number), [1]);
  // A repository this login cannot see is said as that, not as a missing issue.
  await assert.rejects(
    client(
      async () =>
        new Response(
          JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }),
        ),
    ).issue(1),
    refused(/no such repository or issue/u),
  );
  // GraphQL: a missing issue is "none", any other error is a refusal.
  const missing = client(
    async () =>
      new Response(
        JSON.stringify({
          data: { repository: { issue: null } },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue" }],
        }),
      ),
  );
  assert.equal(await missing.issue(999), null);
  await assert.rejects(
    client(
      async () =>
        new Response(JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "No access" }] })),
    ).issue(1),
    refused(/No access/u),
  );
});
