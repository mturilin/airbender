// shared/tree.ts — walking the tree of issues and sub-issues.
//
// What: one function that lists everything inside an issue, at any depth.
//
// Why: both halves need it. The backend uses it to close an issue's
// sub-issues and to refuse moving an issue inside itself; the frontend uses
// it to decide where an issue may be dropped or moved. It used to be written
// twice, once on each side.
//
// Gotchas:
// - Like shared/constants.ts, this file has no imports, so it is safe to
//   bundle on either side.

/**
 * Every issue inside `rootId`, at any depth, in an order where each issue
 * comes before the issues inside it (parents before children). The root
 * itself is not included.
 *
 * Guarded against a loop in the data (an issue that is, through bad data, its
 * own ancestor): each issue is visited once.
 *
 * @param issues Every issue of the folder; only `id` and `parentId` are read.
 */
export function descendantsOf<
  Item extends { id: string; parentId: string | null },
>(rootId: string, issues: Iterable<Item>): Item[] {
  const all = [...issues];
  const found: Item[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const issue of all) {
      if (issue.parentId !== parentId || seen.has(issue.id)) continue;
      seen.add(issue.id);
      found.push(issue);
      queue.push(issue.id);
    }
  }
  return found;
}
