// bend/args.ts — reading a command line.
//
// What: turns the words after a command's name into positional arguments
// and options, checked against what that command accepts.
//
// Why: `bend` has some twenty commands with a handful of options each. One
// small reader keeps their behaviour the same everywhere: `--name value`
// and `--name=value` both work, an unknown option is a usage error that
// names it, and `--` ends the options so any text can follow.
//
// Design notes:
// - Written by hand rather than with a library: the plugin has no argument
//   parser among its dependencies, and this is the whole of what is needed.
// - Pure and tested (args.test.ts).

import { UsageError } from "../tracker/types.ts";

/** Which options a command accepts. Names are given without the dashes. */
export interface OptionSpec {
  /** Options that take a value: `--type bug`. */
  values?: readonly string[];
  /** Options that take a value and may be given several times. */
  lists?: readonly string[];
  /** Options that are simply present or not: `--top`. */
  flags?: readonly string[];
  /** One-letter forms, e.g. `{ C: "dir", h: "help" }`. */
  short?: Readonly<Record<string, string>>;
}

/** What was read from a command line. */
export interface Parsed {
  positionals: string[];
  values: Record<string, string>;
  lists: Record<string, string[]>;
  flags: Set<string>;
}

/**
 * Reads `words` against `spec`.
 *
 * @throws UsageError for an option the command does not accept, an option
 *   missing its value, or a value given to an option that takes none.
 */
export function parseArgs(words: readonly string[], spec: OptionSpec): Parsed {
  const parsed: Parsed = {
    positionals: [],
    values: {},
    lists: {},
    flags: new Set(),
  };
  const takesValue = (name: string) =>
    (spec.values ?? []).includes(name) || (spec.lists ?? []).includes(name);
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (word === "--") {
      parsed.positionals.push(...words.slice(at + 1));
      break;
    }
    // A lone "-" is a value ("read from standard input"), not an option.
    if (!word.startsWith("-") || word === "-") {
      parsed.positionals.push(word);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      name = equals === -1 ? word.slice(2) : word.slice(2, equals);
      inline = equals === -1 ? undefined : word.slice(equals + 1);
    } else {
      const long = spec.short?.[word.slice(1)];
      if (long === undefined) {
        throw new UsageError(
          // The usual cause of a long "option" is text that begins with a dash.
          word.length > 2
            ? `Unknown option ${word}. If this is text that starts with a dash, put -- before it or use --text-file.`
            : `Unknown option ${word}.`,
        );
      }
      name = long;
    }
    if ((spec.flags ?? []).includes(name)) {
      if (inline !== undefined) {
        throw new UsageError(`Option --${name} does not take a value.`);
      }
      parsed.flags.add(name);
      continue;
    }
    if (!takesValue(name)) throw new UsageError(`Unknown option --${name}.`);
    const value = inline ?? words[at + 1];
    if (value === undefined) {
      throw new UsageError(`Option --${name} needs a value.`);
    }
    if (inline === undefined) at += 1;
    if ((spec.lists ?? []).includes(name)) {
      parsed.lists[name] = [...(parsed.lists[name] ?? []), value];
    } else {
      parsed.values[name] = value;
    }
  }
  return parsed;
}

/**
 * A priority typed as `2` or `p2`, as a number from 0 to 4.
 *
 * @throws UsageError for anything else.
 */
export function parsePriority(typed: string): number {
  const match = /^p?([0-4])$/iu.exec(typed.trim());
  if (match === null) {
    throw new UsageError(`A priority is a number from 0 to 4, not "${typed}".`);
  }
  return Number(match[1]);
}
