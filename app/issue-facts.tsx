// app/issue-facts.tsx — the facts line of an issue.
//
// What: IssueFacts, the line of small tags under an issue's title (id that
// copies itself, status, priority, type, category, assignee, counts), and
// CategorySelect, the category dropdown it and the new-issue form share.
//
// Why: the same facts are shown on a row, in an opened issue and in the
// message-box card, and must read the same everywhere; where the issue can be
// changed, priority, type and category are edited right on this line.

import { useState } from "react";
import { toast } from "sonner";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { ISSUE_TYPES } from "../shared/constants.ts";
import type { IssueType } from "../shared/constants.ts";
import type { IssueActions } from "./actions.ts";
import { StatusTag, TAG_SELECT_CLASS, Tag } from "./bits.tsx";
import { StateTag } from "./workflow-controls.tsx";

/** Value of the dropdown entry that switches CategorySelect to typing. */
const NEW_CATEGORY = "\u0000new";

/**
 * Chooses a category: one already in use, none, or a new one typed in.
 *
 * A plain dropdown cannot be typed into, so "New category…" swaps the
 * dropdown for a short text field: Enter saves what was typed, Escape or
 * leaving the field empty goes back to the dropdown. The list of categories
 * grows only through this field; there is no separate list to maintain.
 *
 * @param value The current category; null for none.
 * @param noneLabel What the "no category" entry reads, e.g. "category" on a
 *   row or "Category: same as parent" in the new-issue form.
 * @param prefix Put before each category name in the list, e.g. "Category: ".
 * @param onChange Called with the chosen or typed name, or null for none.
 *   The name is passed as typed; the backend tidies it and reuses the
 *   spelling of an existing category.
 */
export function CategorySelect({
  value,
  choices,
  onChange,
  noneLabel,
  prefix = "",
  className,
  ariaLabel,
}: {
  value: string | null;
  choices: string[];
  onChange: (category: string | null) => void;
  noneLabel: string;
  prefix?: string;
  className?: string;
  ariaLabel: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  if (typing) {
    const finish = (save: boolean) => {
      const name = draft.trim();
      setTyping(false);
      setDraft("");
      if (save && name !== "") onChange(name);
    };
    return (
      <input
        autoFocus
        value={draft}
        maxLength={40}
        aria-label={`${ariaLabel}: new category name`}
        placeholder="new category"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Not a form submit: inside the new-issue form Enter here must
            // save the category, not create the issue.
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className={cn(className, "w-32 cursor-text")}
      />
    );
  }
  // A category the issue has that is not (yet) in the list is still shown.
  const listed =
    value === null || choices.includes(value) ? choices : [value, ...choices];
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(event) => {
        if (event.target.value === NEW_CATEGORY) setTyping(true);
        else onChange(event.target.value === "" ? null : event.target.value);
      }}
      className={className}
    >
      <option value="">{noneLabel}</option>
      {listed.map((name) => (
        <option key={name} value={name}>
          {prefix}
          {name}
        </option>
      ))}
      <option value={NEW_CATEGORY}>New category…</option>
    </select>
  );
}

/** Priority, type and similar small facts about an issue, on one line. */
export function IssueFacts({
  issue,
  onEdit,
  category,
  showStatus = false,
}: {
  issue: Issue;
  /** When given, priority and type become small dropdowns that call this. */
  onEdit?: IssueActions["edit"];
  /**
   * When given, the category becomes a dropdown too: `choices` are the
   * categories in use, `onChange` sets or clears this issue's.
   */
  category?: {
    choices: string[];
    onChange: IssueActions["setCategory"];
  };
  /**
   * Show the issue's status as a tag. Used for sub-issues, which sit under
   * their parent and so are not under a status heading that would say it.
   */
  showStatus?: boolean;
}) {
  // The current type is always offered, even if it is one this plugin does
  // not otherwise list (beads has more types than the new-issue form).
  const typeChoices: string[] =
    issue.type === null || (ISSUE_TYPES as readonly string[]).includes(issue.type)
      ? [...ISSUE_TYPES]
      : [issue.type, ...ISSUE_TYPES];
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      {/* Clicking the id copies it (bead-bb-c58): ids are what you type
          to an agent or into bd, and they are awkward to select by hand
          between the tags. */}
      <Tip label="Copy the id">
        <button
          type="button"
          className="cursor-copy font-mono text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            // The clipboard can be refused (no permission, or the page is
            // not focused); say so instead of failing silently.
            navigator.clipboard.writeText(issue.id).then(
              () => toast.success(`Copied ${issue.id}`),
              () => toast.error(`Could not copy ${issue.id}`),
            );
          }}
        >
          {issue.id}
        </button>
      </Tip>
      {showStatus ? <StatusTag issue={issue} /> : null}
      <StateTag issue={issue} />
      {onEdit === undefined ? (
        <>
          {issue.priority === null ? null : (
            <Tag strong={issue.priority <= 1}>P{issue.priority}</Tag>
          )}
          {issue.type === null ? null : <Tag>{issue.type}</Tag>}
        </>
      ) : (
        <>
          <select
            aria-label={`Priority of ${issue.id}`}
            value={issue.priority ?? ""}
            onChange={(event) =>
              onEdit(issue.id, { priority: Number(event.target.value) })
            }
            className={cn(
              TAG_SELECT_CLASS,
              issue.priority !== null && issue.priority <= 1
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {issue.priority === null ? <option value="">P?</option> : null}
            {[0, 1, 2, 3, 4].map((priority) => (
              <option key={priority} value={priority}>
                P{priority}
              </option>
            ))}
          </select>
          <select
            aria-label={`Type of ${issue.id}`}
            value={issue.type ?? ""}
            onChange={(event) =>
              onEdit(issue.id, { type: event.target.value as IssueType })
            }
            className={cn(TAG_SELECT_CLASS, "text-muted-foreground")}
          >
            {issue.type === null ? <option value="">type?</option> : null}
            {typeChoices.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </>
      )}
      {/* The category: a dropdown where it can be changed, a plain tag
          where it cannot (closed issues), nothing when there is none. */}
      {category !== undefined ? (
        <CategorySelect
          value={issue.category}
          choices={category.choices}
          onChange={(next) => category.onChange(issue.id, next)}
          noneLabel="category"
          ariaLabel={`Category of ${issue.id}`}
          className={cn(
            TAG_SELECT_CLASS,
            "max-w-40",
            issue.category === null
              ? "text-muted-foreground/60"
              : "text-muted-foreground",
          )}
        />
      ) : issue.category === null ? null : (
        <Tag>{issue.category}</Tag>
      )}
      {issue.assignee === null ? null : <Tag>{issue.assignee}</Tag>}
      {issue.blocks.length === 0 ? null : (
        <Tag>holds up {issue.blocks.length}</Tag>
      )}
      {issue.commentCount === 0 ? null : (
        <Tag>
          {issue.commentCount}{" "}
          {issue.commentCount === 1 ? "comment" : "comments"}
        </Tag>
      )}
    </span>
  );
}
