<!-- airbender:rules:start -->
<!-- airbender:rules:version 2 -->
## Working with beads through Airbender

This repository's issues are tracked in beads (`bd`) and worked from the
Airbender tab in BB. These are the instructions for working on issues here;
follow them whenever you work on one.

The commands you need (`bd <command> --help` says more):

- `bd show <id>` and `bd comments <id>`: read an issue and its history.
- `bd update <id>` with `--description "..."`, `--acceptance "..."` or
  `--design "..."`: write what is wanted, what "done" means, and the plan.
  With `--status in_progress`: mark it started.
- `bd comment <id> "..."`: record a decision, a surprise, or a hand-over.
- `bd create "..." --deps discovered-from:<id>`: follow-up work, linked to
  the issue it came from.
- `bd dep add <id> <other-id>`: this issue waits for the other one.
- `bd list` and `bd ready`: what there is, and what can be worked on.

- **Standing facts are in `FACTS.md`.** Read it when you start. When
  you learn something every later session should know (how to build, a
  convention, a lasting preference of the user's), add it there as one
  line, `- **short-key** — the fact`. Do not use `bd remember` for that.

- **Every piece of work has an issue.** If the user asks for something that
  has no issue yet, create one first (`bd create`), with what is wanted and
  why, and what "done" means (`bd update <id> --acceptance "..."`).
- **A question is not work.** A plain question or a discussion needs no
  issue: answer it in the conversation. Where it ends in a decision worth
  keeping, offer to record it.
- **Make the issue you work on the thread's current issue**, by calling the
  `beads_set_current` tool with its id as soon as you start, also when you
  created the issue yourself. The user sees in the Airbender tab, and
  above the message box, which issue the thread is on.
- **The repository's owner chooses its workflow** in the Airbender tab:
  standard, where every issue goes through steps, or simple, with no steps.
  You are told which one applies when you set your current issue with
  `beads_set_current`, and again if the user switches it. On the standard
  workflow the rules below marked "(standard)" apply. On the simple
  workflow there are no steps to report (the `beads_workflow_move` tool
  refuses and says so): the user directs the work in the conversation and
  closes issues themselves.
- **(standard) An issue takes only the steps its size needs.** When you
  are started on an issue that has no size, size it first: S (small: done
  in one go, the user sees it once, at the end), M (medium: definition and
  plan together, one review, then the result) or L (large: every step). In
  doubt, take the larger. The user can set or change the size. When you
  create an issue yourself you may give it a size, with the label
  `size:s`, `size:m` or `size:l`.
- **(standard) Every issue goes through its workflow.** Do the step you are
  started on only, and report it with the `beads_workflow_move` tool when
  it is finished. You may move an issue to another step when that is where
  the work really is, with your reason, but never forward past a review
  that is the user's (of the definition, of the plan, of the finished
  work). While an issue waits for the user: if their reply asks for
  changes, move it back and redo the work; if they approve, record that,
  quoting them; if it is only a question, answer it.
- **Ask the issue's open questions first.** Being started on an issue is not
  permission to assume the answers. Record each answer on the issue.
- **Record as you go.** Decisions and their reasons, things that did not
  work, and progress go on the issue (`bd comment`, `bd note`, the design
  field). Follow-up work becomes its own issue, linked to the one it came
  from.
- **Do not close the issue.** When the work is done, add a comment saying
  what you did, how you checked it and what you did not check, and tell the
  user it is ready to validate. Never close an issue with `bd close`
  unless the user tells you to close that issue: on the standard workflow
  it closes when its last step is reported done, on the simple one the user
  closes it.
- **(standard) Commit when the user has accepted the issue and chosen
  how**, not before. That is the workflow's last step: one commit per
  issue, only that issue's files, with the issue's id and title as the
  subject line. A merge only when the user chose "Commit & merge": then
  also push the main branch and, after that, delete the issue's branch
  locally and on the remote. An issue the user starts "in a new branch"
  tells you the branch to create first. In a conversation opened for one
  issue in a work tree, follow the landing order that step gives you, and
  leave the work tree and its local branch to Airbender.
- **(standard) An epic can have a branch for all of its issues.** The user
  starts an issue that has sub-issues "in a branch" or "in a work tree":
  you then only create the branch (or say which branch the work tree is
  on) and start no work. The epic waits at the step "On its branch". Its
  issues are started one at a time, in a folder on that branch only, and
  each is committed there and never merged by itself. The branch is merged
  once, when the user closes the epic with "Close & merge".
- **On the simple workflow, commit only when the user asks.**
<!-- airbender:rules:end -->
