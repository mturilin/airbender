// app/section-block.tsx — a titled group of issues.
//
// What: SectionBlock, one status group with its heading, count, optional
// header buttons and optional collapsible sub-groups, and CurrentSection, the
// pinned group for the thread's current issue.
//
// Why: every group in the tab, including Current, is drawn the same way (the
// user asked for Current to look like the other groups, only highlighted).

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { useActions } from "./actions.ts";
import type { Section, SubGroup } from "./issue-model.ts";
import { IssueRow } from "./issue-row.tsx";

/**
 * One titled group of issues. `headerActions` puts buttons at the right end
 * of the title line; the Current group uses it for Clear and "define".
 */
export function SectionBlock({
  section,
  headerActions = null,
  detailsClassName,
  collapsed = false,
  subIssuesClassName,
  listClassName,
  rowHoverClassName,
  subGroups = [],
  collapsedSubGroups = [],
  onToggleSubGroup,
  emptyNote,
}: {
  section: Section;
  headerActions?: ReactNode;
  detailsClassName?: string;
  /** Show only the heading line (with its count), not the issues. */
  collapsed?: boolean;
  /** Passed to each row; see IssueRow. */
  subIssuesClassName?: string;
  /** Extra classes for the box around the rows, e.g. Current's border. */
  listClassName?: string;
  /** Passed to each row as its hover background; see IssueRow. */
  rowHoverClassName?: string;
  /**
   * When not empty, the group is drawn as these sub-groups, each with its
   * own collapsible heading, instead of one list. Used for Ready when a
   * grouping is chosen. The group's own heading keeps the total count.
   */
  subGroups?: SubGroup[];
  /** Keys of the sub-groups that are collapsed. */
  collapsedSubGroups?: string[];
  /** Collapses or opens a sub-group. */
  onToggleSubGroup?: (key: string) => void;
  /** Shown in place of the list when the group has no issues. */
  emptyNote?: string;
}) {
  /** One boxed list of rows; a group has one, or one per sub-group. */
  const rows = (issues: Issue[]) => (
    <ul
      className={cn(
        "mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card",
        listClassName,
      )}
    >
      {issues.map((issue) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          detailsClassName={detailsClassName}
          subIssuesClassName={subIssuesClassName}
          hoverClassName={rowHoverClassName}
        />
      ))}
    </ul>
  );
  return (
    <section>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-baseline gap-2 text-sm font-medium">
            {section.title}
            <span className="text-xs font-normal text-muted-foreground">
              {section.issues.length}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">{section.hint}</p>
        </div>
        {headerActions}
      </div>
      {section.issues.length === 0 && emptyNote !== undefined ? (
        <p className="mt-2 text-xs text-muted-foreground">{emptyNote}</p>
      ) : null}
      {collapsed || section.issues.length === 0 ? null : subGroups.length ===
        0 ? (
        rows(section.issues)
      ) : (
        subGroups.map((subGroup) => {
          const folded = collapsedSubGroups.includes(subGroup.key);
          return (
            <div key={subGroup.key} className="mt-3">
              <button
                type="button"
                aria-expanded={!folded}
                onClick={() => onToggleSubGroup?.(subGroup.key)}
                className="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <Icon
                  name={folded ? "ChevronRight" : "ChevronDown"}
                  className="size-3.5 shrink-0"
                />
                {subGroup.label}
                <span className="font-normal">· {subGroup.issues.length}</span>
              </button>
              {folded ? null : rows(subGroup.issues)}
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * The first group in a thread's tab: the bead this thread is working on. It
 * looks and behaves like every other group — one collapsed row that opens on
 * its chevron — so a long description never pushes the rest of the tab down.
 * Shown only for threads, because "what this thread works on" has no meaning
 * on the New thread screen.
 *
 * Three cases: a bead is chosen and exists; a bead is chosen but is no longer
 * in the list (deleted, or from another repository); nothing is chosen yet.
 */
export function CurrentSection({
  issue,
}: {
  issue: Issue | null;
}) {
  const actions = useActions();
  const { currentBeadId, setCurrent } = actions;
  if (setCurrent === null) return null;
  const clear = (
    <Button
      variant="ghost"
      size="sm"
      tip="Stop treating this as the issue the conversation is working on"
      onClick={() => setCurrent(null)}
    >
      Clear
    </Button>
  );
  if (issue !== null) {
    return (
      <SectionBlock
        section={{
          id: "current",
          title: "Current",
          hint: "The bead this thread is working on.",
          issues: [issue],
        }}
        // Pinned, so an opened long description scrolls inside itself
        // instead of covering the list below. For the same reason the
        // current bead's sub-issues scroll inside a cap. The two caps
        // together leave at least half the panel to the list.
        detailsClassName="max-h-[22vh] overflow-y-auto"
        // The current issue stands out by a box with a thicker border and a
        // light green background, the look the user chose after trying it
        // (bead-bb-6ui).
        //
        // The green is BB's theme "success" colour mixed INTO the card
        // colour, giving a solid colour. The first attempts used the green
        // at low opacity instead, which let whatever lay underneath show
        // through: the panel's gray background at rest, and the gray hover
        // on top, so it read as gray-green. A solid mix cannot pick up gray.
        // Hover is the same mix with more green, nothing else.
        listClassName="border-2 border-success/40 bg-[color:color-mix(in_oklab,var(--success)_9%,var(--card))]"
        rowHoverClassName="hover:bg-[color:color-mix(in_oklab,var(--success)_18%,var(--card))]"
        // The current issue's sub-issues get no darker tint of their own:
        // gray over green is the same gray-green again.
        subIssuesClassName="max-h-[22vh] overflow-y-auto bg-transparent"
      />
    );
  }
  return (
    <section>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Current</h3>
          <p className="text-xs text-muted-foreground">
            The bead this thread is working on.
          </p>
        </div>
        {currentBeadId === null ? null : clear}
      </div>
      <div className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        {currentBeadId === null ? (
          <>
            None yet. Press play on an issue to start the agent on it.
          </>
        ) : (
          <>
            <span className="font-mono text-foreground">{currentBeadId}</span>{" "}
            is not in the list any more.
          </>
        )}
      </div>
    </section>
  );
}
