# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [sync-concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Record everything in beads

Beads is this project's memory. Chat history is lost when a session ends;
what is written to a bead is not. Write down as much as you can, as you go,
not at the end.

**Before starting work**

- Every piece of work has a bead. If the user asks for something that has no
  bead yet, create one first (`bd create`), then claim it.
- Give the bead a real description: what is wanted and **why**, in the user's
  own words where possible. Set type and priority.
- Write what "done" means: `bd update <id> --acceptance "..."`.

**While working**

- **Design and intent** go in the design field, kept current as the design
  changes: `bd update <id> --design "..."` (or `--design-file`). Say what was
  chosen, what was rejected, and why.
- **Every decision** — yours or the user's — gets a comment at the moment it
  is made, with the reason: `bd comment <id> "Decided X because Y"`. Record
  the user's decisions and preferences in their words, and say that they came
  from the user.
- **Things tried that did not work**, surprises, and gotchas get a comment
  too, so the next agent does not repeat them.
- **Progress** worth resuming from goes in the notes: `bd note <id> "..."`.
- **Follow-up work** you notice becomes its own bead, linked to the one it
  came from: `bd create "..." --deps discovered-from:<id>`.
- **Work that must wait for other work** is linked: `--deps blocked-by:<id>`.
- **Decisions that span several beads** become a bead of type `decision`,
  linked from the beads they affect.

**When finishing**

- **Do not close the bead.** The user validates the work and closes it
  themselves. This overrides any "close when done" wording elsewhere in this
  file. Close a bead only when the user tells you to close that bead.
- Instead, add a comment that says what was done and how it was checked, and
  state plainly what was not tested: `bd comment <id> "..."`. Leave the bead
  in progress and tell the user it is ready for them to validate.
- Anything left undone becomes a new bead before you hand over.

**After the user closes a bead**

- Commit the work that belongs to that bead, as soon as you learn it is
  closed (the user tells you, or you see it closed in `bd show`). Closing is
  the user's sign that the work is validated, so it is the moment the work
  becomes worth keeping in git. Do not commit a bead's work before it is
  closed.
- One commit per bead. Stage only the files that belong to it; never
  `git add -A`.
- The commit message names the bead by **id and description**:
  - Subject line: the bead's id, then its title, for example
    `bead-bb-un8: Show design, acceptance criteria, notes and comments in an opened issue`.
  - Body: what the bead asked for and what was done, taken from the bead's
    description and from the hand-over comment.
  - A commit that has to cover several beads lists each one in the body as
    `<id>: <title>`.
- This project opts in to agents committing at this point; it replaces the
  "do not run git commits" default in the Beads block below. It does not
  cover pushing: do not push unless asked.
- If your own standing instructions require the user's approval for each
  commit, they still apply: propose the exact files and message, and commit
  once the user agrees.

**Across the whole project**

- Standing facts every future session should know (conventions, how to build
  and install, the user's lasting preferences) go in `bd remember "..."`.

When unsure whether something is worth recording, record it.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
