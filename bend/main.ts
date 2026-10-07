// bend/main.ts — the `bend` command.
//
// What: reads a command line, finds the repository's tracker, carries out
// one command through it, prints the answer as text or JSON, and gives the
// exit status.
//
// Why: this is the door agents use to read and change issues without
// knowing which tracker holds them. It is deliberately thin: what an
// operation means is decided in tracker/, and this file only connects words
// on a command line to it.
//
// Design notes:
// - `run` takes its surroundings (where to print, how to read standard
//   input, the starting folder) as an argument, so the whole command can be
//   exercised in tests without a real process.
// - Exit status: 0 done; 1 refused, with the reason in plain words; 2 usage
//   error; 3 not supported by this repository's tracker.
// - `decide` and `handover` are comments underneath, with a fixed opening
//   so they can be found later. They are their own commands so that an
//   agent's rules read as actions and so a hand-over cannot leave out what
//   was not checked.
// - Changing commands print one line saying what was done; with --json
//   they print `{ "ok": true, ... }`.

import { readFileSync } from "node:fs";
import { detectTracker } from "../tracker/detect.ts";
import { recall, remember } from "../tracker/memory.ts";
import { DECISION_PREFIX, handoverText } from "../tracker/parts.ts";
import {
  LINK_KINDS,
  PARTS,
  Refused,
  Unsupported,
  UsageError,
  type LinkKind,
  type Part,
} from "../tracker/types.ts";
import { parseArgs, parsePriority, type Parsed } from "./args.ts";
import {
  COMMANDS,
  COMMON_SPEC,
  commandHelp,
  mainHelp,
  type Command,
} from "./commands.ts";
import {
  formatComments,
  formatFacts,
  formatIssue,
  formatList,
  formatStatus,
} from "./format.ts";

/** What the command needs from the process around it. */
export interface Surroundings {
  /** Prints a line of the answer. */
  out: (text: string) => void;
  /** Prints a line about a problem. */
  err: (text: string) => void;
  /** Reads all of standard input. */
  stdin: () => string;
  /** The folder the command was started in. */
  cwd: string;
}

/** Options that take a value and may come before the command's name. */
const LEADING_VALUE_OPTIONS = new Set(["-C", "--dir", "--as", "--text-file"]);

/**
 * Splits a command line into the command's name and everything else.
 * Options may come before the name (`bend -C path list`).
 */
function splitCommand(argv: readonly string[]): {
  name: string | undefined;
  rest: string[];
} {
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at]!;
    if (LEADING_VALUE_OPTIONS.has(word)) {
      at += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    return { name: word, rest: [...argv.slice(0, at), ...argv.slice(at + 1)] };
  }
  return { name: undefined, rest: [...argv] };
}

/** The positional at `index`, or a usage error naming what is missing. */
function need(parsed: Parsed, index: number, what: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`Missing ${what}.`);
  }
  return value;
}

/**
 * The free text of a command: the words after `from`, or the content of
 * --text-file ("-" for standard input).
 *
 * @param allowEmpty True where an empty text means something (clearing a
 *   part); otherwise an empty text is a usage error.
 */
function textOf(
  parsed: Parsed,
  from: number,
  surroundings: Surroundings,
  allowEmpty = false,
): string {
  const words = parsed.positionals.slice(from);
  const file = parsed.values["text-file"];
  if (file !== undefined && words.length > 0) {
    throw new UsageError("Give the text as an argument or with --text-file, not both.");
  }
  let text: string;
  if (file === undefined) {
    if (words.length === 0) {
      throw new UsageError("Missing the text (as an argument, or with --text-file).");
    }
    text = words.join(" ");
  } else if (file === "-") {
    text = surroundings.stdin();
  } else {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Refused(`The file ${file} could not be read.`);
    }
  }
  if (!allowEmpty && text.trim() === "") {
    throw new UsageError("The text is empty.");
  }
  return text;
}

/** One of `allowed`, or a usage error listing them. */
function oneOf<Value extends string>(
  typed: string,
  allowed: readonly Value[],
  what: string,
): Value {
  if ((allowed as readonly string[]).includes(typed)) return typed as Value;
  throw new UsageError(`Unknown ${what} "${typed}". Use one of: ${allowed.join(", ")}.`);
}

/**
 * Carries out one command.
 *
 * @returns What to print: `text` for a reader and `json` for --json.
 * @throws Refused, UsageError or Unsupported; see the header.
 */
async function carryOut(
  command: Command,
  parsed: Parsed,
  surroundings: Surroundings,
): Promise<{ text: string; json: unknown }> {
  const actor = parsed.values.as;
  const { tracker, root } = detectTracker(
    parsed.values.dir ?? surroundings.cwd,
    actor,
  );
  const value = (name: string) => parsed.values[name];
  const priority = (name: string) =>
    value(name) === undefined ? undefined : parsePriority(value(name)!);
  /** The answer of a command that changed something. */
  const did = (text: string, extra: Record<string, unknown> = {}) => ({
    text,
    json: { ok: true, ...extra },
  });

  switch (command.name) {
    case "list": {
      const issues = await tracker.list({
        status: value("status"),
        type: value("type"),
        priority: priority("priority"),
        category: value("category"),
        assignee: value("assignee"),
        parentId: value("parent"),
      });
      return { text: formatList(issues), json: issues };
    }
    case "ready": {
      const issues = await tracker.ready();
      return { text: formatList(issues), json: issues };
    }
    case "show": {
      const issue = await tracker.show(need(parsed, 0, "the issue id"));
      return { text: formatIssue(issue), json: issue };
    }
    case "comments": {
      const comments = await tracker.comments(need(parsed, 0, "the issue id"));
      return { text: formatComments(comments), json: comments };
    }
    case "search": {
      const issues = await tracker.search(textOf(parsed, 0, surroundings));
      return { text: formatList(issues), json: issues };
    }
    case "create": {
      const id = await tracker.create({
        title: need(parsed, 0, "the title"),
        description: value("description"),
        done: value("done"),
        type: value("type"),
        priority: priority("priority"),
        category: value("category"),
        parentId: value("parent"),
        from: value("from"),
        blockedBy: parsed.lists["blocked-by"],
      });
      return { text: id, json: { ok: true, id } };
    }
    case "edit": {
      const id = need(parsed, 0, "the issue id");
      if (value("category") !== undefined && parsed.flags.has("no-category")) {
        throw new UsageError("Give --category or --no-category, not both.");
      }
      if (value("assignee") !== undefined && parsed.flags.has("no-assignee")) {
        throw new UsageError("Give --assignee or --no-assignee, not both.");
      }
      const changes = {
        title: value("title"),
        type: value("type"),
        priority: priority("priority"),
        category: parsed.flags.has("no-category") ? null : value("category"),
        assignee: parsed.flags.has("no-assignee") ? null : value("assignee"),
      };
      if (Object.values(changes).every((change) => change === undefined)) {
        throw new UsageError("Nothing to change: give at least one option.");
      }
      await tracker.edit(id, changes);
      return did(`Changed ${id}.`, { id });
    }
    case "write": {
      const id = need(parsed, 0, "the issue id");
      const part: Part = oneOf(need(parsed, 1, "the part"), PARTS, "part");
      await tracker.write(id, part, textOf(parsed, 2, surroundings, true));
      return did(`Wrote the ${part} of ${id}.`, { id, part });
    }
    case "comment": {
      const id = need(parsed, 0, "the issue id");
      await tracker.comment(id, textOf(parsed, 1, surroundings));
      return did(`Commented on ${id}.`, { id });
    }
    case "decide": {
      const id = need(parsed, 0, "the issue id");
      await tracker.comment(
        id,
        DECISION_PREFIX + textOf(parsed, 1, surroundings).trim(),
      );
      return did(`Recorded the decision on ${id}.`, { id });
    }
    case "start": {
      const id = need(parsed, 0, "the issue id");
      await tracker.start(id);
      return did(`${id} is in progress.`, { id });
    }
    case "close": {
      const id = need(parsed, 0, "the issue id");
      await tracker.close(id, value("reason"));
      return did(`Closed ${id}.`, { id });
    }
    case "reopen": {
      const id = need(parsed, 0, "the issue id");
      await tracker.reopen(id);
      return did(`Reopened ${id}.`, { id });
    }
    case "move": {
      const id = need(parsed, 0, "the issue id");
      const under = value("under");
      if ((under === undefined) === !parsed.flags.has("top")) {
        throw new UsageError("Say where to: --under <parent>, or --top.");
      }
      await tracker.move(id, under ?? null);
      return did(
        under === undefined ? `Moved ${id} to the top level.` : `Moved ${id} under ${under}.`,
        { id, parentId: under ?? null },
      );
    }
    case "link": {
      const id = need(parsed, 0, "the issue id");
      const other = need(parsed, 1, "the other issue's id");
      if (value("kind") === undefined) {
        throw new UsageError(`Say what kind of link: --kind ${LINK_KINDS.join(" | ")}.`);
      }
      const kind: LinkKind = oneOf(value("kind")!, LINK_KINDS, "kind of link");
      await tracker.link(id, other, kind);
      return did(
        kind === "related"
          ? `${id} and ${other} are related.`
          : `${id} is ${kind.replace("-", " ")} ${other}.`,
        { id, otherId: other, kind },
      );
    }
    case "unlink": {
      const id = need(parsed, 0, "the issue id");
      const other = need(parsed, 1, "the other issue's id");
      await tracker.unlink(id, other);
      return did(`Removed the link between ${id} and ${other}.`, { id, otherId: other });
    }
    case "handover": {
      const id = need(parsed, 0, "the issue id");
      // Checked before anything is written, so a refused hand-over leaves
      // the issue as it was.
      const text = handoverText({
        done: value("done") ?? "",
        checked: value("checked") ?? "",
        notChecked: value("not-checked") ?? "",
      });
      const issue = await tracker.show(id);
      if (issue.status === "closed") {
        throw new Refused(`${id} is closed; there is nothing to hand over.`);
      }
      // Handed over means: in progress, waiting for the owner. An issue
      // that was never started is started here so it shows as such.
      if (issue.status !== "in_progress") await tracker.start(id);
      await tracker.comment(id, text);
      return did(`Handed ${id} over. It stays in progress until the owner closes it.`, { id });
    }
    case "status": {
      const capabilities = await tracker.capabilities();
      return { text: formatStatus(capabilities), json: capabilities };
    }
    case "remember": {
      const saved = remember(root, textOf(parsed, 0, surroundings), value("key"));
      return did(
        `${saved.replaced ? "Replaced" : "Saved"} the fact "${saved.key}" in AGENTS.md.`,
        saved,
      );
    }
    case "recall": {
      const facts = recall(root, parsed.positionals);
      return { text: formatFacts(facts), json: facts };
    }
    default:
      throw new UsageError(`Unknown command "${command.name}".`);
  }
}

/**
 * Runs `bend` with the given arguments.
 *
 * @param argv The words after the program's name.
 * @returns The exit status (see the header).
 * Side effects: whatever the command does to the tracker or to AGENTS.md;
 *   prints through `surroundings`.
 */
export async function run(
  argv: readonly string[],
  surroundings: Surroundings,
): Promise<number> {
  let json = argv.includes("--json");
  try {
    const { name, rest } = splitCommand(argv);
    const wantsHelp = rest.includes("--help") || rest.includes("-h");
    if (name === undefined || name === "help") {
      const about = name === "help" ? rest.find((word) => !word.startsWith("-")) : undefined;
      const command = COMMANDS.find((candidate) => candidate.name === about);
      if (about !== undefined && command === undefined) {
        throw new UsageError(`Unknown command "${about}". Run \`bend --help\`.`);
      }
      surroundings.out(command === undefined ? mainHelp() : commandHelp(command));
      // Bare `bend` is a usage error; asking for help is not.
      return name === undefined && !wantsHelp ? 2 : 0;
    }
    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (command === undefined) {
      throw new UsageError(`Unknown command "${name}". Run \`bend --help\`.`);
    }
    if (wantsHelp) {
      surroundings.out(commandHelp(command));
      return 0;
    }
    const parsed = parseArgs(rest, {
      values: [...(COMMON_SPEC.values ?? []), ...(command.spec.values ?? [])],
      lists: command.spec.lists,
      flags: [...(COMMON_SPEC.flags ?? []), ...(command.spec.flags ?? [])],
      short: COMMON_SPEC.short,
    });
    json = parsed.flags.has("json");
    const answer = await carryOut(command, parsed, surroundings);
    surroundings.out(json ? JSON.stringify(answer.json, null, 2) : answer.text);
    return 0;
  } catch (cause) {
    const status =
      cause instanceof UsageError ? 2 : cause instanceof Unsupported ? 3 : 1;
    const message = cause instanceof Error ? cause.message : String(cause);
    // With --json the problem goes to standard output too, in a fixed
    // shape, so a program reading the answer does not have to look in two
    // places.
    if (json) {
      surroundings.out(JSON.stringify({ ok: false, status, error: message }, null, 2));
    } else {
      surroundings.err(`bend: ${message}`);
    }
    return status;
  }
}
