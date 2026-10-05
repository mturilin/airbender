// server/issues.ts — turning beads' rows into the tab's issues.
//
// What: the shape of a row from `bd list --json`, the function that turns rows
// into issues (who blocks whom, links from both ends, categories), and small
// helpers on issues.
//
// Why: this is the most intricate logic in the backend and it is pure: rows
// in, issues out. Kept free of BB so it can be tested with plain node (see
// server/issues.test.ts).
//
// Gotchas:
// - No BB import here, and relative imports carry their .ts extension: node
//   runs this file directly in the tests.

import { z } from "zod";
import { CLOSED_STATUS } from "../shared/constants.ts";
import type { Issue, IssueLink } from "./contract.ts";

/**
 * One row of `bd list --json`, limited to the fields the tab uses. Parsed
 * loosely: unknown fields are ignored and optional ones may be missing,
 * because bd omits empty fields and adds new ones between versions.
 */
export const bdIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** Id of the issue this one sits inside; absent for a top-level issue. */
  parent: z.string().nullish(),
  design: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  notes: z.string().optional(),
  close_reason: z.string().optional(),
  comment_count: z.number().optional(),
  status: z.string(),
  priority: z.number().optional(),
  issue_type: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).nullish(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  dependencies: z
    .array(z.object({ depends_on_id: z.string(), type: z.string() }))
    .nullish(),
});

export type BdIssue = z.infer<typeof bdIssueSchema>;

/** Beads' type for the two-way link that `bd dep relate` creates. */
export const RELATES_TO = "relates-to";

/** Beads' type for sub-issues; handled through `parent`, never as a link. */
const PARENT_CHILD = "parent-child";

/**
 * How an issue's category is kept in beads: as a label "category:<name>".
 *
 * beads has no category field. It has free-text labels, and a convention for
 * an attribute with a single value: a label of the form `<dimension>:<value>`
 * (what `bd state <id> <dimension>` reads). Using it means bd and any other
 * beads tool show the category, with nothing stored outside beads. "One per
 * issue" is not enforced by beads; this plugin enforces it by removing every
 * category label before adding one.
 */
export const CATEGORY_PREFIX = "category:";

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

/** Longest category name accepted. */
const CATEGORY_MAX_LENGTH = 40;

/** The category carried by a set of labels, or null. The first one wins. */
export function categoryOf(labels: string[]): string | null {
  const label = labels.find((candidate) =>
    candidate.startsWith(CATEGORY_PREFIX),
  );
  // Lower-cased on the way in as well as on the way out (see
  // cleanCategory), so a label written with capitals by hand or by another
  // tool still counts as the same category.
  const name = label?.slice(CATEGORY_PREFIX.length).trim().toLowerCase() ?? "";
  return name === "" ? null : name;
}

/**
 * Checks and tidies a category name typed by the user.
 *
 * Categories are always lower case (the user's decision): it matches how
 * type and status read on a row, and it means capital letters can never
 * split one category into two, whoever sets it.
 *
 * @returns `{ name }`, or `{ reason }` in plain words when it cannot be used.
 */
export function cleanCategory(typed: string): { name: string } | { reason: string } {
  const name = typed.trim().replace(/\s+/gu, " ").toLowerCase();
  if (name === "") return { reason: "A category needs a name." };
  if (name.length > CATEGORY_MAX_LENGTH) {
    return {
      reason: `A category name can be at most ${CATEGORY_MAX_LENGTH} characters.`,
    };
  }
  // bd splits a label on commas, so a comma would turn one category into
  // several labels.
  if (name.includes(",")) {
    return { reason: "A category name cannot contain a comma." };
  }
  return { name };
}

/**
 * Turns bd's rows into the tab's issue shape and works out who blocks whom.
 *
 * An issue is blocked by another when it has a "blocks"-type dependency on it
 * and that other issue is not closed. Closed issues are never shown as blocked.
 * Blocking also passes down to sub-issues and, when every open sub-issue is
 * blocked, up to the issue that holds them (see the two passes below).
 * Other dependency types (parent-child, discovered-from, related) do not stop
 * work in beads, so they do not count as blocking.
 *
 * Separately, it collects every link of every kind except parent-child for
 * each issue, from both ends (`links`). A two-way "relates-to" pair is
 * stored on both issues; it is listed once per issue, as "out", so the tab
 * shows one chip for it and not two.
 */
export function toIssues(rows: BdIssue[]): Issue[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const isOpen = (row: BdIssue) => row.status !== CLOSED_STATUS;
  const blocks = new Map<string, { id: string; title: string }[]>();
  const blockedBy = new Map<string, { id: string; title: string }[]>();
  for (const row of rows) {
    if (!isOpen(row)) continue;
    for (const dependency of row.dependencies ?? []) {
      if (dependency.type !== "blocks") continue;
      const blocker = byId.get(dependency.depends_on_id);
      if (blocker === undefined || !isOpen(blocker)) continue;
      const waiting = blockedBy.get(row.id) ?? [];
      waiting.push({ id: blocker.id, title: blocker.title });
      blockedBy.set(row.id, waiting);
      const held = blocks.get(blocker.id) ?? [];
      held.push({ id: row.id, title: row.title });
      blocks.set(blocker.id, held);
    }
  }
  // Downwards (beads' rule): an open issue also waits on whatever the open
  // issues it sits inside wait on. Worked out from the direct blockers
  // gathered above, before anything is added, so the result does not depend
  // on the order of the rows. `seen` stops a loop in bad parent data.
  const direct = new Map(blockedBy);
  for (const row of rows) {
    if (!isOpen(row)) continue;
    const seen = new Set<string>([row.id]);
    let parent = row.parent == null ? undefined : byId.get(row.parent);
    while (parent !== undefined && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (isOpen(parent)) {
        for (const blocker of direct.get(parent.id) ?? []) {
          const waiting = blockedBy.get(row.id) ?? [];
          if (!waiting.some((known) => known.id === blocker.id)) {
            blockedBy.set(row.id, [...waiting, blocker]);
          }
        }
      }
      parent = parent.parent == null ? undefined : byId.get(parent.parent);
    }
  }
  // Upwards (the user's rule): an open issue all of whose open sub-issues
  // are blocked is blocked itself; one workable sub-issue keeps it
  // actionable. A sub-issue that has sub-issues of its own counts as blocked
  // by the same rule, so this goes through every level. Closed sub-issues
  // are ignored, and an issue with no open sub-issue is never blocked this
  // way (all closed means it is ready to be closed).
  const openChildren = new Map<string, BdIssue[]>();
  for (const row of rows) {
    if (!isOpen(row) || row.parent == null) continue;
    openChildren.set(row.parent, [...(openChildren.get(row.parent) ?? []), row]);
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
          (blockedBy.get(child.id) ?? []).length > 0 ||
          (!path.has(child.id) &&
            allSubIssuesBlocked(child.id, new Set([...path, id]))),
      );
    subIssuesBlocked.set(id, answer);
    return answer;
  };
  const links = new Map<string, IssueLink[]>();
  const addLink = (ownerId: string, link: IssueLink) =>
    links.set(ownerId, [...(links.get(ownerId) ?? []), link]);
  for (const row of rows) {
    for (const dependency of row.dependencies ?? []) {
      if (dependency.type === PARENT_CHILD) continue;
      const other = byId.get(dependency.depends_on_id);
      // A link to an issue outside this list (deleted, or in another
      // project) has no title to show and nothing to open; left out.
      if (other === undefined) continue;
      addLink(row.id, {
        kind: dependency.type,
        direction: "out",
        id: other.id,
        title: other.title,
        closed: !isOpen(other),
      });
      // The other end. Skipped for a two-way link whose mirror image is
      // stored there too, which that issue lists as its own "out".
      const mirrored =
        dependency.type === RELATES_TO &&
        (other.dependencies ?? []).some(
          (back) => back.type === RELATES_TO && back.depends_on_id === row.id,
        );
      if (!mirrored) {
        addLink(other.id, {
          kind: dependency.type,
          direction: "in",
          id: row.id,
          title: row.title,
          closed: !isOpen(row),
        });
      }
    }
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    design: row.design ?? "",
    acceptance: row.acceptance_criteria ?? "",
    notes: row.notes ?? "",
    closeReason: row.close_reason ?? "",
    commentCount: row.comment_count ?? 0,
    parentId: row.parent ?? null,
    step: stepOf(row.labels ?? []),
    status: row.status,
    priority: row.priority ?? null,
    type: row.issue_type ?? null,
    assignee: row.assignee ?? null,
    category: categoryOf(row.labels ?? []),
    labels: (row.labels ?? []).filter(
      (label) =>
        !label.startsWith(CATEGORY_PREFIX) && !label.startsWith(STEP_PREFIX),
    ),
    updatedAt: row.updated_at ?? row.created_at ?? null,
    blockedBy: blockedBy.get(row.id) ?? [],
    subIssuesBlocked: isOpen(row) && allSubIssuesBlocked(row.id, new Set()),
    blocks: blocks.get(row.id) ?? [],
    links: links.get(row.id) ?? [],
  }));
}
