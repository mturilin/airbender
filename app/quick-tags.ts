// app/quick-tags.ts — quick tags typed into a new issue's title.
//
// What: reading #type, #p0..#p4 and #category tags out of a typed title,
// finding the tag under the caret, and suggesting completions for it.
//
// Why: the user wanted to set type, priority and category without leaving the
// title field (bead-bb-ky8). The parsing is pure text work, kept apart from
// the form so it can be tested with plain node (see app/quick-tags.test.ts).
//
// Gotchas:
// - No React and no "@/..." imports here; relative imports carry their .ts
//   extension, because node runs this file directly in the tests.

import { ISSUE_TYPES } from "../shared/constants.ts";
import type { IssueType } from "../shared/constants.ts";

/** What the quick tags typed into a new issue's title came to. */
interface QuickTags {
  /** The title with the recognised tags taken out. */
  title: string;
  type: IssueType | null;
  priority: number | null;
  category: string | null;
  /** `#someday`: create it straight into Someday (bead-bb-26g). */
  someday: boolean;
}

/**
 * Reads the quick tags out of a new issue's title (bead-bb-ky8):
 *
 * - `#task`, `#bug` and the other issue types set the type;
 * - `#p0` to `#p4` set the priority;
 * - `#someday` files it in Someday (bead-bb-26g);
 * - `$name` sets the category.
 *
 * A tag counts only as a word of its own (at the start, or after a space),
 * in any mix of capitals. Recognised tags are removed from the title;
 * anything else, such as `#123` or `$5`, is left in it as typed. When a kind
 * of tag appears twice, the last one wins.
 *
 * A category tag must start with a letter and may contain letters, digits,
 * `-` and `_`. That rules out prices (`$5`); a title that really needs a
 * word like `$HOME` in it has to be fixed up with Edit afterwards.
 */
export function parseQuickTags(typed: string): QuickTags {
  const found: QuickTags = {
    title: "",
    type: null,
    priority: null,
    category: null,
    someday: false,
  };
  const kept: string[] = [];
  for (const word of typed.split(/\s+/u)) {
    const lower = word.toLowerCase();
    const priority = /^#p([0-4])$/u.exec(lower);
    if (priority !== null) {
      found.priority = Number(priority[1]);
    } else if (lower === "#someday") {
      found.someday = true;
    } else if (
      lower.startsWith("#") &&
      (ISSUE_TYPES as readonly string[]).includes(lower.slice(1))
    ) {
      found.type = lower.slice(1) as IssueType;
    } else if (/^\$[a-z][a-z0-9_-]*$/u.test(lower)) {
      found.category = lower.slice(1);
    } else if (word !== "") {
      kept.push(word);
    }
  }
  found.title = kept.join(" ");
  return found;
}

/** One entry in the tag auto-complete list. */
export interface TagSuggestion {
  /** What is shown, e.g. "#bug" or "$ux polish". */
  label: string;
  /** A word saying what kind of thing it sets: type, priority, category or state. */
  kind: "type" | "priority" | "category" | "state";
  /** The value it sets, without the `#` or `$`. */
  value: string;
}

/** Most suggestions listed at once. */
const TAG_SUGGESTIONS_MAX = 8;

/** Whether a category name can be typed as a `$tag` (one plain word). */
export function isTagSafeCategory(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/u.test(name);
}

/**
 * The tag being typed at the caret, if any: the run of characters from the
 * last space before the caret up to the caret, when it starts with `#` or
 * `$`. Returns where it starts in the title and what has been typed of it.
 */
export function tagAtCaret(
  title: string,
  caret: number,
): { start: number; token: string } | null {
  const before = title.slice(0, caret);
  const start = before.search(/\S*$/u);
  const token = before.slice(start);
  return token.startsWith("#") || token.startsWith("$")
    ? { start, token }
    : null;
}

/**
 * What to offer for a partly typed tag. `#` offers the issue types and the
 * priorities that start with what was typed; `$` offers the categories in
 * use, those that start with it first, then those that merely contain it. Nothing is offered
 * once the tag is typed in full, so the list gets out of the way.
 */
export function suggestTags(token: string, categories: string[]): TagSuggestion[] {
  const typed = token.slice(1).toLowerCase();
  const all: TagSuggestion[] =
    token[0] === "#"
      ? [
          ...ISSUE_TYPES.map((type) => ({
            label: `#${type}`,
            kind: "type" as const,
            value: type,
          })),
          ...[0, 1, 2, 3, 4].map((priority) => ({
            label: `#p${priority}`,
            kind: "priority" as const,
            value: `p${priority}`,
          })),
          { label: "#someday", kind: "state" as const, value: "someday" },
        ]
      : categories.map((category) => ({
          label: `$${category}`,
          kind: "category" as const,
          value: category,
        }));
  if (all.some((entry) => entry.value === typed)) return [];
  return [
    ...all.filter((entry) => entry.value.startsWith(typed)),
    // "Contains" matches are for categories only, whose names the user may
    // half remember. For `#` they would offer #epic for "#p", which is noise.
    ...all.filter(
      (entry) =>
        entry.kind === "category" &&
        !entry.value.startsWith(typed) &&
        entry.value.includes(typed),
    ),
  ].slice(0, TAG_SUGGESTIONS_MAX);
}
