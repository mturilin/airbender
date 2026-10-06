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

- **Four things can be set up**, in this order:
  1. **Install beads**, when the tracker's program is not on the computer.
     The owner **chooses the way of installing each time**, from the ways
     available on that computer.
  2. **Set up beads in this folder**, when the folder has no issue database.
     This is the most important one.
  3. **Configure beads for the coding agent**, when the folder has beads but
     the tracker's own setup for the agent is missing.
  4. **Add Airbender's rules to the agents' instructions file**, as a
     separate command: the working rules the panel's buttons rely on. The
     owner either enables it or skips it. Where the folder has a
     separate instructions file for Claude Code, the step **also makes that
     file point at the same rules**, and counts as done only when both are
     in place. **It does not create that file.** `[0bk]`
- **What is missing is offered in the middle of the panel**, not hidden in a
  menu, each with its button and a **Skip**.
- **After Skip, a step is only in the menu.**
- **A "⋯" menu in the top right corner lists all of them**, so any can be
  started by hand. **A step that is already done, or is not possible yet, is
  greyed out.**
- **Installing, setting up the folder and configuring the agent run in a
  visible terminal**, so the owner can watch and answer what it asks.
- **What is still missing is re-checked on every refresh. What was found in
  place is not checked again**: the panel does not try to notice that
  something was removed afterwards.

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
  move to, link and close. `[l3m]`
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
  caused by, validates, supersedes. `[zty.4]`
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
- A new issue created in epic mode goes into the epic unless the owner
  chooses otherwise. The details window stays as it is. `[ha9]`

## Creating an issue

- The entry field at the bottom: type a title and press Enter. `[pp7]`
- A chevron beside the field reveals type, priority and description, for
  writing a full issue. Both the quick way and the full way are supported.
  `[pp7]`
- **Tags typed in the title set type, priority and category**, without
  opening the rest of the form: `#` and a type (`#task`, `#bug` and so on)
  sets the type, `#p0` to `#p4` sets the priority, and `$` and a name sets
  the category. `[ky8]`
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
  recommendations and it should go ahead. It is **an icon** with a tooltip,
  on a **gray, square background** like the app's own send button, not on
  white and not round. **It is shown only when the accept and send-back
  buttons are not.** `[eg0]` `[lit]`
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
  whatever its type: a magnifier button on its row beside the button for
  the details window, and a "Focus" button inside the opened issue (which
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
  reads "Start in a new branch", as does the button inside an opened issue
  and, in the message box of the conversation, the button beside "Start".
  Later steps keep their buttons with words.
- Starting in a new branch: the agent makes the branch as the first thing
  it does and says so; the product itself changes nothing in git. If the
  name is taken or the branch cannot be made, the agent stops and says so.
  "Uncommitted changes" are changes to files git tracks; files it does not
  track do not count. The message box reads "Not yet", with the warning
  and an OK button. The title's part of the name is cut at a word after
  about forty characters. Committing without merging leaves the branch.
  The branch on the remote is deleted only once the main branch is there.
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
- Setup: for the file Claude Code reads (CLAUDE.md), the rules step writes
  a short pointer to the agents' instructions file when it holds only the
  tracker's generated, unfilled text; a file with
  the owner's own text is kept, with one pointer line added at the top. The
  confirmation says so. Airbender's rules state that they take precedence
  over the tracker's own instructions where the two disagree.
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
- "Agree & continue" sends "I agree with your recommendations. Go ahead."
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
