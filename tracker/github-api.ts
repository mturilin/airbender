// tracker/github-api.ts — the connection to GitHub.
//
// What: the handful of things the GitHub adapter asks GitHub for, as one
// interface (GitHubClient), and its real implementation: signing in,
// sending requests, paging, and saying in plain words why a request failed.
//
// Why: everything that knows GitHub's wire format is here, and everything
// that knows how an issue is mapped is in github.ts. The adapter is handed
// a client, so its rules are tested against an in-memory stand-in
// (github-fake.ts) with no network, and this file is checked against real
// GitHub by the end-to-end test.
//
// Design notes:
// - Reading uses GitHub's GraphQL interface: one request brings an issue
//   with its parent, its sub-issues and what blocks it, where the REST
//   interface would need a request for each. Changing uses REST, which has
//   a plain call for every change needed.
// - Requests are sent by node itself, not by running `gh` each time: a
//   process per request is slow, and a caller that keeps a copy of the
//   issues (the cache layer, bead-bb-c9l.5) will send many from one
//   long-lived process.
// - The login is the one the `gh` program already holds: GH_TOKEN or
//   GITHUB_TOKEN if set, else `gh auth token`, asked once per client.
// - The parent chain is read four levels up. An issue waits for what the
//   issues it sits inside wait for; deeper nesting than that is rare, and
//   each level costs a join on every issue of every list.
//
// Gotchas:
// - The token is kept in memory only and must never reach a message or a
//   log. Failures are worded from GitHub's answer, not from the request.
// - GraphQL reports a missing issue as an error next to `data` with a
//   null in it, not as a failed request.
// - A sub-issue and a blocker are named by the issue's database id in
//   request bodies, not by its number.
// - GitHub's `since` on a list of issues means "updated at or after".

import { execFile } from "node:child_process";
import { Refused } from "./types.ts";

/** A short pointer to an issue, as GitHub gives it. */
export interface GhRef {
  number: number;
  title: string;
  state: "open" | "closed";
}

/** An issue an issue sits inside, with what that one waits for. */
export interface GhParent extends GhRef {
  blockedBy: GhRef[];
  parent: GhParent | null;
}

/** One issue, with everything the adapter maps. */
export interface GhIssue extends GhRef {
  /** The database id, which sub-issue and blocker calls ask for. */
  id: number;
  body: string;
  /** GitHub's word for why it was closed, lower case; null when open. */
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** The first assignee's login. */
  assignee: string | null;
  labels: string[];
  commentCount: number;
  parent: GhParent | null;
  subIssues: GhRef[];
  blockedBy: GhRef[];
  blocking: GhRef[];
}

/** One comment, as GitHub gives it. */
export interface GhComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
}

/** What `update` can change; a field left out is left as it is. */
export interface GhChanges {
  title?: string;
  body?: string;
  /** The whole set of labels the issue is to carry. */
  labels?: string[];
  /** The whole set of assignees, by login. */
  assignees?: string[];
  state?: "open" | "closed";
  stateReason?: "completed" | "not_planned" | "reopened";
}

/**
 * Everything the adapter asks of GitHub, for one repository.
 *
 * Every method rejects with Refused, in plain words, when GitHub cannot be
 * reached, the login is missing or not accepted, a limit is hit, or GitHub
 * says no. A missing issue is not a rejection where the answer can say so
 * (`issue` gives null, `refs` leaves it out).
 */
export interface GitHubClient {
  /** "owner/name". */
  readonly repository: string;
  /** The login of the signed-in account. */
  viewer(): Promise<string>;
  /** Whether the repository has issues switched on. */
  hasIssues(): Promise<boolean>;
  issue(number: number): Promise<GhIssue | null>;
  /** Pointers to these issues; one that does not exist is left out. */
  refs(numbers: number[]): Promise<GhRef[]>;
  /** Every issue in a state, oldest first; pull requests are not issues. */
  issues(options: {
    state: "open" | "closed" | "all";
    /** Only those updated at or after this moment. */
    since?: string;
  }): Promise<GhIssue[]>;
  /** Issues matching free text, best match first; at most fifty. */
  search(text: string): Promise<GhIssue[]>;
  /** An issue's comments, oldest first. */
  comments(number: number): Promise<GhComment[]>;
  /** @returns The new issue's number and database id. */
  create(draft: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; id: number }>;
  update(number: number, changes: GhChanges): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
  /** Puts an issue under a parent, taking it out of any other. */
  setParent(parentNumber: number, childId: number): Promise<void>;
  removeParent(parentNumber: number, childId: number): Promise<void>;
  /** Records that `number` waits for the issue with database id `blockerId`. */
  addBlockedBy(number: number, blockerId: number): Promise<void>;
  removeBlockedBy(number: number, blockerId: number): Promise<void>;
  /** How many requests this client has sent; for tests of what a read costs. */
  requests(): number;
}

/** How to sign in, said wherever a login is missing or refused. */
const SIGN_IN =
  "Sign in with `gh auth login`, or set GH_TOKEN to a token that may read and write the repository's issues.";

/**
 * The token to sign in with: from the environment, else from `gh`.
 *
 * @throws Refused when there is none.
 * Side effects: may run `gh auth token` once.
 */
export function findToken(): Promise<string> {
  const given = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (given) return Promise.resolve(given);
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000 }, (error, stdout) => {
      const token = stdout.trim();
      if (error === null && token !== "") return resolve(token);
      reject(new Refused(`Not signed in to GitHub. ${SIGN_IN}`));
    });
  });
}

/** The fields read for a pointer to an issue. */
const REF = "number title state";

/**
 * The fields read for an issue. The numbers are upper bounds on what is
 * read with each issue, not on what GitHub allows; an issue with more
 * sub-issues or blockers than this shows the first of them.
 */
const ISSUE = `
  ${REF} databaseId body stateReason createdAt updatedAt
  assignees(first: 1) { nodes { login } }
  labels(first: 100) { nodes { name } }
  comments { totalCount }
  subIssues(first: 100) { nodes { ${REF} } }
  blockedBy(first: 50) { nodes { ${REF} } }
  blocking(first: 50) { nodes { ${REF} } }
  parent { ...Up parent { ...Up parent { ...Up parent { ...Up } } } }
`;

/** One level of the parent chain; see the header for why four are read. */
const UP = `fragment Up on Issue { ${REF} blockedBy(first: 50) { nodes { ${REF} } } }`;

/** A pointer as GraphQL gives it. */
interface RawRef {
  number: number;
  title: string;
  state: string;
}
interface RawParent extends RawRef {
  blockedBy: { nodes: RawRef[] };
  parent?: RawParent | null;
}
/** An issue as GraphQL gives it. */
interface RawIssue extends RawRef {
  databaseId: number;
  body: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  assignees: { nodes: { login: string }[] };
  labels: { nodes: { name: string }[] };
  comments: { totalCount: number };
  subIssues: { nodes: RawRef[] };
  blockedBy: { nodes: RawRef[] };
  blocking: { nodes: RawRef[] };
  parent: RawParent | null;
}

const toRef = (raw: RawRef): GhRef => ({
  number: raw.number,
  title: raw.title,
  state: raw.state === "CLOSED" ? "closed" : "open",
});

const toParent = (raw: RawParent | null | undefined): GhParent | null =>
  raw == null
    ? null
    : {
        ...toRef(raw),
        blockedBy: raw.blockedBy.nodes.map(toRef),
        parent: toParent(raw.parent),
      };

/** GraphQL's shape of an issue turned into this file's. Pure. */
export function toGhIssue(raw: RawIssue): GhIssue {
  return {
    ...toRef(raw),
    id: raw.databaseId,
    body: raw.body ?? "",
    stateReason: raw.stateReason?.toLowerCase().replaceAll("_", " ") ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    assignee: raw.assignees.nodes[0]?.login ?? null,
    labels: raw.labels.nodes.map((label) => label.name),
    commentCount: raw.comments.totalCount,
    parent: toParent(raw.parent),
    subIssues: raw.subIssues.nodes.map(toRef),
    blockedBy: raw.blockedBy.nodes.map(toRef),
    blocking: raw.blocking.nodes.map(toRef),
  };
}

/** A time of day a person can read, for "try again at". */
const clock = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Why a request failed, in plain words, from GitHub's answer.
 *
 * @param status The HTTP status.
 * @param headers The response's headers (rate-limit ones are read).
 * @param detail GitHub's own message, when it gave one.
 */
export function explainFailure(
  status: number,
  headers: { get(name: string): string | null },
  detail: string,
): string {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = Number(headers.get("x-ratelimit-reset"));
  const retryAfter = Number(headers.get("retry-after"));
  if ((status === 403 || status === 429) && remaining === "0") {
    return `GitHub's hourly limit on requests is used up. It lifts at ${Number.isFinite(reset) && reset > 0 ? clock(reset) : "the top of the hour"}.`;
  }
  if (
    (status === 403 || status === 429) &&
    (retryAfter > 0 || /secondary rate limit|abuse/iu.test(detail))
  ) {
    return `GitHub asked to slow down (too many requests in a short time). Try again in ${retryAfter > 0 ? `${retryAfter} seconds` : "a minute"}.`;
  }
  if (status === 401) {
    return `GitHub did not accept the login; it may have expired. ${SIGN_IN}`;
  }
  if (status === 403) {
    return `GitHub refused: this login may not do that here. ${detail}`.trim();
  }
  if (status === 404) {
    return "GitHub found no such repository or issue, or this login may not see it.";
  }
  if (status === 410) {
    return "Issues are switched off for this repository on GitHub.";
  }
  if (status >= 500) {
    return `GitHub is having trouble (status ${status}). Try again in a moment.`;
  }
  return detail === "" ? `GitHub refused the request (status ${status}).` : `GitHub refused: ${detail}`;
}

/**
 * Builds the real client for one repository.
 *
 * @param repository "owner/name".
 * @param token Gives the token to sign in with; asked once. The default
 *   looks in the environment and then asks `gh` (findToken).
 * @param send The function that sends a request; node's own `fetch` by
 *   default. Replaced in tests.
 * Side effects: none until a method is called; then HTTPS requests to
 *   api.github.com, which read or change the repository's issues.
 */
export function createGitHubClient({
  repository,
  token = findToken,
  send = fetch,
}: {
  repository: string;
  token?: () => Promise<string>;
  send?: typeof fetch;
}): GitHubClient {
  const [owner, name] = repository.split("/") as [string, string];
  const base = `/repos/${owner}/${name}`;
  let sent = 0;
  let signedIn: Promise<string> | undefined;
  let login: Promise<string> | undefined;

  /**
   * Sends one request and gives the parsed answer.
   *
   * @param path Starts with "/"; "/graphql" for GraphQL.
   * @throws Refused in plain words for every kind of failure.
   */
  async function request<Answer>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> {
    signedIn ??= token();
    const bearer = await signedIn;
    sent += 1;
    let response: Response;
    try {
      response = await send(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "bend",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // The cause is not passed on: it can name the request, and nothing
      // about the request belongs in a message.
      throw new Refused(
        "GitHub could not be reached. Check the network connection and try again.",
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON: left as null, and reported below if the request failed.
    }
    if (!response.ok) {
      const answer = (parsed ?? {}) as {
        message?: unknown;
        errors?: { message?: unknown }[];
      };
      const detail = [
        typeof answer.message === "string" ? answer.message : "",
        ...(Array.isArray(answer.errors)
          ? answer.errors.map((error) =>
              typeof error === "string"
                ? error
                : typeof error?.message === "string"
                  ? error.message
                  : "",
            )
          : []),
      ]
        .filter((part) => part !== "")
        .join(" ");
      throw new Refused(explainFailure(response.status, response.headers, detail));
    }
    return parsed as Answer;
  }

  /**
   * Sends one GraphQL request.
   *
   * @returns `data`. A missing issue is not a failure: its place in `data`
   *   is null and the caller decides what that means.
   * @throws Refused for any other error GraphQL reports.
   */
  async function graphql<Data>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Data> {
    const answer = await request<{
      data?: Data;
      errors?: { type?: string; message?: string }[];
    }>("POST", "/graphql", { query, variables });
    const errors = (answer.errors ?? []).filter(
      (error) => error.type !== "NOT_FOUND",
    );
    if (errors.some((error) => error.type === "RATE_LIMITED")) {
      throw new Refused(
        "GitHub's hourly limit on requests is used up. Try again within the hour.",
      );
    }
    if (errors.length > 0 || answer.data == null) {
      throw new Refused(
        `GitHub refused: ${errors.map((error) => error.message).join(" ") || "it gave no answer."}`,
      );
    }
    return answer.data;
  }

  /** Every page of a REST list, a hundred at a time. */
  async function everyPage<Row>(path: string): Promise<Row[]> {
    const rows: Row[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await request<Row[]>(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }

  return {
    repository,

    viewer() {
      login ??= graphql<{ viewer: { login: string } }>(
        "query { viewer { login } }",
        {},
      ).then((data) => data.viewer.login);
      return login;
    },

    async hasIssues() {
      const repo = await request<{ has_issues?: boolean }>("GET", base);
      return repo.has_issues !== false;
    },

    async issue(number) {
      const data = await graphql<{
        repository: { issue: RawIssue | null } | null;
      }>(
        `${UP} query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE} } }
        }`,
        { owner, name, number },
      );
      // No repository at all is not "no such issue": the name is wrong, or
      // this login may not see it. Said as that, so nobody goes looking
      // for an issue number.
      if (data.repository == null) {
        throw new Refused(explainFailure(404, new Headers(), ""));
      }
      const raw = data.repository.issue;
      return raw === null ? null : toGhIssue(raw);
    },

    async refs(numbers) {
      if (numbers.length === 0) return [];
      // One request for all of them, each under a name of its own.
      const fields = numbers
        .map((number, at) => `i${at}: issue(number: ${Math.trunc(number)}) { ${REF} }`)
        .join(" ");
      const data = await graphql<{
        repository: Record<string, RawRef | null> | null;
      }>(
        `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) { ${fields} }
        }`,
        { owner, name },
      );
      if (data.repository == null) {
        throw new Refused(explainFailure(404, new Headers(), ""));
      }
      return Object.values(data.repository)
        .filter((raw): raw is RawRef => raw !== null)
        .map(toRef);
    },

    async issues({ state, since }) {
      const states =
        state === "all" ? ["OPEN", "CLOSED"] : [state.toUpperCase()];
      const found: GhIssue[] = [];
      let after: string | null = null;
      for (;;) {
        const data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: RawIssue[];
            };
          } | null;
        } = await graphql(
          `${UP} query($owner: String!, $name: String!, $states: [IssueState!], $since: DateTime, $after: String) {
            repository(owner: $owner, name: $name) {
              issues(first: 100, after: $after, states: $states, filterBy: { since: $since },
                     orderBy: { field: CREATED_AT, direction: ASC }) {
                pageInfo { hasNextPage endCursor }
                nodes { ${ISSUE} }
              }
            }
          }`,
          { owner, name, states, since: since ?? null, after },
        );
        const page = data.repository?.issues;
        if (page === undefined) {
          throw new Refused(explainFailure(404, new Headers(), ""));
        }
        found.push(...page.nodes.map(toGhIssue));
        if (!page.pageInfo.hasNextPage) return found;
        after = page.pageInfo.endCursor;
      }
    },

    async search(text) {
      const data = await graphql<{
        search: {
          nodes: (
            | (RawIssue & { repository: { nameWithOwner: string } })
            | Record<string, never>
          )[];
        };
      }>(
        `${UP} query($query: String!) {
          search(query: $query, type: ISSUE, first: 50) {
            nodes { ... on Issue { repository { nameWithOwner } ${ISSUE} } }
          }
        }`,
        { query: `repo:${repository} is:issue ${text}` },
      );
      // The text is the caller's and GitHub reads qualifiers in it: a
      // second "repo:" would widen the search to another repository, whose
      // issues would then pass for this one's, numbers and all. Whatever
      // GitHub answers, only this repository's issues are given.
      return data.search.nodes
        .filter(
          (node): node is RawIssue & { repository: { nameWithOwner: string } } =>
            "number" in node &&
            node.repository.nameWithOwner.toLowerCase() ===
              repository.toLowerCase(),
        )
        .map(toGhIssue);
    },

    async comments(number) {
      const rows = await everyPage<{
        id: number;
        user: { login: string } | null;
        created_at: string;
        body: string | null;
      }>(`${base}/issues/${number}/comments`);
      return rows.map((row) => ({
        id: `${row.id}`,
        author: row.user?.login ?? "",
        createdAt: row.created_at,
        body: row.body ?? "",
      }));
    },

    async create(draft) {
      const made = await request<{ number: number; id: number }>(
        "POST",
        `${base}/issues`,
        draft,
      );
      return { number: made.number, id: made.id };
    },

    async update(number, changes) {
      await request("PATCH", `${base}/issues/${number}`, {
        title: changes.title,
        body: changes.body,
        labels: changes.labels,
        assignees: changes.assignees,
        state: changes.state,
        state_reason: changes.stateReason,
      });
    },

    async addComment(number, body) {
      await request("POST", `${base}/issues/${number}/comments`, { body });
    },

    async setParent(parentNumber, childId) {
      await request("POST", `${base}/issues/${parentNumber}/sub_issues`, {
        sub_issue_id: childId,
        replace_parent: true,
      });
    },

    async removeParent(parentNumber, childId) {
      await request("DELETE", `${base}/issues/${parentNumber}/sub_issue`, {
        sub_issue_id: childId,
      });
    },

    async addBlockedBy(number, blockerId) {
      await request(
        "POST",
        `${base}/issues/${number}/dependencies/blocked_by`,
        { issue_id: blockerId },
      );
    },

    async removeBlockedBy(number, blockerId) {
      await request(
        "DELETE",
        `${base}/issues/${number}/dependencies/blocked_by/${blockerId}`,
      );
    },

    requests: () => sent,
  };
}
