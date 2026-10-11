# Agent Instructions

This project uses **bd** (beads) for issue tracking.

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
  own words where possible. Set type and priority. You may also give a bead
  you create a size, with the label `size:s`, `size:m` or `size:l`: you know
  it better than the background agent that sizes unsized beads.
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
  request), move it with `start` first, or with `start-branch` if the user
  asked for it to be done in a branch of its own: that move tells you the
  branch to create, and is refused while the folder has uncommitted
  changes.
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
  & merge, also merge that branch into the main branch, push the main
  branch, and then delete the bead's branch, locally and on the remote: the
  user chose this, which is their approval of the merge, of that push and
  of the deletion. Push first, delete after: a merge that makes no commit
  does not set off the hook below, and until the main branch is pushed the
  branch on the remote is the only copy there.
- In a conversation that Airbender opened for one bead in a work tree, the
  Commit & merge step tells you its own order: bring the main branch into
  your branch first and settle conflicts there (send the bead back if you
  cannot), move the main branch forward from the folder where it is checked
  out, push it, delete your branch on the remote, and leave the work tree
  and the local branch alone: Airbender archives the conversation and
  removes both when you report the step done.
- An epic can have a branch for all of its beads. The user starts a bead
  that has sub-issues "in a branch" or "in a work tree": you then only
  create the branch (or say which branch the work tree is on) and start no
  work. The epic waits at the step "On its branch". Its beads are started
  one at a time, in a folder on that branch only, and each is committed
  there and never merged by itself. The branch is merged once, when the
  user closes the epic with "Close & merge".
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
  and install, the user's lasting preferences) are in `FACTS.md`. Read it
  when you start, and add a new one there as one line under a short key. Do
  not use `bd remember` for that.

When unsure whether something is worth recording, record it.
<!-- airbender:rules:end -->

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
