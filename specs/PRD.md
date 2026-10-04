# Beads Tab — Product Requirements

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

A panel inside the coding-agent app, next to a conversation with an agent. It
shows the issues of the repository that conversation is working in, lets the
owner manage them, and connects them to the agent: start the agent on an
issue, have an agent write an issue up, and have the agent commit the work
when the owner accepts it.

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

Four bands, top to bottom. `[pp7]`

1. **Current** — the issue this conversation is working on. Stays in place
   when the list scrolls.
2. **Toolbar** — the repository folder, the filter, and a refresh button.
   Stays in place.
3. **Groups** — all other issues. The only part that scrolls.
4. **New issue** — an entry field that is always there, fixed at the bottom.

Rules for the layout:

- Current is a group like the others and looks like them: a heading and one
  row. It is not a large card. `[pp7]`
- Every issue is one row with a chevron on the left. Opening the chevron
  shows the rest. Rows start collapsed, except an issue that has sub-issues
  (see "Sub-issues"). A long issue must never push the rest of the panel
  down. `[pp7]`
- The Current row is the same width as the rows in the groups. `[d37]`
- The refresh button is small and shows only an icon: two circular arrows.
  It does not say "Refresh". `[pp7]`

## The groups

In this order: `[02g]` `[a28]`

- **In progress** — work has started.
- **Ready** — open, and not waiting on any unfinished issue.
- **Blocked** — waiting on at least one unfinished issue.
- **Other** — any other status.
- **Closed** — "Finished or cancelled."

Rules:

- The current issue appears only in Current, not also in its status group.
  `[pp7]`
- The Closed heading is always shown, with its count. Its issues are hidden
  by default. A Show / Hide button on the heading reveals and hides them.
  `[a28]`

## The filter

- One filter control in the toolbar. It filters by **type** and by
  **priority**. `[pp7]`
- Filtering hides issues. It does not regroup them. `[pp7]`
- The filter never hides the current issue. `[pp7]`
- The filter is remembered. `[pp7]`
- Showing closed issues is not part of the filter; it is the Closed heading's
  own button. `[a28]`

## An issue row

This describes a top-level row. A sub-issue's row is leaner and is described
under "Sub-issues".

Collapsed, a row shows the title, the issue id, its priority and its type.

- **Priority and type are changed right on the row**, for open issues.
  `[ssf]`
- Buttons on the row are described under "Starting work", "Define" and
  "Closing".

## An opened issue

Opening a row shows:

- The description. **A long description is cut short**, to about four lines,
  with "View more". View more opens the details window on that issue, where
  the whole description is shown. `[5qt]`
- **Acceptance criteria, design, notes, close reason and comments** — each
  under its own heading, **collapsed to start**, opened on its own chevron.
  Parts that are empty are not shown. `[un8]`
- An **Edit** button, for open issues. It turns the title and the description
  into a form with Save and Cancel. Clicking a title does not edit it; it
  opens the issue. `[vve]`
- The Define button (see "Define").

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
- **Every issue that has sub-issues has a details button.** It opens a modal
  window showing that issue with its sub-issues, one level deep.
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
  change its type and priority, close it, Define it, add a sub-issue, and
  drag to re-nest. Play closes the window.
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
  - a sub-issue row has no buttons, not even on hover. Play, Define,
    close and the way into the details window are inside the opened
    sub-issue. Only the drag anchor appears while the pointer is on the row.

## Creating an issue

- The entry field at the bottom: type a title and press Enter. `[pp7]`
- A chevron beside the field reveals type, priority and description, for
  writing a full issue. Both the quick way and the full way are supported.
  `[pp7]`
- **A parent can be selected there**, so the new issue is created inside
  another issue. "Add sub-issue" on an issue selects it for you. `[5qt]`

## Current

One conversation works on at most one issue at a time: its current issue.

- The Current group is first, above everything else. `[pp7]`
- It has two extra buttons: **Clear** (stop treating this issue as current)
  and **Define**. `[pp7]`
- **A closed issue stops being current**, however it was closed: from the
  panel, by the agent, or from a terminal. The panel must show this on its
  own, without the owner pressing refresh. `[p49]` `[m4b]`

## Starting work (play)

- **While there is no current issue, every open issue can be started with
  play.** A top-level issue has the play button on its row; a sub-issue has
  it inside the opened sub-issue. `[pp7]` `[5qt]`
- Play makes the issue current and directs the conversation's agent to work
  on it. `[pp7]`
- The agent then goes through these steps, in this order: `[avf]`
  1. **Requirements.** Make clear what is wanted, why, and what "done" means.
     Ask the owner what is unclear. Record the result on the issue.
  2. **Implementation plan.** Say what will change and how. Wait for the
     owner's approval. Record the plan on the issue.
  3. **Build.**
- **The agent may skip step 1 or step 2 when it is obvious**, at its own
  judgment, and must say that it skipped it. `[avf]`
- **Open questions come first.** If the issue has open questions for the
  owner, the agent asks them and waits. Pressing play is not permission to
  assume the answers. `[avf]`
- The thinking in steps 1 and 2 is done by the conversation's own agent, in
  the conversation. Play does not hand it to another agent. `[avf]`
- **Play on an issue that has sub-issues** directs the agent to work on that
  issue and all its sub-issues together. `[5qt]`
- **The agent does not close the issue when it finishes.** It records what it
  did and how it checked it, leaves the issue in progress, and tells the owner
  it is ready. The owner validates and closes. `[e1d]`

## Define

Define turns a bare request into a clear, buildable issue: what is wanted and
why, what "done" means, and a proposed approach.

- It is done by an agent **in the background, not in the current
  conversation**. `[4la]`
- It must **not appear as a separate conversation** in the app. A background
  agent is acceptable. `[4la]`
- It is shut down when it is done. `[4la]`
- It runs on the Fable model. The model can be changed in the settings.
  `[4la]`
- It only writes onto the issue. It does not start the work, change files or
  close the issue. `[4la]`
- **A top-level issue with no description shows the Define button on its
  row**, as an icon-only button of the same kind as the cancel button. Other
  issues, and all sub-issues, have it inside the opened issue. `[4la]`
  `[5qt]`
- The name is **Define** everywhere. `[—]`

## Closing

Every open issue can be closed from the panel, and **closing always asks for
confirmation**. `[pp7]`

There are two different actions, with two different icons: `[0rg]` `[d37]`

- **Close & commit** — the work is validated and should be committed. This is
  the expected outcome. It exists only for the **current** issue. It closes
  the issue and tells the conversation's agent to commit that issue's work.
- **Close without commit** — the issue is not needed; this is a cancel. It is
  the only way to close a backlog issue.

**Close & commit on an issue with sub-issues closes all of them**: the issue
and every sub-issue still open inside it, at any depth. The confirmation
says how many sub-issues will be closed. `[5qt]`

How they are presented: `[d37]`

- On the current issue's row, the only close button is Close & commit. It is
  an ordinary gray button with an icon and the words "Close & commit". No
  green.
- For the current issue, Close without commit is less prominent: it is shown
  only inside the opened issue.
- On a top-level backlog row, the close button is a muted icon. A sub-issue
  is closed from inside the opened sub-issue. `[5qt]`
- Confirmation for a backlog issue asks only "Are you sure you want to close
  this issue?", with **Close** and **Cancel**. It does not mention commits,
  because committing does not apply there.
- Confirmation for the current issue says whether a commit will follow.

## Staying up to date

- The panel refreshes on its own when issues change outside it: an agent or
  the owner working in a terminal. `[6v6]`
- This is triggered by watching for the change, not by checking on a timer.
  `[6v6]`

## How agents work with it

These rules apply to any agent working in a repository that uses the product.

- **Record as much as possible on the issue**: the intent in the owner's
  words, the design, every decision with its reason, and what was tried.
  Chat is lost; the issue is not. `[—]`
- **Requirements, then plan, then build**, as under "Starting work". `[avf]`
- **Do not close issues.** The owner validates and closes. `[e1d]`
- **Commit after the owner closes an issue.** One commit per issue. The
  commit message carries the issue's id and its description. Nothing is
  pushed unless asked. `[d37]`
- **Update this spec with every change.** The spec and the implementation
  are updated in the same commit. Requests that are not built yet stay in
  the tracker and are not written here. `[wie]`

## What it is not

- **Not a second issue tracker.** Issues live in beads; the panel shows and
  changes them there. `[02g]`
- **Not a place in the left sidebar.** `[02g]`
- **Not an auto-closer.** Nothing closes an issue except the owner, or an
  agent the owner told to. `[e1d]`
- **Not a git tool.** The panel never commits by itself; it asks the agent
  to. `[d37]`
- **Not multi-machine.** It reads the repository on the machine the app
  itself runs on. `[02g]`
- **No picker beside the message box.** Choosing the issue to work on from
  the message area was dropped in favour of the panel. `[prr]`

## Unspecified details

Behaviour the owner did not ask for or decide. It is what the product does
today, recorded so a rebuild matches. Any of it may be changed without
breaking a requirement above.

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
- Play is offered only while there is no current issue. To switch, press
  Clear first.
- Play and Close & commit reach the agent as a message in the conversation.
  If the agent is busy, the message waits its turn.
- While Define runs, the row is marked "defining…" and its button opens the
  background agent. Define is stopped after 20 minutes if it has not
  finished. What Define writes is signed as "define agent", not as the owner.
- Define is asked to keep its write-up short, to stay inside the request, and
  to raise at most three open questions, each with the answer it would
  assume.
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
- In Current, the opened description and the sub-issue list each scroll
  inside a height limit, so the pinned band leaves room for the list.
- "Move to" lists at most eight matches at a time; Enter takes the first,
  Escape cancels. It offers open issues only, never the issue itself, its own
  sub-issues, or the parent it is already in.
- An issue cannot be moved inside itself or inside one of its own
  sub-issues.
- Dragging does not ask for confirmation.
- A description counts as long above about 240 characters or four lines.
- While a parent is selected in the new-issue field, a line above the field
  names it and has a button to clear it. The parent stays selected after an
  issue is created, so several sub-issues can be added in a row.
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
