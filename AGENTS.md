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

## The spec

`specs/PRD.md` is the source of truth for what this product does. It is
written so the product could be rebuilt on another platform from it alone:
behaviour from the owner's point of view, no implementation details.

- **Read it before you plan or build.** A change must not break a
  requirement in it without the user deciding so.
- **Update it after EVERY change.** Any change to what the product does,
  however small, is not finished until `specs/PRD.md` matches it. The spec
  and the implementation are updated **in the same commit**: edit the spec
  in the same piece of work, before you hand over, and commit it with that
  bead's commit.
- **The spec describes only what is built.** A new request that is not built
  yet is not written into the spec; it lives in beads, as a bead. It enters
  the spec when it is built, in the commit that builds it.
- **Write only what the user asked for or decided**, in the section it
  belongs to, with the bead id in brackets. Do not add your own reasoning or
  ideas.
- **Behaviour you chose yourself**, because the user did not specify it, goes
  under "Unspecified details", never among the requirements.
- When a requirement changes, replace the old text. The spec says what is
  true now; the history stays on the beads.

<!-- airbender:rules:start -->
## Record everything in beads

Beads is this project's memory. Chat history is lost when a session ends;
what is written to a bead is not. Write down as much as you can, as you go,
not at the end.

**Before starting work**

- Every piece of work has a bead. If the user asks for something that has no
  bead yet, create one first (`bd create`), then claim it.
- **A question is not work.** A plain question or a discussion needs no
  bead: answer it in the conversation. Create a bead only when something is
  to be changed. Where a discussion ends in a decision worth keeping, offer
  to record it.
- **Make the bead you work on the thread's current bead**, by calling the
  `beads_set_current` tool with its id, as soon as you start on it. This
  matters most when the work began from a plain typed request and you
  created the bead yourself: the tab's buttons set the current bead for you,
  a typed request does not. While a thread has a current bead, the Airbender
  tab offers its workflow buttons (approve, accept and so on) on that bead
  only, so a bead you work on without making it current leaves the user with
  no button to move it on.
  When you switch to another bead, set that one; when the work is committed
  and you are on no bead, clear it.
- Give the bead a real description: what is wanted and **why**, in the user's
  own words where possible. Set type and priority.
- Write what "done" means: `bd update <id> --acceptance "..."`.

- **Ask the bead's open questions first.** If the bead records open
  questions for the user, put them to the user and wait for the answers
  before you plan or build. Being told to work on a bead (for example by the
  play button) is not permission to assume the answers, even where the bead
  lists an answer you "would assume". Record each answer on the bead as a
  comment.

- **A question is not a go-ahead.** When the user's message asks you
  something, or you have asked them something that is not yet answered,
  answer or wait, and change nothing: no file edits, no new or moved beads,
  no commits, no settings. This holds even when the answer seems obvious and
  the work seems agreed. Agreement on an idea is not approval to build it.
  Start only when the user says so in words ("go", "do it", "build it") or
  presses a button that says so.

- **Take the bead through its workflow, one step at a time.** Every bead
  goes through these steps to be closed: Not started, Define, Review
  definition, Plan, Review plan, Implement, Agent review, Human review,
  Apply. When
  you are started on a bead you are told which step it is at. If you begin
  work on a bead that is still Not started (for example from a typed
  request), move it with `start` first.
  **A bead takes only the steps its size needs.** When you are started on a
  bead that has no size, size it first and say which in one line, with the
  move `size:s`, `size:m` or `size:l`: S, small, is done in one go and
  reaches the user once, at the end; M, medium, has one review at the front,
  of definition and plan together; L, large, takes every step. In doubt,
  take the larger. The user can set or change the size; you are told when
  they do, and take the new path from where the bead is.
  Then do the step you are at only:
  1. *Define.* Make sure it is clear what is wanted, why, and what "done"
     means; ask the user what is unclear; write the agreed description and
     acceptance criteria onto the bead.
  2. *Plan.* Say what you will change and how, and write the plan into the
     bead's design field. Change nothing yet.
  3. *Implement.* Do the work.
  4. *Agent review.* Review the work against the bead as if someone else had
     done it; fix what you find.
  5. *Commit*, or *Commit & merge.* After the user has accepted the work
     (on the main branch "Accept & commit" goes straight to Commit; on
     another branch they choose one of the two at Apply): do that (see "Committing a bead's
     work" below), and report the step done, which closes the bead.
  The reviews of the definition, of the plan and of the finished work are
  the user's. While a bead waits for one of them, read what the user
  replies: if they ask for changes, move it back (`send-back`, giving their
  words) and redo the work; if they approve, in the tab or in the
  conversation, record a spoken approval with `approved`, quoting them, and
  carry on; if they only ask a question, answer it and leave the bead where
  it is. Never move a bead forward past a review the user has not given.
  When you finish a step, report it with the `beads_workflow_move` tool,
  with a one-line note. It tells you what comes next: your next step, or
  that the bead now waits for the user, in which case say so and stop.
  You have the judgment to move a bead to where the work really is, with
  your reason: the size you choose is the usual way to leave steps out;
  `skip` leaves out Define or Plan, and `to:<step>` goes to any step. Say so
  in one line, so the user can stop you. If in doubt, take the fuller path. You cannot move a bead to Apply or past it.

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

- **Do not close the bead.** The user validates the work and accepts it;
  the bead closes when its last step, the commit, is reported done. Never run
  `bd close` on it yourself, unless the user tells you to close that bead.
  This overrides any "close when done" wording elsewhere in this file.
- Instead, add a comment that says what was done and how it was checked, and
  state plainly what was not tested: `bd comment <id> "..."`. Leave the bead
  in progress and tell the user it is ready for them to validate.
- Update `specs/PRD.md` to match what you changed (see "The spec"), and say
  in your hand-over comment that you did.
- Anything left undone becomes a new bead before you hand over.

**Committing a bead's work**

- Commit the work that belongs to a bead when it reaches the Commit or the
  Commit & merge step. It gets there when the user accepts it at Human
  review and then, at Apply, chooses one of the two. The user's acceptance
  is the sign that the work is validated, so it is the moment the work
  becomes worth keeping in git. Do not commit a bead's work before that,
  unless the user has told you to commit as you go on a branch.
- At Commit, commit only; leave the work on the branch it is on. At Commit
  & merge, also merge that branch into the main branch: the user chose
  this, which is their approval of that merge.
- When the work is in git, report the step done with the
  `beads_workflow_move` tool, naming the commit. That closes the bead.
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
  "do not run git commits" default in the Beads block below.
- **Every commit is pushed automatically.** A git hook
  (`.beads/hooks/post-commit`) pushes the branch to the remote `origin`
  (the GitHub repository `airbender`) right after each commit. You do not
  push by hand, and you do not need to be asked. If the hook reports that
  the push failed, say so to the user with the error; the commit itself is
  safe locally.
- **Do not amend or rewrite a commit once it is made.** It is already on the
  remote, and the hook does not force-push. Fix forward with a new commit.
- If your own standing instructions require the user's approval for each
  commit, they still apply: propose the exact files and message, and commit
  once the user agrees.

**Across the whole project**

- Standing facts every future session should know (conventions, how to build
  and install, the user's lasting preferences) go in `bd remember "..."`.

When unsure whether something is worth recording, record it.
<!-- airbender:rules:end -->

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
