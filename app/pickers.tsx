// app/pickers.tsx — the Move to and Link search boxes.
//
// What: the two small search boxes an opened issue can show: one to pick a new
// parent, one to link the issue with another using beads' own link kinds.
//
// Why: both are "type a few letters, press Enter" pickers over the issue list,
// opened from the opened issue's button row.
//
// Design notes:
// - They share their behaviour by convention only for now; a common base is
//   planned separately (bead-bb-dw0.5).

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS, LINK_KINDS } from "../shared/constants.ts";
import type { LinkKind } from "../shared/constants.ts";
import { TAG_SELECT_CLASS } from "./bits.tsx";
import {
  TWO_WAY_KINDS,
  byUrgency,
  fuzzyScore,
  linkWords,
} from "./issue-model.ts";

/**
 * The box behind the "Link" button: links this issue with another, using
 * beads' own link kinds.
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
 * Drawn inside the opened issue, like the Move to picker and for the same
 * reason: the list the rows sit in clips anything that hangs outside it.
 *
 * Keys: typing narrows the list, Enter takes the first result, Escape
 * cancels.
 *
 * @param targets Issues this one may be linked with (already excludes itself).
 * @param onPick Called with the link to add: the issue it is stored on, the
 *   issue it points at, and its kind.
 */
export function LinkPicker({
  issue,
  targets,
  onPick,
  onCancel,
}: {
  issue: Issue;
  targets: Issue[];
  onPick: (fromId: string, toId: string, kind: LinkKind) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  // Starts on "blocks", as beads does when no kind is given.
  const [kind, setKind] = useState<LinkKind>("blocks");
  const [swapped, setSwapped] = useState(false);
  const twoWay = TWO_WAY_KINDS.includes(kind);
  const reversed = swapped && !twoWay;
  const shown = useMemo(
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
            // Open issues first: they are the likelier other end.
            Number(left.target.status === CLOSED_STATUS) -
              Number(right.target.status === CLOSED_STATUS) ||
            byUrgency(left.target, right.target),
        )
        .map((entry) => entry.target),
    [targets, query],
  );
  const listed = shown.slice(0, MOVE_TO_RESULTS);
  const pick = (otherId: string) =>
    reversed ? onPick(otherId, issue.id, kind) : onPick(issue.id, otherId, kind);
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
        {LINK_KINDS.map((choice) => (
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
  const search = (
    <>
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
            if (listed[0] !== undefined) pick(listed[0].id);
          }
        }}
        placeholder="Type to find the other issue…"
        aria-label={`Search for an issue to link with ${issue.id}`}
      />
      <ul>
        {listed.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              className={cn(
                "block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm hover:bg-state-hover",
                target.status === CLOSED_STATUS &&
                  "text-muted-foreground line-through",
              )}
              onClick={() => pick(target.id)}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {target.id}
              </span>{" "}
              {target.title}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
      {/* The order on screen is the order of the sentence. */}
      {reversed ? (
        <>
          {search}
          {sentence}
        </>
      ) : (
        <>
          {sentence}
          {search}
        </>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {listed.length === 0
            ? "No issue matches."
            : shown.length > listed.length
              ? `${shown.length - listed.length} more — keep typing to narrow.`
              : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Most results the "Move to" picker lists at once. */
const MOVE_TO_RESULTS = 8;

/**
 * The picker behind "Move to": a search field and a short list of issues to
 * move this one into, with "Top level" first for an issue that has a parent.
 *
 * Drawn inside the opened issue rather than floating over it, because the
 * list the rows sit in clips anything that hangs outside it.
 *
 * Keys: typing narrows the list, Enter takes the first result, Escape
 * cancels.
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
            right.score - left.score || byUrgency(left.target, right.target),
        )
        .map((entry) => entry.target),
    [targets, query],
  );
  // "Top level" is offered while it would change something and the search
  // does not rule it out.
  const offerTopLevel =
    issue.parentId !== null && fuzzyScore(query, "top level") > 0;
  const shown = matches.slice(0, MOVE_TO_RESULTS);
  const option =
    "block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm hover:bg-state-hover";
  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
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
            if (offerTopLevel && shown.length === 0) onPick(null);
            else if (shown[0] !== undefined) onPick(shown[0].id);
          }
        }}
        placeholder={`Move ${issue.id} into… type to search`}
        aria-label={`Search for an issue to move ${issue.id} into`}
      />
      <ul>
        {offerTopLevel ? (
          <li>
            <button type="button" className={option} onClick={() => onPick(null)}>
              Top level{" "}
              <span className="text-muted-foreground">(out of its parent)</span>
            </button>
          </li>
        ) : null}
        {shown.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              className={option}
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {shown.length === 0 && !offerTopLevel
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
