// report.go — one sync, one report, whatever the tracker; the log of them;
// and what is wrong with a repository's syncing, in one place.
//
// What: SyncNow runs a sync of the repository's issues with their remote
// and reports it as one entry, in the same shape for a tracker whose
// changes wait in bend's queue and for one that has a sync of its own. The
// entries are kept as a log in the copy's folder. SyncStatus reads how
// things stand without syncing anything, and works out the trouble, if
// any, that the owner has to be told of.
//
// Why: syncing is bend's, for every tracker, and whoever shows it (a
// terminal, the Airbender tab) only shows (bead-bb-c9l.16). The log is in
// the repository's shared git folder so that all of them read the same
// one. The owner asked that failures be shown prominently, "because ... it
// can mess up the data": what counts as trouble is decided here once, so a
// terminal and the tab cannot disagree.
//
// Design notes:
//   - Nothing here names a tracker. Two questions are asked of it: does it
//     queue its changes (About().Writes), and has it a sync of its own
//     (tracker.Syncer).
//   - "Not known" is null in an entry, for what was sent and what came in.
//   - "Syncing has stopped by itself" is not kept anywhere: it is the last
//     entry being a conflict or stuck.
//   - A run that found another of bend's syncs running and did nothing
//     leaves no entry: the other one leaves its own.
//   - A stop (conflict, stuck) holds until a sync ends well. A sync that
//     merely fails afterwards (the network was off when the owner pressed
//     Refresh) does not lift it.
//   - Runs that ended well with nothing sent and nothing brought in, one
//     after another, are kept as one entry with a count: a clock that ticks
//     every three minutes would otherwise push everything worth reading out
//     of the log in a few hours.
//
// Gotchas:
//   - For a tracker with a sync of its own, what came in is worked out by
//     comparing the copy's issues before and after, so it is "not known"
//     the first time, when there was no copy before.

package kept

import (
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/helper"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

const (
	// runsFile is the log of syncs, oldest first.
	runsFile = "sync-runs.json"
	// RunsFile is the same, for a caller that watches it for changes.
	RunsFile = runsFile
	// runsKept is the most entries kept.
	runsKept = 200
	// adapterFolder is where a tracker with a sync of its own keeps what it
	// remembers between runs, inside the copy's folder.
	adapterFolder = "tracker"
)

// What can set a sync off.
const (
	// CauseAsked: someone asked for it (`bend sync`, the tab's Refresh).
	CauseAsked = "asked"
	// CauseTimer: the helper's clock.
	CauseTimer = "timer"
	// CauseChange: a change was made through bend a moment before.
	CauseChange = "change"
	// CauseRead: a read found the copy a few minutes old.
	CauseRead = "read"
)

// Causes is every cause a caller may name.
var Causes = []string{CauseAsked, CauseTimer, CauseChange, CauseRead}

// Entry is one sync, as the log keeps it.
type Entry struct {
	End tracker.SyncEnd `json:"end"`
	// Message is the tracker's own words about a run that did not end
	// synced, or about changes it refused; else "".
	Message string `json:"message"`
	// Sent is what this side sent; null when it is not known.
	Sent []tracker.SyncChange `json:"sent"`
	// BroughtIn is the issues that came in new or changed; null when it is
	// not known.
	BroughtIn []string `json:"broughtIn"`
	// At is when it ended (milliseconds since 1970); Seconds how long it
	// took.
	At      int64  `json:"at"`
	Seconds int    `json:"seconds"`
	Cause   string `json:"cause"`
	// Refused is how many changes the tracker refused for good in this
	// run; Waiting how many still wait to be sent after it.
	Refused int `json:"refused"`
	Waiting int `json:"waiting"`
	// Runs is how many runs this entry stands for: more than 1 for runs
	// that ended well with nothing to do, one after another.
	Runs int `json:"runs"`
}

// quiet says the run ended well and had nothing to do.
func (entry Entry) quiet() bool {
	return entry.End == tracker.SyncSynced && entry.Message == "" && entry.Refused == 0 &&
		entry.Sent != nil && len(entry.Sent) == 0 && entry.BroughtIn != nil && len(entry.BroughtIn) == 0
}

// syncer gives the tracker's own sync; nil when it has none.
func (kept *Tracker) syncer() tracker.Syncer {
	if kept.isQueued() {
		return nil
	}
	own, _ := kept.inner.(tracker.Syncer)
	return own
}

// Syncs says whether the repository's issues can be synced with a remote
// at all: its changes wait in bend's queue, or the tracker has a sync of
// its own.
func (kept *Tracker) Syncs() bool { return kept.isQueued() || kept.syncer() != nil }

// ownFolder is the folder the tracker's own sync may keep its files in.
func (kept *Tracker) ownFolder() string { return filepath.Join(kept.store.Dir, adapterFolder) }

// SyncsWith says what the issues are synced with, in words for the owner;
// "" when syncing is not switched on. known is false when it cannot be
// told now (the remote was not reached); the words are then "".
//
// Side effects: for a tracker with a sync of its own, may run its program
// and reach the remote (the answer is remembered for a while).
func (kept *Tracker) SyncsWith() (words string, known bool) {
	if own := kept.syncer(); own != nil {
		return own.SyncsWith(kept.ownFolder())
	}
	if !kept.isQueued() {
		return "", true
	}
	if remote, ok := kept.inner.(tracker.Remote); ok {
		return remote.SyncedWith(), true
	}
	return "the " + kept.inner.About().Tracker + " tracker", true
}

// Runs gives the log of syncs, newest first; failed leaves out the runs
// that ended well.
func (kept *Tracker) Runs(failed bool) []Entry {
	runs := []Entry{}
	kept.store.Read(runsFile, &runs)
	slices.Reverse(runs)
	if failed {
		runs = slices.DeleteFunc(runs, func(entry Entry) bool { return entry.End == tracker.SyncSynced })
	}
	return runs
}

// log adds an entry to the log.
func (kept *Tracker) log(entry Entry) {
	kept.store.Changing(func() error {
		runs := []Entry{}
		kept.store.Read(runsFile, &runs)
		if last := len(runs) - 1; last >= 0 && entry.quiet() && runs[last].quiet() {
			entry.Runs += max(runs[last].Runs, 1)
			runs = runs[:last]
		}
		runs = append(runs, entry)
		if len(runs) > runsKept {
			runs = runs[len(runs)-runsKept:]
		}
		return kept.store.Write(runsFile, runs)
	})
}

// updated gives ids as changes of the plainest kind, for a tracker whose
// sync names the issues it sent and no more.
func updated(ids []string) []tracker.SyncChange {
	changes := make([]tracker.SyncChange, 0, len(ids))
	for _, id := range ids {
		changes = append(changes, tracker.SyncChange{ID: id, Kinds: []string{tracker.ChangeUpdated}})
	}
	return changes
}

// seen is what the comparison before and after a sync needs of an issue.
type seen struct {
	updatedAt string
	status    string
	// comments is how many comments it has: a new comment does not always
	// move an issue's "last changed".
	comments int
}

// seenIn reads the copy's issues for the comparison; nil when there is no
// copy to read.
func (kept *Tracker) seenIn() map[string]seen {
	var issues []tracker.Issue
	if there, err := kept.store.Read(issuesFile, &issues); !there || err != nil {
		return nil
	}
	found := make(map[string]seen, len(issues))
	for _, issue := range issues {
		at := ""
		if issue.UpdatedAt != nil {
			at = *issue.UpdatedAt
		}
		found[issue.ID] = seen{at, issue.Status, issue.CommentCount}
	}
	return found
}

// NotSynced is the refusal for a repository whose issues are synced with
// nothing.
func NotSynced() error {
	return tracker.Refused("This repository's issues are not synced with anything yet: they are on this computer only. `bend setup` shows the step that publishes them.")
}

// SyncNow runs one sync of the repository's issues with their remote and
// reports it.
//
// cause is what set it off (one of Causes). full rereads everything, for a
// tracker whose changes are queued. wait says what to do when another sync
// is running: wait for it and then sync, or do nothing and report "busy".
// Returns the entry. Fails only when there is nothing to sync with
// (NotSynced, or a tracker that is not synced at all); a sync that did not
// work is an entry, not a failure.
// Side effects: the tracker and its remote; the copy's files; one entry in
// the log, unless the run was "busy".
func (kept *Tracker) SyncNow(cause string, full, wait bool) (Entry, error) {
	began := kept.now()
	entry := Entry{Cause: cause, Runs: 1}
	own := kept.syncer()
	// gaveWay is set when another sync of bend's was running, so that this
	// one did nothing: it leaves no entry, the other one leaves its own.
	gaveWay := false
	switch {
	case kept.isQueued():
		sync := kept.Sync
		if wait {
			sync = kept.WaitAndSync
		}
		result, err := sync(full)
		entry = kept.entryOf(result, err, entry)
		gaveWay = err == nil && result.Busy
	case own != nil:
		if words, known := own.SyncsWith(kept.ownFolder()); words == "" {
			if known {
				return entry, NotSynced()
			}
			entry.End, entry.Message = tracker.SyncFailed, "The remote the issues are synced with could not be reached."
			break
		}
		done, err := kept.syncing(wait)
		if err != nil {
			return entry, err
		}
		if done == nil {
			entry.End, entry.Message = tracker.SyncBusy, "Another sync of these issues was running; it does the work."
			entry.Sent, entry.BroughtIn = []tracker.SyncChange{}, []string{}
			gaveWay = true
			break
		}
		entry = kept.ownSync(own, entry)
		done()
	default:
		return entry, tracker.Refused("Nothing to sync: this repository's issues are not synced with a remote through bend.")
	}
	ended := kept.now()
	entry.At, entry.Seconds = ended.UnixMilli(), int(ended.Sub(began).Round(time.Second).Seconds())
	// A "busy" of the tracker's own (something else was changing its
	// data) is an entry: nothing was synced, and if that goes on it is
	// trouble.
	if !gaveWay {
		kept.log(entry)
	}
	if entry.End == tracker.SyncSynced {
		helper.SyncedWell(kept.store.Dir)
	}
	return entry, nil
}

// syncing takes the lock that says a sync is running. With wait, it waits
// for another holder, up to a few minutes (a sync of the tracker's own can
// take that long). Returns nil, with no error, when another sync is
// running and it was not waited for, or did not end.
func (kept *Tracker) syncing(wait bool) (done func(), err error) {
	for attempt := 0; ; attempt++ {
		done, free, err := kept.store.Syncing()
		if err != nil {
			return nil, tracker.Refused("The local copy of the issues cannot be written (%s).", kept.store.Dir)
		}
		if free {
			return done, nil
		}
		if !wait || attempt > 600 {
			return nil, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// ownSync runs the tracker's own sync and fills the entry in. The caller
// holds the sync lock.
func (kept *Tracker) ownSync(own tracker.Syncer, entry Entry) Entry {
	before := kept.seenIn()
	run := own.SyncOnce(kept.ownFolder())
	entry.End, entry.Message = run.End, run.Message
	if run.End != tracker.SyncSynced {
		return entry
	}
	// What the sync brought in shows in the tracker's data only: the copy
	// is read anew, also for whoever reads next.
	if err := kept.Reread(); err != nil {
		entry.End, entry.Message = tracker.SyncFailed, "The issues were synced, but could not be read afterwards: "+err.Error()
		return entry
	}
	if !run.SentKnown {
		return entry
	}
	entry.Sent = run.Sent
	if entry.Sent == nil {
		entry.Sent = []tracker.SyncChange{}
	}
	if before == nil {
		return entry
	}
	entry.BroughtIn = []string{}
	for _, issue := range kept.issues {
		if slices.Contains(run.ChangedHere, issue.ID) {
			continue
		}
		at := ""
		if issue.UpdatedAt != nil {
			at = *issue.UpdatedAt
		}
		if was, had := before[issue.ID]; !had || was != (seen{at, issue.Status, issue.CommentCount}) {
			entry.BroughtIn = append(entry.BroughtIn, issue.ID)
		}
	}
	return entry
}

// entryOf turns what the sync of a queued tracker did into an entry.
func (kept *Tracker) entryOf(result SyncResult, err error, entry Entry) Entry {
	entry.Refused, entry.Waiting = result.Refused, result.Waiting
	switch {
	case err != nil:
		entry.End, entry.Message = tracker.SyncFailed, err.Error()
		return entry
	case result.Busy:
		entry.End, entry.Message = tracker.SyncBusy, "Another sync of these issues was running; it does the work."
		entry.Sent, entry.BroughtIn = []tracker.SyncChange{}, []string{}
		return entry
	}
	entry.Sent = updated(result.SentIssues)
	// What was just sent comes back as changed; that is this side's own
	// change, not something brought in.
	entry.BroughtIn = []string{}
	for _, id := range result.BroughtInIssues {
		if !slices.Contains(result.SentIssues, id) {
			entry.BroughtIn = append(entry.BroughtIn, id)
		}
	}
	switch {
	case result.Problem != "":
		entry.End, entry.Message = tracker.SyncFailed, result.Problem
	case result.Refused > 0:
		entry.End = tracker.SyncSynced
		entry.Message = plural(result.Refused, "change was", "changes were") + " refused and will not be sent again. `bend refused` lists them."
	default:
		entry.End = tracker.SyncSynced
	}
	return entry
}

// plural gives a count with the word for one or for several.
func plural(count int, one, several string) string {
	if count == 1 {
		return "1 " + one
	}
	return strconv.Itoa(count) + " " + several
}

// failingFor is how long syncs must have been failing, where they worked
// before, to be called trouble: a little more than one round of the
// helper's clock.
const failingFor = 4 * time.Minute

// The kinds of trouble.
const (
	// TroubleConflict and TroubleStuck: syncing has stopped by itself, and
	// a person has to settle something.
	TroubleConflict = "conflict"
	TroubleStuck    = "stuck"
	// TroubleFailing: syncs keep failing.
	TroubleFailing = "failing"
	// TroubleRefused: the tracker refused changes for good; they wait for
	// the owner to dismiss or resend them.
	TroubleRefused = "refused"
	// TroubleDisabled: the helper is disabled, so nothing syncs by itself.
	TroubleDisabled = "disabled"
)

// Trouble is what is wrong with a repository's syncing now, for the owner
// to be told of.
type Trouble struct {
	Kind string `json:"kind"`
	// Serious says the issues are not being synced, so that work can be
	// lost or done twice; otherwise it is something to know and deal with
	// at leisure.
	Serious bool `json:"serious"`
	// Title says it in a few words; Advice says what to do.
	Title  string `json:"title"`
	Advice string `json:"advice"`
	// Message is the tracker's own words from the last run that did not
	// work; "" when there are none.
	Message string `json:"message"`
	// Since is when it began (milliseconds since 1970).
	Since int64 `json:"since"`
	// Failures is how many syncs in a row did not work.
	Failures int `json:"failures"`
}

// HelperState is how the helper that syncs on a clock stands.
type HelperState = helper.State

// SyncState is how a repository's syncing stands.
type SyncState struct {
	// Source is the tracker's name.
	Source string `json:"source"`
	// Remote is what the issues are synced with, in words; null when
	// syncing is not switched on.
	Remote *string `json:"remote"`
	// Running says a sync is running now.
	Running bool `json:"running"`
	// Halted says syncing by itself has stopped until a sync that was
	// asked for ends well.
	Halted bool `json:"halted"`
	// Last is the last run; null when there has been none.
	Last *Entry `json:"last"`
	// SyncedAt is when the last run that ended well ended (milliseconds
	// since 1970); null when none did.
	SyncedAt *int64 `json:"syncedAt"`
	// Pending is the changes made here that were not sent yet; null when
	// it is not known.
	Pending []tracker.SyncChange `json:"pending"`
	// Trouble is what is wrong now; null when nothing is.
	Trouble *Trouble    `json:"trouble"`
	Helper  HelperState `json:"helper"`
}

// haltedBy gives the entry that stopped syncing by itself: the newest
// conflict or stuck with no sync that ended well after it. Runs that only
// failed or gave way after it do not lift the stop. ok is false when
// syncing is not stopped.
func haltedBy(runs []Entry) (entry Entry, ok bool) {
	for at := len(runs) - 1; at >= 0; at-- {
		switch {
		case runs[at].End == tracker.SyncSynced:
			return Entry{}, false
		case runs[at].End.Halts():
			return runs[at], true
		}
	}
	return Entry{}, false
}

// LastRun gives when a sync last ended well (the zero time for never) and
// whether syncing by itself has stopped, from the log. Nothing but the log
// is read.
func (kept *Tracker) LastRun() (syncedAt time.Time, halted bool) {
	runs := []Entry{}
	kept.store.Read(runsFile, &runs)
	for at := len(runs) - 1; at >= 0; at-- {
		if runs[at].End == tracker.SyncSynced {
			syncedAt = time.UnixMilli(runs[at].At)
			break
		}
	}
	_, halted = haltedBy(runs)
	return syncedAt, halted
}

// SyncStatus says how the repository's syncing stands. It syncs nothing.
//
// Side effects: for a tracker with a sync of its own, may run its program
// to ask what waits and whether the remote holds the issues.
func (kept *Tracker) SyncStatus() SyncState {
	state := SyncState{Source: kept.inner.About().Tracker, Helper: helper.Look(kept.store.Dir)}
	if !kept.Syncs() {
		return state
	}
	words, known := kept.SyncsWith()
	if words != "" {
		state.Remote = &words
	}
	state.Running = kept.store.SyncingNow()
	runs := []Entry{}
	kept.store.Read(runsFile, &runs)
	if len(runs) > 0 {
		last := runs[len(runs)-1]
		state.Last = &last
		_, state.Halted = haltedBy(runs)
	}
	for at := len(runs) - 1; at >= 0; at-- {
		if runs[at].End == tracker.SyncSynced {
			state.SyncedAt = &runs[at].At
			break
		}
	}
	if state.Remote != nil {
		if own := kept.syncer(); own != nil {
			if changes, known := own.Pending(kept.ownFolder()); known {
				state.Pending = changes
				if state.Pending == nil {
					state.Pending = []tracker.SyncChange{}
				}
			}
		} else if waiting, err := kept.readQueue(); err == nil {
			ids := []string{}
			for _, one := range waiting {
				ids = withIDs(ids, one.ID)
			}
			state.Pending = updated(ids)
		}
		refused := 0
		if kept.isQueued() {
			refused = len(kept.RefusedChanges())
		}
		state.Trouble = troubleIn(runs, refused, state.Helper, kept.now())
	} else if !known {
		// The remote was not reached, so it cannot be said what the issues
		// are synced with; syncs that failed for that are trouble all the
		// same.
		state.Trouble = troubleIn(runs, 0, helper.State{}, kept.now())
	}
	return state
}

// troubleIn works out what is wrong from the log, the refused changes and
// the helper's state; nil when nothing is.
//
// The rule for "failing": one failed sync where the issues have never
// synced well from here (there is nothing to fall back on); otherwise two
// or more in a row that have gone on for longer than one round of the
// clock. One dropped connection is then not called trouble, and neither is
// a sync that failed behind a command run where the remote cannot be
// reached (an agent's sandbox) while the helper, started elsewhere, sends
// the change a moment later.
func troubleIn(runs []Entry, refused int, about helper.State, now time.Time) *Trouble {
	failures, since, message := 0, int64(0), ""
	for at := len(runs) - 1; at >= 0 && runs[at].End != tracker.SyncSynced; at-- {
		failures++
		since = runs[at].At
		if message == "" {
			message = runs[at].Message
		}
	}
	everSynced := slices.ContainsFunc(runs, func(entry Entry) bool { return entry.End == tracker.SyncSynced })
	if failures > 0 {
		trouble := Trouble{Serious: true, Message: strings.TrimSpace(message), Since: since, Failures: failures}
		stop, halted := haltedBy(runs)
		if halted {
			// The stop's own words and time, not those of a later run that
			// merely failed.
			trouble.Message, trouble.Since = strings.TrimSpace(stop.Message), stop.At
		}
		switch {
		case halted && stop.End == tracker.SyncConflict:
			trouble.Kind = TroubleConflict
			trouble.Title = "Syncing has stopped: the issues were changed here and elsewhere in a way that cannot be merged."
			trouble.Advice = "Settle the conflict in the tracker, then sync again. Nothing is synced by itself until a sync ends well."
			return &trouble
		case halted:
			trouble.Kind = TroubleStuck
			trouble.Title = "Syncing has stopped: unfinished changes on this computer block every sync."
			trouble.Advice = "Clear them in the tracker, then sync again. Nothing is synced by itself until a sync ends well."
			return &trouble
		case !everSynced || (failures >= 2 && now.UnixMilli()-since >= failingFor.Milliseconds()):
			trouble.Kind = TroubleFailing
			trouble.Title = "The issues are not being synced: the last " + plural(failures, "sync", "syncs") + " failed."
			trouble.Advice = "Changes made here stay on this computer, and changes made elsewhere do not arrive, until a sync works. Sync again once the cause is dealt with."
			if about.GaveUpAt >= since && !about.Running {
				trouble.Advice += " bend has stopped trying by itself for now; a sync that works starts it again."
			}
			return &trouble
		}
	}
	if refused > 0 {
		return &Trouble{Kind: TroubleRefused,
			Title:  plural(refused, "change was", "changes were") + " refused by the tracker and not sent.",
			Advice: "Look at them, then dismiss each or send it again."}
	}
	if about.Disabled {
		return &Trouble{Kind: TroubleDisabled,
			Title:  "Syncing by itself is switched off in this repository.",
			Advice: "The issues are synced only when a sync is asked for. `bend helper enable` switches it back on."}
	}
	return nil
}
