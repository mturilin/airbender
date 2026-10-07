// tracker/memory.ts — standing facts about a repository, kept in a file.
//
// What: saves and shows short facts every future session should know
// (how to build, a lasting preference of the owner), in a marked section of
// the repository's AGENTS.md.
//
// Why: the owner chose a file over a tracker's own memory ("use file"). A
// file works with every tracker, is read by agents at the start of a
// session without anything fetching it, survives a fresh clone, and can be
// reviewed like any other project rule.
//
// Design notes:
// - One entry per key. Saving under a key that exists replaces that entry in
//   place, so a corrected fact does not pile up beside the old one.
// - The section is delimited by marker comments and owned by this program;
//   everything else in AGENTS.md is left exactly as it is.
// - The text functions (readFacts, writeFacts) are pure and tested; the two
//   at the end read and write the file.
//
// Gotchas:
// - Saving a fact changes a tracked file, so it shows up as an uncommitted
//   change that has to go into some commit.
// - A fact is one line: line breaks in the text are turned into spaces.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./types.ts";

const START = "<!-- bend:facts:start -->";
const END = "<!-- bend:facts:end -->";
const HEADING = "## Remembered facts";
const INTRO =
  "Standing facts for every session, kept by `bend remember`. One line per fact; do not edit the markers.";

/** One remembered fact. */
export interface Fact {
  key: string;
  text: string;
}

/** A key made from a fact's first words, for a fact saved without one. */
export function keyFor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .split("-")
    .filter((word) => word !== "")
    .slice(0, 6)
    .join("-");
}

/** The facts held in a file's text; none when it has no section. */
export function readFacts(file: string): Fact[] {
  const start = file.indexOf(START);
  const end = start === -1 ? -1 : file.indexOf(END, start);
  if (start === -1 || end === -1) return [];
  return file
    .slice(start + START.length, end)
    .split("\n")
    .flatMap((line) => {
      const match = /^- \*\*(.+?)\*\* — (.*)$/u.exec(line.trim());
      return match === null ? [] : [{ key: match[1]!, text: match[2]! }];
    });
}

/**
 * A file's text with its facts section replaced by `facts` (added at the
 * end when the file has none). Text outside the section is untouched.
 */
export function writeFacts(file: string, facts: Fact[]): string {
  const block = [
    START,
    HEADING,
    "",
    INTRO,
    "",
    ...facts.map((fact) => `- **${fact.key}** — ${fact.text}`),
    END,
  ].join("\n");
  const start = file.indexOf(START);
  const end = start === -1 ? -1 : file.indexOf(END, start);
  if (start === -1 || end === -1) {
    return file.trim() === "" ? `${block}\n` : `${file.replace(/\n*$/u, "")}\n\n${block}\n`;
  }
  return file.slice(0, start) + block + file.slice(end + END.length);
}

/** The file the facts of a repository are kept in. */
const factsFile = (root: string) => join(root, "AGENTS.md");

/**
 * Saves a fact for the repository at `root`.
 *
 * @param key The fact's name; made from its first words when left out.
 *   Saving under an existing key replaces that fact.
 * @returns The key it was saved under, and whether it replaced one.
 * @throws UsageError when the text is empty.
 * Side effects: writes AGENTS.md in `root` (created when missing).
 */
export function remember(
  root: string,
  text: string,
  key?: string,
): { key: string; replaced: boolean } {
  const fact = text.replace(/\s+/gu, " ").trim();
  if (fact === "") throw new UsageError("A fact needs some text.");
  const name = (key?.trim() || keyFor(fact)).replace(/\*/gu, "");
  if (name === "") throw new UsageError("A fact needs a key.");
  const path = factsFile(root);
  const file = existsSync(path) ? readFileSync(path, "utf8") : "";
  const facts = readFacts(file);
  const at = facts.findIndex((known) => known.key === name);
  if (at === -1) facts.push({ key: name, text: fact });
  else facts[at] = { key: name, text: fact };
  writeFileSync(path, writeFacts(file, facts));
  return { key: name, replaced: at !== -1 };
}

/**
 * The facts saved for the repository at `root`.
 *
 * @param words When given, only facts whose key or text contains every one
 *   of these words (any case).
 */
export function recall(root: string, words: string[] = []): Fact[] {
  const path = factsFile(root);
  if (!existsSync(path)) return [];
  const wanted = words.map((word) => word.toLowerCase());
  return readFacts(readFileSync(path, "utf8")).filter((fact) => {
    const text = `${fact.key} ${fact.text}`.toLowerCase();
    return wanted.every((word) => text.includes(word));
  });
}
