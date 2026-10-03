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
2. **Toolbar** (pinned): the folder, the Filter menu (show closed, types,
   priorities; remembered per folder), and a refresh button.
3. **Every other issue**, grouped by status; this part scrolls. While the
   thread has no bead, each open issue has a play button: it makes that issue
   the thread's bead and sends the agent a message to start on it. An opened
   issue also offers Flesh out, which writes a request to the agent into the
   message box without sending it.
   An opened issue shows its description, then a folded heading for each
   of acceptance criteria, design, notes, close reason and comments that the
   issue has; each opens on its own chevron.
   Every row has a close button, which asks for confirmation; a closed row
   has a reopen button instead.
   Closing the thread's current bead also clears it as current.
4. **New issue field** (pinned at the bottom): type a title and press Enter;
   the chevron adds type, priority and description.

The agent can set the thread's bead itself with the `beads_set_current` tool,
which BB offers to threads whose folder has a `.beads` directory.

The list refreshes when the tab opens, when you press Refresh, when the BB
window regains focus, and after any change to the issues: one made through
this plugin, or one made by an agent or in a terminal with `bd`.

## Limits of this version

- Issues can be created, closed and reopened, but not edited or deleted from
  the tab.
- The thread's bead is a note kept by BB on the thread; setting it does not
  change the issue's status in beads.
- `bd` runs on the machine the BB server runs on. Threads whose folder is on
  another machine get an explanation instead of a list.

## Setting

`bd command` — name or full path of the `bd` tool. Change it only if BB cannot
find `bd`; reload the plugin afterwards.

## Develop

```
npm install --include=dev
bb plugin build        # compile into dist/
bb plugin install .    # register this folder with BB
bb plugin dev          # rebuild and reload on every save
```

`components/ui/` is vendored source owned by this plugin; edit it freely.
