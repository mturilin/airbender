// server/issues.ts — turning the tracker's issues into the tab's issues.
//
// What: the function that turns issues in the tracker core's common shape
// (tracker/types.ts) into the shape the tab draws (server/contract.ts), and
// the small helpers for what the tab keeps in labels: an issue's workflow
// step, its size, and an epic's branch.
//
// Why: the tab reads issues through the tracker core, as `bend` does, so
// there is one code path to beads (bead-bb-c9l.2). The core gives what is
// common to every tracker; what only the tab knows is added here: the
// workflow's labels, the tab's own names for links, and the owner's rule
// that an issue whose open sub-issues are all blocked is blocked itself.
// It is pure: issues in, issues out, tested with plain node (see
// server/issues.test.ts).
//
// Design notes:
// - The tab's shape is left as it was, with beads' names for links
//   ("blocks", "relates-to"), so the front end did not have to change.
// - The description is given to the tab as one text with the requirements
//   inside it, as the tracker holds it for beads: the tab has no place of
//   its own for requirements yet, and the text must read and edit as before.
//
// Gotchas:
// - No BB import here, and relative imports carry their .ts extension: node
//   runs this file directly in the tests.

import { CLOSED_STATUS } from "../shared/constants.ts";
import { withRequirements } from "../tracker/parts.ts";
import type { Issue as TrackerIssue } from "../tracker/types.ts";
import type { Issue, IssueLink } from "./contract.ts";

/**
 * The tab's name for the two-way link, which is beads' own: what a
 * "related" link is stored as.
 */
export const RELATES_TO = "relates-to";

/** The tab's names for the core's common link kinds; others are kept. */
const TAB_KIND: Record<string, string> = {
  "blocked-by": "blocks",
  related: RELATES_TO,
};

/** The core's name for the link that makes one issue wait for another. */
const BLOCKED_BY = "blocked-by";

/**
 * Prefix of the label that records which step of its workflow an issue is at
 * (bead-bb-e2b), e.g. `step:plan`. A plain label, like the category: beads'
 * own `bd set-state` would record every change as a closed child issue,
 * which would clutter each issue's sub-issues.
 */
export const STEP_PREFIX = "step:";

/**
 * The workflow step recorded on an issue, or null when none is. The value is
 * passed on as stored; the workflow decides what an unknown one means.
 */
export function stepOf(labels: string[]): string | null {
  const label = labels.find((candidate) => candidate.startsWith(STEP_PREFIX));
  const step = label?.slice(STEP_PREFIX.length).trim() ?? "";
  return step === "" ? null : step;
}

/** The label prefix an issue's size is stored under, e.g. "size:m". */
export const SIZE_PREFIX = "size:";

/**
 * The size stored on an issue: how much of the workflow it takes.
 *
 * @returns The size id, or null when the issue has none. What the id means
 *   is the workflow's (shared/workflow.ts); an id the workflow does not
 *   know is simply not offered or shown.
 */
export function sizeOf(labels: string[]): string | null {
  const label = labels.find((candidate) => candidate.startsWith(SIZE_PREFIX));
  const size = label?.slice(SIZE_PREFIX.length).trim() ?? "";
  return size === "" ? null : size;
}

/**
 * The label prefix an epic's branch is stored under, e.g.
 * `branch:proj-a1b-kanban-board` (bead-bb-ty5.2): the branch all of its
 * issues are worked on. A label, like the step and the size, so that it is
 * visible in beads and travels with the issue.
 */
export const BRANCH_PREFIX = "branch:";

/** The branch recorded on an issue, or null when none is. */
export function branchOf(labels: string[]): string | null {
  const label = labels.find((candidate) => candidate.startsWith(BRANCH_PREFIX));
  const branch = label?.slice(BRANCH_PREFIX.length).trim() ?? "";
  return branch === "" ? null : branch;
}

/**
 * Turns the tracker's issues into the tab's issue shape.
 *
 * What an issue waits for (`blockedBy`) is the tracker's own answer: the
 * unfinished issues it depends on, and those of the open issues it sits
 * inside. Two things are added here, from the tracker's links and parents:
 * `blocks`, the open issues that wait for this one directly, and
 * `subIssuesBlocked`, the owner's rule that an open issue all of whose open
 * sub-issues are blocked is blocked itself.
 *
 * Links are listed as the tracker gives them, from both ends, under the
 * tab's names for the kinds.
 */
export function toIssues(found: TrackerIssue[]): Issue[] {
  const byId = new Map(found.map((issue) => [issue.id, issue]));
  const isOpen = (issue: { status: string }) => issue.status !== CLOSED_STATUS;
  const blocks = new Map<string, { id: string; title: string }[]>();
  for (const issue of found) {
    if (!isOpen(issue)) continue;
    for (const link of issue.links) {
      if (link.kind !== BLOCKED_BY || link.direction !== "out") continue;
      if (!isOpen(link)) continue;
      const held = blocks.get(link.id) ?? [];
      held.push({ id: issue.id, title: issue.title });
      blocks.set(link.id, held);
    }
  }
  // Upwards (the user's rule): an open issue all of whose open sub-issues
  // are blocked is blocked itself; one workable sub-issue keeps it
  // actionable. A sub-issue that has sub-issues of its own counts as blocked
  // by the same rule, so this goes through every level. Closed sub-issues
  // are ignored, and an issue with no open sub-issue is never blocked this
  // way (all closed means it is ready to be closed).
  const openChildren = new Map<string, TrackerIssue[]>();
  for (const issue of found) {
    if (!isOpen(issue) || issue.parentId === null) continue;
    openChildren.set(issue.parentId, [
      ...(openChildren.get(issue.parentId) ?? []),
      issue,
    ]);
  }
  const subIssuesBlocked = new Map<string, boolean>();
  const allSubIssuesBlocked = (id: string, path: Set<string>): boolean => {
    const known = subIssuesBlocked.get(id);
    if (known !== undefined) return known;
    const children = openChildren.get(id) ?? [];
    // `path` holds the issues being worked out above this one; meeting one
    // again means the parent data loops, and the loop is not followed.
    const answer =
      children.length > 0 &&
      children.every(
        (child) =>
          child.blockedBy.length > 0 ||
          (!path.has(child.id) &&
            allSubIssuesBlocked(child.id, new Set([...path, id]))),
      );
    subIssuesBlocked.set(id, answer);
    return answer;
  };
  return found.map((issue) => ({
    id: issue.id,
    title: issue.title,
    description: withRequirements(issue.description, issue.requirements),
    design: issue.plan,
    acceptance: issue.done,
    notes: issue.notes,
    closeReason: issue.closeReason,
    commentCount: issue.commentCount,
    parentId: issue.parentId,
    step: stepOf(issue.labels),
    size: sizeOf(issue.labels),
    branch: branchOf(issue.labels),
    // Not known to the tracker; filled in by the server for the tab's list.
    conversationId: null,
    status: issue.status,
    priority: issue.priority,
    type: issue.type,
    assignee: issue.assignee,
    category: issue.category,
    labels: issue.labels.filter(
      (label) =>
        !label.startsWith(STEP_PREFIX) &&
        !label.startsWith(SIZE_PREFIX) &&
        !label.startsWith(BRANCH_PREFIX),
    ),
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    // A closed issue waits for nothing; the tracker says the same, and the
    // tab's rows rely on it.
    blockedBy: isOpen(issue)
      ? issue.blockedBy.map(({ id, title }) => ({ id, title }))
      : [],
    subIssuesBlocked: isOpen(issue) && allSubIssuesBlocked(issue.id, new Set()),
    blocks: blocks.get(issue.id) ?? [],
    links: issue.links
      // A link to an issue outside the list has no title to show.
      .filter((link) => byId.has(link.id))
      .map(
        (link): IssueLink => ({
          kind: TAB_KIND[link.kind] ?? link.kind,
          direction: link.direction,
          id: link.id,
          title: link.title,
          closed: !isOpen(link),
        }),
      ),
  }));
}
