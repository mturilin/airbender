# Airbender (bb-plugin-airbender)

A BB plugin that shows a repository's beads issues in a tab in the right-hand
panel, beside a thread or on the New thread screen.

- `server.ts` and `server/` — the backend. Finds the folder a thread or
  project works in, runs `bd` there to list and change issues, and stores
  each thread's current bead. `server.ts` wires the pieces and maps each
  request to one call. `server/contract.ts` is the typed contract with the
  frontend; `folder.ts` finds the folder and runs `bd`; `store.ts` holds the
  issue operations; `work.ts` moves an issue through its workflow;
  `current-bead.ts` is the thread's current issue; `issues.ts` turns beads'
  rows into issues (blocking, links, categories); `watch.ts` and `setup.ts`
  are what their names say; `prompts.ts` holds the wording sent
  to agents.
- `app.tsx` and `app/` — the frontend. `app.tsx` registers the surfaces;
  the **Airbender** tab is `app/panel.tsx` and the files beside it (rows,
  opened issue, groups, new-issue field, menus, setup), and
  `app/composer.tsx` holds the message-box controls; `app/issue-card.tsx`
  is the card an issue shows on hover; `app/epic-band.tsx`
  and `app/use-focus.ts` are epic mode. Logic without React is
  in `app/issue-model.ts` and `app/quick-tags.ts`.
- `shared/` — what both halves use: `constants.ts` (the values they must
  agree on), `tree.ts` (walking sub-issues), and the workflow:
  `workflow.ts` says what a workflow is, `standard-workflow.ts` is the
  standard one (its steps, button labels and wording for agents), and
  `workflows.ts` lists the choices a repository has: Standard, or Simple,
  which is no workflow at all. Which one a repository uses is remembered by
  `server/workflow-choice.ts`. To change how issues
  are worked, change `standard-workflow.ts`; nothing else names a step. These files have no imports,
  so they are safe to bundle on either side.
- `*.test.ts` — tests for the logic without React or BB; run `npm test`.
- `PLUGIN_OVERVIEW.md` — the text BB shows on the plugin's detail page.

## Use

Open a thread, open the right-hand panel, choose new tab, then **Airbender**
under Actions.

Outside the tab, around the message box of a thread: one line above it
(the current issue's step on a blue chip, its id, and a sentence saying what
is required now, such as "Please review the plan and give feedback.";
hover or click it for the whole issue), and inside it the current
step's buttons as text ("Approve plan" and "Send back", "Implement", "Commit &
merge"…). "Send back" takes its reason from what is typed in the box. The
gray "Agree & continue" icon shows when those two answer buttons do not. BB hides the buttons inside the box in its
compact layout; the status line stays.

From top to bottom the tab shows:

1. **Toolbar** (pinned): the folder, a refresh button and a "⋯" menu. The
   menu chooses the repository's workflow: **Standard** (every issue goes
   through the steps below) or **Simple** (no steps: each row has Make
   current / Release and Close buttons, and you direct the agent yourself).
   The choice is remembered per repository, its work trees follow it, and
   issues keep their steps while it is on Simple. The menu also holds the
   setup steps.
2. **Epic band** (pinned, only in epic mode): an issue with sub-issues has
   a magnifier button that zooms the list in on it, so only its direct
   sub-issues are listed, as full rows. The band names the epic and its
   back arrow goes up one level. Epic mode is only a way of looking, is
   remembered per thread, and can be entered while the thread's bead is
   none, the epic (which is then released) or something inside it; it ends
   by itself when an outside issue becomes the thread's bead.
3. **Current** (pinned): the bead this thread is working on, as one row that
   opens on its chevron.
4. **Every other issue**, grouped by status; this part scrolls. The Ready
   heading carries two menus, both remembered per folder: Group (divides
   Ready into collapsible sub-groups by priority, type or category) and
   Filter (types, priorities, categories; narrows every group). Every open issue shows
   the step of its workflow it is at (Not started, Define, Review
   definition, Plan, Review plan, Implement, Agent review, Human review, Apply,
   then Commit or Commit & merge) and one main button
   for that step: at an agent's step it starts the agent on that step and
   makes the issue the thread's bead; at one of yours it is your approval.
   Send back, Skip and Mark as done are inside the opened issue. Next to it
   is the row's "⋯" menu, the only other thing on a row besides the
   maximize button, which opens the issue in the details window and is on
   every issue: Open in window, Make current, Edit, Add
   sub-issue, Move to, Link and Close, or Reopen on a closed issue. Edit,
   Move to and Link open the issue and are done there. The same actions are
   buttons inside the opened issue; a sub-issue's row has no menu. Make
   current makes an issue the thread's bead (Release undoes it), without starting the agent or moving the workflow; the agent gets a
   short note, and replacing another bead asks first. While the
   thread has a bead, these buttons are offered on that issue only.
   An opened issue shows its description, then a folded heading for each
   of acceptance criteria, design, notes, close reason and comments that the
   issue has; each opens on its own chevron.
   Priority and type are small dropdowns on each open issue's row; picking a
   value changes the issue straight away.
   An opened open issue has an Edit button: it turns the title and
   description into a form with Save and Cancel.
   An issue takes only the steps its size needs. Pressing "Start" has the
   agent size it first: S (done in one go, you see it once, at the end), M
   (definition and plan together, one review, then the result) or L (every
   step). The size then shows as a small dropdown beside the step, where you
   can change it until the work reaches you; you can also set it yourself
   beforehand from the row's "⋯" menu. A plain question in the chat needs no
   issue.
   Unless switched off, a background agent sizes new and changed issues
   before they are started (a hidden worker thread on a small model; see
   Settings), leaving alone any size you or an agent set and any issue that
   has started. "Auto" on the Size row of an issue's menu does it on
   request.
   On the main branch Human review offers "Accept & commit", which goes
   straight to the commit. On another branch "Accept" moves the issue to
   Apply, where you choose "Commit" or "Commit & merge"; the agent does it,
   and reporting it done closes the issue.
   Close, in the menu and inside the opened issue, cancels an issue: it
   closes it without finishing it, after asking for confirmation. A closed
   issue has Reopen there instead. Closing the thread's bead also clears it as current.
   The Closed group's heading is always last in the list, with its count
   and a Show/Hide button; closed issues start hidden.
   Issues can sit inside other issues, to any depth. A sub-issue is drawn
   indented under its parent and only one level is drawn. A details button
   on any issue with sub-issues opens a window on it; the same button inside
   the window goes deeper, and a path at the top goes back up. The window is a
   fixed, large size and has its own new-issue field, so adding a sub-issue
   there stays there. Drag an issue
   onto another to nest it, or onto a group heading or empty space to move
   it out; an opened issue has an "Add sub-issue" button, which selects it as the
   parent in the new-issue field at the bottom, and a "Move to" button with a
   search field for moving it into another issue or out to the top level.
   An issue with sub-issues starts opened. A long description is cut to about four lines with
   "View more", which opens the window. Starting an issue with sub-issues starts
   the agent on all of them, and closing it closes all of them.
5. **New issue field** (pinned at the bottom): type a title and press Enter;
   the chevron adds type, priority and description.

The agent can set the thread's bead itself with the `beads_set_current` tool
and move an issue's step with `beads_workflow_move`. Both are offered to
every thread, in any folder: BB fixes a thread's tools when its session
starts, so offering them only where beads was already set up left some
agents without them. Where a tool does not apply (no beads in the folder,
or the repository on the simple workflow) it refuses and says why.

The list refreshes when the tab opens, when you press Refresh, when the BB
window regains focus, and after any change to the issues: one made through
this plugin, or one made by an agent or in a terminal with `bd`.

Buttons have tooltips, clicking an issue's id copies it, and the current
issue's row has a thicker border so it stands out.

An issue can have one category, set from a dropdown on its row next to
priority and type (pick one in use, or "New category…" to type one), or in
the new-issue form; a new sub-issue takes its parent's. It is stored as the
beads label `category:<name>`. The Filter menu can narrow by category.

In the new-issue field, tags in the title set things without opening the
form: `#bug` (or any type), `#p0` to `#p4`, and `$name` for the category,
for example `Fix login #bug #p1 $ux`. The tags are removed from the title. Typing `#` or `$` shows
matching suggestions above the field: Up and Down to move, Tab or Enter to
complete, Escape to close.

## Getting a folder ready

When something is missing, the tab offers it in a card in the middle, each
step with its button and a Skip; the "⋯" menu at the right of the toolbar
lists every step, greyed out when done or not yet possible:

1. **Install beads** — pick a method (install script, mise, Homebrew, npm).
2. **Set up beads in this folder** — runs `bd init`.
3. **Configure beads for Claude Code / Codex** — runs `bd setup <agent>`.
4. **Add Airbender's rules for agents** — the working rules the buttons
   rely on, added to `AGENTS.md` between `<!-- airbender:rules:start -->`
   and `<!-- airbender:rules:end -->`. It also makes `CLAUDE.md` point at
   `AGENTS.md` (an `@AGENTS.md` line): a beads-generated
   `CLAUDE.md` becomes a short pointer, one with your own text keeps it,
   and none is created where there is none.

Steps 1 to 3 run in a BB terminal you can watch and type into; the tab
reloads when it ends and shows the last output if it failed.

## Limits of this version

- Issues can be created, closed and reopened, and their type, priority,
  title and description changed. Design, acceptance criteria, notes and
  comments cannot be edited, and issues cannot be deleted, from the tab.
- The thread's bead is a note kept by BB on the thread; setting it does not
  change the issue's status in beads.
- `bd` runs on the machine the BB server runs on. Threads whose folder is on
  another machine get an explanation instead of a list.

## Settings

In BB under Tools, then Airbender (the tab's "⋯" menu says so too; a tab
cannot open that page itself, see get-bb/bb#5014).

- `bd command` — name or full path of the `bd` tool. Change it only if BB
  cannot find `bd`. Reload the plugin after changing it.
- `Size issues in the background` — on by default. Off stops the automatic
  sizing; "Auto" on the Size row of an issue's menu still works.
- `Sizing provider` and `Sizing model` — what the background agent runs on:
  by default `claude-code` and `claude-haiku-4-5-20251001`. The model must
  belong to the provider (`bb provider models <provider>` lists them). These
  three are read each time a sizing starts; no reload is needed.

## Develop

```
npm install --include=dev
bb plugin build        # compile into dist/
bb plugin install .    # register this folder with BB
bb plugin dev          # rebuild and reload on every save
npx tsc --noEmit       # typecheck
npm test               # run the tests (node's own test runner)
```

The frontend may import only types from `server.ts` and `server/`; values
both sides need go in `shared/`. Files that the tests load
(`server/issues.ts`, `server/prompts.ts`, `app/issue-model.ts`,
`app/quick-tags.ts`, everything in `shared/`) must not import React, the BB SDK or `@/...` paths.
A new source folder must be added to `include` in `tsconfig.json`.

`components/ui/` is vendored source owned by this plugin; edit it freely.
