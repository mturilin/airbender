See and work a repository's [beads](https://github.com/gastownhall/beads)
issues in a tab beside the conversation, without leaving BB.

## What you get

- An **Airbender** tab in the right-hand panel of every thread, and on the
  New thread screen.
- Issues grouped by what you can do about them: in progress, ready, blocked,
  other, and closed (hidden until you ask). Ready can be grouped by priority,
  type or category, and the list can be filtered.
- A new-issue field that is always there. Type `#bug`, `#p1` or `$category`
  in the title to set type, priority and category as you write.
- Each issue opens to show its description, acceptance criteria, design,
  notes and comments, and can be edited, closed, reopened, moved under
  another issue, or linked with another issue using beads' own link kinds.
- Sub-issues, drawn under their parent, with a details window for deeper
  levels. Drag an issue onto another to nest it.
- **Current issue**: the issue a thread is working on, highlighted on top.
  Press play on an issue to make it current and start the thread's agent on
  it: requirements first, then a plan you approve, then the work.
- **Close & commit**: close the current issue and ask the agent to commit
  its work.
- **Define**: a background agent that writes up a thin issue (what is
  wanted, what done means, a design, open questions).
- In the message box: a pill showing the current issue, and two one-click
  replies, "Go" and "Agree & go".
- **Setup**: when beads is missing from the computer or the folder, the tab
  offers to install it and set the folder up, in a terminal you can watch.

## How it works

The plugin runs the `bd` command-line tool in the folder the thread works in.
Issues stay in beads; the tab shows and changes them there. It follows
changes made elsewhere (an agent, or you in a terminal) by itself. The plugin
never runs git: committing is asked of the thread's agent. Nothing leaves the
machine.

## Requirements

- BB running on the machine that has the repository. Threads whose folder is
  on another machine get an explanation instead of a list.
- `bd` and a folder set up with `bd init`. The tab offers both when they are
  missing.
