---
name: bend
description: Use when reading or changing a repository's issues: finding ready work, reading an issue, writing its requirements or plan, recording a decision, filing follow-up work, linking issues, or handing work over. `bend` works the same whatever tracker holds the issues (beads today), so use it instead of the tracker's own commands.
---

# bend

`bend` reads and changes a repository's issues. You do not need to know
which tracker the repository uses: the commands, fields and output are the
same everywhere. Use `bend`, not the tracker's own program.

## First step

```bash
bend status        # which tracker is here, and what it can hold
bend ready         # issues that can be worked on now
bend show <id>     # one issue in full: parts, links, sub-issues
bend comments <id> # its history: decisions, hand-overs, discussion
```

Run `bend --help` for every command and `bend <command> --help` for one.

## While working on an issue

```bash
bend start <id> --as <your-name>              # mark it in progress
bend write <id> requirements --text-file r.md # the agreed requirements
bend write <id> done "What done means"
bend write <id> plan --text-file plan.md      # the agreed plan
bend decide <id> "Chose X, because Y (the owner's decision)"
bend comment <id> "Tried Z; it did not work because …"
bend create "Follow-up title" --from <id>     # work discovered on the way
bend link <id> <other-id> --kind blocked-by   # <id> waits for <other-id>
```

- `write` replaces a whole part: `description`, `requirements`, `done`,
  `plan` or `notes`. Read the issue first if you mean to add to a part.
- Long text, or text that starts with a dash: use `--text-file <file>`
  (`-` reads standard input), or put `--` before the text.
- Record every decision when it is made, with its reason, and say whose
  decision it was.

## When you are finished

```bash
bend handover <id> --done "…" --checked "…" --not-checked "…"
```

All three are required. Say plainly what you did not check; if nothing was
left unchecked, write "nothing". The issue stays in progress: the owner
validates the work and closes it. Do not close an issue yourself unless the
owner tells you to close that issue.

## Standing facts

```bash
bend recall                       # facts every session should know
bend remember "…" --key <name>    # save or replace one
```

Facts are kept in the repository's `AGENTS.md`. Save only what every future
session needs (how to build, a lasting preference), not notes about one
issue.

## Reading the answers

- Add `--json` to any command for machine-readable output.
- Exit status: `0` done · `1` refused, with the reason in plain words ·
  `2` you asked wrongly · `3` this repository's tracker cannot do that.
  On `3`, do not retry: say so and carry on another way.
- `bend status` lists what the tracker keeps "another way" (for example
  requirements inside the description). That is handled for you.
