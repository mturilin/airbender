# bb-plugin-beads

A BB plugin that shows a repository's beads issues in a tab in the right-hand
panel, beside a thread or on the New thread screen.

- `server.ts` — the backend. Finds the folder a thread or project works in,
  runs `bd` there to list and create issues, works out "blocked by" and
  "holds up" from their dependencies, and stores each thread's current bead.
- `app.tsx` — the frontend. The **Beads issues** tab: issues grouped into in
  progress, ready, blocked, other, and closed.
- `PLUGIN_OVERVIEW.md` — the text BB shows on the plugin's detail page.

## Use

Open a thread, open the right-hand panel, choose new tab, then **Beads
issues** under Actions. From top to bottom the tab shows:

1. **Current** (pinned): the bead this thread is working on, as one row that
   opens on its chevron, with Flesh out and Clear.
2. **Toolbar** (pinned): the folder, the Filter menu (types, priorities;
   remembered per folder), and a refresh button.
3. **Every other issue**, grouped by status; this part scrolls. While the
   thread has no bead, each open issue has a play button: it makes that issue
   the thread's bead and sends the agent a message to start on it. An opened
   issue also offers Flesh out, which starts a background agent that fills
   in the issue's description, acceptance criteria and design. It does not
   appear in the sidebar and the thread you are in is not touched; the row
   is marked "fleshing out…" until it stops, and the button opens it.
   An issue with no description shows the Flesh out button on its row.
   An opened issue shows its description, then a folded heading for each
   of acceptance criteria, design, notes, close reason and comments that the
   issue has; each opens on its own chevron.
   Priority and type are small dropdowns on each open issue's row; picking a
   value changes the issue straight away.
   There are two ways to close, each with its own icon and its own
   confirmation. The "Close & commit" button, on the thread's current bead, closes the
   issue and sends the agent a message asking it to commit the work. The
   cross closes an issue without a commit: use it to drop an issue. On other
   open issues it is on the row; on the current bead it is only inside the
   opened issue, so "Close & commit" is the obvious choice there. A closed row has a reopen button instead. Closing the
   thread's current bead also clears it as current.
   The Closed group's heading is always last in the list, with its count
   and a Show/Hide button; closed issues start hidden.
4. **New issue field** (pinned at the bottom): type a title and press Enter;
   the chevron adds type, priority and description.

The agent can set the thread's bead itself with the `beads_set_current` tool,
which BB offers to threads whose folder has a `.beads` directory.

The list refreshes when the tab opens, when you press Refresh, when the BB
window regains focus, and after any change to the issues: one made through
this plugin, or one made by an agent or in a terminal with `bd`.

## Limits of this version

- Issues can be created, closed and reopened, and their type and priority
  changed, but their text cannot be edited and they cannot be deleted from
  the tab.
- The thread's bead is a note kept by BB on the thread; setting it does not
  change the issue's status in beads.
- `bd` runs on the machine the BB server runs on. Threads whose folder is on
  another machine get an explanation instead of a list.

## Settings

- `bd command` — name or full path of the `bd` tool. Change it only if BB
  cannot find `bd`.
- `Flesh-out model` — model id the background agent uses for Flesh out
  (default `claude-fable-5-1`). Empty uses the project's default model.

Reload the plugin after changing a setting.

## Develop

```
npm install --include=dev
bb plugin build        # compile into dist/
bb plugin install .    # register this folder with BB
bb plugin dev          # rebuild and reload on every save
```

`components/ui/` is vendored source owned by this plugin; edit it freely.
