// app/issue-model.ts — how the tab reads the issue list.
//
// What: pure functions and small types that turn the issues from the backend
// into what the tab shows: which are blocked, which status group each belongs
// to, the sub-groups of Ready, the order of rows, search ranking for the
// pickers, the wording of links, and the filter shape.
//
// Why: this is the logic most likely to be subtly wrong, and none of it needs
// React or BB. Kept apart from the components so it can be loaded and tested
// with plain node (see app/issue-model.test.ts).
//
// Design notes:
// - Nothing here keeps state or touches the browser, except formatWhen, which
//   uses the reader's locale.
//
// Gotchas:
// - No React, no BB SDK and no "@/..." imports in this file, and relative
//   imports carry their .ts extension: node runs it directly in the tests.
// - Types from the backend are imported as types only.

import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS, ISSUE_TYPES } from "../shared/constants.ts";

/** A titled group of issues, in the order the tab shows them. */
export interface Section {
  id: "current" | "in_progress" | "ready" | "blocked" | "other" | "closed";
  title: string;
  /** One short line explaining what belongs in the group. */
  hint: string;
  issues: Issue[];
}

/**
 * Whether the tab treats an open issue as blocked. Three ways, all worked
 * out in server.ts: it waits on an unfinished issue; an issue it sits
 * inside does (beads' own rule, already folded into `blockedBy`); or it has
 * open sub-issues and every one of them is blocked (the user's rule: an
 * issue with even one workable sub-issue is actionable and is not blocked).
 * A closed issue is never blocked.
 */
export function isBlocked(issue: Issue): boolean {
  return (
    issue.status !== CLOSED_STATUS &&
    (issue.blockedBy.length > 0 || issue.subIssuesBlocked)
  );
}

/** Most urgent first; within one priority, most recently changed first. */
export function byUrgency(left: Issue, right: Issue): number {
  const priority = (left.priority ?? 99) - (right.priority ?? 99);
  if (priority !== 0) return priority;
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

/**
 * Splits issues into the groups the tab shows.
 *
 * "Blocked" wins over the issue's own status, because an issue that waits on
 * unfinished work cannot be picked up whatever its status says. "Other"
 * catches statuses such as deferred or any custom one.
 */
export function toSections(issues: Issue[]): Section[] {
  const sections: Section[] = [
    {
      id: "in_progress",
      title: "In progress",
      hint: "Someone has started these.",
      issues: [],
    },
    {
      id: "ready",
      title: "Ready",
      hint: "Open, and nothing unfinished stands in the way.",
      issues: [],
    },
    {
      id: "blocked",
      title: "Blocked",
      hint: "Waiting on other unfinished issues.",
      issues: [],
    },
    {
      id: "other",
      title: "Other",
      hint: "Deferred, or in a status of your own.",
      issues: [],
    },
    { id: "closed", title: "Closed", hint: "Finished or cancelled.", issues: [] },
  ];
  const find = (id: Section["id"]) =>
    sections.find((section) => section.id === id)!;
  for (const issue of issues) {
    if (issue.status === CLOSED_STATUS) find("closed").issues.push(issue);
    else if (isBlocked(issue)) find("blocked").issues.push(issue);
    else if (issue.status === "in_progress")
      find("in_progress").issues.push(issue);
    else if (issue.status === "open") find("ready").issues.push(issue);
    else find("other").issues.push(issue);
  }
  for (const section of sections) section.issues.sort(byUrgency);
  return sections;
}

/** "3 Oct 2026, 20:31" in the reader's own locale; the raw text if unparsable. */
export function formatWhen(timestamp: string): string {
  const when = new Date(timestamp);
  return Number.isNaN(when.getTime())
    ? timestamp
    : when.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/**
 * How well `query` matches `text`, for the "Move to" search: higher is
 * better, 0 is no match. A run of the query's letters found together beats
 * the same letters found scattered, and a match at the start of a word beats
 * one in the middle, so typing a few letters of an id or of a title's words
 * finds it without typing it exactly.
 */
export function fuzzyScore(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 1;
  const haystack = text.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at !== -1) {
    const atWordStart = at === 0 || /[^a-z0-9]/u.test(haystack[at - 1]!);
    return 1000 + (atWordStart ? 100 : 0) - Math.min(at, 99);
  }
  // Otherwise every letter must appear in order; closer together is better.
  let position = 0;
  let gaps = 0;
  for (const letter of needle.replaceAll(" ", "")) {
    const found = haystack.indexOf(letter, position);
    if (found === -1) return 0;
    gaps += found - position;
    position = found + 1;
  }
  return Math.max(1, 500 - gaps);
}

/**
 * How a link reads from the issue it is stored on, as in "this issue is
 * blocked by X". Beads' own names, with the dashes taken out; only "blocks"
 * is reworded, because beads stores "A blocks-type-depends on B" on the
 * issue that waits, and "this issue blocks X" would say the opposite.
 * "relates-to" is what a "related" link made here is stored as.
 */
const LINK_WORDS: Record<string, string> = {
  blocks: "blocked by",
  "discovered-from": "discovered from",
  related: "related",
  "relates-to": "related",
  tracks: "tracks",
  until: "until",
  "caused-by": "caused by",
  validates: "validates",
  supersedes: "supersedes",
};

/** Kinds that read the same from both ends, so they have no direction. */
export const TWO_WAY_KINDS: readonly string[] = ["related", "relates-to"];

/** A link's wording; a kind this file does not know is shown as beads names it. */
export function linkWords(kind: string): string {
  return LINK_WORDS[kind] ?? kind;
}

/**
 * Whether a description is long enough to be cut short in an opened row:
 * more than about four lines' worth, by length or by line count.
 */
export function isLongDescription(text: string): boolean {
  return text.length > 240 || text.split("\n").length > 4;
}

/**
 * What the user chose to see. An empty list means "all". Whether closed
 * issues are shown is not a filter: it is the Closed group's own Show/Hide
 * button (see BeadsPanel).
 */
export interface Filters {
  types: string[];
  priorities: number[];
  /** Category names; the empty string stands for "no category". */
  categories: string[];
  /**
   * How the Ready group is divided into sub-groups; "none" leaves it one
   * list. Kept here, with the filter, because it is the same kind of thing:
   * a remembered choice about how this folder's list is shown.
   */
  groupBy: GroupBy;
  /**
   * Sub-groups the user has collapsed, as "<grouping>:<value>" (for example
   * "priority:1", "category:ux", "category:" for no category). Kept per
   * grouping, so switching the grouping and back restores what was folded.
   */
  collapsed: string[];
}

/** The ways the Ready group can be divided. */
export const GROUPINGS = ["none", "priority", "type", "category"] as const;

export type GroupBy = (typeof GROUPINGS)[number];

export const NO_FILTERS: Filters = {
  types: [],
  priorities: [],
  categories: [],
  groupBy: "none",
  collapsed: [],
};

/** One sub-group of the Ready group. */
export interface SubGroup {
  /** "<grouping>:<value>", the key used in Filters.collapsed. */
  key: string;
  /** Heading shown to the user, e.g. "P1", "bug", "ux", "No category". */
  label: string;
  issues: Issue[];
}

/**
 * Divides issues into sub-groups by priority, type or category.
 *
 * Order: priority from P0 to P4; type in the order of the type dropdown,
 * then any other type alphabetically; category alphabetically. Issues with
 * no value come last, in a sub-group of their own. Sub-groups with no issues
 * are left out. The order of issues inside a sub-group is the order they
 * came in.
 *
 * Only the issues passed in are placed (top-level ones); an issue's
 * sub-issues are drawn under it by the row and so travel with their parent,
 * whatever their own values are.
 *
 * @returns An empty list for "none", meaning "do not divide".
 */
export function toSubGroups(issues: Issue[], groupBy: GroupBy): SubGroup[] {
  if (groupBy === "none") return [];
  // The value an issue is grouped under; "" stands for "has none".
  const valueOf = (issue: Issue): string =>
    groupBy === "priority"
      ? issue.priority === null
        ? ""
        : `${issue.priority}`
      : groupBy === "type"
        ? (issue.type ?? "")
        : (issue.category ?? "");
  const byValue = new Map<string, Issue[]>();
  for (const issue of issues) {
    const value = valueOf(issue);
    byValue.set(value, [...(byValue.get(value) ?? []), issue]);
  }
  const known = ISSUE_TYPES as readonly string[];
  const rank = (value: string): [number, string] =>
    value === ""
      ? [2, ""] // no value: last
      : groupBy === "type" && known.includes(value)
        ? [0, `${known.indexOf(value)}`.padStart(3, "0")] // dropdown order
        : [groupBy === "type" ? 1 : 0, value]; // otherwise alphabetical
  const label = (value: string) =>
    value !== ""
      ? groupBy === "priority"
        ? `P${value}`
        : value
      : groupBy === "priority"
        ? "No priority"
        : groupBy === "type"
          ? "No type"
          : "No category";
  return [...byValue.entries()]
    .sort(([left], [right]) => {
      const [leftRank, leftName] = rank(left);
      const [rightRank, rightName] = rank(right);
      return leftRank - rightRank || leftName.localeCompare(rightName);
    })
    .map(([value, grouped]) => ({
      key: `${groupBy}:${value}`,
      label: label(value),
      issues: grouped,
    }));
}

/** Adds the value to the list if absent, removes it if present. */
export function toggled<Value>(list: Value[], value: Value): Value[] {
  return list.includes(value)
    ? list.filter((candidate) => candidate !== value)
    : [...list, value];
}
