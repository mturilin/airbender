// app/menus.tsx — the Group and Filter menus.
//
// What: useMenu, the open/close behaviour shared by the small menus, and the
// Group and Filter buttons with their menus on the Ready heading.
//
// Why: the menus are drawn in the app's own style instead of the browser's
// dropdown, which the user found ugly, and must all close the same way.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { GROUPINGS, toggled } from "./issue-model.ts";
import type { Filters, GroupBy } from "./issue-model.ts";

/** One labelled checkbox line in the filter menu. */
function FilterOption({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-state-hover">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

/**
 * Open/closed state for a small menu that hangs under its button.
 *
 * The menu closes on a press outside it or on Escape. Shared by the Filter
 * and Group menus so both behave alike.
 *
 * @returns `open` and `setOpen`, and `root`: a ref to put on the element
 *   that wraps both the button and the menu, so a press inside either does
 *   not count as "outside". Also `panel`: an optional second ref, for a menu
 *   that is drawn elsewhere in the page (a portal) and so is not inside
 *   `root`; a press inside it does not count as "outside" either.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return { open, setOpen, root, panel };
}

/** What each grouping is called in the Group menu and on its button. */
const GROUPING_LABELS: Record<GroupBy, string> = {
  none: "None",
  priority: "Priority",
  type: "Type",
  category: "Category",
};

/**
 * The Group button and its menu, on the Ready heading: how the Ready group
 * is divided into sub-groups (none, priority, type or category).
 *
 * Drawn like the Filter button beside it, and for the same reason shows the
 * active choice on the button: a divided list should say what divides it.
 * It replaced a browser dropdown, which the owner found ugly (its open list
 * is drawn by the operating system, not in the app's style).
 *
 * Choosing an entry applies it and closes the menu.
 */
export function GroupMenu({
  groupBy,
  onChange,
}: {
  groupBy: GroupBy;
  onChange: (next: GroupBy) => void;
}) {
  const { open, setOpen, root } = useMenu();
  return (
    <div ref={root} className="relative shrink-0">
      <Button
        variant={groupBy === "none" ? "ghost" : "secondary"}
        size="sm"
        aria-expanded={open}
        tip="Divide the Ready issues into sub-groups you can collapse"
        onClick={() => setOpen((current) => !current)}
      >
        {groupBy === "none"
          ? "Group"
          : `By ${GROUPING_LABELS[groupBy].toLowerCase()}`}
        <Icon name="ChevronDown" className="size-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md"
        >
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            Group Ready by
          </div>
          {GROUPINGS.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={choice === groupBy}
              onClick={() => {
                onChange(choice);
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-state-hover",
                choice === groupBy && "font-medium",
              )}
            >
              {GROUPING_LABELS[choice]}
              {choice === groupBy ? (
                <Icon name="Check" className="size-4 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Filter button and its menu: types, priorities and categories.
 *
 * The button shows how many narrowing choices (types and priorities) are
 * active, so a shortened list is never mistaken for the whole list. The menu
 * closes on a click outside it or on Escape.
 *
 * @param types Issue types that occur in this folder, so the menu only offers
 *   choices that can match something.
 */
export function FilterMenu({
  filters,
  onChange,
  types,
  categories,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  types: string[];
  /** Categories in use, so the menu only offers ones that can match. */
  categories: string[];
}) {
  const { open, setOpen, root } = useMenu();
  const narrowing =
    filters.types.length +
    filters.priorities.length +
    filters.categories.length;
  return (
    <div ref={root} className="relative shrink-0">
      <Button
        variant={narrowing > 0 ? "secondary" : "ghost"}
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Filter{narrowing > 0 ? ` (${narrowing})` : ""}
        <Icon name="ChevronDown" className="size-4" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 space-y-2 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
          {types.length === 0 ? null : (
            <div>
              <div className="px-2 text-xs font-medium text-muted-foreground">
                Type
              </div>
              {types.map((type) => (
                <FilterOption
                  key={type}
                  label={type}
                  checked={filters.types.includes(type)}
                  onChange={() =>
                    onChange({ ...filters, types: toggled(filters.types, type) })
                  }
                />
              ))}
            </div>
          )}
          <div>
            <div className="px-2 text-xs font-medium text-muted-foreground">
              Priority
            </div>
            {[0, 1, 2, 3, 4].map((priority) => (
              <FilterOption
                key={priority}
                label={`P${priority}`}
                checked={filters.priorities.includes(priority)}
                onChange={() =>
                  onChange({
                    ...filters,
                    priorities: toggled(filters.priorities, priority),
                  })
                }
              />
            ))}
          </div>
          {/* Shown only once a category exists: with none in use there is
              nothing to narrow by. */}
          {categories.length === 0 ? null : (
            <div>
              <div className="px-2 text-xs font-medium text-muted-foreground">
                Category
              </div>
              {["", ...categories].map((category) => (
                <FilterOption
                  key={category}
                  label={category === "" ? "No category" : category}
                  checked={filters.categories.includes(category)}
                  onChange={() =>
                    onChange({
                      ...filters,
                      categories: toggled(filters.categories, category),
                    })
                  }
                />
              ))}
            </div>
          )}
          <p className="px-2 text-xs text-muted-foreground">
            Nothing ticked under a heading shows all of them.
          </p>
          {narrowing === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() =>
                onChange({ ...filters, types: [], priorities: [], categories: [] })
              }
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
