# Airbender — Product Requirements

This is the source of truth for what the product does. It is written so the
product could be rebuilt on a different platform from this document alone.
It describes behaviour, not how it is built.

It describes only what is built. Requests that are not built yet are kept as
issues in the tracker; a requirement enters this document in the same commit
as the code that implements it.

Every requirement comes from the product owner. The issue that decided it is
given in brackets, for example `[pp7]` means issue `bead-bb-pp7`; the reasons
and the history are on that issue. `[—]` marks a decision made in conversation
that has no issue of its own. Behaviour the owner did not specify is kept
apart, in "Unspecified details" at the end.

## What it is

Airbender is a panel inside the coding-agent app, next to a conversation with
an agent. It shows the issues of the repository that conversation is working
in, lets the owner manage them, and connects them to the agent: start the
agent on an issue, have an agent write an issue up, and have the agent commit
the work when the owner accepts it.

Issues are kept by the beads issue tracker, inside the repository. The panel
is a view of that tracker, not a second tracker.

## Why it exists

- Issues are most useful beside the agent doing the work. Without the panel,
  seeing or changing an issue means leaving the conversation for a terminal.
- The owner decides what is worked on and when it is done. The agent does the
  work. The panel is where those two meet.
- What was asked for, why, and what was decided must survive the
  conversation. It is written onto the issue, so the issue is the record.

## Where it lives

- In the panel on the right of a conversation, and on the new-conversation
  screen. `[02g]`
- **Not** in the app's left sidebar. That sidebar belongs to the whole desktop
  session, not to one project, so a project's issues do not belong there.
  `[02g]`
- It shows the issues of the folder the conversation is working in. On the
  new-conversation screen it shows the issues of the selected project.
  `[02g]`

## Layout

Bands, top to bottom. `[pp7]`

1. **Toolbar** — the repository folder, a refresh button and, at the right
   end, a "⋯" menu for the choice of workflow (see "Choosing the workflow")
   and for setup (see "Getting a folder ready"). Stays in place. `[8j6]`
2. **Current epic** — only in epic mode (see "Epic mode"): the epic the
   list is zoomed in on, with a back arrow. Stays in place. `[ha9]`
3. **Current** — the issue this conversation is working on. Stays in place
   when the list scrolls.
4. **Groups** — all other issues. The only part that scrolls.
5. **New issue** — an entry field that is always there, fixed at the bottom.

Rules for the layout:

- **An issue id is shown in the monospace font, and wherever it stands on a
  line with other text it is lined up with that text on the baseline**, the
  line the letters stand on. It must never be centred against the other
  text box by box: monospace letters sit at a different height inside their
  line than the letters of the ordinary font, so centred they look
  misaligned. How to do it: put the id and the text beside it together in
  one row that is aligned on the baseline; an icon on the same line stays
  outside that row and is centred against it. The id is left exactly on that
  baseline, with no nudge up or down, even where it seems to ride a little
  high: that is an illusion of the monospace letters. `[fmg]`

- Current is a group like the others and looks like them: a heading and one
  row. It is not a large card. `[pp7]`
- The current issue is displayed more prominently than the other rows: its
  row has a box around it with a light green background. On hover the green
  gets a little stronger; it must stay green and never turn gray-green.
  `[6ui]`
- Every issue is one row with a chevron on the left. Opening the chevron
  shows the rest. Rows start collapsed, except an issue that has sub-issues
  (see "Sub-issues"). A long issue must never push the rest of the panel
  down. `[pp7]`
- The Current row is the same width as the rows in the groups. `[d37]`
- The refresh button is small and shows only an icon: two circular arrows.
  It does not say "Refresh". `[pp7]`

## Getting a folder ready

When something the panel needs is missing, the panel offers to set it up.
`[80e]`

- **Setting a repository up does not need the panel.** The same steps can
  be run from a plain terminal with `bend setup`; the panel's setup shows
  the state that command reports and runs its steps, so the two never
  disagree. `[c9l.9]`
- **Airbender is set up only from the repository's main folder, on the
  main branch.** In a worktree, or in the main folder on another branch,
  setup changes nothing in the repository and says where to set it up
  instead; in a worktree whose main folder has Airbender's instructions
  but has not committed them, it says to commit them there. Installing
  beads still works anywhere. `[25p]`
- **Setup offers to commit the files it writes** (`.bend.json`,
  `AGENTS.md`, `CLAUDE.md`, `FACTS.md`) right away, as a step of its own,
  confirmed first. It commits those files only, and nothing else; it does
  not push. `[25p]`
- **Every file Airbender or beads touches is in exactly one of three
  groups, and setup leaves nothing in between**: once a repository is set
  up, git shows nothing of Airbender's or beads'. `[cnv]`
  - **Committed**, part of the repository: `.bend.json`, `AGENTS.md`,
    `CLAUDE.md`, `FACTS.md`, beads' tracked files (`.beads/config.yaml`,
    `metadata.json`, `README.md`, `.beads/hooks/`, `.beads/.gitignore`)
    and the lines beads adds to `.gitignore`.
  - **Ignored**, this computer's only: the issue database, locks, sync
    state, bend's copy inside `.git`, `.claude/settings.local.json`.
  - **Removed**: beads' own setup for the coding agents (its hooks for
    Claude Code and Codex, the files they leave empty, its Codex skill)
    and its blocks in the instructions files.
- **Beads' journal is switched on while setting up**, so a later sync
  changes no tracked file. `[cnv]`
- **The first step is choosing where the issues are kept**, beads or GitHub
  issues, where nothing says so yet. The choice is recorded in the
  repository. The panel offers it like any other step. `[c9l.9]`
- **Airbender is for repositories of one's own.** Before anything is set
  up, setup checks the folder's remote on GitHub. Where it is a fork, or a
  repository the owner's GitHub account cannot push to, setup warns that
  this looks like someone else's project: Airbender adds its files to the
  repository and they get committed, so in a contribution they would end
  up in the owner's pull requests. It offers two ways on: **keep the
  issues in GitHub issues in a repository of the owner's**, named by the
  owner, or **set up here anyway**. Where it cannot tell, it says nothing.
  No question is asked in a repository of one's own. `[dof]`
- **Issues kept in a repository of the owner's, for someone else's
  project:** the setting file is kept out of git in that copy of the
  repository only, and no instructions for agents are added to the
  project. `[dof]`
- **Three things can be set up**, in this order:
  1. **Install beads**, when the tracker's program is not on the computer.
     The owner **chooses the way of installing each time**, from the ways
     available on that computer.
     **Install bend** goes with it: when the `bend` program is missing, the
     panel says so, because without it there are no issues, and offers to
     install it where commands are found. On Linux and macOS, on Intel/AMD
     or ARM64, setup downloads the matching release and verifies its
     SHA-256 checksum before installation; Go is not required. Source
     builds remain available for other platforms. It runs in a terminal
     the owner can watch, when the owner presses it. `[c9l.4]` `[bk2]`
  2. **Set up beads in this folder**, when the folder has no issue database.
     This is the most important one. **It sets up the issues only, and none
     of the tracker's own instructions for agents.** `[c9l.8]` **Beads asks
     no questions in the terminal**: the owner is set up as the
     repository's maintainer. `[dof]`
  3. **Add Airbender's instructions to the agents' instructions file**, as a
     separate command: the working rules the panel's buttons rely on. The
     owner either enables it or skips it. Where the folder has a
     separate instructions file for Claude Code, the step **also brings
     that file to the same rules** (see below for how), and counts as done
     only when both are in place. **It does not create that file.**
     `[0bk]` `[c9l.12]`
- **Airbender's instructions are the only ones about issues that a
  repository gives its agents.** The tracker's own, which tell an agent to
  close an issue when it is done, are not set up, and nothing is shown to
  an agent at the start of a session beyond the instructions file.
  `[c9l.8]`
- **A repository that was set up with the tracker's own instructions can
  be switched over in one step**, confirmed first, which says what it will
  remove. It removes the blocks the tracker generated and the tracker's
  hooks for the coding agents, and changes nothing else in the owner's
  files. `[c9l.8]`
- **The tracker's own setup for a coding agent is no longer offered.**
  `[c9l.8]`
- **Standing facts are kept in a file of their own**, beside the
  instructions file, which agents add to. `[c9l.8]` **The instructions
  name it as a link, the place to store facts and memories; it is not
  loaded into an agent's prompt.** `[c9l.12]`
- **The rules live in the agents' instructions file only.** Setup writes
  no line that loads one file from another, and takes out the ones it
  wrote before. `[c9l.12]`
- **The file Claude Code looks for (CLAUDE.md):** where there is none,
  none is created. A link to the agents' instructions file is the normal
  arrangement and is left as it is. A file of its own is the owner's
  choice: make it such a link, or have the same rules written into it as
  well. `[c9l.12]`
- **Facts that were saved in the tracker are shown to the owner once, to
  choose which are carried over** to that file. `[c9l.8]`
- **What is missing is offered in the middle of the panel**, not hidden in a
  menu, each with its button and a **Skip**.
- **After Skip, a step is only in the menu.**
- **A "⋯" menu in the top right corner lists all of them**, so any can be
  started by hand. **A step that is already done, or is not possible yet, is
  greyed out.**
- **Installing and setting up the folder run in a visible terminal**, so
  the owner can watch, and answer what an installer asks.
- **What is still missing is re-checked on every refresh. What was found in
  place is not checked again**: the panel does not try to notice that
  something was removed afterwards.

## Keeping the issues on the repository's remote

- **The issues are not left on one computer.** Where a folder's issues are
  synced nowhere, the panel says so and offers to sync them to the
  repository's remote; from then on the product keeps them in sync by
  itself. `[0bz]`
- **Syncing leaves no branch of its own on the remote.** The issues go to
  the remote under a ref of their own, and nothing a sync does shows up on
  the remote as a branch or a "recent pushes" notice. `[7lb]`
- **Syncing is `bend`'s, for every tracker; the panel only shows it.**
  `bend` runs the syncs, keeps time, keeps the log and works out what is
  wrong; the panel shows the state, the log and the trouble, and its
  refresh button asks `bend` for a sync. A repository is synced the same
  when it is worked from a plain terminal with no panel open. `[c9l.16]`
- **`bend` keeps time with a helper process of its own.** Any `bend`
  command starts it for the repository when it is not running. It syncs
  every three minutes, and ends by itself when `bend` has not been used
  for half an hour. `[c9l.16]`
  - **"Used" means any command run on purpose.** A read the panel makes
    only because it was told the issues changed does not count.
  - **`bend helper stop` ends the one that is running**, and nothing more:
    the next `bend` command starts one again. **`bend helper start`**
    starts one now. **`bend helper disable`** ends it and keeps it from
    being started in that repository; **`bend helper enable`** allows it
    again.
- **Nothing of one tracker shows above the tracker layer.** What a
  tracker's own sync has to say is said in common words (is syncing
  switched on and with what; how one sync ended, what was sent, what came
  in, or "not known"); the helper, the commands, the log and the panel
  know nothing else of it. `[c9l.16]`
- **A sync that does not work is shown prominently**, because it can lose
  work: a bar across the top of the issue list says what is wrong, for as
  long as it is wrong, and the sync log can show only the syncs that
  failed. `[c9l.16]`
- **Syncs of one repository never run at the same time**, whoever starts
  them: there is a lock, and they happen one after another. `[0bz]`
- **On another computer**, a copy of the repository whose issues are on
  the remote is offered them, in place of an empty start. `[0bz]`
- **Hovering the refresh button shows the time of the last sync and its
  result**, for example whether it was one issue's update. `[6a9]`
- **The menu has a sync log**: a small window with all the syncs and what
  each did, for troubleshooting. `[6a9]`
- **In the menu, the sync log and the sync's state are one line**: "Sync
  log…" with the state at its right, as a setup step has its "installed":
  synced one minute ago. `[6a9]` `[c9l.18]`
- **That line is the menu's second**, right under the line that names the
  tracker. `[c9l.18]`
- **The syncing is a part of its own that can be replaced**: the panel
  does not assume one way of syncing. There will be several, the next for
  GitHub. `[6a9]`
- **Refresh and sync are one control**: the refresh button. **The issues
  are synced by themselves every few minutes**, so no time is shown. **The
  button is marked as an error, red, when the issues are not being
  synced.** The rest of the information is in the bar above the list and
  in the menu. `[0bz]` `[c9l.16]`

## The groups

In this order: `[02g]` `[a28]`

- **In progress** — work has started.
- **Ready** — open, and not waiting on any unfinished issue.
- **Blocked** — waiting on at least one unfinished issue.
- **Someday** — set aside for later: neither ready nor closed, to be
  revisited. An issue in Someday stays there even when it waits on
  another. `[26g]`
- **Other** — any other status.
- **Closed** — "Finished or cancelled."

Rules:

- The current issue appears only in Current, not also in its status group.
  `[pp7]`
- The Closed heading is always shown, with its count. Its issues are hidden
  by default. A Show / Hide button on the heading reveals and hides them.
  `[a28]`
- **Someday is folded away the same way**, collapsed with a Show / Hide
  button, and shown only when it holds issues. `[26g]`

## Categories

An issue can have a category, which says what area it belongs to. `[7ct]`

- **One category per issue, or none.**
- **Category names are always lower case.** Whatever is typed is stored and
  shown in lower case.
- **The list of categories grows as it is used**: a category is picked from
  the ones already used in the repository, or a new one is typed.
- **It is set on the issue's row**, next to priority and type. For a
  sub-issue's lean row it is set inside the opened sub-issue.
- **It can be set in the new-issue form.**
- **A new sub-issue inherits its parent's category**, and can be changed
  afterwards.
- **The filter can narrow the list by category.**

## The filter

- One filter control, on the **Ready heading**, beside the grouping
  control. It filters by **type**, by **priority** and by **category**.
  `[pp7]` `[7ct]` `[aze]`
- Filtering hides issues. It does not regroup them. `[pp7]`
- The filter never hides the current issue. `[pp7]`
- The filter is remembered. `[pp7]`
- Showing closed issues is not part of the filter; it is the Closed heading's
  own button. `[a28]`

## Grouping the Ready issues

- Besides filtering, the **Ready** group can be **grouped**: divided into
  sub-groups by **priority**, by **type** or by **category**. `[aze]`
- **Filter and grouping are both kept.** Filtering hides issues; grouping
  arranges the ones that are left. `[aze]`
- **Only the Ready group is divided.** The other groups stay as they are.
  `[aze]`
- **One grouping at a time**, or none. `[aze]`
- **Each sub-group can be collapsed.** `[aze]`
- **The grouping control sits on the Ready heading**, the group it changes.
  It is a menu in the product's own style, not the browser's dropdown.
  `[aze]`

## An issue row

This describes a top-level row. A sub-issue's row is leaner and is described
under "Sub-issues".

Collapsed, a row shows the title, the issue id, its priority, its type and
its category.

- **Priority and type are changed right on the row**, for open issues.
  `[ssf]`
- **Clicking the issue's id copies it** to the clipboard. `[c58]`
- **It also shows the step of the workflow the issue is at**, and one main
  button for that step. See "The workflow". `[e2b]`
- **That button is small and nimble** on every row but the current issue's,
  so that it fits in the row and does not make it bigger. `[q9v]`
- **Besides that button, a row has one "more" menu, three dots**, and
  nothing else, because closing is not the most frequent thing done to an
  issue. The menu holds: make current (or release), edit, add sub-issue,
  move to, link and close. `[l3m]` It also holds **"Move to Someday"**,
  or **"Back to Ready"** for an issue in Someday. `[26g]`
- **The button that opens an issue with its sub-issues stays on the row**,
  next to the menu; it is not moved into the menu. `[l3m]`
- **Edit, move to and link, chosen from the menu, open the issue** and are
  done there. `[l3m]`
- **For a closed issue the menu holds reopen.** `[l3m]`
- **Every action in the menu is also inside the opened issue**, so each can
  be reached in two ways. `[l3m]`
- **Each entry of the menu has an icon.** `[l3m]`
- **Workflow moves are not in the menu.** `[l3m]`
- **A sub-issue's row has no menu.** `[l3m]`
- Closing is described under "Closing".

## An opened issue

Opening a row shows:

- The description. **A long description is cut short**, to about four lines,
  with "View more". View more opens the details window on that issue, where
  the whole description is shown. `[5qt]`
- **Acceptance criteria, design, notes, close reason and comments** — each
  under its own heading, **collapsed to start**, opened on its own chevron.
  Parts that are empty are not shown. `[un8]`
- **When the issue was created and when it was last changed**, in the
  bottom right corner of the issue's card in the list; a closed-up card
  shows a short date, like 10/15/26. `[tj4]`
- An **Edit** button, for open issues. It turns the title and the description
  into a form with Save and Cancel. Clicking a title does not edit it; it
  opens the issue. `[vve]`
- **The owner's other moves at the issue's step**: send back, skip, and
  marking an agent's step as done (see "The workflow"). `[e2b]`
- **The buttons are always in view**, also where the opened issue's text is
  too long for its space and scrolls: only the text scrolls. `[l3m]`
- **The buttons inside an opened issue are lean and quiet**: little vertical
  padding, and less prominent than ordinary buttons, with no sharp border,
  so they do not take much space or attract too much attention. `[zty.1]`

## Links between issues

- The tab supports the tracker's **own kinds of link between issues, and
  nothing additional**: blocked by, discovered from, related, tracks, until,
  caused by, validates, supersedes. `[zty.4]` Where the issues are GitHub
  issues, only the kinds GitHub issues have are offered: blocked by,
  discovered from, related. `[c9l.6]`
- An opened issue has a **Link** button. It opens a small search box, like
  "Move to", with a dropdown of the kinds, starting on "blocked by".
  `[zty.4]`
- The box reads as a sentence: "This issue — blocked by — the issue you
  search for". A **swap button** turns it round: "the issue you search
  for — blocked by — this issue". `[zty.4]`
- An opened issue shows its links on **one "Links" line, as chips**: the
  kind and the other issue's title. Links recorded on this issue and links
  from other issues that point at it are both shown. `[zty.4]`
- **Clicking a chip opens that issue. A small × on hover removes the link.**
  `[zty.4]`
- Rows and the new-issue form are not changed by this. Nothing is linked
  automatically. `[zty.4]`
- Where an issue is tagged "blocked", the tag's **tooltip names what it is
  waiting for**. Blocked issues are not otherwise marked more strongly.
  `[zty.4]`
- **An issue whose sub-issues are all blocked is blocked too.** If even one
  of its sub-issues can be worked on, it is actionable and is not blocked.
  `[zty.4]`
- **A sub-issue of a blocked issue is blocked too**, as in the tracker
  itself. `[zty.4]`

## Sub-issues (epics)

An issue can contain other issues, and those can contain more, to any depth.
`[5qt]`

- **Any issue can hold sub-issues.** The type "epic" is only a label.
- **A sub-issue is shown indented under its parent**, whatever its own
  status. It does not appear in the status groups.
- **The panel shows one level only**: under a parent, just its direct
  sub-issues.
- **An issue's chevron opens its description and its sub-issues together.**
  For an issue that has sub-issues the chevron is open by default.
- **Every issue has a details (maximize) button**, and the same in its
  menu. It opens a modal window showing that issue, with its sub-issues one
  level deep if it has any. `[2oy]`
- **The window is one window that is moved through**, not windows on top of
  each other. Pressing details on a sub-issue inside it shows that sub-issue
  with its own sub-issues. A clickable path at the top goes back up. This is
  how deeper levels are reached: a hierarchy browser.
- **The window is always the same size, and rather large.** Its size does
  not depend on how many sub-issues the issue has.
- **Adding a sub-issue in the window stays in the window.** The window has
  its own new-issue field; "Add sub-issue" pressed inside the window uses
  that field. "Add sub-issue" pressed in the panel uses the panel's field.
  Neither sends the owner to the other.
- **The window can do everything the list can**: open an issue, edit it,
  change its type and priority, cancel it, move it through its workflow,
  add a sub-issue, and drag to re-nest. Starting the agent closes the
  window.
- **Drag and drop.** Every issue has a drag anchor: a grip on its row that
  the issue is dragged by. Dragging an issue onto another makes it a
  sub-issue of that one. Dragging a sub-issue onto a group heading or onto
  empty space in the list moves it out to the top level.
- **Move to.** An opened issue has a "Move to" button, for moving it quickly
  to a new parent without dragging: it helps when there are many issues and
  dragging is not possible. It opens a small search field with fuzzy
  matching over the issues; picking one moves the issue inside it. For an
  issue that has a parent, "Top level" is offered there too, which moves it
  out.
- **Add sub-issue.** An opened issue has an "Add sub-issue" button. It does
  not add a second place to type: it selects that issue as the parent in the
  new-issue field at the bottom and puts the cursor there. The row must not
  get its own text field; that makes the panel too busy.
- **Closed sub-issues of an open parent stay visible**, struck through.
- **Sub-issue rows are leaner than top-level rows and look different**, so
  the two are easy to tell apart:
  - the block of sub-issues has a background only slightly darker than the
    rows around it: a slight difference, not a strong one;
  - a rail runs down its left edge;
  - each sub-issue is one compact line, about half the height of a
    top-level row;
  - this lean row is for the panel only. **In the details window sub-issues
    are full-size rows**, the same as normal issues in the panel, because
    the window has the room; `[zty.2]`
  - a sub-issue row has no buttons, not even on hover. Its step's button,
    make current, cancel and the way into the details window are inside the opened
    sub-issue. Only the drag anchor appears while the pointer is on the row.
  - in an opened open sub-issue, **the button that starts work is the first
    button**. `[uca]`

## Epic mode

It is called "epic mode" everywhere the owner sees it. `[0ai]`

With a large epic, the owner can zoom in on it: the panel then shows only
that epic's issues, and the current issue is picked from among them. `[ha9]`

- **A band names the current epic**, between the toolbar and Current. Beside
  the epic is **an arrow back**, which leaves it, like getting out of a
  folder. `[ha9]`
- **Resting the pointer on the epic's id shows the same card** as the
  current issue's id shows in the main window. `[ha9]`
- **One level at a time.** The list shows the epic's direct sub-issues; a
  sub-issue that has sub-issues of its own shows them under it as usual and
  can be zoomed in on in turn. `[ha9]`
- **It is only a way of looking**: the panel shows just the issues inside
  the epic. Nothing about any issue changes. `[ha9]`
- **It belongs to the conversation and is remembered.** Another conversation
  can go into the same epic, or a different one, as it wants. `[ha9]`
- **Only an issue from the epic can be current in epic mode.** The epic
  itself counts. `[ha9]`
  - If the current issue is not from the epic, epic mode cannot be entered.
  - If, in epic mode, a different issue from outside becomes current, the
    panel leaves epic mode when it notices.
  - **Entering while the epic itself is current deselects it**: nothing is
    current then, and the owner picks the next issue from the epic.
  - Going out of epic mode keeps the current issue; the owner can go back
    in. There is no limit on going in and out while these conditions hold.
- **The current issue is the sub-issue**, not the epic. `[ha9]`
- **When all the tasks of the epic are done, the band has a button to close
  the epic.** `[ty5.1]` For an epic that has a branch of its own the
  button is "Close & merge" (see "The workflow"). `[ty5.2]`
- **After leaving epic mode for a moment, a button returns to the epic that
  was left**, without looking for it among all the issues. `[fmg]`
- A new issue created in epic mode goes into the epic unless the owner
  chooses otherwise. The details window stays as it is. `[ha9]`
- **Autopilot: an epic with many sub-issues can be worked one issue after
  another without the owner starting each one.** `[8ff]`
  - It is the supervised kind: **every review stays the owner's**. The
    issues are only strung together. (A kind where the reviews are
    automated too is wanted later, built on this one.)
  - It is turned on in epic mode, for that epic in that conversation.
  - Whenever the conversation is on no issue, the epic's next ready issue
    is started; when that issue is closed, the next one starts by itself.
  - **It never starts an issue in Someday**, and an epic whose only open
    sub-issues are in Someday has nothing left to do. `[26g]`
  - **A stuck issue makes it fail fast**: it stops and tells the owner that
    it could not do it, and the owner goes on by hand. It is deliberately
    not persistent for now.

## Creating an issue

- The entry field at the bottom: type a title and press Enter. `[pp7]`
- A chevron beside the field reveals type, priority and description, for
  writing a full issue. Both the quick way and the full way are supported.
  `[pp7]`
- **Tags typed in the title set type, priority and category**, without
  opening the rest of the form: `#` and a type (`#task`, `#bug` and so on)
  sets the type, `#p0` to `#p4` sets the priority, and `$` and a name sets
  the category. `[ky8]` **`#someday` creates the issue in Someday.**
  `[26g]`
- **The tags auto-complete.** Typing `#` or `$` offers the matching types,
  priorities, or categories in use, and one can be picked to complete the
  tag. `[ky8]`
- **A parent can be selected there**, so the new issue is created inside
  another issue. "Add sub-issue" on an issue selects it for you. `[5qt]`
- **After a sub-issue is added in the panel, the parent is cleared.**
  `[zty.5]`

## Current

One conversation works on at most one issue at a time: its current issue.

- The Current group is first, above everything else. `[pp7]`
- **Every open issue can be made current**, from its row's menu and from a
  button inside the opened issue, marked with a target icon. That only
  makes the issue the conversation's current one. It is different from
  doing the issue's next step: it does not move the workflow and does not
  start the agent. `[l3m]`
- **On the current issue the same control makes it non-current.** `[l3m]`
- These two affect only which issue is current, never the workflow
  directly. `[l3m]`
- **Making an issue current asks for confirmation only when another issue
  is current and would be replaced.** The confirmation speaks of the switch
  as something that will happen, not as something done. `[l3m]`
- **The agent is let know with a short message** that the current issue
  changed. `[l3m]`
- **A closed issue stops being current**, however it was closed: from the
  panel, by the agent, or from a terminal. The panel must show this on its
  own, without the owner pressing refresh. `[p49]` `[m4b]`

## Choosing the workflow

**The owner chooses how issues are worked: Standard or Simple.** `[8j6]`

- **Standard**: every issue goes through the steps under "The workflow".
- **Simple**: no workflow at all. There is no step, no apply, no "not
  started" or "review plan"; nothing. An issue can be made current,
  released and closed, and that is all: fully manual. `[8j6]`
- **The choice is made in the toolbar's "⋯" menu**, since it is not made
  often. It can be changed at any time. `[8j6]`
- **The choice belongs to the repository.** Each repository remembers its
  own. `[8j6]`
- **A work tree continues its repository's workflow.** `[8j6]`
- **A repository that has never chosen is on Standard.** `[8j6]`
- **Switching keeps each issue's step.** On Simple the step is not shown;
  back on Standard the issue is where it was. `[8j6]`
- **On Simple, make current, release and close are prominent buttons on the
  issue's row, not entries in its menu.** `[8j6]`
- **On Simple the agent is not to move issues through steps**: what it is
  told about steps says they exist only on Standard, and a step it reports
  anyway is refused in plain words. `[8j6]` `[8fm]`

Everything under "The workflow", and every mention of a step or a step's
button elsewhere in this document, applies on Standard only.

## The workflow

**On Standard, every issue goes through a fixed sequence of steps to be
closed.** At each
step it waits either for the agent or for the owner. `[e2b]`

The steps, in order: `[e2b]`

1. **Not started** (owner) — nobody has started on the issue yet. Every new
   issue begins here.
2. **Define** (agent) — write up what is wanted, why, and what "done" means.
3. **Review definition** (owner) — is the issue properly defined?
4. **Plan** (agent) — work out how to do it and write the plan down.
5. **Review plan** (owner) — is the plan good?
6. **Implement** (agent) — do the work.
7. **Agent review** (agent) — the agent reviews the work.
8. **Human review** (owner) — the owner validates the work.
9. **Apply** (owner) — the owner chooses how the accepted work goes into
   git: **Commit**, or **Commit & merge**. `[0uh]` `[7h1]`
10. **Commit**, or **Commit & merge** (agent) — the agent does what was
    chosen. `[7h1]`
11. Then the issue is **closed**.

**An issue takes only as many of these steps as it needs.** `[4mb]`

- **An issue that is not started is started with an icon, without text**,
  a play button. `[4mb]` `[jqn.1]`
- **Beside it is a second icon, for starting the issue in a new branch**:
  also a play button, with two dots and a small arrow. `[jqn.1]`
  - Started that way, the issue's work is done on a branch of its own, in
    the same folder and conversation, and merged at the end.
  - The branch is named from the issue's id and a short form of its title.
  - **That icon is shown only while the folder is on the main branch; the
    same command is always in the issue's menu.**
  - **A branch cannot be started over uncommitted changes.** Pressing it
    then starts nothing and shows a message box saying there are
    uncommitted changes and they must be committed before starting a
    branch.
  - After "Commit & merge" the main branch is pushed and the issue's branch
    is deleted, here and on the remote.
- **An issue can also be started in a work tree of its own**, for working
  on several issues in parallel. `[ak0]`
  - It opens **a new top-level conversation** for that issue, in a work
    tree and on a branch of its own; the agent works there. The
    conversation it was started from is left alone.
  - The app chooses where the work tree is kept.
  - **It is started from the issue's menu**, not from the row. Its icon is a
    play button with a little fir tree beside it.
  - After it is started, the panel goes to the new conversation, **and the
    panel is open there**.
  - Issues being worked in another conversation are not marked.
  - **Landing:** at "Commit & merge" the agent first brings the main branch
    into its own branch and settles conflicts in its work tree; if it
    cannot, the issue goes back to the work. Then the work goes onto the
    main branch, which is pushed.
  - **Then everything is closed**: the conversation is archived, the work
    tree removed, the branch deleted. To keep chatting, the owner opens
    another conversation themselves.
- **Inside an opened issue, the two buttons have their icon and the text
  "Start in branch" and "Start in worktree".** `[o3d]`
- **An epic can be started in a branch or in a work tree**, for all of its
  issues together. `[ty5.2]`
  - On an issue that has sub-issues the two commands read **"Start epic in
    branch"** and **"Start epic in worktree"**, and have icons of their
    own, so that it is clear they mean something different: **just a
    branch**, and **just a fir tree with two triangles**, without the play
    button.
  - Starting that way **creates the branch or the work tree and activates
    epic mode**. No work is started: the epic's issues are started one by
    one. The plain start on an epic keeps its meaning: the agent works the
    whole epic in one go.
  - **It can only be started while none of the epic's issues is being
    worked on**, that is, while none of them is the current issue of any
    conversation. Otherwise nothing is started. Nothing else is checked:
    uncommitted changes are not looked at for this, so an epic can be
    started in a work tree from a main branch that has unfinished work on
    it. An issue that was started, released and left half-done can
    therefore overlap with the epic's work; that is accepted.
  - **Once an epic has a branch, its issues are worked on only in a folder
    that is on that branch.**
  - **Its issues do not propose to merge, only to commit.**
  - **An epic opened in a work tree in a parallel conversation shows it**:
    "worktree" on the epic, which takes the owner to that conversation.
    `[ty5.2]` It is not a boxed tag, which looked too much like a button,
    and an epic on a branch carries no tag: **the branch is shown beside
    the folder's path**, as the branch icon and its name, and **in a work
    tree the same place says "worktree", with the fir tree icon**.
    `[ty5.3]`
  - **When all its issues are closed, the epic has the button "Close &
    merge"**: its branch is merged, and the epic is closed. For an epic in
    a work tree, everything is then closed as for a single issue.
- **The agent sizes the issue first**, and says which size in one line.
  The sizes are T-shirt sizes: `[4mb]`
  - **S, small**: definition, the work and the agent's own review in one
    go; the owner sees it once, at the end.
  - **M, medium**: the definition and the plan come together, for one
    review by the owner, then the result.
  - **L, large**: every step, as listed above.
- **The size is shown on the issue as a dropdown once it has one**; an
  issue without a size shows nothing. **The owner changes the size there**,
  and the agent then takes that size's path from where the issue is. `[4mb]`
- **Issues are sized in the background** when they are created and when
  they change, by an agent of their own, without the owner's conversation.
  `[zkc]`
  - Every change to the issue counts.
  - A size the owner chose themselves is never overwritten.
  - An issue that has started is not re-sized; the owner decides.
  - All issues are sized, whoever created them.
  - An agent may size an issue when it creates it; it knows more about it
    than a background agent.
  - It runs on a small, cheap model to begin with, which can be changed.
  - It can be turned off. The switch and the model are on the app's own
    settings page for the product, and the panel tells the owner where
    that page is.
  - **Each issue's menu has a command to trigger the sizing by hand.**
- **A pure question does not need an issue**: asked in the conversation, it
  is answered there and creates none. `[4mb]`
- **Where there is only one way to apply the work, accepting it goes
  straight to committing.** On the main branch the owner's review offers
  "Accept & commit"; on another branch it offers "Accept" and then the two
  options at Apply. `[4mb]`

Rules:

- **The panel shows which step each open issue is at**, first among the
  issue's small facts, on a **light blue background**. `[e2b]`
- **The step's tag carries an icon for whose move it is**: a person where
  the owner's input is needed, a robot where the next step is the agent's.
  **A Not started issue shows the robot**: the next step is for the agent
  to look at what was written. `[e2b]`
- **Each step has one main button.** At an agent's step it starts the agent
  on that step. At the owner's step it is the owner's approval. `[e2b]`
- **While the agent is working on an issue, the button that starts its
  step is not shown on it.** `[dtf]`
- **The Define button has an icon of its own**, different from the play
  triangle on the buttons of the other steps. `[0xy]`
- **Starting never begins again from the first step.** The agent is asked to
  do the step the issue is at, and only that. `[e2b]`
- **A step named after the agent's work means that work is under way.**
  "Define" on an issue means it is being defined, not that nobody has
  touched it; that is "Not started". `[e2b]`
- **Define is a step, not a special button.** There is no separate Define
  action and no separate agent for it. `[e2b]`
- **Every step runs in the conversation**, with the conversation's own
  agent. `[e2b]`
- **At a review, the owner approves or sends it back** to the step before,
  saying why. `[e2b]`
- **The agent has the judgment to move an issue to any step**, for example
  to leave out steps it finds unnecessary. `[eg0]`
- **While an issue waits for the owner's review, the agent does not move it
  forward.** `[eg0]`
- **The owner does not have to think about moving issues between steps.**
  While an issue waits for their review they simply reply. If the reply
  asks for changes, the agent moves the issue back to the work step; if it
  is only a question, the issue stays where it is. The agent decides which.
  `[eg0]`
- **At Apply the owner is given two options, "Commit" and "Commit &
  merge". Both close the issue** once the agent has done it. `[7h1]`
  `[lmy]` Apply is reached only where both options exist (see above).
  `[4mb]`
- **A step may be skipped with a stated reason**, which is recorded. `[e2b]`
- **Accepting at the owner's review does not close the issue. It moves it
  to Apply, or straight to the commit** where there is nothing to choose,
  and from there the agent commits the work as the owner chose.
  **The issue closes only once its work is in git.** `[0uh]` `[d37]`
- **Closing an issue that has sub-issues closes all of them**: the issue
  and every sub-issue still open inside it, at any depth. `[5qt]`
- **While there is no current issue, every open issue offers its step's
  button.** A top-level issue has it on its row; a sub-issue has it inside
  the opened sub-issue. Starting an issue makes it current. `[pp7]` `[5qt]`
- **Starting an issue that has sub-issues** directs the agent to work on
  that issue and all its sub-issues together. `[5qt]`
- **Open questions come first.** If the issue has open questions for the
  owner, the agent asks them and waits. Being started is not permission to
  assume the answers. `[avf]`
- **The workflow is described in one place in the product**, separate from
  the panel and from the rest of the backend, so that it can be changed, or
  another added, without touching them. `[e2b]`

## Closing

- **Finishing an issue is the workflow's last step** (see "The workflow").
- **Cancel** closes an issue that is not needed, without finishing it and
  without a commit. It is always possible, at any step. `[e2b]` `[0rg]`
- **Closing always asks for confirmation**, whether finishing or cancelling.
  `[pp7]`
- Cancel is less prominent than the main button `[d37]`: it is in the
  row's menu and inside the opened issue, never a button of its own on the
  row. `[l3m]` A sub-issue is cancelled from inside the opened sub-issue.
  `[5qt]`
- Buttons are ordinary gray. No green. `[d37]`

## Syncing with GitHub

- **The owner can sync issues with GitHub issues from a dialog, both
  ways**: GitHub issues are brought into the folder's issues, and issues
  are sent to GitHub. `[rh3]` It is called "Import / export GitHub
  issues", not "sync", so that it is not taken for the issue sync, and
  it stands under Setup in the menu, since it is done once or twice and
  not day to day. `[c9l.21]`
- **The owner selects the issues, and previews the result** before
  anything is changed. `[rh3]`
- **Closed issues are synced as well as open ones.** `[rh3]`
- **The import from GitHub copies the comments, when a checkbox is
  ticked**, so that a project that used to live in GitHub issues arrives
  with its discussion. Only in that direction: comments are not sent to
  GitHub. `[apc]`
- **A sync under way shows its progress**, and what the sync is printing,
  so that the owner can tell it is not stuck. `[rh3]`
- **It is one screen with three columns: sync to GitHub, linked, and sync
  from GitHub. The owner selects in each, and a filter says whether
  closed, not closed or all issues are shown.** `[rh3]`
- It is done by the issue store's own GitHub sync; the product adds the
  choosing, the preview and the confirmation, and does not sync by a method
  of its own. `[rh3]`
- **The GitHub token is stored, but never where it would be synced to the
  repository.** `[rh3]`

## In the main window

Outside the tab, around the message box of a conversation, so that the
state of the work and the decision about it are where the owner reads the
agent's messages. `[3l4]` `[eg0]`

- **Above the message box, one line of status.** It reads, in order: the
  stage the conversation's current issue is at, **on the same light blue
  background as in the panel**; the issue's ID; and the current prompt, what
  is required of the owner now, **as a human-friendly phrase**, for example
  "Please review the results and give feedback." Not two lines. `[eg0]`
- **Hovering anywhere on that line shows the issue's card immediately**; so
  does clicking it. There is no ordinary tooltip. `[eg0]` `[prr]`
- With no current issue, the line is not shown. `[prr]`
- **Inside the message box, after the model selector, are the contextual
  action buttons**: the moves for the current issue's
  step, **with text on them**, usually two, for example "Approve plan" and
  "Send back", or "Accept" and "Send back". Seeing both shows what action
  is expected. `[eg0]`
- **During the agent's stages no workflow buttons are shown there.** `[eg0]`
- **"Agree & continue"** tells the agent the owner agrees with its
  recommendations and it should go ahead. It is **a check mark with the
  word "LGTM"** `[ahs]` and a tooltip, on a **gray background with square
  corners** like the app's own send button, not on white and not round.
  `[eg0]` `[lit]` **It is shown all the
  time, not depending on the workflow**: also beside the accept and
  send-back buttons. `[7jd]`
- **There is no "Go" button.** `[eg0]`
- Pressing a contextual button makes the real move in the issue's workflow.
  `[eg0]`
- The buttons are disabled where they would do harm: "Agree & continue"
  while there is text in the message box. `[lit]`

## Tooltips

- **Buttons have tooltips** that say what they do. `[b5o]`

## Staying up to date

- The panel refreshes on its own when issues change outside it: an agent or
  the owner working in a terminal. `[6v6]`
- This is triggered by watching for the change, not by checking on a timer.
  `[6v6]`
- **Switching between repositories must not take seconds.** `[3pr]`

## How agents work with it

These rules apply to any agent working in a repository that uses the product.

- **Record as much as possible on the issue**: the intent in the owner's
  words, the design, every decision with its reason, and what was tried.
  Chat is lost; the issue is not. `[—]`
- **Take an issue through its workflow one step at a time**, as under "The
  workflow", and report each finished step. `[e2b]`
- **Every agent always has the means to say which issue it is on and to
  move an issue's step**, whatever the folder held when its conversation
  started and whichever workflow is chosen. Where they do not apply (the
  folder has no issues, or the repository is on Simple) they refuse in plain
  words and change nothing. `[8fm]`
- **The agent is told which workflow applies**, at the moments it matters:
  when it says which issue it is on, when the owner makes an issue current
  for it, and when the owner switches the workflow. `[8fm]`
- **Do not close issues by hand.** The owner validates and accepts; the
  issue closes when its last step, the commit, is reported done. `[e1d]`
  `[0uh]`
- **Commit after the owner has accepted an issue and chosen how at Apply,
  and not before.** One commit per issue. The commit message carries the issue's id
  and its description. `[d37]` `[0uh]`
- **Every commit is pushed** to the project's remote repository as soon as
  it is made, automatically, whoever makes it. `[bfi]`
- **Update this spec with every change.** The spec and the implementation
  are updated in the same commit. Requests that are not built yet stay in
  the tracker and are not written here. `[wie]`

## The `bend` command

A program for agents to read and change a repository's issues, beside the
panel. `[bwr]`

- **The agent does not need to know which tracker holds the issues.** The
  commands, fields and output are the same whatever the tracker; the tracker
  is found from the folder. Two trackers are supported: beads, and GitHub
  issues. `[bwr]` `[c9l.1]`
- **Which tracker a repository uses.** The repository can say so itself in
  a small setting file that is checked in. Without one, a repository that
  has beads uses beads; otherwise one whose remote is on GitHub uses GitHub
  issues. So a repository that has both stays on beads unless it says
  otherwise. `[c9l.1]`
- **On GitHub, each thing is kept where GitHub has a place for it**, and
  otherwise in a way a person reading the issue on GitHub can see: `[c9l.1]`
  - GitHub's own: title, description, comments, assignee, closing,
    sub-issues, and "blocked by".
  - As labels: type, priority, category, "in progress", and Someday
    (`someday`) `[26g]`.
  - As marked sections of the description: requirements, done, plan and
    notes.
  - As a marked "Links" section of the description: "discovered from" and
    "related", which GitHub does not have.
  - As one hidden line at the end of the description: free-form data kept
    with an issue (an epic's branch). `[c9l.6]`
- **`bend` answers reads from a copy of the issues kept on the computer,
  for every tracker**, so that the agent in a terminal, the panel and the
  sync see one and the same thing, and a read does not start the tracker's
  program. With beads, a change still goes to beads at once and its answer
  is certain before the command returns; a change made with beads' own
  program in a terminal shows in the next read. `[c9l.14]`
- **On a hosted tracker, `bend` works from a copy of the issues kept on
  the computer.** A read answers from the copy without waiting for the
  network; a change is recorded in the copy and sent afterwards; what others
  changed is brought in by a sync. `[c9l.5]`
  - **Making an issue waits for the tracker**, which alone gives its number.
  - **A workflow move asks the tracker first** and is refused if the issue
    was moved meanwhile.
  - **A change that cannot be sent now** (no network, a limit, a login that
    ran out) waits and is sent again, in order. **One the tracker will never
    take** is put on a list of refused changes with its reason and its
    text, and the issue shows the tracker's version again. Both are
    visible.
  - **When two sides change the same issue, the last change wins, but the
    written parts** (description, requirements, done, plan, notes) **are
    merged separately**, so changes to different parts both survive.
  - **A read answers from the copy at once while it is less than a day
    old**; older than that it is reread first. A read that finds it more
    than three minutes old still answers at once and has it refreshed in
    the background. Everything is reread once a day.
  - **The copy is kept in the repository's git folder**, shared by all its
    work trees, never committed. It holds issue texts, never the login.
  - **A change is sent a moment after the command that made it**, and the
    helper's clock brings in what others changed (see "Keeping the issues
    on the repository's remote"); a sync can be asked for at any time.
    `[c9l.16]`
- **Agents read and change issues with `bend` in every repository**, also
  where the tracker is beads; they do not need to know which tracker a
  repository uses. `[c9l.7]` `[c9l.10]`
  - **What they are told is one wording for every tracker.** It names
    `bend` only, and says "issue", not "beads issue".
  - **Issues only through `bend`**: the rules rule out the tracker's own
    program (`bd`, `gh`) and its website for issues.
  - **An issue is never closed by any means** unless the owner says so:
    not with `bend`, not with the tracker's own program, and not by
    closing words in a commit or a pull request. `[c9l.19]`
  - **The two agent tools are called `airbender_set_current` and
    `airbender_workflow_move`.**
  - **Setup keeps a repository's rules from drifting behind.** The rules
    change over time. Where a repository's rules were changed by hand and
    are from an earlier version than the current one, setup says so and
    asks the owner to choose: replace them with the current rules, or keep
    their own. It never replaces them unasked, and never leaves them
    behind unsaid.
  - **An update is said to be an update.** Where a repository has
    Airbender's rules and they are only not the current ones, setup says
    that the rules have changed and offers to update them; it does not
    say the folder has to be got ready, which it was.
- **The panel works on a repository whose issues are GitHub issues** as it
  does on a beads one: the owner sees them, changes them and starts agents
  on them. It does so through `bend`'s copy, so it answers at once.
  `[c9l.6]`
  - **It does not ask for the beads program where beads is not used.**
  - **The "Sync log…" row and the sync log say what each of `bend`'s
    syncs sent and brought in** there, as on a beads repository.
  - **It shows what waits and what was refused**: an issue with changes
    not yet sent says so, and the changes GitHub refused are listed with
    their issue, what they were, their text and the reason.
  - **On screen it says "issue" everywhere**, on every tracker; "beads" is
    only the name of one tracker.
  - **The menu says which tracker the project uses**, as its first line,
    above the workflow choice, with a small icon: "This project uses
    GitHub issues" or "This project uses beads issues". The toolbar does
    not name the tracker. `[c9l.21]`
  - **The tracker is switched in that same spot**, between beads and
    GitHub issues, either way. `[c9l.18]`
    - **The window says what it will do, and does not ask how**: how many
      issues that exist only in the tracker in use will be created in the
      other, how many that are on both sides already will be brought up to
      date, and what stays where it is. Then it does it.
    - **The copying is that of "Import / export GitHub issues".**
    - **After switching back, the issues of the first tracker are there
      as before.**
  - **The menu's setup steps are folded away** under one row that opens
    them, since they are not needed all the time. `[c9l.21]`
  - **What an agent is told there names `bend`, not `bd`**: the message
    for each step, the rules in the repository's instruction file, the
    agent tools' texts and the background sizing.
  - **An epic's branch can be kept on a GitHub issue**, so starting an
    epic "in a branch" or "in a work tree" works there.
  - **Background sizing there is the same as with beads**: it follows the
    existing setting.
- **It does not depend on the app the panel runs in**, so it can be used, or
  moved, on its own.
- **It is one self-contained program**, built from source in this
  repository, that runs from any folder and needs nothing else installed
  beside it but the tracker's own program. `[c9l.4]`
- **The panel reads and changes issues through it**, by running it, as
  agents do, so there is one implementation. Whatever the panel does with
  an issue can be asked of `bend` in a form a program can read: labels,
  free-form data kept with an issue, every kind of link the tracker has,
  removing one link of several, and which of the expected problems
  occurred. `[c9l.4]`
- **What it can do:** list issues, list those ready to work on, show one,
  show its comments, search; create, edit, write one of an issue's parts
  (description, requirements, done, plan, notes), comment, record a
  decision, close, reopen, put in Someday and bring back `[26g]`; move an
  issue under another or to the top level;
  link and unlink two issues (blocked by, discovered from, related); hand an
  issue over; report the repository's status; save and recall standing
  facts.
- **It sets a repository up.** `bend setup` alone only reads: it says what
  is in place and what is missing, and gives the same to a program. Each
  subcommand is one setup step, and changes something; `bend setup all`
  runs the missing ones in order, each exactly as it runs by itself.
  `[c9l.9]`
  - **Steps ask by default, and options answer in advance**, so that an
    agent or the panel can run them without anyone typing. A yes-or-no
    question is answered by one option for all; each choice has an option
    of its own.
  - **Where nobody is at a keyboard, a step never waits.** If an answer is
    missing it changes nothing, says what it needed and which option gives
    it, and ends at once.
  - **Every step is idempotent**: if it is already done, it changes nothing.
  - **Preparing the issues** gets them where the repository's remote
    already holds them, and starts a new database where it does not.
    **Publishing the issues** to the remote is a step of its own.
  - **Anything that changes the machine, or sends data off it,** is shown
    as the exact command first and needs a yes or an explicit option.
- **It has no notion of a "current" issue.** That belongs to a working
  session, not to the tracker.
- **Closing is available to agents.** That agents do not close on their own
  is a rule for agents, not a missing command.
- **Status says what applies here:** which tracker is used, what it
  supports, what is kept another way, and what is not available.
- **Standing facts are kept in a file in the repository**, not in the
  tracker.
- **It can be asked for machine-readable output**, and it ends with a
  status that tells "refused", "asked wrongly" and "this tracker cannot do
  that" apart.

## What it is not

- **Not a second issue tracker.** Issues live in beads; the panel shows and
  changes them there. `[02g]`
- **Not a place in the left sidebar.** `[02g]`
- **Not an auto-closer.** No issue is closed without the owner: by their
  acceptance, which leads to its last step, or by their cancelling it.
  `[e1d]` `[0uh]`
- **Not a git tool.** The panel never commits by itself; it asks the agent
  to. Pushing is done by the repository, not by the panel. `[d37]` `[bfi]`
- **Not multi-machine.** It reads the repository on the machine the app
  itself runs on. `[02g]`
- **No picker beside the message box.** Choosing the issue to work on from
  the message area was dropped in favour of the panel. `[prr]`

## Unspecified details

Behaviour the owner did not ask for or decide. It is what the product does
today, recorded so a rebuild matches. Any of it may be changed without
breaking a requirement above.

- Times on an issue's card: small and muted. While the card is closed up
  it shows one short date, the day it was last changed (or created, when
  it has no changed time), with both full times as its tooltip; open, it
  shows "Created <date, time> ·
  Changed <date, time>", in the reader's own date format. "Changed" is left
  out when it reads the same as "Created", and either part is left out when
  the tracker gave no time. A compact sub-issue row, which is one line, has
  none; its opened issue shows them at the right end of its row of buttons
  instead. `[tj4]`

- Current: inside an opened issue the target button is one toggle, with the
  words "Make current" or "Release". Its icon is a target on an issue that
  is not current and an exit door on the one that is, so the two cannot be
  mistaken for each other. In the row's menu
  the entry reads "Make current" or "Release from current". A closed issue
  has neither, and there is none where there is no conversation.
- The row's menu: it opens under its button, or above it near the bottom of
  the window, and closes on a choice, on Escape and on a click elsewhere.
  Its entries, in order: the current entry, Edit, Add sub-issue, Move to…,
  Link…, then, under a line, Close. Each entry's icon is the one the same
  action has as a button inside the opened issue. The menu and the opened issue call
  cancelling "Close"; inside the opened issue it is a labelled button, as
  is Reopen on a closed issue.
- Epic mode: it is offered on every open issue that has sub-issues,
  whatever its type: a button on its row, with an arrow going down into an
  open ring, beside the button for
  the details window, and an "Epic mode" button inside the opened issue (which
  is how a sub-issue is zoomed in on). Where it may not be entered the
  button is greyed out, the mouse pointer over it stays the ordinary arrow,
  and its tooltip reads "You can only enter epic mode when no issue is
  selected, or an issue from this epic is selected."
- Epic mode: the band reads "Epic", then the titles of the issues the epic
  is inside, as a path that can be clicked, then the epic's id and title.
  The arrow goes up one level: to the issue the epic is inside when there
  is one, otherwise to the whole list.
- Epic mode: with no current issue it can be entered. "From the epic" means
  at any depth. The panel also leaves epic mode by itself when the epic is
  closed or no longer exists. Leaving by itself is silent.
- Epic mode: the deselecting on entry is an ordinary release, so the agent
  gets the same short message as for any release. Nothing else about epic
  mode is told to the agent.
- Epic mode: the button reads "Close epic" and is there when every issue
  under the epic, at any depth, is closed and there is at least one. It
  asks first: "Close this epic?", then "All N issues in <the epic's title>
  are closed. You can reopen the epic later." (for one: "The only issue in
  <the epic's title> is closed. ..."), with "Close epic" and "Not yet". The epic is closed whatever step it is at
  itself; the panel then shows the whole list.
- Epic mode, the way back: one quiet line in the band's place while the
  panel is on the whole list, reading "Back to epic" with the epic's id and
  title, and a small cross that dismisses it. It is offered after leaving
  with the back arrow and after epic mode ended by itself; not after going
  up one level, which is still epic mode. While the conversation's current
  issue is from outside that epic the line is greyed out, with the same
  explanation as the button that enters epic mode. It goes when the epic is closed or no
  longer exists, and entering another epic makes that one the epic to go
  back to. It is remembered per conversation, on this computer.
- Epic mode: it is remembered on the computer it was chosen on; the same
  conversation opened on another computer starts on the whole list.
- Epic mode: the list keeps its groups, Group and Filter. A dragged issue
  dropped on empty space in the list goes directly under the epic, where
  outside epic mode it goes to the top level. An epic with nothing to list
  says so.
- Sizes: the size can be changed until the work reaches the owner for
  review; after that "Send back" says what should be redone. The owner can
  give an issue a size before the agent does, from the row's menu or from
  "Size…" inside the opened issue, and the agent
  then follows it without sizing the issue itself. Going down a size is
  allowed: the reviews still ahead of the work are dropped. In doubt
  between two sizes the agent takes the larger, and if its work is sent
  back it takes the next larger path. A small issue that turns out not to
  be small is re-sized by the agent, which says so.
- Sizes: a small issue shows "Implement" as soon as it is sized, since that
  is the step its work is in. A change of size is recorded on the issue,
  and the agent is told only when the issue is already under way and is
  the conversation's current issue. The
  sentence at "Review plan" reads "Please review what is planned and give
  feedback", because a medium issue's definition is reviewed there too.
- Background sizing: on unless switched off. "A change" is a change to the
  issue's title, description, acceptance criteria, design, notes or type,
  or a sub-issue added or removed; not its comments, category, priority,
  status or step, since the sizing itself writes a comment. It happens
  while a panel on that repository is open; issues made with none open are
  sized when one next opens. Issues are taken ten at a time, a few seconds
  after the first needs a size. Each sized issue gets one comment with the
  reason. An issue that could not be sized is not tried again until it
  changes or the owner asks.
- Sizes in an issue's menu: one row, marked with an icon of a box with its
  measurements, holds "Size", then S, M and L (the present one marked),
  then "Auto". S, M and L set the size by hand; "Auto" triggers the
  background sizing for that issue. The row is there while the size may
  still be changed; "Auto" only on an issue that has not been started. It
  works also while the automatic sizing is switched off, and replaces the
  size the issue has, the owner's own included.
- Background sizing: the settings are an on/off switch, the provider and
  the model. The panel's "⋯" menu ends with a line saying where they are.
- Sizes: the dropdown shows S, M or L; its tooltip says what each means. On
  a closed issue no size is shown.
- Work that changed no files is closed without a commit: the agent says so
  when it reaches the commit.
- Where a discussion in the conversation ends in a decision worth keeping,
  the agent offers to record it.
- The details window from an issue: the button is on every full-size row;
  the menu entry reads "Open in window" and is first in the menu, on open
  and closed issues. A sub-issue's row has no buttons, so inside an opened
  sub-issue the button reads "Open in window", or "Open with sub-issues"
  when it has some. The issue the window is showing offers neither.
- Starting in a new branch: the two start icons are drawn as one small
  group with a soft fill, apart from the row's other icons. Their play
  triangles are the same shape, the second one smaller to make room for
  the branch beside it. The menu entry
  reads "Start in branch", as does, in the message box of the conversation,
  the button beside "Start".
  Later steps keep their buttons with words.
- Starting in a new branch: the agent makes the branch as the first thing
  it does and says so; the product itself changes nothing in git. If the
  name is taken or the branch cannot be made, the agent stops and says so.
  "Uncommitted changes" are changes to files git tracks; files it does not
  track do not count. The message box reads "Not yet", with the warning
  and an OK button. The title's part of the name is cut at a word after
  about forty characters. Committing without merging leaves the branch.
  The branch on the remote is deleted only once the main branch is there.
- Starting in a work tree: the entry reads "Start in worktree", in the
  menu and among the buttons of an opened issue, on every issue that is
  not started, also while the conversation has another current issue. The
  work tree is cut from the main branch as it is on this computer,
  including what has not been pushed; uncommitted changes are not taken
  along and do not prevent it. The app names the branch, from the issue's
  id and title and the conversation. The new conversation is titled with
  the issue's id and title, and the issue is its current issue. Only the
  owner can start one; an agent cannot.
- In a work tree, whether a coding agent is set up is asked of the
  repository's main folder, so a new work tree does not offer to set an
  agent up again. The new conversation's side tabs are the app's own two
  and the panel's.
- Closing up after a landing from a work tree: it happens once the agent
  has finished speaking, by itself, and takes a little while. The archived
  conversation can still be read. The branch on this computer is the one
  thing the product itself removes from git, and only after checking that
  everything on it is on the main branch; if any part of the closing up
  fails, what is left stays in place. "Commit" without merging leaves the
  conversation, the work tree and the branch. If the work tree or the
  conversation cannot be made, nothing is started and the panel says why.
- An epic with a branch of its own: while its issues are being worked the
  epic stands at a step called "On its branch", shown as its step like any
  other; the agent does not work on the epic itself. The branch is noted on
  the epic. "Start epic in branch" is refused over uncommitted changes like
  any start in a branch, and names the branch from the epic's id and title;
  if the branch cannot be made the agent says why and the epic goes back to
  not started. From the new-conversation screen, where there is no agent
  to make a branch, only the work tree start is possible; the branch start
  says so. A refused start shows a message box naming the issues that
  are being worked on. The conversation opened for an epic in a work tree
  has no current issue, and its agent only says which branch it is on. For
  a moment after such a start, until the work tree's branch is known, the
  epic's issues cannot be started and say that the work tree is being set
  up. In a folder that is not on the epic's branch, an issue of the epic
  shows, where its buttons would be, a line naming the epic and its
  branch, and anything asked for it anyway is refused with those words. An
  issue of such an epic is not offered a branch or a work tree of its own,
  and neither is an epic inside it. "Close & merge" is offered only in a
  folder on the epic's branch, and asks first: "Close and merge this
  epic?", saying that all its issues are closed and that its branch is
  merged into the main branch and deleted, with "Not yet" and "Close &
  merge". In another folder the band offers no button for such an epic.
  Closing the epic without finishing it, from its menu, leaves its branch
  and work tree as they are. A merge that fails sends the epic back to the
  work like any issue. Only the owner can start an epic in a work tree; an
  agent may start one in a branch when asked to.
- The epic's "worktree" mark: it sits after the step on the epic's row and
  in the opened epic, as underlined text with the small fir; its tooltip
  names the branch. In the epic's own conversation, and on an issue's card
  above the message box, it is plain text, not a link. The epic band
  carries no such mark. The step still reads "On its branch".
- The branch beside the folder's path: plain text in the path's own
  lettering, shown whenever the branch can be told, also on the main
  branch. In a work tree "worktree" comes before the branch. When there is no
  room the path is cut first; a long branch name is cut too, and both show
  whole in their tooltips. A path inside the owner's home folder is shown
  with `~` in its place (the owner's request); the tooltip has it in full.
- A new sub-issue takes nothing from its parent but the category: not its
  step, its size or an epic's branch.
- Autopilot: it is an on/off switch in the epic band, with its name beside
  it (the owner chose a switch over a button), shown
  only in a conversation and where issues have steps. The next issue is
  the epic's most urgent direct sub-issue that is open, not blocked and
  not the current issue of another conversation; among equals, the oldest.
  An issue already under way is taken up from its step; one that waits for
  the owner is only made current. The agent is told that autopilot started
  the issue and that the reviews are still the owner's. Under the band one
  line says what the run is doing, which issue waits for the owner and at
  which step, or why it stopped. Stuck means: the agent's turn ended with
  the issue still at one of the agent's steps (it asked something, gave up
  or failed); the agent sent the issue back from the commit step; or the
  issue could not be started. It also stops, saying so, when every issue
  is closed and when only blocked or elsewhere-worked issues are left.
  Turning it off does not interrupt the agent. Making another issue
  current, or releasing the current one, by hand turns it off. Turning it
  on again resumes. Leaving epic mode leaves it on. It is remembered
  across restarts, and it works with the panel closed. On an epic that has
  a branch it only starts issues in a folder on that branch.
- Syncing with GitHub: it is an entry of the panel's menu and opens a
  large window. The repository is the one the folder's "origin" remote
  points at, on github.com only. The window has three columns side by side, in
  which the owner selects: "To GitHub", the folder's issues that are not
  on GitHub; "Linked", the issues that are both in the folder and on
  GitHub, which are brought into step in both directions at once; and
  "From GitHub", the repository's issues that are not in the folder
  (without pull requests, the thousand most recently changed at most).
  Nothing is ticked at first. Each column has a box that ticks all it
  shows, and says how many are ticked. Above the columns, for all three,
  are a filter by title or number and a filter for closed and not closed:
  open (to begin with), closed, or all. A linked issue counts as open
  while either side is open, and says its GitHub number and where one side
  is closed and the other open. A row is the issue's id or number over its
  title; a closed issue is struck through.
  For an issue changed on both sides the owner chooses: the
  newer one wins (preselected), GitHub wins, or the folder's wins. Preview
  lists what would be imported, updated here, created on GitHub and
  updated on GitHub. "Sync" is offered only for what was just previewed;
  changing a tick asks for a new preview. Before issues are created on
  GitHub it asks once more, with their number and the repository. A preview
  or sync under way shows a bar, how many of the issues it has been
  through, the time it has taken, the last lines the sync printed, and a
  Stop button; it is done ten issues at a time, and Stop lets the ten
  under way finish and starts no more, leaving done what was done. There
  is no time limit on a whole sync. An issue that is closed in the folder
  is closed on GitHub right after it is created there. After a
  sync the window says what was done and the lists are read again. From
  GitHub is done first, then the linked issues, then to GitHub. With no token set, the sign-in of the GitHub command-line
  tool on the owner's computer is used for each sync, and nothing is
  stored (the owner asked whether the token could come from that tool by
  itself). A token set in the product's settings, kept on the owner's
  computer, is used in its place. With neither, the window says both ways
  to put that right. A refusal by GitHub is said in plain words.
- What a sync is said to have done: the issues changed here that it sent,
  each with the kind of change (created, updated, closed, deleted, a
  comment, a link), and the issues that came in new or changed from
  elsewhere; in words, "nothing new", "sent 1 issue", "brought in 2
  issues, sent 1 issue", with the first few ids named in the log. Where it
  cannot be told, it says "synced" and no more. A failed sync says how it
  ended. The refresh button's tooltip is one line: what the button does,
  then "Last sync 1 minute ago:" and that; when the button is red the
  reason comes first.
- The sync log: the menu's row "Sync log…", which also shows the sync's
  state; a small
  window, newest first, each sync with its time, what it did, what set it
  off (on the clock, after a change here, the copy was old, asked for),
  how long it took, and the store's own message where it failed. It lists
  the syncs of the repository whoever ran them: the panel, a terminal, the
  helper. A sync that did not work is in red. A switch leaves only those.
  A line says how the helper stands. The newest two hundred are kept, per
  repository, with the repository on this computer (in its git folder,
  never committed). Syncs that found nothing new are listed too; several
  of them in a row are one line with a count. A sync that found another
  one running and did nothing is not listed. The log the panel kept before
  syncing moved to `bend` is not carried over.
- The sync commands: `bend sync` syncs now and says how it ended, what was
  sent and what came in, and exits with status 1 when it did not work;
  `bend sync --status` syncs nothing and says what the issues are synced
  with, what waits to be sent, how the last sync ended, how the helper
  stands and what is wrong; `bend sync --log` lists the syncs, with
  `--failed` only those that did not work. `bend status` also says what is
  wrong with the syncing, when something is.
- The helper: one for each copy of a repository's issues, shared by its
  work trees. It looks every fifteen seconds whether it should end, and
  syncs when three minutes have passed since its own last try and since
  the last sync that ended well, by anyone; a sync that failed elsewhere
  (inside an agent's sandbox, say) does not put it off. Each sync is a
  `bend sync` of its own. A sync that hangs is ended: the store's own
  program after five minutes, with everything it started, which leaves a
  failed entry in the log; the whole sync after seven by the helper, and
  after eight when the panel asked for it. It also ends when the `bend` program is replaced by another
  build, when the folder it was started from is gone, and after three
  syncs in a row failed. After it gave up, none is started by itself for
  three minutes, twice as long each further time, an hour at most, until a
  sync works; this holds only for commands run with the same view of the
  network as the one that gave up, so that a helper that fails inside an
  agent's sandbox does not keep one from being started outside it, and a
  running helper that is failing is replaced by one started from another
  view of the network. It does not sync where the issues are synced with
  nothing, nor after a conflict or a stuck state, but stays, and takes
  syncing up again when that changes. Where it cannot be told whether the
  issues are synced with anything, because the remote is not reached, that
  counts as a failed sync towards giving up. A stop after a conflict or a
  stuck state holds until a sync ends well; one that merely fails after it
  does not lift it. Asking how the helper stands (`bend helper`) and
  stopping it do not count as `bend` being used, and start none. A helper
  asked about in the moment after it starts, before it has written down
  when it started, is said to be starting, not running since a time.
  `[p1z]` `BEND_NO_BACKGROUND` set keeps
  `bend` from starting it (and from syncing behind a command);
  `BEND_NO_HELPER` keeps it from starting the helper alone.
- What counts as trouble with the syncing: a conflict or a stuck state, at
  once; syncs that fail, from the first one where the issues have never
  synced well from this computer, otherwise once two or more in a row have
  failed over more than four minutes (a little more than one round of the
  clock, so that one dropped connection, or a sync that failed inside an
  agent's sandbox a moment before the helper sent the change, is not
  called trouble); changes the tracker refused for good; and the helper
  being disabled. The first three mean the issues are not being synced and
  are shown in red; the last two in amber.
- The trouble bar: across the top of the issue list, under the toolbar. It
  says what is wrong, since when and when the issues were last synced
  well, what to do, and the tracker's own words from the last sync that
  failed. "Sync now" is offered for what a sync can mend, and "Show log"
  opens the sync log, on the failed syncs when the trouble is one. It
  cannot be put away; it goes when the trouble does. After a failed sync
  that is not yet called trouble, the panel asks again four and a half
  minutes later, so that the bar appears when it becomes one. Syncs that
  fail because the remote is not reached are trouble also where it could
  never be confirmed what the issues are synced with.
- Issues count as synced only when the remote really holds them. A
  repository whose issue store names a remote to which nothing was ever
  sent (the store does that by itself when a folder is set up) is treated
  like one with no remote: nothing is synced by itself, and the setup step
  is offered; that step sends the issues first and then syncs. When the
  remote cannot be reached it is neither synced nor offered the step.
- Pressing refresh always tries a sync at once, whatever the helper is
  doing.
- With beads, a change is not synced right after the command that made
  it: the clock sends it, within about three minutes.
- With beads, what came in is worked out by comparing the issues before
  and after a sync ("last changed", status, number of comments), less
  those changed on this computer meanwhile.
- The state on the "Sync log…" row: "synced 1 minute ago", "syncing…",
  "not synced", "not yet synced from here", "failed", "stopped" or
  "waiting"; a longer message appears under the row only for a folder
  synced with nothing, a failure or a stop.
- With beads as the store, what was sent is read from beads' own journal
  of changes, which is switched on for the repository the first time it
  is synced; changes made before that are not known and not guessed.
- Switching the tracker: a "Switch…" control at the right of the menu's
  first line, not offered while a setup step runs in a terminal. Its
  window names the tracker in use and the other one, and lists what
  happens as sentences with numbers: the open issues that exist only on
  the side being left, created on the other; the issues linked on both
  sides, brought up to date (the newer side wins; comments are copied);
  the closed issues that exist only on the side being left, which are not
  copied; that nothing is deleted and one can switch back at any time;
  that `.bend.json` changes and is to be committed; and how many changes
  made here still wait to be sent, when any do. Only open issues are
  created on the other side, since issues created on GitHub cannot be
  deleted, only closed; the window says that too. There are two buttons,
  "Copy N issues and switch" (or "Update N issues and switch" when there
  are only linked ones) and "Switch only"; with nothing to copy, or where
  no copy can be made (no GitHub sign-in, no beads database in the folder,
  no repository on github.com), there is one, "Switch", and the reason is
  said. A field takes the GitHub repository where the folder's remote does
  not name it. The copy shows its progress in the window. Going to GitHub
  issues the copy is made first and the switch only if it went through, so
  a failure changes nothing; going to beads the switch is made first and
  the copy follows, and a failure of the copy is said as that, with the
  window then showing only that. A copy counts as gone through only when
  no issue was left out. The copy can be stopped, and closing the window
  during it stops it and switches nothing afterwards. The copying works
  with the repository of the folder's git remote; where the switch is
  about another one (named in the field, or the one in use), no copy is
  offered and the window says which is which. The buttons are off until it
  is worked out what a copy would do. Afterwards the tab shows the other tracker's
  issues, and watches that tracker's copy, with no reload. A
  conversation's current issue that is not among the issues shown is not
  shown as current, and is shown again after switching back. Where the
  other tracker is not ready, the usual setup card offers its step, and
  the menu's first line still names the tracker and offers the switch, so
  that there is a way back.
- Refresh and sync as one control: the refresh button reloads the list at
  once and, where the issues have a remote, syncs with it, reloading again
  when the sync ends; it turns while either goes on. It is red exactly
  when the trouble bar is red; its tooltip then says so in one line. It is
  not red in a folder whose issues are synced nowhere, nor merely because
  the app was closed for a while.
- Keeping the issues on the remote: the step is one of the setup steps,
  "Sync issues to the repository's remote", shown on the setup card like
  the others and in the menu. It asks first, saying that the whole issue
  history is published to the repository's remote, apart from the
  branches, and that the issue store records the remote with a small
  commit of its own, whose pushing is the owner's. After it `bend`
  syncs (brings in what other computers changed, then sends what changed
  here) every three minutes while it is in use, and when the owner presses
  refresh. The
  menu says, on its "Sync log…" row, when the
  issues were last synced, that a sync is under way, or that the last one
  failed and why. One repository's syncs never overlap, whichever of its
  work trees and however many panels and conversations ask; a sync asked
  for during another waits for it and then runs. A failed sync is tried
  again at the next round. A change made on two computers that cannot be merged
  stops the syncing by itself and is shown with the issue store's message;
  the product does not settle it, and takes syncing up again after a sync
  the owner asks for succeeds. Syncing by itself happens only while `bend`
  is in use: with the panel open but untouched for half an hour the helper
  ends, and what changed elsewhere shows when the panel is next looked at.
  On a copy of the repository with no issues, where the remote has them,
  the setup step reads "Get this repository's issues" and downloads them;
  nothing is published by it.
- Copying comments from GitHub: the checkbox reads "Copy comments" and is
  ticked when the window opens. It applies to what is ticked under "From
  GitHub" and under "Linked". The comments an issue here does not have yet
  are added oldest first, each under the name of who wrote it on GitHub,
  ending with a line that says who wrote it there, when, and gives the
  address of the original; by that address a comment is known to be here
  already, so syncing again adds nothing twice, and a comment made on
  GitHub since is added. The time shown for a copied comment is the time
  of the copy; the original time is in that last line. A comment changed
  or removed on GitHub afterwards is not followed. Preview says, per
  issue, how many comments would be copied; the progress and the result
  say how many were. A comment that cannot be copied is reported and does
  not stop the others.
- Speed of switching: `bend` keeps the list of a repository's issues it
  last read and answers from it while nothing has changed, so a switch does
  not read the issues anew; a conversation switched back to shows the list
  it last had at once and brings it up to date behind. A change made in the
  panel shows at once. The refresh button, and coming back to the app's
  window, always read the issues anew. One thing can show late, by up to a
  few minutes, in a panel left untouched: an issue removed outright, or a
  sync run by hand, in a terminal. `[3pr]` `[c9l.14]`
- The small step button on a row: lower than the icon buttons beside it,
  small text, no border, a soft grey fill that darkens under the pointer;
  it keeps its icon, label and tooltip. On the current issue it is the
  full-size bordered button.
- Choosing the workflow: the menu lists Standard and Simple above the setup
  steps, each with a line saying what it means and a tick on the one in
  use. It is offered only where the folder has issues to show. The choice
  takes effect at once, in every open tab and at the message box.
- The choice is kept on this machine. A separate copy (clone) of a
  repository has its own choice.
- On Simple: a row of an open issue shows "Make current" (or "Release" on
  the current issue) as a button with words and Close as an icon with a
  tooltip; the row's menu keeps Edit, Add sub-issue, Move to and Link. A
  closed issue keeps Reopen in the menu. A sub-issue's row stays without
  buttons. Inside an opened issue the buttons are the same as on Standard,
  without the step's.
- On Simple: closing asks "Close this issue?" and also closes the issue's
  open sub-issues, saying how many. The line above the message box shows
  the current issue's id and title, and inside the box only "Agree &
  continue" is offered.
- What agents are told about those two means begins with when they apply
  ("only if the folder tracks its work in beads", and for steps "and its
  repository is on the standard workflow"), since they are told it in every
  folder.
- What the agent is told about the workflow: on Standard, that the
  repository is on it, the step the issue is at and whose turn it is; on
  Simple, that issues have no steps and that the owner directs the work and
  closes issues. A switch is told only to the conversation whose panel made
  it, as a short message that asks for nothing; other conversations on the
  same repository learn it when they next say which issue they are on.
  Choosing the workflow already in use tells nobody.
- An agent cannot make an issue current where the folder's issues cannot be
  read at that moment, including when the tracker's program fails.
- On Simple: a step asked for anyway is refused with "This folder uses the
  simple workflow, which has no steps."
- A choice of Edit, Move to or Link from the menu shows one of the three at
  a time, replacing any of the others that was showing.
- Current: the note to the agent says which issue is current now and which
  was before, that this only changes which issue the conversation is on, and
  that no action is needed and no work should start. It arrives as a message
  in the conversation, so the agent takes one short turn to acknowledge it.
  Nothing is sent when nothing changed.
- Current: the confirmation reads "Switch the current issue?" with "Switch"
  and "Keep it".
- Current: when the current issue is no longer in the list, the Current
  group says so and offers "Clear".
- Workflow: the step is kept on the issue in the tracker as a label,
  `step:<name>`, and every move is added to the issue's comments with who
  made it and the reason given. An issue with no step recorded is Not started.
- Workflow: the main button of a Not started issue reads "Define": it moves
  the issue to Define and starts the agent on it. The agent can make that
  move itself when its work began from a typed request.
- Workflow: only the first step tells "not started" from "under way". A
  later step whose agent was never started, or has stalled, still shows
  that step's button, which starts the agent on it again.
- Workflow: "the agent is working on an issue" means the issue is the
  conversation's current one and the conversation's agent is busy
  (starting, running or stopping a turn). The button is hidden on the
  issue's row and inside the opened issue, and is back as soon as the agent
  is idle. The owner's own buttons are not affected.
- Workflow: Define and Plan are the steps that can be skipped; the
  implementation and the two reviews of it cannot.
- Workflow: the owner can also report an agent's step as done ("Mark as
  done", "Mark as reviewed"), for when the agent did the work without
  reporting it.
- Workflow: when the owner's move leads to one of the agent's steps, the
  agent is started on it straight away, and told the reason if it was sent
  back. When the agent finishes a step and the next one is also its own,
  it carries on; otherwise it tells the owner and stops.
- Workflow: the "Define" button's icon is a page with two written lines.
- Workflow: the main buttons read "Define", "Plan", "Implement", "Review",
  "Approve definition", "Approve plan", "Accept", "Commit" and "Commit &
  merge". "Send back",
  "Skip" and "Mark as done" are inside the opened issue; a move that needs
  a reason shows a small field for it.
- Workflow: "Commit & merge" is offered only when the work is on its own
  branch; on the main branch there is only "Commit". Choosing "Commit &
  merge" is the owner's approval of that merge, so the agent does not ask
  again. "Send back" is offered at Apply too, for a change of mind.
- Workflow: for either choice the agent is told to commit only that issue's
  files with its id and title in the subject, to follow the repository's
  own commit rules, and to say if a push fails. For "Commit" it is told not
  to merge; for "Commit & merge", to merge the work's branch into the main
  one afterwards. It then reports the step done, which closes the issue; or
  sends it back to Implement with a reason if it cannot be done.
- Workflow: the owner can also mark the commit step as done, for work
  committed by hand; that asks for confirmation, since it closes the issue.
- Workflow: when the owner says in the conversation which of the two they
  want, the agent records that choice, quoting them.
- Workflow: the reason given with a move is passed on to the agent only
  when the issue is sent back to an earlier step.
- Workflow: the step chip has no outline, and its text is slightly bolder
  than the facts beside it.
- Workflow: while a conversation has a current issue, the step buttons are
  offered on that issue only.
- Workflow: the confirmation for cancelling reads "Close this issue without
  finishing it?" with "Close issue" and "Keep it"; for finishing, "Close this issue as
  finished?" with the move's own label and "Not yet".
- Workflow: a closed issue keeps its last step; reopened, it is at that
  step again.
- Workflow: how an issue and its sub-issues move through steps together is
  not worked out; each has its own step.
- bend: there is also a "start" command, which marks an issue as being
  worked on and, when the caller names itself, assigns it.
- bend: a hand-over must say three things: what was done, how it was
  checked, and what was not checked. Without all three it is refused and
  nothing is changed. It is recorded as a comment and leaves the issue in
  progress.
- bend: a decision is recorded as a comment that begins "Decision:".
- bend: with beads, requirements are kept as a marked section at the end of
  the description, since beads has no place of its own for them; the
  category is the same label the panel uses. Status reports both.
- bend: facts are kept in FACTS.md at the repository's root, one line per
  key; saving under a key that exists replaces that line, and a fact saved
  without a key gets one from its first words. Facts an earlier version
  kept in a section of AGENTS.md are still read, and move to the file the
  next time a fact is saved. `[c9l.8]`
- bend: lists show open issues unless asked otherwise; an issue that waits
  for an unfinished one is shown as blocked.
- bend: status warns when the beads database is not synced anywhere.
- bend: refusals from beads are reworded where they would advise commands
  bend does not have, and name no command themselves, because the panel
  shows the same refusals. `[c9l.2]`
- bend: a new sub-issue takes its parent's category when none is given,
  and none of its parent's other labels. `[c9l.2]`
- bend and the panel find a repository's issues from a work tree as well,
  where the tracker's own folder is only in the repository's main folder.
  `[c9l.2]`
- The panel shows an issue's description and its requirements as one text,
  the requirements as a marked section at its end, as beads holds them.
  `[c9l.2]`
- bend: the setting file is `.bend.json` at the repository's root, holding
  `{"tracker": "github"}` or `{"tracker": "beads"}`, and optionally
  `"repository": "owner/name"`; without that the remote called origin
  names the repository. A file that names only the repository leaves the
  choice of tracker to the rule above and says where the issues are. A setting file that cannot be understood is
  refused, naming the file. `[c9l.1]`
- bend on GitHub: only github.com. An issue is named by its number, with
  or without "#". Issues of another repository cannot be named. `[c9l.1]`
- bend on GitHub: the labels are `type:<name>`, `priority:<0-4>`,
  `category:<name>` and `in-progress`; GitHub makes a label the first time
  it is used. The sections read "Requirements", "Done when", "Plan",
  "Notes" and "Links". `[c9l.1]`
- bend on GitHub: a "discovered from" or "related" link is written on both
  issues ("discovered from #12" on one, "led to #15" on the other; "related
  to" on both), and removing it removes both lines. `[c9l.1]`
- bend on GitHub: everything is done as the signed-in GitHub account.
  Starting an issue assigns it to that account. A comment written as
  someone else opens with that name and is shown as written by them.
  `[c9l.1]`
- bend on GitHub: closing with a reason adds the reason as a comment that
  begins "Closed:"; the issue's close reason shows GitHub's own word
  (completed, not planned). Closing takes "in progress" off. `[c9l.1]`
- bend on GitHub: "ready" means open, not in progress, and waiting for
  nothing. An issue waits for what the issues it sits inside wait for, up
  to four levels up. `[c9l.1]`
- Someday: the status is beads' own `deferred` on beads and the label
  `someday` on an open GitHub issue; bend reads both as `deferred` and
  the tab calls it Someday. `bend defer` and `bend undefer` set and clear
  it; starting or closing an issue takes it out of Someday. The default
  `bend list` leaves Someday out (`--status deferred` or `all` shows it),
  and `bend ready` never lists it. Moving to Someday and back asks no
  confirmation. In the opened issue the button sits beside Close. Elsewhere
  an issue in Someday still counts as unfinished: in sub-issue counts, and
  among the open sub-issues offered for closing with an epic. `[26g]`
- bend on GitHub: the login is the one the `gh` program holds, or a token
  in `GH_TOKEN` or `GITHUB_TOKEN`. Not signed in, no access, a limit
  reached (with the time it lifts) and no network are each said in plain
  words. Status warns that commands take a moment, that there is an hourly
  limit, and that search runs behind. `[c9l.1]`
- bend: it is written in Go with no packages beyond the standard ones.
  Setup installs it into the owner's own commands folder (`~/.local/bin`);
  a setting names another place. On Linux and macOS amd64/arm64, it
  downloads the release matching the plugin version, using curl and
  sha256sum or shasum. A failed download or checksum check leaves an
  existing installation untouched. Where no matching binary is offered,
  or the download tools are missing, setup offers a source build if Go and
  the source are available; otherwise it says why. `[c9l.4]` `[bk2]`
- bend: it has a version number that goes up when its commands or its
  output for programs change; the panel treats a `bend` older than it needs
  as missing and offers "Update bend", or "Build bend again" for a source
  build. `[c9l.4]` `[bk2]`
- bend: for programs, a failure says which kind it is: refused, asked
  wrongly, not supported, the tracker's program is missing, the folder has
  no tracker, or there is no login. A quick form of status says the
  tracker's name, the repository and its kinds of link without asking the
  tracker anything. `[c9l.4]`
- bend: a link can be of any kind the repository's tracker has (beads has
  five beyond the common three); a kind it does not have is "asked
  wrongly". Unlinking can be narrowed to one kind, and to the link recorded
  on the first issue. `[c9l.4]`
- bend: the panel tells it which beads program to run and to pass over any
  tracker but beads. `[c9l.4]`
- bend setup: the steps are called tracker, program, issues, instructions,
  facts and publish. A repository that already has a beads folder counts as
  having chosen beads; a GitHub remote alone does not count as a choice.
  With GitHub issues the "issues" step is signing in, which is only offered
  at a keyboard. Where the repository has no remote, publishing is not
  offered and the reason is given. What another program prints during a
  step (an installer, the tracker's program) is kept out of bend's own
  answer. The panel keeps its own confirmation windows and hands bend the
  answers; it keeps bend's answer about a folder for a short while, and
  "everything is in place" until something is run. `[c9l.9]`
- Where setup may run: the main branch is the remote's default where git
  knows it, else a local `main` or `master`; where neither can be told,
  only the worktree rule applies. A step already done stays done
  anywhere; only a step still to do is held back, and signing in to
  GitHub is not. The commit step is called "Commit Airbender's files",
  comes after the facts and before publishing, commits in one commit with
  the message "Set up Airbender: <files>", runs in a terminal so the
  repository's hooks show, and says beforehand that the whole of each file
  goes in, a change made to it by hand included. It is not offered where
  setup has written nothing, outside git, or where the issues are kept in
  another repository (someone else's project). Only setup's own work
  counts: `.bend.json` changed, `FACTS.md` new, `AGENTS.md` or `CLAUDE.md`
  new or with Airbender's rules block changed (or `CLAUDE.md` made a
  link); an agent's other edits to those files while working an issue do
  not. A worktree whose branch was made before Airbender was set up on
  main is told to bring the branch up to date with main. `[25p]`
- Removing beads' agent setup: beads' Codex hook is recognised in both
  its forms (`bd codex-hook`, and an older beads' `bd prime`). After
  beads' own removal, setup deletes what is left only where the whole
  file is beads': a hooks file with nothing but beads' hooks or none, a
  `.codex/config.toml` with nothing but beads' `[features]` switch,
  `.agents/skills/beads/`, then the folders left empty. A file that holds
  anything else of the owner's is kept. Setup's commit takes
  `.beads/config.yaml` when it differs from the last commit, and the
  deletion of any of those files that had been committed. `[cnv]`
- Someone else's project: the check asks GitHub once per reading of the
  setup state, only while no tracker is chosen, and gives up silently after
  five seconds; no GitHub login counts as "cannot tell". `bend setup
  tracker` then needs a yes at a keyboard, or `--anyway`, unless the issues
  go to GitHub issues in a repository other than the remote's. Keeping them
  there is recorded in the copy's own git settings (`bend.foreign`), and
  `.bend.json` is listed in `.git/info/exclude`. The panel's window starts
  with "Keep the issues in a repository of yours" chosen, and refuses a
  name that is not owner/name or is the remote's own repository. Setting up
  anyway later in such a copy makes it count as the owner's own again;
  `.bend.json` stays excluded. Beads is set up with
  `bd init --skip-agents --non-interactive --role maintainer`, which also
  leaves its export of issues to a file off. `[dof]`
- bend has one copy for every tracker; a tracker reached over the network
  has its changes queued on it. There, what depends on other issues (links
  seen from the other end, sub-issues, what blocks what) is put together
  when an issue is read. A change the copy can see is wrong is refused at
  once (an issue that is not there, a loop of sub-issues, a link of an
  issue to itself, a closed issue started); one only the tracker's own
  rules refuse shows on the list of refused changes after it was sent. A
  waiting "start" shows who it is assigned to only once sent. A change is
  sent as whoever made it. A change that takes the tracker several steps
  and is sent again after stopping half-way finishes what is missing: on
  GitHub the issue is closed first and the reason's comment added after,
  and a link kept on both issues is completed or taken off on whichever
  side still lacks or holds it. An id may be written as the tracker shows
  it or as it accepts it ("12" or "#12"). Only the step and size labels of
  a change go ahead of the queue; its other labels wait in turn. A copy
  left by an earlier version is put aside with a warning and made anew; so
  is a damaged file of issues.
  `[c9l.15]`
- The panel on GitHub issues: an issue with unsent changes carries a small
  "not sent yet" mark. The refused changes are at the top of the sync log
  window, each with "Send again" and "Dismiss", and the "Sync log…" row
  says when there are any. "Import / export GitHub issues…", which mirrors beads issues
  to GitHub, is not offered there. A folder with no tracker says so
  whether or not the beads program is installed. A missing GitHub login is
  said in `bend`'s words, with the setup card and its sign-in step. A sync
  that left changes waiting, or could not ask GitHub, counts as failed and
  is tried again; one in which GitHub refused a change for good counts as
  done, with a line saying how many were refused. A list is never made to
  wait for GitHub: the refresh button asks for a sync instead. A sync and
  a list may take up to five minutes before they are given up on. A
  tracker chosen or changed outside the panel (in a terminal, or by a
  pull) is noticed at the next read. In what an agent is told, the
  owner's own words (titles, the note an issue is sent back with) are
  left as written. `[c9l.6]`
- The menu's folded setup row reads "Setup" with a chevron, and at its
  right "all set" or how many steps are to do; it is folded again each
  time the menu is opened. `[c9l.21]`
- The tracker's line in the menu: for GitHub issues the repository's name
  stands under it and opens the repository's issues page on github.com.
  The GitHub mark is GitHub's own; beads' is three beads on a thread,
  drawn for this. A folder with no tracker chosen shows no such line.
  `[c9l.21]`
- The epic's branch on GitHub: the hidden line reads
  `<!-- bend:data {"branch":"…"} -->` and counts only as the very last
  line of the description, so that a description which quotes such a line
  is not mistaken for data. Someone who edits the issue's text on
  github.com can delete it, or type under it; the epic then reads as
  having no branch. A line broken by hand is left where it is and counts
  as no data. `[c9l.6]`
- What agents are told: the step messages name `bend show`, `bend
  comments`, `bend write <id> description|done|plan` and `bend start`. The
  rules in the instruction file are version 3; setup takes version 1 and
  both wordings of version 2 (the one that named `bd` and the one that
  named `bend`) as earlier versions of its own and replaces them in place,
  and leaves a block the owner edited alone. The background sizing's own
  tool is `airbender_report_sizes`. `[c9l.10]` The two tools are offered
  under their own names only; the names they had before
  (`beads_set_current`, `beads_workflow_move`) are gone, so a conversation
  from before the change has to be started anew, and a repository whose
  rules still name them has to take the update. `[c9l.20]`
- Rules that fell behind: the rules block names its version in a hidden
  line. A block changed by hand that names the current version is the
  owner's and the step counts as done; one that names an earlier version,
  or none, is "behind". For it, and for an unchanged earlier version, the
  instructions step is called "Update Airbender's instructions for agents"
  and says which version is there and which is current; for the unchanged
  one it adds "Nothing is wrong here". Where updates are all the panel has
  to offer, its card is headed "This folder is set up. Airbender has an
  update for it", and the step's button reads "Update". In a terminal it asks, or takes
  `--rules replace` or `--rules keep`; with nobody to ask and no answer it
  changes nothing and names the option. Replace saves what was there
  first, outside the working files (in the repository's git folder), and
  says where; it is refused, with nothing changed, for a block whose end
  marker is gone, since nothing then says where the owner's own text
  begins. Keep changes nothing but the version the block names, so the
  question returns only when the rules change again. Rules that name a
  later version than this `bend` writes are left alone and not called
  behind. In the panel the
  step's window shows the two choices with neither chosen, and its button
  waits for one. The panel keeps "everything is in place" for a few
  minutes, so a change made by hand to the rules shows after that or
  after a step is run. `[c9l.10]`
- `bend note <id>` adds a paragraph to an issue's notes and keeps what is
  there. On a hosted tracker it waits as a change of its own and is added
  to the notes the tracker holds when it is sent, so a note made elsewhere
  meanwhile is kept. `bend stop <id>` puts an issue that is in progress
  back to open and leaves its assignee; for one that is not in progress it
  changes nothing and says so; it is refused for a closed one. A step
  message names its commands with the issue's own id. `[c9l.10]`
- `bend sync` names, for a program, the issues whose changes it sent and
  those that came in new or changed; `bend status --quick` says whether
  changes are queued for a hosted tracker. `[c9l.6]`
- bend's copy of a hosted tracker: comments are kept per issue from the
  first time they are asked for, and asked for again when the issue has
  changed. Search searches the copy. Labels from two sides add up. The
  sync after a change is a process of its own that outlives the command; a
  setting switches it off, and another makes bend ask the tracker directly
  for everything. A sync that finds another running does nothing, or waits
  when it was asked for by hand. The labels that ask the tracker first are
  the workflow's step and the size. The size limit of one day and the three
  minutes are fixed numbers. `[c9l.5]`
- bend's copy with beads: it is kept in the repository's shared git
  folder; it knows it is behind by the small file beads rewrites on every
  change; after a change through bend it is reread by a process started
  behind the command; "ready" is beads' own answer, asked once after each
  reread; comments are kept per issue and asked for again when the issue
  changed; search is beads' own and always asks it. From a work tree the
  copy and beads' file of changes are the main folder's. A read can succeed
  with the beads program gone while the copy is fresh; a change cannot. The
  panel keeps no list of its own and reloads when the copy changes.
  `[c9l.14]`
- The step "On its branch" is believed only on an issue that has a branch
  recorded. A sub-issue made with the tracker's own program takes its
  parent's labels, the step among them; under an epic on its branch it
  would read "On its branch" and could not be started, so it counts as not
  started. `[c9l.17]`
- bend: every command accepts: run in another folder, read the text from a
  file or standard input, and who is acting. The ending statuses are 0 done,
  1 refused, 2 asked wrongly, 3 not supported by this tracker.
- Setup: every step asks for confirmation first, showing what it will do
  and the exact command. The folder step lists what it adds to the
  repository.
- Setup: the ways of installing offered are the tracker's install script,
  mise, Homebrew and npm, each only when its tool is on the computer.
- Setup: the agents offered are Claude Code and Codex, each as its own step.
- Setup: a greyed-out menu entry says why beside it: "installed", "done",
  "install beads first", "set up the folder first", "running…".
- Setup: while a terminal is running, the card says which step and the
  steps cannot be started. When it ends the panel reloads by itself. If it
  failed, the card says so, shows the last lines it printed, and the step
  can be started again.
- Setup: skipped steps are remembered per folder, on this computer.
- Setup: Airbender's rules are added at the end of the instructions file,
  between two marker lines, leaving the rest untouched. They are: every
  piece of work has an issue; make the issue being worked on the current
  one; ask the issue's open questions first; requirements, then plan, then
  build; record decisions on the issue; do not close the issue; commit when
  the owner has closed it, one commit per issue with its id and title.
- Setup and CLAUDE.md: how the file stands is found without following a
  link. The choice for a file of its own is asked in a terminal, or given
  as `--claude link` or `--claude rules`, and offered in the panel's
  window with neither picked; with nobody to ask and no answer nothing is
  changed and the option is named. "Link" makes a relative link to
  AGENTS.md. Text of the owner's own in the file is added to the end of
  AGENTS.md first, unless it is there already word for word, so that no
  agent loses it; the tracker's generated block, the pointer text an
  earlier setup wrote and the import lines are not carried. What the file
  held is saved in the repository's git folder and the step says where;
  if a link cannot be made on the computer the file is put back. "Rules"
  writes the rules block into the file and leaves its other text; once a
  CLAUDE.md holds the block the choice is not asked again, and later
  versions of the rules update both files. A link to some other file is
  left alone and said to be; so is a CLAUDE.md that is a folder. Where
  AGENTS.md is the link and CLAUDE.md the file, the two are one file all
  the same, and nothing is asked. A CLAUDE.md that cannot be read is not
  touched: the step refuses. `[c9l.12]`
- The instructions step's window: each thing the owner has to decide is a
  block of its own, with a heading that names it ("The rules in
  AGENTS.md", "CLAUDE.md"), what was found, and its two answers under it;
  the blocks are numbered when there are two. What the step does without
  asking is a separate list under them ("Also done, without asking"), and
  what it leaves alone another ("Left as it is"). The button reads "Choose
  both to continue" or "Choose to continue" until every decision is
  answered, then "Apply"; with nothing to decide it reads "Update", "Add"
  or "Replace". `[c9l.12]`
- The setup card while a step is applied: from the owner's confirmation
  until the folder's setup has been read again, the step shows a spinner
  and "Applying: …" in place of its buttons, and the other steps on the
  card cannot be started. `[c9l.12]`
- Setup and import lines: the lines `@AGENTS.md` and `@FACTS.md` are
  taken out wherever they stand as a line of their own, starting at the
  first column and outside a fenced block of code, in AGENTS.md and in a
  CLAUDE.md that is a file. A line that only looks like one, in an example
  the owner wrote, is left. Where that is all there is to do, the
  step is called "Update Airbender's instructions for agents". The rules
  are version 4. `[c9l.12]`
- Setup: Airbender's rules name the few tracker commands an agent needs,
  say where standing facts are kept, and carry a version. A block of an
  earlier version, unchanged, is replaced where it stands; a block the
  owner edited is left as it is, and the confirmation says so. `[c9l.8]`
- Setup: only what stands between the tracker's own markers is removed.
  Text the tracker wrote without markers (its "Quick Reference", its
  opening lines) is left, and the confirmation names it for the owner to
  remove. `[c9l.8]`
- Setup: the tracker's hooks are found in the files they are in, in the
  repository's main folder, and removed with the tracker's own command for
  that. Hooks installed for the whole computer are not touched. `[c9l.8]`
- Setup: the facts file is FACTS.md at the repository's root, one line per
  fact under a short key. In the facts step every saved fact is ticked to
  begin with; the unticked ones stay in the tracker. A line at the top of
  the file records that they were looked at, so the step is not offered
  again on another computer. `[c9l.8]`
- Setup: on a repository where the instructions step has something of the
  tracker's to remove it is called "Replace beads' instructions with
  Airbender's"; otherwise "Add Airbender's instructions for agents".
  `[c9l.8]`
- Setup: nothing is offered for a folder on another machine or when no
  project is chosen.
- For "all sub-issues are blocked", only open sub-issues count, and it
  works through every level: a sub-issue with sub-issues of its own counts
  as blocked by the same rule. An issue whose sub-issues are all closed is
  not blocked. Its "blocked" tooltip reads "All its sub-issues are blocked".
  Nothing is written to the tracker for this; it only changes how the tab
  groups and tags the issue.
- A sub-issue blocked through the issue it sits inside names that issue's
  blockers in its tooltip.
- Sub-issue (parent and child) is one of the tracker's link kinds but is
  not offered in the Link box; it has its own controls.
- A "related" link is recorded on both issues, has no direction, and its
  swap button is off. It shows as one chip on each issue.
- A link pointing at this issue from another reads "blocks · title" for a
  blocking link and "title · discovered from this" (and likewise) for the
  other kinds. A closed issue's title in a chip is struck through.
- The Links line is shown only when the issue has links. Links to issues
  that are not in the list are not shown.
- The Link box lists every issue except the open one, open issues first,
  and closed ones struck through. Enter takes the first result; Escape
  cancels. Removing a link does not ask for confirmation.
- The Link button is not shown on a closed issue; its chips and their ×
  still are.
- When the tracker refuses a link (it exists already, or it would make a
  loop), its message is shown.
- Workflow: when the owner approves or accepts in the conversation, the
  agent records that, quoting their words, so the owner need not also press
  the button. It may not record an approval that was not given.
- Workflow: the agent cannot move an issue to Apply or past it by its own
  judgment; those steps are reached only through the owner's acceptance and
  then their choice.
- Workflow: every move the agent makes by its own judgment needs a reason,
  which is recorded on the issue.
- Workflow: whether work is "on its own branch" is read from the folder: its
  current branch compared with the repository's main one. When that cannot
  be told, the button reads "Commit".
- "Agree & continue" sends "LGTM. Agreed with your recommendations. Go
  ahead." (the owner's wording `[ahs]`). Beside a step's own buttons it
  makes no move in the workflow by itself: the agent reads the sentence,
  records the approval and goes on; at the review of finished work it
  does not say whether to commit.
  Its tooltip shows its name and its message. It is disabled while the
  agent is working.
- On the line above the message box the step chip carries the person or
  robot for whose work is next, and the prompt is stronger when it is the
  owner's turn. The card opens after about a tenth of a second of hovering.
- The prompt could not be shown as the grey hint text of the empty message
  box, which is where the owner first wanted it: the app does not let a
  product change that text.
- The contextual buttons are, at the owner's steps, their main move and any
  move that takes the issue back ("Send back"). Moves that close the issue
  or are rare (skip, mark as done, cancel), and the button that starts an
  agent's step, are in the panel only.
- "Send back" in the message box takes its reason from what is typed there,
  hands it to the agent with the move, and empties the box. With nothing
  typed it asks the owner to type what should change first.
- The prompts read: "Please review the definition and give feedback.",
  "Please review the plan and give feedback.", "Please review the results
  and give feedback."; for a new issue, "Not started yet. Press Define when
  you want the agent to begin."; and at an agent's step a quieter sentence
  saying what the agent is doing, such as "The agent is planning the work."
- "Agree & continue" comes last among the product's buttons in the message
  box; at an agent's step and with no current issue it is the only one. The app decides where a product's buttons sit
  in the box; it is not placed between the app's send and microphone
  buttons.
- The line and the buttons appear only in an existing conversation, not on
  the New thread screen. The app does not draw what is inside the message
  box in its compact layout; the line above it stays.
- The current issue's card shows, top to bottom: "Current issue" and when it last
  changed; the parent's title, for a sub-issue; the title; the ID (which
  copies itself when clicked) with status, priority, type and category; the
  description as formatted text; what "done" means, when the issue says;
  and the sub-issues with a progress bar, closed ones struck through. Long
  text scrolls inside the card. The card is read-only and opens upwards.
- The card is about a quarter wider than it first was, at the owner's
  request, and never wider than most of the window. The epic's card is the
  same card, headed "Epic", and opens downwards from the epic band.
- A card opened by a click stays until a click outside it or Escape. A
  card opened by hovering goes away shortly after the pointer leaves both
  the line and the card; clicking the line meanwhile keeps it.
- The line follows changes to the current issue by itself.
- The grouping menu offers none, priority, type and category, with a tick on
  the active one; its button names the active grouping ("By priority").
- The filter still narrows every group below Current, not only Ready, though
  its button is on the Ready heading.
- The Ready heading is always shown, even with no issues under it, so its
  two controls can always be reached. An empty Ready says "No ready issues."
  or "No ready issues match the filter."
- Each sub-group has a heading with its name and how many issues it holds,
  and a chevron that collapses it. The Ready heading keeps the total.
- Sub-groups are ordered: priority from P0 to P4; type in the order of the
  type dropdown, then any other type alphabetically; category
  alphabetically. Issues with no value come last, under "No priority", "No
  type" or "No category". A sub-group with no issues is not shown.
- The filter is applied first; grouping divides what is left.
- An issue is placed by its own value, and its sub-issues stay under it
  whatever their own values are.
- The chosen grouping and the collapsed sub-groups are remembered per
  repository, on this computer, with the filter. Collapsed sub-groups are
  remembered separately for each grouping.
- The category is kept in the tracker as a label, `category:<name>`, so the
  tracker's own tools show it. That label is not shown among an issue's
  other labels.
- A category name is at most 40 characters and cannot contain a comma. A
  category written with capital letters by another tool is read as lower
  case.
- A category leaves the list when no issue uses it any more.
- Inheritance happens once, when the sub-issue is created. Changing the
  parent's category later, or moving an issue to another parent, does not
  change the sub-issue's category.
- The category filter includes "No category", is offered once any category
  exists, and is remembered with the rest of the filter.
- Closed issues show their category but it cannot be changed.
- The product was first installed under another internal name. A
  conversation's current issue chosen under that name is still honoured.
- A push that fails does not undo the commit; the failure is reported and
  the commit stays local until it is pushed.
- A commit is not amended once made, since it is already pushed; mistakes
  are fixed with a new commit.
- A tag typed in the title is removed from the title. Tags work in any mix
  of capitals and anywhere in the title, as words of their own. Anything not
  recognised, such as `#123` or `$5`, stays in the title as typed. While
  typing, a line by the field shows what was recognised. A tag in the title
  wins over the same choice made in the form. A category tag is one word:
  letters, digits, `-` and `_`, starting with a letter. A title that is only
  tags is not created. The same works in the details window's field.
- The tag suggestions appear above the field as soon as `#` or `$` starts a
  word and narrow as more is typed; up to eight are shown. Up and Down move
  through them, Tab or Enter completes, Escape closes them, and a click
  picks one. While suggestions are showing, Enter completes the tag instead
  of creating the issue. They disappear once a tag is typed in full.
  Picking a category whose name is not a single word sets the category
  without putting a tag in the title.
- Within a group, issues are ordered by priority, most urgent first, then by
  most recently changed.
- New issues default to type "task" and priority 2 when none is chosen.
- The types offered are task, feature, bug, chore, epic and decision.
  Priorities run from P0 (most urgent) to P4.
- A closed top-level row has a Reopen button; a closed sub-issue has it
  inside the opened sub-issue. Reopening does not ask for confirmation.
  A reopened issue comes back as open and does not become current again.
- Closed issues cannot be edited, and their priority and type cannot be
  changed.
- An issue that is waiting on unfinished work cannot be closed; the panel
  shows the tracker's refusal.
- The filter is remembered per repository folder. Whether closed issues are
  shown is not remembered: they are hidden again each time the panel opens.
- With no closed issues, the Closed heading shows a count of zero and no
  button.
- Messages to the agent (the instruction for a step, the request to
  commit) arrive in the conversation. If the agent is busy, the message
  waits its turn.
- An agent can itself declare which issue its conversation is working on.
- Comments are loaded when their heading is opened, oldest first.
- The description is edited as plain Markdown text. Saving an empty
  description removes it; an empty title cannot be saved.
- Deleting an issue outside the panel is not noticed until the next refresh.
- A parent sits in the status group of its own status; its sub-issues follow
  it there, each showing its own status as a tag.
- A sub-issue that is the current issue is shown in Current, not under its
  parent.
- An open sub-issue whose parent is closed is shown at the top level, in its
  own status group, so it is not hidden inside the folded Closed group.
- The filter applies to top-level issues; the sub-issues of a shown parent
  are always shown.
- Under a parent, open sub-issues come first, then closed ones.
- A closed-up row that has sub-issues says how many it has.
- A compact sub-issue row shows, beside the title, its status and priority
  (and how many sub-issues it has). Its id and type are shown inside the
  opened sub-issue, where priority and type can also be changed.
- The drag anchor of a compact row also appears while the keyboard focus
  is on the row.
- In Current, the opened issue's text and the sub-issue list each scroll
  inside a height limit, so the pinned band leaves room for the list. The
  text's limit is high enough that an opened issue with nothing unfolded
  does not scroll.
- "Move to" lists at most eight matches at a time; Enter takes the first,
  Escape cancels. It offers open issues only, never the issue itself, its own
  sub-issues, or the parent it is already in.
- An issue cannot be moved inside itself or inside one of its own
  sub-issues.
- Dragging does not ask for confirmation.
- A description counts as long above about 240 characters or four lines.
- While a parent is selected in the new-issue field, a line above the field
  names it and has a button to clear it.
- In the details window, after a sub-issue is added the field goes back to
  the issue the window is showing.
- Copying an id is confirmed by a short message; a refused copy says so.
- Tooltips are on every icon-only control and on labelled buttons whose
  effect is not obvious from the label; they also show on keyboard focus.
- The box around the current issue has a thicker border than other rows,
  also green. The green is the theme's own "success" green, mixed lightly
  into the row's normal background.
- The current issue's sub-issues sit on the same green, without the darker
  tint sub-issues have elsewhere.
- In the details window the block of sub-issues keeps its left rail but has
  no darker background.
- The window's new-issue field creates inside the issue the window is
  showing unless another issue inside it was chosen; it cannot create a
  top-level issue. It is not shown for a closed issue.
- "View more" is offered on any issue with a long description, with or
  without sub-issues. In the details window the issue being shown starts
  opened.
- Closing a parent without a commit does not close its sub-issues; while any
  are open the tracker refuses, and the panel shows its message.
- When an epic is closed with its sub-issues, the agent is asked for one
  commit per issue where the changes can be told apart, otherwise one commit
  that lists each issue.
