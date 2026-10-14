// sync.go — syncing a beads repository's issues with their remote.
//
// What: the beads adapter's side of tracker.Syncer: beads' own `bd sync`
// (pull, check for conflicts, push) against the repository's git remote,
// what was sent read from beads' journal of changes, and whether the remote
// holds the issues at all.
//
// Why: `bd init` leaves the issues on one computer, and the owner wants to
// see what each sync did (bead-bb-6a9). The Airbender plugin used to do
// this; it moved here so that a repository syncs the same from a plain
// terminal (bead-bb-c9l.16). Everything that knows beads' ways is in this
// file, so that nothing of them shows above the tracker layer.
//
// Design notes:
//   - How a run ended is `bd sync`'s exit code, which beads documents for
//     exactly this: 0 synced, 1 error, 2 conflict, 3 busy, 4 stuck.
//   - What was sent comes from beads' events journal: every change made
//     through beads on this computer, each with a sequence number that only
//     grows. One number is remembered, the journal's head at the last good
//     sync; "what is pending" is everything after it. `bd sync` itself
//     reports no counts.
//   - What was brought in cannot come from the journal, which by beads'
//     design does not record what a pull brings. The layer above compares
//     the issues before and after; this file only names the issues changed
//     here around the run, whose difference is this side's doing.
//   - The journal is off by default and records only while on. It is
//     switched on the first time a sync is looked at here; until there is a
//     position in it, what was sent is "not known", never guessed.
//   - A remote that holds nothing is not synced with: `bd init` takes the
//     git origin as the remote and pushes nothing, and `bd sync` pulls first
//     and fails on such a remote, every time (bead-bb-fmr).
//
// Gotchas:
//   - A journal position means nothing on another computer, and beads fails
//     a read below what its retention kept (seven days by default). Either
//     way a new position is taken and "not known" is said once.
//   - What is remembered between runs is one file in the folder the layer
//     above hands in. "The remote holds the issues" is remembered for good;
//     any other answer for half a minute, since a setup step that has just
//     run changes exactly that.

package beads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

const (
	// syncTimeout is how long a whole `bd sync` may take.
	syncTimeout = 5 * time.Minute
	// remoteAskedFor is how long "the issues are synced with nothing" is
	// believed.
	remoteAskedFor = 30 * time.Second
	// syncFile is the file kept between runs, in the folder handed in.
	syncFile = "beads-sync.json"
	// syncedWith is what a beads repository's issues are synced with, in
	// words for the owner.
	syncedWith = "the repository's git remote"
)

// Ran is one run of a program: how it exited and what it printed. Code is
// -1 when it did not run or was killed.
type Ran struct {
	Code   int
	Stdout string
	Stderr string
}

// remembered is what is kept between runs.
type remembered struct {
	// Position is the journal's head at the last good sync; nil for none
	// taken yet.
	Position *int `json:"position"`
	// JournalOn says the journal was found switched on.
	JournalOn bool `json:"journalOn"`
	// Holds says the remote is known to hold the issues; it stays so.
	Holds bool `json:"holds"`
	// Asked is the last answer about the remote that was not "holds", and
	// when (seconds since 1970).
	AskedAt    int64  `json:"askedAt,omitempty"`
	AskedState string `json:"askedState,omitempty"`
}

// readRemembered reads what is kept in keep; the zero value when nothing
// is, or it cannot be read.
func readRemembered(keep string) remembered {
	var held remembered
	if content, err := os.ReadFile(filepath.Join(keep, syncFile)); err == nil {
		if json.Unmarshal(content, &held) != nil {
			return remembered{}
		}
	}
	return held
}

// write keeps held in keep. A failure is not reported: what is lost is
// asked again.
func (held remembered) write(keep string) {
	content, err := json.MarshalIndent(held, "", " ")
	if err != nil || os.MkdirAll(keep, 0o755) != nil {
		return
	}
	temporary := filepath.Join(keep, syncFile+".new")
	if os.WriteFile(temporary, append(content, '\n'), 0o644) == nil {
		os.Rename(temporary, filepath.Join(keep, syncFile))
	}
}

// EndOf says what `bd sync`'s exit code means, in the tracker layer's
// words.
func EndOf(code int) tracker.SyncEnd {
	switch code {
	case 0:
		return tracker.SyncSynced
	case 2:
		return tracker.SyncConflict
	case 3:
		return tracker.SyncBusy
	case 4:
		return tracker.SyncStuck
	}
	return tracker.SyncFailed
}

// journalKinds maps the journal's operations to kinds of change.
var journalKinds = map[string]string{
	"create":     tracker.ChangeCreated,
	"update":     tracker.ChangeUpdated,
	"close":      tracker.ChangeClosed,
	"delete":     tracker.ChangeDeleted,
	"comment":    tracker.ChangeComment,
	"dep_add":    tracker.ChangeLink,
	"dep_remove": tracker.ChangeLink,
}

// ChangesFrom reads journal records into changes per issue.
//
// lines is what `bd events tail` or `export` printed: one JSON record a
// line, `{seq, op, issue_id, ...}`. A line that is not such a record is
// passed over.
// Returns the changes, one per issue in the order first seen, and the
// highest sequence number among the records; found is false when there
// were none.
func ChangesFrom(lines string) (changes []tracker.SyncChange, head int, found bool) {
	changes = []tracker.SyncChange{}
	at := map[string]int{}
	for _, line := range strings.Split(lines, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record struct {
			Seq     *int    `json:"seq"`
			Op      string  `json:"op"`
			IssueID *string `json:"issue_id"`
		}
		if json.Unmarshal([]byte(line), &record) != nil || record.Seq == nil || record.IssueID == nil {
			continue
		}
		if !found || *record.Seq > head {
			head, found = *record.Seq, true
		}
		kind, known := journalKinds[record.Op]
		if !known {
			// An operation this file does not know still counts as a change.
			kind = tracker.ChangeUpdated
		}
		index, seen := at[*record.IssueID]
		if !seen {
			index = len(changes)
			at[*record.IssueID] = index
			changes = append(changes, tracker.SyncChange{ID: *record.IssueID, Kinds: []string{}})
		}
		if !slices.Contains(changes[index].Kinds, kind) {
			changes[index].Kinds = append(changes[index].Kinds, kind)
		}
	}
	return changes, head, found
}

// raw runs bd with these arguments and gives how it exited; long for a run
// that may take minutes. It does not fail: a bd that is missing or was
// killed gives code -1.
func (beads *Tracker) raw(args []string, long bool) Ran {
	if beads.runs != nil {
		return beads.runs(args, long)
	}
	limit := bdTimeout
	if long {
		limit = syncTimeout
	}
	return run(beads.dir, limit, beads.command, args...)
}

// git runs a read-only git command in the repository; ok is false when it
// failed.
func (beads *Tracker) git(args ...string) (string, bool) {
	if beads.gits != nil {
		return beads.gits(args)
	}
	ran := run(beads.dir, bdTimeout, "git", args...)
	return strings.TrimSpace(ran.Stdout), ran.Code == 0
}

// run runs a program in a folder, for at most limit.
func run(dir string, limit time.Duration, program string, args ...string) Ran {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	command := exec.CommandContext(ctx, program, args...)
	command.Dir = dir
	command.Env = Environment()
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	// A group of its own, ended whole when the limit passes: the program
	// starts others (its database), and one left behind would go on
	// holding the data, and the pipes this run waits on.
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }
	command.WaitDelay = 5 * time.Second
	err := command.Run()
	code := 0
	if err != nil {
		code = -1
		var exited *exec.ExitError
		if errors.As(err, &exited) && exited.ExitCode() >= 0 {
			code = exited.ExitCode()
		}
		if stderr.Len() == 0 && code == -1 {
			stderr.WriteString(err.Error())
		}
	}
	return Ran{Code: code, Stdout: stdout.String(), Stderr: stderr.String()}
}

// RemoteState says where the repository's issues stand with a remote:
// "none", beads has no remote for them; "empty", it has one that nothing
// was ever sent to; "holds", the remote holds them; "unknown", it could not
// be told now (the remote was not reached).
//
// Side effects: one run of bd, and one question to the git remote.
func (beads *Tracker) RemoteState() string {
	listed := beads.raw([]string{"dolt", "remote", "list", "--json"}, false)
	if listed.Code != 0 {
		return "unknown"
	}
	var remotes []struct {
		URL *string `json:"url"`
	}
	if json.Unmarshal([]byte(listed.Stdout), &remotes) != nil {
		return "unknown"
	}
	if len(remotes) == 0 {
		return "none"
	}
	// Beads keeps the issues on a git remote under refs/dolt/data. A remote
	// that is not a git repository cannot be asked this way: taken as
	// holding.
	if remotes[0].URL == nil || !strings.HasPrefix(*remotes[0].URL, "git+") {
		return "holds"
	}
	answer, ok := beads.git("ls-remote", strings.TrimPrefix(*remotes[0].URL, "git+"), "refs/dolt/data")
	switch {
	case !ok:
		return "unknown"
	case answer == "":
		return "empty"
	}
	return "holds"
}

// SyncsWith is tracker.Syncer's: what the issues are synced with, "" when
// syncing is not switched on.
func (beads *Tracker) SyncsWith(keep string) (string, bool) {
	held := readRemembered(keep)
	if held.Holds {
		return syncedWith, true
	}
	state := held.AskedState
	if state == "" || time.Since(time.Unix(held.AskedAt, 0)) >= remoteAskedFor {
		state = beads.RemoteState()
		// Read again: the question took a while, and a sync may have moved
		// the position meanwhile.
		held = readRemembered(keep)
		if state == "holds" {
			held.Holds, held.AskedAt, held.AskedState = true, 0, ""
		} else {
			held.AskedAt, held.AskedState = time.Now().Unix(), state
		}
		held.write(keep)
	}
	switch state {
	case "holds":
		return syncedWith, true
	case "unknown":
		return "", false
	}
	return "", true
}

// head gives the journal's present head, 0 for an empty journal or one
// that cannot be read.
func (beads *Tracker) head() int {
	all := beads.raw([]string{"events", "export"}, false)
	if all.Code != 0 {
		return 0
	}
	_, head, _ := ChangesFrom(all.Stdout)
	return head
}

// journal makes sure beads is keeping its journal, and that there is a
// position in it to read from.
//
// check asks beads whether the journal is on even when it was found on
// before (someone may have switched it off).
// Returns the position; ok is false when it was only now taken (or cannot
// be): what happened before it is not known.
func (beads *Tracker) journal(keep string, check bool) (position int, ok bool) {
	held := readRemembered(keep)
	fresh := false
	if !held.JournalOn || check {
		asked := beads.raw([]string{"config", "get", "events-journal"}, false)
		if strings.TrimSpace(asked.Stdout) != "true" {
			if beads.raw([]string{"config", "set", "events-journal", "true"}, false).Code != 0 {
				return 0, false
			}
			fresh = true
		}
		held = readRemembered(keep)
		held.JournalOn = true
		held.write(keep)
	}
	if held.Position != nil && !fresh {
		return *held.Position, true
	}
	// No position yet: take the journal's present head, and say nothing
	// about what came before.
	beads.setPosition(keep, beads.head())
	return 0, false
}

// setPosition keeps a new journal position.
func (beads *Tracker) setPosition(keep string, position int) {
	held := readRemembered(keep)
	held.Position = &position
	held.write(keep)
}

// since gives the journal's records after a position.
//
// ok is false when beads cannot give them (the position was pruned away,
// or belongs to another computer's journal): a new position is then taken.
func (beads *Tracker) since(keep string, position int) (changes []tracker.SyncChange, head int, ok bool) {
	ran := beads.raw([]string{"events", "tail", "--since", strconv.Itoa(position)}, false)
	if ran.Code != 0 {
		beads.setPosition(keep, beads.head())
		return nil, 0, false
	}
	changes, head, found := ChangesFrom(ran.Stdout)
	if !found {
		head = position
	}
	return changes, head, true
}

// Pending is tracker.Syncer's: the changes made here that were not sent.
func (beads *Tracker) Pending(keep string) ([]tracker.SyncChange, bool) {
	position, ok := beads.journal(keep, false)
	if !ok {
		return nil, false
	}
	changes, _, ok := beads.since(keep, position)
	return changes, ok
}

// SyncOnce is tracker.Syncer's: one `bd sync`.
//
// Side effects: beads' database and the remote; the journal position moves
// to the journal's head as it was before a run that ended well.
func (beads *Tracker) SyncOnce(keep string) tracker.SyncRun {
	position, known := beads.journal(keep, true)
	var mine []tracker.SyncChange
	head := 0
	if known {
		mine, head, known = beads.since(keep, position)
	}
	ran := beads.raw([]string{"sync"}, true)
	end := EndOf(ran.Code)
	if end != tracker.SyncSynced {
		// Nothing was sent; what is pending stays pending.
		words := strings.TrimSpace(ran.Stderr)
		if words == "" {
			words = strings.TrimSpace(ran.Stdout)
		}
		if words == "" {
			words = "bd sync did not run."
		}
		lines := strings.Split(words, "\n")
		if len(lines) > 8 {
			lines = lines[len(lines)-8:]
		}
		return tracker.SyncRun{End: end, Message: strings.Join(lines, "\n")}
	}
	if !known {
		// Without the journal this side's own changes cannot be told from
		// the other's, so nothing is claimed.
		return tracker.SyncRun{End: end}
	}
	changedHere := []string{}
	for _, change := range mine {
		changedHere = append(changedHere, change.ID)
	}
	// Changed here while the sync ran: not brought in, and for next time.
	if during, _, ok := beads.since(keep, head); ok {
		for _, change := range during {
			if !slices.Contains(changedHere, change.ID) {
				changedHere = append(changedHere, change.ID)
			}
		}
	}
	beads.setPosition(keep, head)
	return tracker.SyncRun{End: end, Sent: mine, SentKnown: true, ChangedHere: changedHere}
}
