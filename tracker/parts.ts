// tracker/parts.ts — small pure helpers shared by adapters and the core.
//
// What: keeping a written part inside another text as a marked section
// (used where a tracker has no field for it), tidying a category name, and
// the fixed openings of decision and hand-over comments.
//
// Why: several trackers lack a field for something the owner's way of
// working needs, such as requirements. A marked section in the description
// keeps the text with the issue, readable by a person in the tracker's own
// screens, and recoverable exactly by this layer.
//
// Design notes:
// - A section is delimited by HTML comments, which trackers that draw
//   Markdown do not show, around a visible heading, so the text reads
//   naturally to a person either way.
// - Everything here is pure text work, tested in parts.test.ts.

import { Refused, UsageError } from "./types.ts";

/** The opening line of a section holding a part called `name`. */
const open = (name: string) => `<!-- bend:${name} -->`;
/** The closing line of a section holding a part called `name`. */
const close = (name: string) => `<!-- /bend:${name} -->`;

/**
 * Splits a text into what is outside the section called `name` and what is
 * inside it.
 *
 * @returns `rest`, the text with the section removed and tidied, and
 *   `section`, the section's content without its heading; "" when absent.
 */
export function splitSection(
  text: string,
  name: string,
): { rest: string; section: string } {
  const start = text.indexOf(open(name));
  const end = start === -1 ? -1 : text.indexOf(close(name), start);
  if (start === -1 || end === -1) return { rest: text.trim(), section: "" };
  const inside = text.slice(start + open(name).length, end);
  const rest = text.slice(0, start) + text.slice(end + close(name).length);
  return {
    rest: rest.replace(/\n{3,}/gu, "\n\n").trim(),
    // The first line inside is the visible heading written by joinSection.
    section: inside.replace(/^\s*##[^\n]*\n?/u, "").trim(),
  };
}

/**
 * Puts a section called `name` at the end of a text, under a visible
 * heading; an empty `section` leaves the text without one.
 *
 * Pre-condition: `rest` holds no section of that name (see splitSection).
 */
export function joinSection(
  rest: string,
  name: string,
  heading: string,
  section: string,
): string {
  const body = section.trim();
  if (body === "") return rest.trim();
  const block = `${open(name)}\n## ${heading}\n\n${body}\n${close(name)}`;
  return rest.trim() === "" ? block : `${rest.trim()}\n\n${block}`;
}

/** The name of the section that holds requirements inside a description. */
const REQUIREMENTS = "requirements";

/**
 * Splits a description as a tracker without a field for requirements holds
 * it into the description proper and the requirements kept inside it.
 */
export function splitRequirements(text: string): {
  description: string;
  requirements: string;
} {
  const { rest, section } = splitSection(text, REQUIREMENTS);
  return { description: rest, requirements: section };
}

/**
 * The one text a tracker without a field for requirements holds: the
 * description with the requirements as a marked section at its end. The
 * opposite of splitRequirements.
 */
export function withRequirements(
  description: string,
  requirements: string,
): string {
  return joinSection(description, REQUIREMENTS, "Requirements", requirements);
}

/** One marked section to put into a text: see joinSections. */
export interface Section {
  /** The name in the markers, e.g. "plan". */
  name: string;
  /** The visible heading above the content, e.g. "Plan". */
  heading: string;
  /** The content; a section with none is left out of the text. */
  text: string;
}

/**
 * Takes several marked sections out of a text at once.
 *
 * @returns `rest`, the text outside all of them, and each section's
 *   content by name; "" for one that is not there.
 */
export function splitSections(
  text: string,
  names: readonly string[],
): { rest: string; sections: Record<string, string> } {
  const sections: Record<string, string> = {};
  let rest = text;
  for (const name of names) {
    const split = splitSection(rest, name);
    rest = split.rest;
    sections[name] = split.section;
  }
  return { rest: rest.trim(), sections };
}

/**
 * Puts several marked sections at the end of a text, in the order given.
 * The opposite of splitSections.
 *
 * Pre-condition: `rest` holds none of these sections.
 */
export function joinSections(rest: string, sections: Section[]): string {
  return sections.reduce(
    (text, section) =>
      joinSection(text, section.name, section.heading, section.text),
    rest.trim(),
  );
}

/**
 * A link kept as a line of text, for a tracker that has no such link of
 * its own. It is written on both issues, so that showing either one needs
 * no search: "out" on the issue the link is about, "in" on the other.
 */
export interface TextLink {
  kind: "discovered-from" | "related";
  /** "related" reads the same from both ends and is always "out". */
  direction: "out" | "in";
  /** The other issue's id. */
  id: string;
}

/** How each text link reads, and is recognised again. */
const LINK_WORDS: { words: string; kind: TextLink["kind"]; direction: TextLink["direction"] }[] = [
  { words: "discovered from", kind: "discovered-from", direction: "out" },
  { words: "led to", kind: "discovered-from", direction: "in" },
  { words: "related to", kind: "related", direction: "out" },
];

/**
 * The lines of a "Links" section: one per link, as a list a person can
 * read ("- discovered from #12").
 */
export function formatTextLinks(links: TextLink[]): string {
  return links
    .map((link) => {
      const { words } = LINK_WORDS.find(
        (known) => known.kind === link.kind && known.direction === link.direction,
      )!;
      return `- ${words} #${link.id}`;
    })
    .join("\n");
}

/**
 * Reads the lines of a "Links" section back. A line that is not one of
 * ours (a person wrote something there) is ignored, and a link written
 * twice is given once.
 */
export function parseTextLinks(section: string): TextLink[] {
  const found: TextLink[] = [];
  for (const line of section.split("\n")) {
    const match = /^\s*[-*]\s*(.+?)\s+#(\d+)\s*$/u.exec(line);
    if (match === null) continue;
    const known = LINK_WORDS.find((words) => words.words === match[1]!.toLowerCase());
    if (known === undefined) continue;
    const link = { kind: known.kind, direction: known.direction, id: match[2]! };
    if (
      !found.some(
        (other) =>
          other.kind === link.kind &&
          other.direction === link.direction &&
          other.id === link.id,
      )
    ) {
      found.push(link);
    }
  }
  return found;
}

/** Longest category name accepted. */
const CATEGORY_MAX_LENGTH = 40;

/**
 * Tidies a typed category name: trimmed, single spaces, lower case.
 *
 * @throws Refused when the name is empty, too long, or contains a comma
 *   (several trackers keep categories as labels and split labels on commas).
 */
export function cleanCategory(typed: string): string {
  const name = typed.trim().replace(/\s+/gu, " ").toLowerCase();
  if (name === "") throw new Refused("A category needs a name.");
  if (name.length > CATEGORY_MAX_LENGTH) {
    throw new Refused(
      `A category name can be at most ${CATEGORY_MAX_LENGTH} characters.`,
    );
  }
  if (name.includes(",")) {
    throw new Refused("A category name cannot contain a comma.");
  }
  return name;
}

/** How a comment that records a decision begins. */
export const DECISION_PREFIX = "Decision: ";

/** How a hand-over comment begins. */
export const HANDOVER_HEADING = "Hand-over";

/**
 * The text of a hand-over comment.
 *
 * A hand-over must say three things, and "what was not checked" may not be
 * left out: the owner's rule is that an agent states plainly what it did
 * not test. Writing "nothing" is allowed; silence is not.
 *
 * @throws UsageError when any of the three is empty.
 */
export function handoverText(parts: {
  done: string;
  checked: string;
  notChecked: string;
}): string {
  const missing = (
    [
      ["--done", parts.done],
      ["--checked", parts.checked],
      ["--not-checked", parts.notChecked],
    ] as const
  )
    .filter(([, text]) => text.trim() === "")
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new UsageError(
      `A hand-over must say what was done, how it was checked and what was not checked. Missing: ${missing.join(", ")}.`,
    );
  }
  return [
    `${HANDOVER_HEADING}: ready for the owner to validate.`,
    "",
    `What was done: ${parts.done.trim()}`,
    "",
    `How it was checked: ${parts.checked.trim()}`,
    "",
    `Not checked: ${parts.notChecked.trim()}`,
  ].join("\n");
}
