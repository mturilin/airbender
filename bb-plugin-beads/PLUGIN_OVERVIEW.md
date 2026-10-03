See a repository's [beads](https://github.com/gastownhall/beads) issues in a
tab beside the conversation, without leaving BB.

## What you get

- A **Beads issues** tab in the right-hand panel of every thread, and on the
  New thread screen.
- Issues grouped by what you can do about them: in progress, ready, blocked,
  and closed (hidden until you ask).
- Each issue opens to show its description, what it waits on, and what it
  holds up.

## How it works

The plugin runs the `bd` command-line tool in the folder the thread works in
and shows what it reports. It only reads: nothing in the app can change an
issue. Nothing leaves the machine.

## Requirements

- `bd` installed on the machine BB runs on.
- A folder set up with `bd init`.
