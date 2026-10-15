# bend

`bend` reads and changes a repository's issues, the same way whatever
tracker holds them: [beads](https://github.com/gastownhall/beads), or GitHub
issues. Agents use it from a terminal; the Airbender tab runs the very same
program for every read and change, so the two cannot drift apart. It is one
Go program, standard library only, with nothing beside it.

```sh
cd bend && go build -o ~/.local/bin/bend ./cmd/bend
bend --help
```

On Linux and macOS, on amd64 or arm64, the tab's "Install bend" step downloads
the binary from the GitHub release matching the plugin version, verifies its
SHA-256 checksum, and installs it into `~/.local/bin`. It needs `curl` and
`sha256sum` or `shasum`, not Go. A failed download or checksum check leaves
an existing binary untouched. Other platforms retain "Build bend", using
Go 1.24 or later and the source command above. The same source command can
also be run manually on supported platforms.

Release tags `vX.Y.Z` must match the plugin's `package.json` version. The
release workflow tests bend and builds four CGO-free binaries:
`bend-linux-amd64`, `bend-linux-arm64`, `bend-darwin-amd64` and
`bend-darwin-arm64`, each with a `.sha256` file. The installer never selects
"latest" and never replaces a binary before its checksum is verified.

This file is the long form; the repository's [README](../README.md) has the
short one.


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

Setting up beads asks nothing in the terminal: `bd init` runs with
`--non-interactive --role maintainer`.

Airbender is for repositories of your own. Where origin is a fork, or a
GitHub repository your account cannot push to, `bend setup tracker` warns:
Airbender's files would end up in your pull requests. Keep the issues in
GitHub issues in a repository of yours (`--use github --repository
owner/name`: `.bend.json` is then kept out of git in that clone, and no
instructions for agents are added), or set up anyway (`--anyway`).

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

## Beads issues from a copy on this computer

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

## GitHub issues from a copy on this computer

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

## Syncing

bend keeps a repository's issues in step with their remote by itself, for
every tracker, with or without the tab (bead-bb-c9l.16):

- **`bend sync`** syncs now, both ways, and says how it ended (synced,
  failed, busy, conflict, stuck), what was sent and what came in; exit
  status 1 when it did not work. With beads it runs `bd sync`, reads what
  was sent from beads' events journal, and works out what came in by
  comparing the issues before and after; with GitHub issues it sends the
  waiting changes and asks what changed.
- **No `__dolt_remote_info__` branch.** When beads pushes, the Dolt inside
  it also force-pushes a one-file branch of that name, which GitHub then
  shows as "had recent pushes" after every sync. bend switches it off for
  every bd it starts, the setup steps' included (`DOLT_REMOTE_INFO_BRANCH`
  set and empty; a value you set yourself is kept). A `bd` typed in a terminal is not covered: set the
  same variable in your own environment (bead-bb-7lb).
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

Still beads-specific in the tab: the "Import / export GitHub issues…" window
(beads' own mirroring, offered on beads only) and the "bd command" setting.
Switching a repository's tracker is in the tab's menu and, from a terminal,
`bend setup tracker --use github` or `--use beads`.

