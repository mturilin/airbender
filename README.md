# Airbender (bb-plugin-airbender)

A BB plugin that shows a repository's beads issues in a tab in the right-hand
panel, beside a thread or on the New thread screen.

- `server.ts` and `server/` — the backend. Finds the folder a thread or
  project works in, lists and changes its issues by running the `bend`
  program (see "bend" below), and stores each thread's
  current bead. `server.ts` wires the pieces and maps each request to one
  call. `server/contract.ts` is the typed contract with the frontend;
  `folder.ts` finds the folder and the `bd` and `bend` programs; `bend.ts`
  runs bend, gives the tracker for a folder and turns bend's failures into
  what the tab shows;
  `store.ts` holds the issue operations, each one a call on that tracker
  (it keeps no list itself: bend answers from its own copy of the issues);
  `work.ts` moves an issue through its workflow; `autopilot.ts` starts an
  epic's issues one after another; `sync.ts` reads from bend how the issue sync stands and asks it
  for a sync;
  `github-comments.ts` copies the comments of imported
  GitHub issues, which beads' own sync leaves behind; `github.ts` lists GitHub issues, open and closed, and
  runs `bd github sync` for the ones chosen in the "Import / export GitHub issues"
  window (`app/github-sync.tsx`);
  `current-bead.ts` is the thread's current issue; `issues.ts` turns the
  tracker's issues into the tab's (its names for links, what it keeps in
  labels, and "blocked when every open sub-issue is"); `watch.ts` and `setup.ts`
  are what their names say (setup is buttons over `bend setup`). The rules
  written for agents are in bend (`bend/internal/instructions`).
- `app.tsx` and `app/` — the frontend. `app.tsx` registers the surfaces;
  the **Airbender** tab is `app/panel.tsx` and the files beside it (rows,
  opened issue, groups, new-issue field, menus, setup), and
  `app/composer.tsx` holds the message-box controls; `app/issue-card.tsx`
  is the card an issue shows on hover; `app/epic-band.tsx`
  and `app/use-focus.ts` are epic mode; `app/place.ts` says whether an
  issue belongs to an epic with a branch and whether the folder is on it. Logic without React is
  in `app/issue-model.ts` and `app/quick-tags.ts`.
- `sync/types.ts` — the shapes bend reports the syncing of issues in
  (one sync, the trouble, the helper's state), shared by the server and
  the tab. Syncing itself is bend's (see "Syncing" under "bend" below);
  the plugin's side, `server/sync.ts`, only reads bend's answers and
  starts `bend sync` for the refresh button.
- `shared/` — what both halves use: `constants.ts` (the values they must
  agree on), `tree.ts` (walking sub-issues), and the workflow:
  `workflow.ts` says what a workflow is, `standard-workflow.ts` is the
  standard one (its steps, button labels and wording for agents), and
  `workflows.ts` lists the choices a repository has: Standard, or Simple,
  which is no workflow at all. Which one a repository uses is remembered by
  `server/workflow-choice.ts`. To change how issues
  are worked, change `standard-workflow.ts`; nothing else names a step. These files have no imports,
  so they are safe to bundle on either side.
- `bend/` — **bend**, a Go program for agents to read and change issues
  without knowing which tracker holds them (see "bend" below). It does not
  depend on the plugin or on BB. The tab's backend reads and changes issues
  by running it too, so there is one code path to the tracker; the only
  `bd` commands in the plugin are in `server/github.ts` (the "Import /
  export GitHub issues" window); syncing and setting a repository up are
  bend's (`bend sync`, `bend setup`).
- `*.test.ts` — tests for the logic without React or BB; run `npm test`.
  The server's tests build bend from `bend/` first, so they need Go; where
  it is missing they are skipped.
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
gray "Agree & continue" icon is always there, after them; it sends "Sounds good. Please proceed." BB hides the buttons inside the box in its
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
   a button (an arrow going into a ring) that zooms the list in on it, so only its direct
   sub-issues are listed, as full rows. The band names the epic and its
   back arrow goes up one level. Once every issue under the epic is
   closed, the band offers "Close epic". The band's "Autopilot" switch
   starts the epic's ready issues one after another in this conversation
   (most urgent first); every review stays yours, and it stops and says
   why if an issue gets stuck. After you leave epic mode, a
   "Back to epic" line in the same place takes you back into the epic you
   left. Epic mode is only a way of looking, is
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
   An issue that is not started shows two icons: a play triangle (start),
   and, while the folder is on the main branch, a play triangle with a
   small branch (start in a new branch; always in the "⋯" menu too). The
   second has the agent create a branch named from the issue's id and
   title before anything else; it is refused, with a message box, while
   the folder has uncommitted changes. "Commit & merge" then merges,
   pushes the main branch and deletes that branch.
   "Start in worktree", in the issue's menu, opens a new conversation
   for the issue in a work tree BB makes, cut from your local main branch,
   so several issues can be worked at once. There "Commit & merge" has the
   agent bring main into its branch first, then move main forward and push
   it; after that Airbender archives that conversation, has BB remove the
   work tree, and deletes the branch (the one git change the plugin makes
   itself, and only once the branch is fully on main).
   On an issue with sub-issues the two read "Start epic in branch" and
   "Start epic in worktree" and do something else: they set the branch or
   the work tree up for the whole epic, put the epic at the step "On its
   branch" and enter epic mode, starting no work. They are refused while
   one of the epic's issues is the current issue of any conversation. The
   epic's issues are then started one by one, only in a folder on that
   branch (elsewhere a line says where they are worked), and are only
   committed there. When all of them are closed, the epic band's "Close &
   merge" has the agent merge the branch, and the epic closes.
   An issue takes only the steps its size needs. Starting one has the
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

The agent can set the thread's issue itself with the `airbender_set_current`
tool and move an issue's step with `airbender_workflow_move`. Both are offered to
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

Every step but "Build bend" is a step of `bend setup` (see "bend" below):
the tab asks bend what is in place, asks you to confirm, and runs the same
step a terminal would, so the two never disagree. First of all, where
nothing says it yet, **Choose where the issues are kept**: beads or GitHub
issues, recorded in `.bend.json`. The tab lists and changes the issues of
either; with GitHub issues the beads steps below are not needed, and
"Prepare the issues" is signing in to GitHub.

Later the tracker is switched from the first line of the "⋯" menu
("This project uses … · Switch…"). The window (`app/tracker-switch.tsx`)
says what copying the issues across would do, worked out by the server
(`switchPreview` in `server/github.ts`), and then copies with the same
`bd github sync` as "Import / export GitHub issues" and runs `bend setup
tracker`. Nothing is deleted on either side, so switching back shows the
first tracker's issues as before.

1. **Install beads** — pick a method (install script, mise, Homebrew, npm).
   **Build bend** comes with it: the tab reads and changes issues with the
   `bend` program, built from the `bend` folder of the plugin with Go into
   `~/.local/bin/bend` (the exact command is shown first). Offered when
   bend is missing or older than the plugin needs; where Go is not
   installed the step says so. The "bend command" setting names another
   place.
2. **Set up beads in this folder** — runs `bd init --skip-agents`: the
   issue database, and none of beads' own instructions for agents.
3. **Add Airbender's instructions for agents** — the working rules the
   buttons rely on, added to `AGENTS.md` between
   `<!-- airbender:rules:start -->` and `<!-- airbender:rules:end -->`
   (`bend/internal/instructions`). They are the only instructions about issues: in
   a repository set up the old way the step is called "Replace beads'
   instructions with Airbender's" and also removes beads' generated blocks
   from `AGENTS.md` and `CLAUDE.md` (between beads' own markers, nothing
   else) and beads' hooks for Claude Code and Codex (`bd setup <agent>
   --remove`). It writes no line that loads one file from another
   (`@AGENTS.md`, `@FACTS.md`) and takes out the ones an earlier setup
   wrote; `FACTS.md` is linked from the rules, not loaded. A `CLAUDE.md`
   that is a link to `AGENTS.md` is left as it is, none is created where
   there is none, and for one that is a file of its own you choose: make
   it a link (`--claude link`), or have the same rules written into it
   (`--claude rules`). Beads' own setup for a coding agent is no longer
   offered: its text tells agents to close issues themselves.
4. **Carry saved facts over** — shown while beads holds facts (`bd
   remember`) that `FACTS.md` does not: you tick which go into `FACTS.md`,
   the file agents read standing facts from now (bend looks after it;
   `bend remember` writes there too).
5. **Sync issues to the repository's remote** — runs `bd dolt push --yes`
   and then `bd sync`, for the first time (a sync pulls first and fails on
   a remote that has nothing on it yet). Offered where beads has no remote
   for the issues, or has one that holds none: `bd init` names the git
   origin as the remote and sends nothing. `bd init` leaves the issue database on this computer
   only (it is not in git); this publishes it to the git remote under
   `refs/dolt/data`, and beads commits the remote into
   `.beads/config.yaml` by itself. Afterwards bend syncs the issues
   by itself, every three minutes while it is in use (see "Syncing"
   below), and when you press the refresh button, which also reloads the
   list. When the issues are not being synced, a red bar across the top
   of the list says so and the button turns red; the "⋯" menu says how
   the last sync went.

In a fresh clone whose remote already holds the issues, step 2 reads
**Get this repository's issues** and runs `bd bootstrap --yes` instead.

Steps 1 to 3 and 5 run in a BB terminal you can watch and type into; the
tab reloads when it ends and shows the last output if it failed.

## bend

`bend` is a command-line program for agents, and for the tab: the same
commands whatever tracker a repository uses: beads, or GitHub issues. It is
written in Go, standard library only, and is one program with nothing
beside it. Build it from the `bend` folder (Go 1.24 or later):

```sh
cd bend && go build -o ~/.local/bin/bend ./cmd/bend
bend --help
```

The tab's setup step "Build bend" runs exactly that.

### Setting a repository up from a terminal

`bend setup` gets a repository ready with no BB:

```sh
bend setup                      # reads only: every step, done or missing, and the command for each
bend setup all                  # does every missing step in order, asking as it goes
bend setup tracker --use beads  # one step, its question answered by an option
```

The steps are `tracker` (beads or GitHub issues, recorded in `.bend.json`),
`program` (install beads), `issues` (get the repository's issues on a fresh
clone, or start a database; with GitHub issues, sign in), `instructions`
(the rules for agents in `AGENTS.md`, what a `CLAUDE.md` is to be, `FACTS.md`;
beads' own blocks and hooks taken out), `facts` (carry facts saved in beads
over) and `publish` (the issue database to the repository's remote).

A step asks what it needs and shows what it will do, with the exact outside
command, before doing it. Options answer in advance: `-y` for a yes, and one
option for each choice (`--use`, `--method`, `--keep`). Where nobody is at
the keyboard (an agent, a script) a step never waits: it changes nothing and
ends at once, naming the option that was missing. A step that is already
done changes nothing. `bend setup --json` gives the state to a program; the
tab draws its setup card from it.

Which tracker: a `.bend.json` file at the repository's root decides
(`{"tracker": "github"}` or `{"tracker": "beads"}`, optionally
`"repository": "owner/name"`); without it a `.beads` folder means beads,
and otherwise a remote called origin on github.com means GitHub issues.
For GitHub, sign in with `gh auth login` or set `GH_TOKEN`.

- `bend/cmd/bend` — the program's entry point.
- `bend/internal/tracker` — the common shape of an issue, the `Tracker`
  interface every adapter implements, the kinds of failure, and small text
  helpers (marked sections, links kept as text).
- `bend/internal/beads` — the beads adapter (runs `bd`).
  `bend/internal/detect` picks the adapter from the folder and reads the
  setting file. A new tracker is a new adapter plus a few lines there.
- `bend/internal/github` — the GitHub adapter: where each field is kept
  (labels, marked sections of the description, GitHub's own sub-issues and
  "blocked by"), the connection to GitHub (login, requests, plain words
  for each failure), and an in-memory stand-in for the tests.
- `bend/internal/facts` — standing facts, kept in `FACTS.md`.
- `bend/internal/setup` — the setup steps and their state.
  `bend/internal/instructions` — the rules written for agents (`rules.md`)
  and how they are put into `AGENTS.md` and `CLAUDE.md`.
- `bend/internal/cli` — the command: the table the help and the accepted
  options both come from, reading arguments, text and JSON output.
- `bend/e2e` — tests that start the program: scenarios on a real throwaway
  beads folder, and a recording of everything a fixed series of commands
  prints (`testdata/recorded.txt`; record again with `BEND_RECORD=1`).
- `.agents/skills/bend/SKILL.md` — tells agents when and how to use it.

### Beads issues from a copy on this computer

On a beads repository too, bend answers reads from a copy of the issues it
keeps in the repository's shared git folder (`.git/bend/beads/`), so that a
read does not start `bd`, which takes most of half a second to open its
database and waits behind a running sync:

- **A read from a fresh copy starts no `bd`** and takes a few thousandths
  of a second.
- **The copy knows it is behind** when the small file beads rewrites on
  every change (`.beads/last-touched`) is newer than what it holds; so a
  change made with `bd` directly shows in the next read. It is then reread,
  with one `bd list`.
- **A change through bend goes to `bd` at once**, as before, and its
  answer is reported. Afterwards the copy is reread by a process bend
  starts behind the command, so the next read is quick again.
- **What that file does not show** (an issue deleted with `bd`, a sync run
  by hand) shows when the copy is more than three minutes old: the read
  still answers at once and the copy is reread behind it. A copy more than
  a day old is reread first.
- **Search and "ready" are beads' own answers.** Search always asks `bd`;
  what is ready is asked once after each reread and kept.
- `bend refresh` rereads it now; `bend list --fresh` rereads and lists.
  Deleting the folder is harmless. `BEND_LIVE=1` asks `bd` every time.

The code is `bend/internal/kept` (the copy, which knows no tracker) over
`bend/internal/localcopy` (its files and locks). An adapter says how its
changes are written (beads: straight through) and may give a cheap sign
that its data changed. GitHub issues are answered from the same copy, with
changes queued; see below.

### GitHub issues from a copy on this computer

On a repository whose issues are on GitHub, bend does not ask GitHub for
every command. It keeps a copy of the issues in the repository's shared git
folder (`.git/bend/`, the same for every work tree, never committed):

- **A read answers from the copy**, in a few thousandths of a second, with
  no network.
- **A change is recorded in the copy and sent afterwards**, by a process
  bend starts in the background. With no network it waits and is sent by
  the next sync, in the order it was made.
- **Two things ask GitHub first and need the network**: making an issue
  (only GitHub gives the number), and changing a `step:` or `size:` label,
  which is refused if the issue was moved meanwhile.
- **What others changed comes in with a sync**: after every change here,
  after a read that found the copy more than three minutes old (the read
  itself does not wait), with `bend sync`, and a copy more than a day old is
  reread before a read answers. Once a day everything is reread, which
  drops issues deleted on GitHub.
- **Two sides' changes add up** where they can: different written parts of
  one issue, and labels. Where both changed the same part, the later wins.
- **A change GitHub will never take** goes to `bend refused`, with its
  reason and text; `bend status` says how many changes wait and how many
  were refused.

One known limit: a change can reach GitHub twice if bend is stopped between
sending it and taking it off its list, or if GitHub got the request but its
answer was lost. For a comment that means the comment appears twice.

`BEND_LIVE=1` makes bend ask GitHub directly for every command, as it used
to; `BEND_NO_BACKGROUND=1` stops it starting a sync, or the helper, by
itself.

### Syncing

bend keeps a repository's issues in step with their remote by itself, for
every tracker, with or without the tab (bead-bb-c9l.16):

- **`bend sync`** syncs now, both ways, and says how it ended (synced,
  failed, busy, conflict, stuck), what was sent and what came in; exit
  status 1 when it did not work. With beads it runs `bd sync`, reads what
  was sent from beads' events journal, and works out what came in by
  comparing the issues before and after; with GitHub issues it sends the
  waiting changes and asks what changed.
- **`bend sync --status`** syncs nothing: what the issues are synced with,
  what waits, the last sync, the helper, and what is wrong (`trouble`).
  **`bend sync --log`** lists the syncs, newest first (`--failed` for only
  those that did not work). The log is `sync-runs.json` in the copy's
  folder, so a terminal and the tab read the same one.
- **The helper** is a process bend starts by itself, one for each copy of
  a repository's issues, after any command that was run on purpose. It
  syncs every three minutes and ends when bend has not been used for half
  an hour, when the bend program is rebuilt, or after three failed syncs
  in a row. `bend helper` says how it stands; `stop` ends the one running
  (the next command starts one again), `start` starts one now, `disable`
  keeps it away in this repository, `enable` allows it again.
- **The plugin does not sync.** It reads `bend sync --status` and
  `--log`, starts `bend sync` for the refresh button, and watches the log
  file so that a sync made anywhere shows in an open tab. A read it makes
  only because a file changed is run with `BEND_PASSIVE=1`, which bend
  does not count as being used.

In the code: `bend/internal/tracker/sync.go` is what a tracker's own sync
says, in common words (`Syncer`); `bend/internal/beads/sync.go` is beads'
side of it, and the only place that knows `bd sync`; `bend/internal/kept/
report.go` is the report, the log and the trouble, for every tracker;
`bend/internal/helper` is the helper, which knows no tracker.

It is the same copy that answers for beads (`bend/internal/kept`), with
the queued way of writing switched on: the GitHub adapter says its changes
are queued, and sits under the copy, where it is used to bring issues in
and to carry out one change at a time. A waiting change is kept as what was
asked ("write the plan of issue 12"), and sending it is that same operation
on the adapter, which is why parts and labels from two sides add up.

Two things follow from the copy sitting above the adapter:

- **Links and "what blocks what" are put together by the copy when read**
  (`kept/derive.go`), from each issue's own facts. GitHub reports a closed
  blocker as changed, not the issue that waited for it, so answers cannot
  be kept as GitHub gave them. A test holds the copy's rule to the
  adapter's.
- **Some refusals come a few seconds late.** The copy refuses at once what
  it can see itself: an issue that is not there, a loop of sub-issues, a
  link of an issue to itself, a closed issue started. What only GitHub's
  rules can refuse (linking two issues already linked, say) shows on `bend
  refused` after the change was sent. After a batch of changes, look at
  `bend status`.

For a program that runs bend (the tab does, `server/bend.ts`): `--json`
prints JSON, and a failure as `{"ok": false, "status", "kind", "error"}`
where the kind is one of `refused`, `usage`, `unsupported`, `no-program`
(the tracker's own program is missing), `not-set-up` (the folder has no
tracker) and `not-signed-in`; `bend version` gives a number that goes up
when the commands or the JSON change; `status --quick` asks the tracker
nothing; `--with-body` adds each issue's description and requirements as
one text, which `write <id> body` takes back; `edit` adds and removes
labels and kept data; `sync --json` gives one sync as an entry (how it ended, the issues
it sent and those that came in), `sync --status --json` how the syncing
stands and what is wrong; `BEND_BD` names the beads program and `BEND_ACCEPT` the
trackers the caller can work with.

Tests: `cd bend && go test ./...`. They are skipped where `bd` is not
installed. The GitHub adapter is tested offline against the stand-in and a
stand-in web server; `bend/e2e/github_test.go` runs every command against
real GitHub and is skipped unless a scratch repository is named:

```sh
cd bend && BEND_GITHUB_SCRATCH=mturilin/bend-scratch go test ./e2e -run GitHub
```

(`github_test.go` asks GitHub directly; `github_copy_test.go` goes through
the copy.)

It creates and then deletes real issues there, and refuses any repository
without "scratch" in its name.

The Airbender tab runs bend for every read and change of an issue
(`server/bend.ts`, `server/store.ts`), and takes whatever tracker bend
finds for the folder (bead-bb-c9l.6). It asks bend what the folder has
(`bend status --quick`: the tracker, the repository, its kinds of link,
and whether changes are queued for a hosted tracker) and follows that:

- the beads program is asked for only where the tracker is beads;
- where changes are queued (GitHub issues), the sync log window lists
  the changes GitHub refused (`bend refused`), and a list is never made
  to wait for GitHub;
- the link picker offers the tracker's kinds;
- what an agent is told names `bend` in every repository, beads too
  (bead-bb-c9l.10): the step messages (`shared/standard-workflow.ts`), the
  tools' texts (`server/agent-tools.ts`) and the rules that `bend setup
  instructions` writes (`bend/internal/instructions/rules.md`) exist once.
  The rules carry a version. A block the owner changed by hand that is
  from an earlier version is reported as "behind", and
  `bend setup instructions --rules replace|keep` settles it: replace saves
  the earlier text under the repository's git folder first, keep marks the
  owner's block as compared with the current version.

An epic's branch is kept with the issue as free-form data; on GitHub that
is one hidden line at the end of the description
(`<!-- bend:data {"branch":"…"} -->`).

Still beads-specific in the tab: the "Import / export GitHub issues…" window (beads'
own mirroring, offered on beads only), the "bd command" setting, and
switching a repository's tracker, which the tab cannot do yet
(bead-bb-c9l.18; from a terminal: `bend setup tracker --use github`).

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
- `GitHub token` — optional. "Import / export GitHub issues" (the tab's "⋯" menu) uses
  the `gh` command's sign-in (`gh auth token`) for each run when this is
  empty, storing nothing. Set a personal access token here to use that one
  instead, for example one that can only read and write this repository's
  issues. A
  secret: BB keeps it in a file of its own on this computer. It is handed
  to `bd github sync` for each run and is never written into the
  repository (beads' own `bd config set github.token` would put it in
  `.beads/config.yaml`, which is in git here).

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
(`server/issues.ts`, `server/bend.ts`, `bend/internal/instructions/rules.md`, `app/issue-model.ts`,
`app/quick-tags.ts`, everything in `shared/`) must not import React, the BB SDK or `@/...` paths.
A new source folder must be added to `include` in `tsconfig.json`.

`components/ui/` is vendored source owned by this plugin; edit it freely.
