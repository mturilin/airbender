// app/use-filters.ts — the remembered filter and grouping of a folder.
//
// What: a hook that keeps the Filters value (types, priorities, categories,
// grouping, collapsed sub-groups) in the browser's local storage, per folder.
//
// Why: the user wants the list to look the same when they come back to it; the
// choice is a view preference, so it stays in the browser and not in beads.
//
// Gotchas:
// - The storage key keeps the name "bb-plugin-airbender:filters:<path>", and
//   still reads the older "bb-plugin-beads:..." key, so nobody loses a saved
//   filter.

import { useCallback, useEffect, useState } from "react";
import { GROUPINGS, NO_FILTERS } from "./issue-model.ts";
import type { Filters, GroupBy } from "./issue-model.ts";

/**
 * Filters for one folder, remembered in the browser's local storage so they
 * survive closing the tab and reloading BB.
 *
 * @param path Folder the tab is showing; null while it is not known yet, in
 *   which case nothing is read or saved.
 * Gotcha: stored text is treated as untrusted and re-checked field by field;
 *   anything unexpected falls back to "no filters".
 */
export function useFilters(path: string | null) {
  const key = path === null ? null : `bb-plugin-airbender:filters:${path}`;
  // The key the filters were saved under before the plugin was renamed;
  // read when nothing is saved under the new one, so the remembered filters
  // survive the rename.
  const legacyKey = path === null ? null : `bb-plugin-beads:filters:${path}`;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  useEffect(() => {
    if (key === null) return;
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(key) ??
          (legacyKey === null ? null : localStorage.getItem(legacyKey)) ??
          "null",
      );
      if (typeof stored !== "object" || stored === null) {
        setFilters(NO_FILTERS);
        return;
      }
      const { types, priorities, categories, groupBy, collapsed } =
        stored as Record<string, unknown>;
      setFilters({
        types: Array.isArray(types)
          ? types.filter((value): value is string => typeof value === "string")
          : [],
        priorities: Array.isArray(priorities)
          ? priorities.filter(
              (value): value is number => typeof value === "number",
            )
          : [],
        categories: Array.isArray(categories)
          ? categories.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        groupBy: (GROUPINGS as readonly unknown[]).includes(groupBy)
          ? (groupBy as GroupBy)
          : "none",
        collapsed: Array.isArray(collapsed)
          ? collapsed.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      });
    } catch {
      setFilters(NO_FILTERS);
    }
  }, [key]);
  const update = useCallback(
    (next: Filters) => {
      setFilters(next);
      if (key === null) return;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or disabled: the filter still works for this session.
      }
    },
    [key],
  );
  return [filters, update] as const;
}
