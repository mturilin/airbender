// tracker/github-fake.ts — an in-memory stand-in for GitHub, for tests.
//
// What: a GitHubClient (github-api.ts) that keeps its issues in memory and
// behaves as GitHub was seen to behave for the calls the adapter makes.
//
// Why: the adapter's rules (where each field is kept, links written on
// both issues, what blocks what, who a comment is from) are worth testing
// on every run, without a network, a login or a rate limit. What GitHub
// really does is checked separately, by bend/github.e2e.test.ts.
//
// Design notes:
// - It imitates only what was checked against real GitHub on 2026-10-09
//   (bead-bb-c9l.1): a label exists once it is applied; a sub-issue has one
//   parent and adding it elsewhere moves it; a blocker is named by its
//   database id; a missing issue is "no such issue", not an error.
// - It counts requests the way the real client does: one per call, so a
//   test can say what a read costs.
//
// Gotchas:
// - A stand-in can drift from the real thing. When the end-to-end test and
//   this file disagree, GitHub is right and this file is wrong.

import type {
  GhChanges,
  GhComment,
  GhIssue,
  GhParent,
  GhRef,
  GitHubClient,
} from "./github-api.ts";
import { Refused } from "./types.ts";

/** One issue as the stand-in keeps it. */
interface Stored {
  number: number;
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  assignees: string[];
  labels: string[];
  parent: number | null;
  /** Numbers of the issues this one waits for. */
  blockedBy: number[];
  comments: GhComment[];
}

/** The stand-in, with a few extras for tests to look inside. */
export interface FakeGitHub extends GitHubClient {
  /** The description of an issue exactly as it is stored. */
  bodyOf(number: number): string;
  /** The labels of an issue exactly as they are stored. */
  labelsOf(number: number): string[];
  /** Moves the stand-in's clock, so "changed since" can be tested. */
  setClock(iso: string): void;
}

/**
 * Builds an empty stand-in repository.
 *
 * @param login The account it is signed in as.
 */
export function createFakeGitHub({
  repository = "someone/scratch",
  login = "octo",
}: { repository?: string; login?: string } = {}): FakeGitHub {
  const stored = new Map<number, Stored>();
  let sent = 0;
  let now = "2026-01-01T00:00:00Z";
  let commentIds = 0;

  /** The stored issue, or GitHub's refusal for one that does not exist. */
  function need(number: number): Stored {
    const issue = stored.get(number);
    if (issue === undefined) {
      throw new Refused(
        "GitHub found no such repository or issue, or this login may not see it.",
      );
    }
    return issue;
  }
  const byId = (id: number): Stored => {
    const issue = [...stored.values()].find((candidate) => candidate.id === id);
    if (issue === undefined) throw new Refused("GitHub refused: no such issue id.");
    return issue;
  };
  const ref = (issue: Stored): GhRef => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
  });
  const refs = (numbers: number[]): GhRef[] =>
    numbers.flatMap((number) => {
      const issue = stored.get(number);
      return issue === undefined ? [] : [ref(issue)];
    });
  /** The parent chain, four levels up, as the real client reads it. */
  function up(number: number | null, levels = 4): GhParent | null {
    const issue = number === null ? undefined : stored.get(number);
    if (issue === undefined || levels === 0) return null;
    return {
      ...ref(issue),
      blockedBy: refs(issue.blockedBy),
      parent: up(issue.parent, levels - 1),
    };
  }
  const full = (issue: Stored): GhIssue => ({
    ...ref(issue),
    id: issue.id,
    body: issue.body,
    stateReason: issue.stateReason,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    assignee: issue.assignees[0] ?? null,
    labels: [...issue.labels],
    commentCount: issue.comments.length,
    parent: up(issue.parent),
    subIssues: [...stored.values()]
      .filter((child) => child.parent === issue.number)
      .map(ref),
    blockedBy: refs(issue.blockedBy),
    blocking: [...stored.values()]
      .filter((other) => other.blockedBy.includes(issue.number))
      .map(ref),
  });
  const touch = (issue: Stored) => {
    issue.updatedAt = now;
  };

  return {
    repository,
    async viewer() {
      sent += 1;
      return login;
    },
    async hasIssues() {
      sent += 1;
      return true;
    },
    async issue(number) {
      sent += 1;
      const issue = stored.get(number);
      return issue === undefined ? null : full(issue);
    },
    async refs(numbers) {
      if (numbers.length === 0) return [];
      sent += 1;
      return refs(numbers);
    },
    async issues({ state, since }) {
      sent += 1;
      return [...stored.values()]
        .filter(
          (issue) =>
            (state === "all" || issue.state === state) &&
            (since === undefined ||
              Date.parse(issue.updatedAt) >= Date.parse(since)),
        )
        .map(full);
    },
    async search(text) {
      sent += 1;
      const words = text.toLowerCase().split(/\s+/u).filter(Boolean);
      return [...stored.values()]
        .filter((issue) =>
          words.every((word) =>
            `${issue.title}\n${issue.body}`.toLowerCase().includes(word),
          ),
        )
        .map(full);
    },
    async comments(number) {
      sent += 1;
      return [...need(number).comments];
    },
    async create(draft) {
      sent += 1;
      const number = stored.size + 1;
      const issue: Stored = {
        number,
        id: 1000 + number,
        title: draft.title,
        body: draft.body,
        state: "open",
        stateReason: null,
        createdAt: now,
        updatedAt: now,
        assignees: [],
        labels: [...draft.labels],
        parent: null,
        blockedBy: [],
        comments: [],
      };
      stored.set(number, issue);
      return { number, id: issue.id };
    },
    async update(number, changes: GhChanges) {
      sent += 1;
      const issue = need(number);
      if (changes.title !== undefined) issue.title = changes.title;
      if (changes.body !== undefined) issue.body = changes.body;
      if (changes.labels !== undefined) issue.labels = [...changes.labels];
      if (changes.assignees !== undefined) issue.assignees = [...changes.assignees];
      if (changes.state !== undefined) {
        issue.state = changes.state;
        issue.stateReason =
          changes.state === "open"
            ? null
            : (changes.stateReason ?? "completed").replaceAll("_", " ");
      }
      touch(issue);
    },
    async addComment(number, body) {
      sent += 1;
      const issue = need(number);
      commentIds += 1;
      issue.comments.push({
        id: `${commentIds}`,
        author: login,
        // A later comment gets a later time, as on GitHub.
        createdAt: new Date(Date.parse(now) + commentIds * 1000).toISOString(),
        body,
      });
      touch(issue);
    },
    async setParent(parentNumber, childId) {
      sent += 1;
      const parent = need(parentNumber);
      const child = byId(childId);
      // GitHub refuses a loop itself.
      for (let at: Stored | undefined = parent; at !== undefined; ) {
        if (at.number === child.number) {
          throw new Refused("GitHub refused: that would make a loop of sub-issues.");
        }
        at = at.parent === null ? undefined : stored.get(at.parent);
      }
      child.parent = parent.number;
      touch(child);
    },
    async removeParent(parentNumber, childId) {
      sent += 1;
      const child = byId(childId);
      if (child.parent !== need(parentNumber).number) {
        throw new Refused("GitHub refused: it is not a sub-issue of that issue.");
      }
      child.parent = null;
      touch(child);
    },
    async addBlockedBy(number, blockerId) {
      sent += 1;
      const issue = need(number);
      const blocker = byId(blockerId);
      if (!issue.blockedBy.includes(blocker.number)) {
        issue.blockedBy.push(blocker.number);
      }
      touch(issue);
    },
    async removeBlockedBy(number, blockerId) {
      sent += 1;
      const issue = need(number);
      const blocker = byId(blockerId);
      issue.blockedBy = issue.blockedBy.filter((had) => had !== blocker.number);
      touch(issue);
    },
    requests: () => sent,
    bodyOf: (number) => need(number).body,
    labelsOf: (number) => [...need(number).labels],
    setClock: (iso) => {
      now = iso;
    },
  };
}
