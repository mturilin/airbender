// bend/commands.ts — what `bend` can do, as a table.
//
// What: one entry per command: how it is called, what it does, the options
// it accepts, and the help text built from those.
//
// Why: the help a person or an agent reads and the options the program
// accepts come from the same entry, so they cannot drift apart.
//
// Design notes:
// - The commands are worded for the owner's way of working (write a part,
//   decide, hand over), not for any tracker's commands.
// - There is no `current` command: which issue a session is working on is
//   about the session, not the tracker (the owner's decision).
// - `close` is offered to agents. That agents do not close on their own is
//   a rule for agents, not a missing command (the owner's decision).

import type { OptionSpec } from "./args.ts";

/** One command's description. */
export interface Command {
  name: string;
  /** The words after the name, e.g. "<id> <part> [text]". */
  usage: string;
  /** One line for the list of commands. */
  summary: string;
  /** A fuller explanation for the command's own help; may be empty. */
  details: string;
  /** Options with their one-line explanations, e.g. ["--type <type>", "…"]. */
  options: readonly (readonly [string, string])[];
  spec: OptionSpec;
  /** Heading the command is listed under in the main help. */
  group: string;
}

const FIND = "Find and read";
const CHANGE = "Create and change";
const STRUCTURE = "Structure";
const FINISH = "Finishing";
const ABOUT = "About this repository";

export const COMMANDS: readonly Command[] = [
  {
    name: "list",
    usage: "[options]",
    summary: "List issues (open ones unless --status says otherwise)",
    details: "",
    options: [
      ["--status <status>", "open | in_progress | closed | … | all"],
      ["--type <type>", "Only this type"],
      ["--priority <0-4>", "Only this priority"],
      ["--category <name>", "Only this category"],
      ["--assignee <name>", "Only issues assigned to this person"],
      ["--parent <id>", "Only the direct sub-issues of <id>"],
    ],
    spec: {
      values: ["status", "type", "priority", "category", "assignee", "parent"],
    },
    group: FIND,
  },
  {
    name: "ready",
    usage: "",
    summary: "List issues that can be worked on now",
    details: "Open issues that wait for nothing, by the tracker's own judgement.",
    options: [],
    spec: {},
    group: FIND,
  },
  {
    name: "show",
    usage: "<id>",
    summary: "Show one issue in full, with its links and sub-issues",
    details: "",
    options: [],
    spec: {},
    group: FIND,
  },
  {
    name: "comments",
    usage: "<id>",
    summary: "Show an issue's comments, oldest first",
    details: "",
    options: [],
    spec: {},
    group: FIND,
  },
  {
    name: "search",
    usage: "<text>",
    summary: "Find issues by words in the title or id",
    details: "",
    options: [],
    spec: {},
    group: FIND,
  },
  {
    name: "create",
    usage: "<title> [options]",
    summary: "Create an issue",
    details: "Prints the new issue's id.",
    options: [
      ["--description <text>", "What is wanted and why"],
      ["--done <text>", 'What "done" means'],
      ["--type <type>", "task | feature | bug | epic | chore | decision"],
      ["--priority <0-4>", "0 is most urgent"],
      ["--category <name>", "One category; the parent's if left out"],
      ["--parent <id>", "Create it as a sub-issue of <id>"],
      ["--from <id>", "It was discovered while working on <id>"],
      ["--blocked-by <id>", "It waits for <id> (repeatable)"],
    ],
    spec: {
      values: [
        "description",
        "done",
        "type",
        "priority",
        "category",
        "parent",
        "from",
      ],
      lists: ["blocked-by"],
    },
    group: CHANGE,
  },
  {
    name: "edit",
    usage: "<id> [options]",
    summary: "Change title, type, priority, category or assignee",
    details: "",
    options: [
      ["--title <text>", "New title"],
      ["--type <type>", "New type"],
      ["--priority <0-4>", "New priority"],
      ["--category <name>", "New category"],
      ["--no-category", "Remove the category"],
      ["--assignee <name>", "New assignee"],
      ["--no-assignee", "Remove the assignee"],
    ],
    spec: {
      values: ["title", "type", "priority", "category", "assignee"],
      flags: ["no-category", "no-assignee"],
    },
    group: CHANGE,
  },
  {
    name: "write",
    usage: "<id> <part> [text]",
    summary: "Replace one written part of an issue",
    details:
      "Parts: description | requirements | done | plan | notes.\nThe text replaces what was there; an empty text clears the part.\nFor long text use --text-file.",
    options: [],
    spec: {},
    group: CHANGE,
  },
  {
    name: "comment",
    usage: "<id> [text]",
    summary: "Add a comment",
    details: "",
    options: [],
    spec: {},
    group: CHANGE,
  },
  {
    name: "decide",
    usage: "<id> [text]",
    summary: "Record a decision and its reason",
    details:
      'Say what was decided and why, and whose decision it was, e.g.\n  bend decide APP-1 "Keep the old endpoint, because mobile still calls it (the owner\'s decision)"',
    options: [],
    spec: {},
    group: CHANGE,
  },
  {
    name: "start",
    usage: "<id>",
    summary: "Mark an issue as being worked on",
    details: "With --as, the issue is also assigned to that name.",
    options: [],
    spec: {},
    group: CHANGE,
  },
  {
    name: "close",
    usage: "<id> [options]",
    summary: "Close an issue",
    details: "",
    options: [["--reason <text>", "Why it is closed"]],
    spec: { values: ["reason"] },
    group: CHANGE,
  },
  {
    name: "reopen",
    usage: "<id>",
    summary: "Reopen a closed issue",
    details: "",
    options: [],
    spec: {},
    group: CHANGE,
  },
  {
    name: "move",
    usage: "<id> (--under <parent> | --top)",
    summary: "Put an issue under a parent, or back at the top level",
    details: "",
    options: [
      ["--under <id>", "Make it a sub-issue of <id>"],
      ["--top", "Take it out of its parent"],
    ],
    spec: { values: ["under"], flags: ["top"] },
    group: STRUCTURE,
  },
  {
    name: "link",
    usage: "<id> <other-id> --kind <kind>",
    summary: "Link two issues",
    details:
      "Kinds: blocked-by | discovered-from | related.\nRead it as a sentence: `bend link A B --kind blocked-by` records that A is blocked by B.",
    options: [["--kind <kind>", "blocked-by | discovered-from | related"]],
    spec: { values: ["kind"] },
    group: STRUCTURE,
  },
  {
    name: "unlink",
    usage: "<id> <other-id>",
    summary: "Remove the link between two issues",
    details: "Whichever way round the link was recorded.",
    options: [],
    spec: {},
    group: STRUCTURE,
  },
  {
    name: "handover",
    usage: "<id> --done <text> --checked <text> --not-checked <text>",
    summary: "Hand an issue over to the owner to validate",
    details:
      'All three are required. If everything was checked, say so: --not-checked "nothing".\nThe issue is left in progress; the owner validates and closes it.',
    options: [
      ["--done <text>", "What was done"],
      ["--checked <text>", "How it was checked"],
      ["--not-checked <text>", "What was not checked"],
    ],
    spec: { values: ["done", "checked", "not-checked"] },
    group: FINISH,
  },
  {
    name: "status",
    usage: "",
    summary: "Which tracker is used here and what it supports",
    details: "",
    options: [],
    spec: {},
    group: ABOUT,
  },
  {
    name: "remember",
    usage: "<text> [--key <key>]",
    summary: "Save a standing fact for future sessions",
    details:
      "Facts are kept in the repository's FACTS.md, one line per key.\nSaving under a key that exists replaces that fact.",
    options: [["--key <key>", "The fact's name; made from its first words if left out"]],
    spec: { values: ["key"] },
    group: ABOUT,
  },
  {
    name: "recall",
    usage: "[words]",
    summary: "Show saved facts, all or those containing the words",
    details: "",
    options: [],
    spec: {},
    group: ABOUT,
  },
];

/** Options every command accepts, with their explanations. */
export const COMMON_OPTIONS: readonly (readonly [string, string])[] = [
  ["-C, --dir <path>", "Run as if started in <path>"],
  ["    --json", "Print machine-readable JSON"],
  ["    --text-file <f>", 'Read the text argument from a file ("-" for stdin)'],
  ["    --as <name>", "Who is acting, for the tracker's history"],
  ["-h, --help", "Help for bend or for one command"],
];

/** The option names behind COMMON_OPTIONS, merged into every command. */
export const COMMON_SPEC: OptionSpec = {
  values: ["dir", "text-file", "as"],
  flags: ["json", "help"],
  short: { C: "dir", h: "help" },
};

/** Lines of `[left, right]` pairs with the right-hand side aligned. */
function columns(pairs: readonly (readonly [string, string])[]): string {
  const width = Math.max(...pairs.map(([left]) => left.length));
  return pairs.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

/** The text of `bend --help`. */
export function mainHelp(): string {
  const groups = [...new Set(COMMANDS.map((command) => command.group))];
  return [
    "bend — read and change a repository's issues, whatever tracker holds them.",
    "",
    "The tracker is detected from the folder you are in. Commands, fields and",
    "output are the same for every tracker. Where a tracker has no home for",
    "something, bend keeps it in a fitting place or says so; it never drops it",
    "silently. Run `bend status` to see what applies here.",
    "",
    "Usage:",
    "  bend <command> [arguments] [options]",
    ...groups.flatMap((group) => [
      "",
      `${group}:`,
      columns(
        COMMANDS.filter((command) => command.group === group).map(
          (command) =>
            [`${command.name} ${command.usage}`.trim(), command.summary] as const,
        ),
      ),
    ]),
    "",
    "Options for every command:",
    columns(COMMON_OPTIONS),
    "",
    "Exit status: 0 done · 1 refused, with the reason in plain words",
    "             2 usage error · 3 not supported by this repository's tracker",
    "",
    "Examples:",
    "  bend ready",
    "  bend show APP-142",
    '  bend create "Login fails on Safari" --type bug --priority 1',
    "  bend write APP-142 plan --text-file plan.md",
    '  bend decide APP-142 "Keep the old endpoint, because mobile still calls it"',
    "  bend link APP-150 APP-142 --kind blocked-by",
    "",
    "Run `bend <command> --help` for one command.",
  ].join("\n");
}

/** The text of `bend <command> --help`. */
export function commandHelp(command: Command): string {
  return [
    `${command.summary}.`,
    "",
    "Usage:",
    `  bend ${command.name} ${command.usage}`.trimEnd(),
    ...(command.details === "" ? [] : ["", command.details]),
    ...(command.options.length === 0
      ? []
      : ["", "Options:", columns(command.options)]),
    "",
    "Options for every command:",
    columns(COMMON_OPTIONS),
  ].join("\n");
}
