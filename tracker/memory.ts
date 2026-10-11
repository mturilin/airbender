// tracker/memory.ts — standing facts about a repository, kept in a file.
//
// What: saves and shows short facts every future session should know (how
// to build, a convention, a lasting preference of the owner), in the file
// FACTS.md at the repository's root.
//
// Why: the owner chose a file over a tracker's own memory ("use file"): a
// file works with every tracker, survives a fresh clone, and can be
// reviewed like any other project text. And a file of its own over a
// section of AGENTS.md (bead-bb-c9l.8): the instructions are the owner's
// and change rarely, facts are added by agents as they work, and in one
// file every new fact was a change to the owner's rules, where a careless
// edit could damage them.
//
// Design notes:
// - One line per fact, `- **key** — text`, under a heading and a few words
//   that say what the file is for. An agent may add a line by hand, without
//   this program; the instructions tell it to.
// - One entry per key. Saving under a key that exists replaces that line
//   where it stands, so a corrected fact does not pile up beside the old
//   one.
// - Only fact lines are ever changed. Whatever else the owner wrote in the
//   file is left exactly as it is.
// - Facts used to be kept in a marked section of AGENTS.md. They are still
//   read from there, and moved to FACTS.md the next time a fact is saved
//   (`moveOldFacts`), so nothing is lost and nothing is written by a read.
// - The text functions are pure and tested; the ones at the end read and
//   write files.
//
// Gotchas:
// - Saving a fact changes a tracked file, so it shows up as an uncommitted
//   change that has to go into some commit.
// - A fact is one line: line breaks in the text are turned into spaces.
// - Nothing loads FACTS.md by itself. The instructions tell agents to read
//   it, and a CLAUDE.md that points at AGENTS.md pulls it in as well
//   (server/prompts.ts in the Airbender plugin).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./types.ts";

/** The file the facts of a repository are kept in, at its root. */
export const FACTS_FILE = "FACTS.md";

/** How a new facts file begins. */
const HEADER = `# Facts

Standing facts about this project, for every session: how to build and run
it, its conventions, lasting preferences of its owner. One line per fact,
under a short key, like the ones below. Keep it short: this file is read at
the start of every session.
`;

/** The section of AGENTS.md facts were kept in before they had a file. */
const OLD_START = "<!-- bend:facts:start -->";
const OLD_END = "<!-- bend:facts:end -->";
/** The file that section was in. */
const OLD_FILE = "AGENTS.md";

/** One remembered fact. */
export interface Fact {
  key: string;
  text: string;
}

/** A fact's line, when a line is one; a dash, a colon or a long dash divides. */
const FACT_LINE = /^- \*\*(.+?)\*\*\s*(?:—|–|-|:)\s*(.*)$/u;

/** The line a fact is written as. */
const lineOf = (fact: Fact) => `- **${fact.key}** — ${fact.text}`;

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

/** The facts held in a text: every line that is a fact's line, in order. */
export function readFacts(file: string): Fact[] {
  return file.split("\n").flatMap((line) => {
    const match = FACT_LINE.exec(line.trim());
    return match === null ? [] : [{ key: match[1]!, text: match[2]! }];
  });
}

/**
 * A facts file's text with one fact saved in it.
 *
 * A line with the same key is replaced where it stands; otherwise the fact
 * is added after the last line. An empty text becomes a new file with its
 * heading. Every other line is untouched.
 *
 * @returns The new text, and whether a fact was replaced.
 */
export function withFact(
  file: string,
  fact: Fact,
): { text: string; replaced: boolean } {
  const lines = (file.trim() === "" ? HEADER : file).replace(/\n*$/u, "").split("\n");
  const at = lines.findIndex(
    (line) => FACT_LINE.exec(line.trim())?.[1] === fact.key,
  );
  if (at !== -1) {
    lines[at] = lineOf(fact);
  } else {
    // A blank line between the words above and the first fact; none
    // between facts.
    const last = lines[lines.length - 1] ?? "";
    if (last.trim() !== "" && !FACT_LINE.test(last.trim())) lines.push("");
    lines.push(lineOf(fact));
  }
  return { text: `${lines.join("\n")}\n`, replaced: at !== -1 };
}

/**
 * The facts in the old section of an AGENTS.md, and that text without the
 * section. Pure.
 *
 * @returns `facts` (none when there is no section) and `rest`, which is
 *   `file` itself when there is none.
 */
export function splitOldFacts(file: string): { facts: Fact[]; rest: string } {
  const start = file.indexOf(OLD_START);
  const end = start === -1 ? -1 : file.indexOf(OLD_END, start);
  if (start === -1 || end === -1) return { facts: [], rest: file };
  const before = file.slice(0, start).replace(/\n*$/u, "");
  const after = file.slice(end + OLD_END.length).replace(/^\n*/u, "");
  return {
    facts: readFacts(file.slice(start, end)),
    rest: `${[before, after.replace(/\n*$/u, "")]
      .filter((part) => part !== "")
      .join("\n\n")}\n`,
  };
}

/** A file's text, or "" when there is no such file. */
const textOf = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : "";

/**
 * Makes sure the repository at `root` has a facts file, so that whatever
 * points at it (the instructions, a CLAUDE.md) finds one.
 *
 * Side effects: writes FACTS.md, with its heading and no facts, when there
 *   is none; nothing otherwise.
 */
export function ensureFactsFile(root: string): void {
  const path = join(root, FACTS_FILE);
  if (!existsSync(path)) writeFileSync(path, HEADER);
}

/**
 * Saves several facts for the repository at `root`, each under its key.
 *
 * @returns How many were new and how many replaced one.
 * Side effects: writes FACTS.md in `root` (created when missing).
 */
export function addFacts(
  root: string,
  facts: Fact[],
): { added: number; replaced: number } {
  const path = join(root, FACTS_FILE);
  let text = textOf(path);
  let replaced = 0;
  for (const fact of facts) {
    const next = withFact(text, {
      key: fact.key.replace(/\*/gu, "").trim(),
      text: fact.text.replace(/\s+/gu, " ").trim(),
    });
    text = next.text;
    if (next.replaced) replaced += 1;
  }
  if (facts.length > 0) writeFileSync(path, text);
  return { added: facts.length - replaced, replaced };
}

/**
 * Moves facts from the old section of AGENTS.md into FACTS.md.
 *
 * A fact whose key FACTS.md already holds is not moved over it: the file is
 * the newer place. The section is removed from AGENTS.md either way, and
 * nothing else in that file changes.
 *
 * @returns How many facts were moved; 0 when there was no section.
 * Side effects: may write FACTS.md and AGENTS.md in `root`.
 */
export function moveOldFacts(root: string): number {
  const oldPath = join(root, OLD_FILE);
  const old = textOf(oldPath);
  const { facts, rest } = splitOldFacts(old);
  if (rest === old) return 0;
  const held = new Set(recallFrom(textOf(join(root, FACTS_FILE))).map((fact) => fact.key));
  const moving = facts.filter((fact) => !held.has(fact.key));
  addFacts(root, moving);
  writeFileSync(oldPath, rest);
  return moving.length;
}

/** The facts of a facts file's text. */
const recallFrom = (text: string) => readFacts(text);

/**
 * Saves a fact for the repository at `root`.
 *
 * @param key The fact's name; made from its first words when left out.
 *   Saving under an existing key replaces that fact.
 * @returns The key it was saved under, and whether it replaced one.
 * @throws UsageError when the text is empty.
 * Side effects: writes FACTS.md in `root` (created when missing); facts
 *   still in the old section of AGENTS.md are moved over first, which
 *   rewrites that file once.
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
  moveOldFacts(root);
  const { replaced } = addFacts(root, [{ key: name, text: fact }]);
  return { key: name, replaced: replaced === 1 };
}

/**
 * The facts saved for the repository at `root`: those in FACTS.md, then
 * any still in the old section of AGENTS.md whose key the file lacks.
 *
 * @param words When given, only facts whose key or text contains every one
 *   of these words (any case).
 * Side effects: reads files only.
 */
export function recall(root: string, words: string[] = []): Fact[] {
  const current = recallFrom(textOf(join(root, FACTS_FILE)));
  const held = new Set(current.map((fact) => fact.key));
  const old = splitOldFacts(textOf(join(root, OLD_FILE))).facts.filter(
    (fact) => !held.has(fact.key),
  );
  const wanted = words.map((word) => word.toLowerCase());
  return [...current, ...old].filter((fact) => {
    const text = `${fact.key} ${fact.text}`.toLowerCase();
    return wanted.every((word) => text.includes(word));
  });
}
