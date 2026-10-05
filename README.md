# Airbender (bb-plugin-airbender)

A BB plugin that shows a repository's beads issues in a tab in the right-hand
panel, beside a thread or on the New thread screen.

- `server.ts` and `server/` — the backend. Finds the folder a thread or
  project works in, runs `bd` there to list and change issues, and stores
  each thread's current bead. `server/contract.ts` is the typed contract
  with the frontend, `server/issues.ts` turns beads' rows into issues
  (blocking, links, categories), `server/bd.ts` runs programs, and
  `server/prompts.ts` holds the wording sent to agents.
- `app.tsx` and `app/` — the frontend. `app.tsx` registers the surfaces;
  the **Airbender** tab is `app/panel.tsx` and the files beside it (rows,
  opened issue, groups, new-issue field, menus, setup), and
  `app/composer.tsx` holds the message-box controls. Logic without React is
  in `app/issue-model.ts` and `app/quick-tags.ts`.
- `shared/constants.ts` — the values both halves must agree on. It has no
  imports, so it is safe to bundle on either side.
- `*.test.ts` — tests for the logic without React or BB; run `npm test`.
- `PLUGIN_OVERVIEW.md` — the text BB shows on the plugin's detail page.

## Use

Open a thread, open the right-hand panel, choose new tab, then **Airbender**
under Actions.

Outside the tab, in the message box of a thread (its row of controls, which
BB hides in its compact layout): a pill with the current issue's title that
opens a small pop-up with its details, and two quick-reply icon buttons, "Go" (arrow) and
"Agree & go" (tick), that send the agent a go-ahead without typing.

From top to bottom the tab shows:

1. **Current** (pinned): the bead this thread is working on, as one row that
   opens on its chevron, with Define and Clear.
2. **Toolbar** (pinned): the folder and a refresh button.
3. **Every other issue**, grouped by status; this part scrolls. The Ready
   heading carries two menus, both remembered per folder: Group (divides
   Ready into collapsible sub-groups by priority, type or category) and
   Filter (types, priorities, categories; narrows every group). While the
   thread has no bead, each open issue has a play button: it makes that issue
   the thread's bead and sends the agent a message to start on it. The agent
   is told to clarify the requirements with you first, then agree an
   implementation plan, then build; it may skip either of the first two when
   it is obvious, and has to say so. An opened
   issue also offers Define, which starts a background agent that fills
   in the issue's description, acceptance criteria and design. It does not
   appear in the sidebar and the thread you are in is not touched; the row
   is marked "defining…" until it stops, and the button opens it.
   An issue with no description shows the Define button on its row.
   An opened issue shows its description, then a folded heading for each
   of acceptance criteria, design, notes, close reason and comments that the
   issue has; each opens on its own chevron.
   Priority and type are small dropdowns on each open issue's row; picking a
   value changes the issue straight away.
   An opened open issue has an Edit button: it turns the title and
   description into a form with Save and Cancel.
   There are two ways to close, each with its own icon and its own
   confirmation. The "Close & commit" button, on the thread's current bead, closes the
   issue and sends the agent a message asking it to commit the work. The
   cross closes an issue without a commit: use it to drop an issue. On other
   open issues it is on the row; on the current bead it is only inside the
   opened issue, so "Close & commit" is the obvious choice there. A closed row has a reopen button instead. Closing the
   thread's current bead also clears it as current.
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
   "View more", which opens the window. Play on an issue with sub-issues starts
   the agent on all of them, and "Close & commit" on it closes all of them.
4. **New issue field** (pinned at the bottom): type a title and press Enter;
   the chevron adds type, priority and description.

The agent can set the thread's bead itself with the `beads_set_current` tool,
which BB offers to threads whose folder has a `.beads` directory.

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

- `bd command` — name or full path of the `bd` tool. Change it only if BB
  cannot find `bd`.
- `Define model` — model id the background agent uses for Define
  (default `claude-fable-5-1`). Empty uses the project's default model.

Reload the plugin after changing a setting.

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
both sides need go in `shared/constants.ts`. Files that the tests load
(`server/issues.ts`, `server/prompts.ts`, `app/issue-model.ts`,
`app/quick-tags.ts`) must not import React, the BB SDK or `@/...` paths.
A new source folder must be added to `include` in `tsconfig.json`.

`components/ui/` is vendored source owned by this plugin; edit it freely.
