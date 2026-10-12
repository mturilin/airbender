// app/pickers.tsx — the Move to and Link search boxes.
//
// What: the two small search boxes an opened issue can show: one to pick a
// new parent for the issue, one to link it with another issue using beads'
// own link kinds. Both are built on SearchPicker, the shared "type a few
// letters, press Enter" box over the issue list.
//
// Why: the user wanted to move and link issues quickly in long lists, where
// the place to drag to is far off screen.
//
// Design notes:
// - SearchPicker owns what the two have in common: the search field, the
//   ranked and shortened list, the keys, the "more, keep typing" line and
//   Cancel. Each picker adds only what is its own: Move to has a "Top level"
//   entry, Link has its sentence with the kind and the swap button.
// - Drawn inside the opened issue rather than floating over it, because the
//   list the rows sit in clips anything that hangs outside it.
// - Keys: typing narrows the list, Enter takes the first result, Escape
//   cancels.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import type { LinkKind } from "../shared/constants.ts";
import { TAG_SELECT_CLASS } from "./bits.tsx";
import {
  TWO_WAY_KINDS,
  byUrgency,
  fuzzyScore,
  linkWords,
} from "./issue-model.ts";

/** Most results a picker lists at once. */
const PICKER_RESULTS = 8;

/** The look of one entry in a picker's list. */
const OPTION_CLASS =
  "block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm hover:bg-state-hover";

/**
 * A search field over a list of issues, with a short ranked list under it.
 *
 * @param targets The issues that may be picked.
 * @param closedLast Rank open issues above closed ones with the same match,
 *   and strike closed ones through. For pickers that offer closed issues.
 * @param firstOption An entry shown above the issues, given the text typed
 *   so far; null when it does not apply. Enter takes it only when no issue
 *   matches, so typing an issue's name always picks that issue.
 * @param above Drawn above the search field; `below` under the list. The
 *   Link picker uses one or the other so the box reads as a sentence.
 * @param onPick Called with the id of the chosen issue.
 */
function SearchPicker({
  targets,
  closedLast = false,
  firstOption,
  above = null,
  below = null,
  placeholder,
  ariaLabel,
  onPick,
  onCancel,
}: {
  targets: Issue[];
  closedLast?: boolean;
  firstOption?: (
    query: string,
  ) => { label: ReactNode; onPick: () => void } | null;
  above?: ReactNode;
  below?: ReactNode;
  placeholder: string;
  ariaLabel: string;
  onPick: (beadId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () =>
      targets
        .map((target) => ({
          target,
          score: fuzzyScore(query, `${target.id} ${target.title}`),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            (closedLast
              ? Number(left.target.status === CLOSED_STATUS) -
                Number(right.target.status === CLOSED_STATUS)
              : 0) ||
            byUrgency(left.target, right.target),
        )
        .map((entry) => entry.target),
    [targets, query, closedLast],
  );
  const shown = matches.slice(0, PICKER_RESULTS);
  const first = firstOption?.(query) ?? null;
  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
      {above}
      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (shown[0] !== undefined) onPick(shown[0].id);
            else first?.onPick();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <ul>
        {first === null ? null : (
          <li>
            <button type="button" className={OPTION_CLASS} onClick={first.onPick}>
              {first.label}
            </button>
          </li>
        )}
        {shown.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              className={cn(
                OPTION_CLASS,
                closedLast &&
                  target.status === CLOSED_STATUS &&
                  "text-muted-foreground line-through",
              )}
              onClick={() => onPick(target.id)}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {target.id}
              </span>{" "}
              {target.title}
            </button>
          </li>
        ))}
      </ul>
      {below}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {shown.length === 0 && first === null
            ? "No issue matches."
            : matches.length > shown.length
              ? `${matches.length - shown.length} more — keep typing to narrow.`
              : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The picker behind "Move to": a search field and a short list of issues to
 * move this one into, with "Top level" first for an issue that has a parent.
 *
 * @param targets Issues this one may be moved into (already excludes itself,
 *   its sub-issues and its present parent).
 * @param onPick Called with the chosen parent's id, or null for top level.
 */
export function MoveToPicker({
  issue,
  targets,
  onPick,
  onCancel,
}: {
  issue: Issue;
  targets: Issue[];
  onPick: (parentId: string | null) => void;
  onCancel: () => void;
}) {
  return (
    <SearchPicker
      targets={targets}
      // "Top level" is offered while it would change something and the
      // search does not rule it out.
      firstOption={(query) =>
        issue.parentId !== null && fuzzyScore(query, "top level") > 0
          ? {
              label: (
                <>
                  Top level{" "}
                  <span className="text-muted-foreground">
                    (out of its parent)
                  </span>
                </>
              ),
              onPick: () => onPick(null),
            }
          : null
      }
      placeholder={`Move ${issue.id} into… type to search`}
      ariaLabel={`Search for an issue to move ${issue.id} into`}
      onPick={onPick}
      onCancel={onCancel}
    />
  );
}

/**
 * The box behind the "Link" button: links this issue with another, using
 * the kinds of link the folder's tracker has.
 *
 * It reads as a sentence, so what will be saved is in front of the user
 * before Enter: "This issue [blocked by] <the issue searched for>". The swap
 * button turns it round, "<the issue searched for> [blocked by] this issue",
 * which is the same kind of link stored on the other issue. The user chose
 * the swap button over always linking from the open issue (awkward when you
 * are looking at the blocker) and over listing each direction as its own
 * kind (twice the list, with reverse names beads does not have). A two-way
 * kind ("related") has nothing to swap.
 *
 * @param kinds The kinds offered: those the folder's tracker has (GitHub
 *   issues have three of beads' eight). Never empty.
 * @param targets Issues this one may be linked with (already excludes itself).
 * @param onPick Called with the link to add: the issue it is stored on, the
 *   issue it points at, and its kind.
 */
export function LinkPicker({
  issue,
  kinds,
  targets,
  onPick,
  onCancel,
}: {
  issue: Issue;
  kinds: readonly LinkKind[];
  targets: Issue[];
  onPick: (fromId: string, toId: string, kind: LinkKind) => void;
  onCancel: () => void;
}) {
  // Starts on "blocks", as beads does when no kind is given; every tracker
  // has it, and it is first in the list.
  const [kind, setKind] = useState<LinkKind>(kinds[0] ?? "blocks");
  const [swapped, setSwapped] = useState(false);
  const twoWay = TWO_WAY_KINDS.includes(kind);
  const reversed = swapped && !twoWay;
  // The fixed half of the sentence: "This issue [kind]" or "[kind] this issue".
  const sentence = (
    <div className="flex items-center gap-1.5 px-1 text-sm">
      {reversed ? null : <span>This issue</span>}
      <select
        aria-label="Kind of link"
        value={kind}
        onChange={(event) => setKind(event.target.value as LinkKind)}
        className={cn(TAG_SELECT_CLASS, "text-foreground")}
      >
        {kinds.map((choice) => (
          <option key={choice} value={choice}>
            {linkWords(choice)}
          </option>
        ))}
      </select>
      {reversed ? <span>this issue</span> : null}
      <span className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={twoWay}
        tip={
          twoWay
            ? "This kind of link has no direction"
            : "Swap which issue is which"
        }
        aria-label="Swap which issue is which"
        onClick={() => setSwapped((current) => !current)}
      >
        <Icon name="ArrowUpDown" className="size-4" />
      </Button>
    </div>
  );
  return (
    <SearchPicker
      targets={targets}
      // Closed issues can be linked too; open ones are the likelier other
      // end, so they come first.
      closedLast
      // The order on screen is the order of the sentence.
      above={reversed ? null : sentence}
      below={reversed ? sentence : null}
      placeholder="Type to find the other issue…"
      ariaLabel={`Search for an issue to link with ${issue.id}`}
      onPick={(otherId) =>
        reversed
          ? onPick(otherId, issue.id, kind)
          : onPick(issue.id, otherId, kind)
      }
      onCancel={onCancel}
    />
  );
}
