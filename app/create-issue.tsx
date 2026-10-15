// app/create-issue.tsx — the new-issue field.
//
// What: CreateIssue: the always-present title field with quick tags and their
// auto-complete, and the expandable part with type, priority, category, parent
// and description.
//
// Why: creating issues is the most important action in the tab (the user's
// words), so the field is always there, at the bottom of the panel and inside
// the details window.
//
// Design notes:
// - The tag parsing itself is in app/quick-tags.ts; this file is the form
//   around it.

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { ISSUE_TYPES } from "../shared/constants.ts";
import type { IssueType } from "../shared/constants.ts";
import { FIELD_CLASS, Tag } from "./bits.tsx";
import { CategorySelect } from "./issue-facts.tsx";
import {
  isTagSafeCategory,
  parseQuickTags,
  suggestTags,
  tagAtCaret,
} from "./quick-tags.ts";
import type { TagSuggestion } from "./quick-tags.ts";

/**
 * The line for creating an issue. Type a title and press Enter for the fast
 * path; the chevron on the left reveals type, priority and description for a
 * full issue.
 *
 * @param onCreate Creates the issue and resolves to null on success or a
 *   plain-language reason on failure. The form keeps what was typed when it
 *   fails, so nothing is lost.
 */
export function CreateIssue({
  onCreate,
  parent,
  onParentChange,
  parentChoices,
  focusRequest,
  categories,
  allowTopLevel = true,
}: {
  onCreate: (draft: {
    title: string;
    description: string;
    type: IssueType | null;
    priority: number | null;
    category: string | null;
    someday?: boolean;
  }) => Promise<string | null>;
  /** The issue the new one will be created inside; null for the top level. */
  parent: Issue | null;
  onParentChange: (parentId: string | null) => void;
  /** Open issues offered as a parent in the expanded form. */
  parentChoices: Issue[];
  /**
   * Changes each time something outside (the "Add sub-issue" button) wants
   * the cursor put in the title field.
   */
  focusRequest: number;
  /** Categories in use, offered in the expanded form. */
  categories: string[];
  /**
   * Whether "no parent" can be chosen. True in the panel. False in the
   * details window, where a new issue always goes inside the issue being
   * shown or one of the issues under it, so the choice is which, not
   * whether.
   */
  allowTopLevel?: boolean;
}) {
  const titleField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest > 0) titleField.current?.focus();
  }, [focusRequest]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Empty string = "let beads decide" (task, priority 2).
  const [type, setType] = useState<IssueType | "">("");
  const [priority, setPriority] = useState("");
  // Null = not chosen: a sub-issue then takes its parent's category.
  const [category, setCategory] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Quick tags in the title, read as the user types so the line under the
  // field can show what they will do.
  const tags = parseQuickTags(title);
  // Auto-complete for a tag being typed. `caret` follows the text cursor;
  // `active` is the highlighted suggestion; `dismissed` is the partly typed
  // tag the user closed the list on with Escape, so it stays closed until
  // they type something else.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typing = tagAtCaret(title, caret);
  const suggestions =
    typing === null || typing.token === dismissed
      ? []
      : suggestTags(typing.token, categories);
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1));
  // Where to put the text cursor after a completion has rewritten the title;
  // applied once React has put the new text in the field.
  const caretAfter = useRef<number | null>(null);
  useEffect(() => {
    if (caretAfter.current === null) return;
    const position = caretAfter.current;
    caretAfter.current = null;
    titleField.current?.setSelectionRange(position, position);
    setCaret(position);
  }, [title]);
  /**
   * Completes the tag being typed with a suggestion.
   *
   * Usually that replaces the partly typed tag with the full one. A category
   * whose name cannot be written as a tag (it has a space, say) is set
   * directly instead, and the partly typed tag is removed from the title.
   */
  const complete = (suggestion: TagSuggestion) => {
    if (typing === null) return;
    const end = typing.start + typing.token.length;
    const asTag =
      suggestion.kind !== "category" || isTagSafeCategory(suggestion.value);
    const inserted = asTag ? `${suggestion.label} ` : "";
    if (!asTag) setCategory(suggestion.value);
    // Do not leave two spaces behind when the tag was followed by one.
    const rest = title.slice(end).replace(/^ /u, "");
    setTitle(title.slice(0, typing.start) + inserted + rest);
    caretAfter.current = typing.start + inserted.length;
    setActive(0);
    setDismissed(null);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A title that is nothing but tags is not an issue.
    if (tags.title === "" || pending) return;
    setPending(true);
    // A tag typed in the title wins over the same choice in the expanded
    // form: it is the more recent, more deliberate of the two.
    const reason = await onCreate({
      title: tags.title,
      description,
      type: tags.type ?? (type === "" ? null : type),
      priority: tags.priority ?? (priority === "" ? null : Number(priority)),
      category: tags.category ?? category,
      ...(tags.someday ? { someday: true } : {}),
    });
    setPending(false);
    setProblem(reason);
    if (reason !== null) return;
    setTitle("");
    setDescription("");
    setCategory(null);
    // The parent is for the one issue just created (the user's rule,
    // bead-bb-zty.5): left selected, the next issue typed here would land
    // inside it unnoticed. In the details window this puts the field back to
    // the issue the window is showing.
    onParentChange(null);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          Could not create the issue: {problem}
        </p>
      )}
      {/* Always shown while a parent is selected, expanded or not, so a new
          issue never lands inside another one unnoticed. */}
      {parent === null ? null : (
        <div className="flex items-center gap-2 pl-9 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            New sub-issue of{" "}
            <span className="font-mono text-foreground">{parent.id}</span>{" "}
            {parent.title}
          </span>
          {allowTopLevel ? (
            <button
              type="button"
              aria-label="Create at the top level instead"
              className="shrink-0 cursor-pointer hover:text-foreground"
              onClick={() => onParentChange(null)}
            >
              <Icon name="CircleX" className="size-4" />
            </button>
          ) : null}
        </div>
      )}
      {more ? (
        <div className="space-y-2 pl-9">
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Type"
              value={type}
              onChange={(event) => setType(event.target.value as IssueType | "")}
              className={FIELD_CLASS}
            >
              <option value="">Type: task</option>
              {ISSUE_TYPES.filter((name) => name !== "task").map((name) => (
                <option key={name} value={name}>
                  Type: {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">Priority: P2 (normal)</option>
              <option value="0">Priority: P0 (most urgent)</option>
              <option value="1">Priority: P1</option>
              <option value="3">Priority: P3</option>
              <option value="4">Priority: P4 (least urgent)</option>
            </select>
            <CategorySelect
              value={category}
              choices={categories}
              onChange={setCategory}
              noneLabel={
                parent === null
                  ? "Category: none"
                  : `Category: same as parent${parent.category === null ? " (none)" : ` (${parent.category})`}`
              }
              prefix="Category: "
              ariaLabel="Category"
              className={cn(FIELD_CLASS, "min-w-0 max-w-full")}
            />
            <select
              aria-label="Parent issue"
              value={parent?.id ?? ""}
              onChange={(event) =>
                onParentChange(
                  event.target.value === "" ? null : event.target.value,
                )
              }
              className={cn(FIELD_CLASS, "min-w-0 max-w-full")}
            >
              {allowTopLevel ? (
                <option value="">Parent: none (top level)</option>
              ) : null}
              {parentChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  Parent: {choice.id} {choice.title.slice(0, 50)}
                </option>
              ))}
            </select>
          </div>
          <textarea
            aria-label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description (optional)"
            rows={4}
            className={cn(FIELD_CLASS, "block w-full resize-y")}
          />
        </div>
      ) : null}
      {/* Auto-complete for a tag being typed. In the flow above the field,
          not floating: the field sits at the bottom edge, and the list above
          it clips anything that hangs outside. Clicking an entry must not
          take the focus out of the field, hence onMouseDown. */}
      {suggestions.length === 0 ? null : (
        <ul
          role="listbox"
          aria-label="Tag suggestions"
          className="ml-9 flex flex-wrap gap-1"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.label} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => complete(suggestion)}
                className={cn(
                  "cursor-pointer rounded border px-1.5 py-px text-xs",
                  index === highlighted
                    ? "border-foreground/40 bg-state-active text-foreground"
                    : "border-border text-muted-foreground hover:bg-state-hover",
                )}
              >
                {suggestion.label}
              </button>
            </li>
          ))}
          <li className="self-center text-[11px] text-muted-foreground">
            Tab to complete
          </li>
        </ul>
      )}
      {/* What the quick tags in the title will do, shown while typing so
          that a type, priority or category is never set by surprise. A
          category picked from the suggestions without becoming a tag (its
          name has a space) is shown here too. */}
      {tags.type === null &&
      tags.priority === null &&
      (tags.category ?? category) === null ? null : (
        <div className="flex flex-wrap items-center gap-1.5 pl-9 text-xs text-muted-foreground">
          <span>Will be created as</span>
          {tags.type === null ? null : <Tag strong>{tags.type}</Tag>}
          {tags.priority === null ? null : (
            <Tag strong>P{tags.priority}</Tag>
          )}
          {(tags.category ?? category) === null ? null : (
            <Tag strong>category {tags.category ?? category}</Tag>
          )}
          {tags.title === "" ? <span>— add a title</span> : null}
        </div>
      )}
      <div className="flex items-center gap-2">
        {/* Same place as an issue row's chevron. The extra fields open
            upward, because this line sits on the bottom edge of the tab. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-expanded={more}
          tip="Set type, priority, description and parent"
          aria-label={more ? "Hide type, priority and description" : "Add type, priority and description"}
          onClick={() => setMore((current) => !current)}
        >
          <Icon
            name={more ? "ChevronUp" : "ChevronRight"}
            className="size-4 text-muted-foreground"
          />
        </Button>
        <Input
          ref={titleField}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setActive(0);
            setDismissed(null);
          }}
          // Fires when the text cursor moves without the text changing
          // (arrow keys, a click), so the suggestions follow the cursor.
          onSelect={(event) =>
            setCaret(
              event.currentTarget.selectionStart ??
                event.currentTarget.value.length,
            )
          }
          onKeyDown={(event) => {
            // Only while suggestions are showing. Otherwise the keys keep
            // their normal meaning; in particular Enter creates the issue.
            if (suggestions.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (highlighted + step + suggestions.length) % suggestions.length,
              );
            } else if (event.key === "Tab" || event.key === "Enter") {
              // With the list open, Enter completes the tag instead of
              // creating the issue.
              event.preventDefault();
              complete(suggestions[highlighted]!);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(typing?.token ?? null);
            }
          }}
          placeholder={
            parent === null
              ? "New issue — title, then Enter. #bug #p1 $category"
              : `New sub-issue of ${parent.id} — type a title and press Enter`
          }
          aria-label="New issue title"
        />
        <Button
          type="submit"
          size="sm"
          disabled={pending || tags.title === ""}
        >
          <Icon name="Plus" className="size-4" />
          Add
        </Button>
      </div>
    </form>
  );
}
