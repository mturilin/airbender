// report_test.go — one sync, one report, over stand-in trackers.
//
// What: checks the entry a sync leaves for a tracker with a sync of its
// own and for one whose changes are queued, the log (what is kept, what is
// folded together, what leaves no entry), and the trouble worked out from
// it.
//
// Why: the report is what a terminal and the Airbender tab both show, and
// the trouble is what the owner is warned by (bead-bb-c9l.16). The tracker
// with a sync of its own here is a stand-in that is neither beads nor
// GitHub: the layer under test must not need to know which tracker it is.

package kept

import (
	"reflect"
	"testing"
	"time"

	"github.com/mturilin/airbender/bend/internal/helper"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// ownSyncer is a stand-in tracker with a sync of its own.
type ownSyncer struct {
	*standIn
	// with is what it is synced with; "" for nothing. reached false makes
	// that impossible to tell.
	with    string
	reached bool
	// next is what the next run reports; during is run while it runs (the
	// remote's changes arriving in the tracker's data).
	next   tracker.SyncRun
	during func()
	runs   int
	// keeps are the folders it was handed.
	keeps []string
}

func (o *ownSyncer) SyncsWith(keep string) (string, bool) {
	o.keeps = append(o.keeps, keep)
	return o.with, o.reached
}
func (o *ownSyncer) Pending(string) ([]tracker.SyncChange, bool) {
	return o.next.Sent, o.next.SentKnown
}
func (o *ownSyncer) SyncOnce(string) tracker.SyncRun {
	o.runs++
	if o.during != nil {
		o.during()
	}
	return o.next
}

// stamped sets when an issue of the stand-in was last changed.
func (s *standIn) stamped(id, at string) {
	for index := range s.issues {
		if s.issues[index].ID == id {
			s.issues[index].UpdatedAt = tracker.Ptr(at)
		}
	}
}

// ownBench is a bench whose tracker has a sync of its own.
func ownBench(t *testing.T) (*bench, *ownSyncer, func() *Tracker) {
	b := newBench(t)
	own := &ownSyncer{standIn: b.inner, with: "a stand-in remote", reached: true}
	open := func() *Tracker {
		return Open(own, b.dir, Options{Now: func() time.Time { return b.clock }})
	}
	return b, own, open
}

func TestASyncOfTheTrackersOwnIsReportedWithWhatCameIn(t *testing.T) {
	b, own, open := ownBench(t)
	// A copy from before, to compare with.
	b.titles(open())
	own.next = tracker.SyncRun{End: tracker.SyncSynced, SentKnown: true,
		Sent: []tracker.SyncChange{{ID: "s-a", Kinds: []string{"comment"}}}, ChangedHere: []string{"s-a"}}
	own.during = func() {
		// The remote's changes arrive: one issue changed, one new; and the
		// one changed here differs too, which is this side's doing.
		b.inner.stamped("s-a", "2026-03-01T10:00:00Z")
		b.inner.stamped("s-b", "2026-03-01T10:00:00Z")
		b.inner.add("s-c", "Third", "open")
	}
	b.clock = b.clock.Add(time.Minute)
	entry, err := open().SyncNow(CauseAsked, false, true)
	must(t, err)
	want := Entry{End: tracker.SyncSynced, Cause: CauseAsked, Runs: 1, At: b.clock.UnixMilli(),
		Sent: []tracker.SyncChange{{ID: "s-a", Kinds: []string{"comment"}}}, BroughtIn: []string{"s-b", "s-c"}}
	if !reflect.DeepEqual(entry, want) {
		t.Errorf("entry = %+v\nwant    %+v", entry, want)
	}
	// The copy is fresh afterwards, and the entry is in the log.
	if titles := b.titles(open()); titles != "First, Second, Third" {
		t.Errorf("the copy lists %s", titles)
	}
	if runs := open().Runs(false); len(runs) != 1 || !reflect.DeepEqual(runs[0], want) {
		t.Errorf("the log holds %+v", runs)
	}
	// The tracker keeps its own files below the copy's folder.
	if len(own.keeps) == 0 || own.keeps[0] != b.dir+"/tracker" {
		t.Errorf("the tracker was handed %v", own.keeps)
	}
}

func TestWhatATrackerCannotTellIsNotGuessed(t *testing.T) {
	b, own, open := ownBench(t)
	// No copy yet, so nothing to compare with; and the tracker does not
	// know what it sent.
	own.next = tracker.SyncRun{End: tracker.SyncSynced}
	entry, err := open().SyncNow(CauseTimer, false, true)
	must(t, err)
	if entry.Sent != nil || entry.BroughtIn != nil || entry.End != tracker.SyncSynced {
		t.Errorf("entry = %+v", entry)
	}
	// It knows what it sent, but there was still nothing to compare with
	// the first time; the second time there is.
	own.next = tracker.SyncRun{End: tracker.SyncSynced, SentKnown: true}
	entry, _ = open().SyncNow(CauseTimer, false, true)
	if entry.Sent == nil || len(entry.Sent) != 0 || entry.BroughtIn == nil || len(entry.BroughtIn) != 0 {
		t.Errorf("entry = %+v", entry)
	}
	_ = b
}

func TestASyncThatDidNotWorkIsAnEntryAndChangesNothing(t *testing.T) {
	b, own, open := ownBench(t)
	b.titles(open())
	lists := b.inner.lists
	own.next = tracker.SyncRun{End: tracker.SyncConflict, Message: "the two sides cannot be merged"}
	entry, err := open().SyncNow(CauseTimer, false, true)
	must(t, err)
	if entry.End != tracker.SyncConflict || entry.Message != "the two sides cannot be merged" || entry.Sent != nil {
		t.Errorf("entry = %+v", entry)
	}
	if b.inner.lists != lists {
		t.Error("the copy was reread after a sync that did not work")
	}
	state := open().SyncStatus()
	if !state.Halted || state.Trouble == nil || state.Trouble.Kind != TroubleConflict || !state.Trouble.Serious ||
		state.Trouble.Message != "the two sides cannot be merged" || state.SyncedAt != nil {
		t.Errorf("state = %+v, trouble %+v", state, state.Trouble)
	}
}

func TestIssuesSyncedWithNothingAreNotSynced(t *testing.T) {
	_, own, open := ownBench(t)
	own.with = ""
	if _, err := open().SyncNow(CauseAsked, false, true); err == nil {
		t.Error("a sync with nothing was not refused")
	}
	if own.runs != 0 || len(open().Runs(false)) != 0 {
		t.Error("something was run or logged")
	}
	if state := open().SyncStatus(); state.Remote != nil || state.Trouble != nil {
		t.Errorf("state = %+v", state)
	}
	// A remote that cannot be reached now is a sync that failed, not a
	// repository that is not synced.
	own.reached = false
	entry, err := open().SyncNow(CauseAsked, false, true)
	must(t, err)
	if entry.End != tracker.SyncFailed || own.runs != 0 {
		t.Errorf("entry = %+v", entry)
	}
}

func TestOnlyOneSyncRunsAndTheOtherLeavesNoEntry(t *testing.T) {
	b, own, open := ownBench(t)
	own.next = tracker.SyncRun{End: tracker.SyncSynced, SentKnown: true}
	var inside Entry
	own.during = func() {
		own.during = nil
		// Another process syncs while this one runs.
		inside, _ = open().SyncNow(CauseTimer, false, false)
		if !open().SyncStatus().Running {
			t.Error("a sync under way was not said to be running")
		}
	}
	_, err := open().SyncNow(CauseAsked, false, true)
	must(t, err)
	if inside.End != tracker.SyncBusy || own.runs != 1 {
		t.Errorf("the second sync ended %s after %d runs", inside.End, own.runs)
	}
	if runs := open().Runs(false); len(runs) != 1 || runs[0].Cause != CauseAsked {
		t.Errorf("the log holds %+v", runs)
	}
	if open().SyncStatus().Running {
		t.Error("still said to be running afterwards")
	}
	_ = b
}

func TestQuietRunsAreFoldedTogetherAndTheLogIsBounded(t *testing.T) {
	b, own, open := ownBench(t)
	b.titles(open())
	own.next = tracker.SyncRun{End: tracker.SyncSynced, SentKnown: true}
	for round := 0; round < 3; round++ {
		b.clock = b.clock.Add(3 * time.Minute)
		open().SyncNow(CauseTimer, false, true)
	}
	runs := open().Runs(false)
	if len(runs) != 1 || runs[0].Runs != 3 || runs[0].At != b.clock.UnixMilli() {
		t.Fatalf("three quiet runs are kept as %+v", runs)
	}
	// A run that did something stands alone, and so does a failure.
	own.next = tracker.SyncRun{End: tracker.SyncFailed, Message: "no network"}
	for round := 0; round < runsKept+5; round++ {
		open().SyncNow(CauseTimer, false, true)
	}
	if all := open().Runs(false); len(all) != runsKept {
		t.Errorf("the log holds %d entries", len(all))
	}
	if failed := open().Runs(true); len(failed) != runsKept {
		t.Errorf("%d of them are failures", len(failed))
	}
}

// entries makes a log from ends, a minute apart, the last one at now.
func entries(now time.Time, ends ...tracker.SyncEnd) []Entry {
	made := []Entry{}
	for index, end := range ends {
		at := now.Add(-time.Duration(len(ends)-1-index) * 3 * time.Minute)
		made = append(made, Entry{End: end, At: at.UnixMilli(), Message: "said " + string(end)})
	}
	return made
}

func TestTroubleIsWorkedOutFromTheLog(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	const synced, failed, conflict, stuck = tracker.SyncSynced, tracker.SyncFailed, tracker.SyncConflict, tracker.SyncStuck
	for name, one := range map[string]struct {
		runs    []Entry
		refused int
		helper  helper.State
		kind    string
		serious bool
	}{
		"nothing synced yet":                          {entries(now), 0, helper.State{}, "", false},
		"all well":                                    {entries(now, failed, synced), 0, helper.State{}, "", false},
		"one failure after a good sync":               {entries(now, synced, failed), 0, helper.State{}, "", false},
		"failing for longer than a round":             {entries(now, synced, failed, failed, failed), 0, helper.State{}, TroubleFailing, true},
		"a failure where it never worked":             {entries(now, failed), 0, helper.State{}, TroubleFailing, true},
		"a conflict, at once":                         {entries(now, synced, conflict), 0, helper.State{}, TroubleConflict, true},
		"stuck, at once":                              {entries(now, synced, stuck), 0, helper.State{}, TroubleStuck, true},
		"refused changes":                             {entries(now, synced), 2, helper.State{}, TroubleRefused, false},
		"the helper disabled":                         {entries(now, synced), 0, helper.State{Disabled: true}, TroubleDisabled, false},
		"failing comes before refused":                {entries(now, failed), 2, helper.State{Disabled: true}, TroubleFailing, true},
		"a failure after a conflict does not lift it": {entries(now, synced, conflict, failed), 0, helper.State{}, TroubleConflict, true},
		"a good sync after a conflict does":           {entries(now, conflict, failed, synced), 0, helper.State{}, "", false},
		"one failure does not hide what is known":     {entries(now, synced, failed), 1, helper.State{}, TroubleRefused, false},
	} {
		trouble := troubleIn(one.runs, one.refused, one.helper, now)
		switch {
		case one.kind == "" && trouble != nil:
			t.Errorf("%s: trouble %+v", name, trouble)
		case one.kind != "" && (trouble == nil || trouble.Kind != one.kind || trouble.Serious != one.serious):
			t.Errorf("%s: trouble %+v, want %s", name, trouble, one.kind)
		}
	}
	// Two failures a moment apart, as two commands run where the remote
	// cannot be reached leave them, are not trouble yet.
	close := entries(now, synced, failed, failed)
	close[1].At = now.Add(-10 * time.Second).UnixMilli()
	if trouble := troubleIn(close, 0, helper.State{}, now); trouble != nil {
		t.Errorf("two failures within seconds are trouble: %+v", trouble)
	}
	// What it says: since the first failure in the row, how many, and the
	// tracker's last words.
	trouble := troubleIn(entries(now, synced, failed, failed, failed), 0, helper.State{}, now)
	if trouble.Failures != 3 || trouble.Since != now.Add(-6*time.Minute).UnixMilli() || trouble.Message != "said failed" {
		t.Errorf("trouble = %+v", trouble)
	}
}

func TestAQueuedTrackersSyncLeavesTheSameReport(t *testing.T) {
	w := newWorld(t)
	here := w.desk(t.TempDir())
	entry, err := here.copy.SyncNow(CauseAsked, false, true)
	must(t, err)
	// A new issue goes to the tracker at once, for its id; a comment waits.
	id, err := here.tracker.Create(tracker.Draft{Title: "Made here"})
	must(t, err)
	must(t, here.tracker.Comment(id, "said here"))
	state := here.copy.SyncStatus()
	if state.Remote == nil || len(state.Pending) != 1 || state.Pending[0].ID != id {
		t.Fatalf("before sending: %+v", state)
	}
	w.pass(time.Minute)
	entry, err = w.desk(here.dir).copy.SyncNow(CauseChange, false, true)
	must(t, err)
	if entry.End != tracker.SyncSynced || len(entry.Sent) != 1 || entry.Cause != CauseChange || entry.BroughtIn == nil {
		t.Errorf("entry = %+v", entry)
	}
	// Cut off: a failure in the tracker's words, and what waits still
	// waits.
	must(t, w.desk(here.dir).tracker.Comment(entry.Sent[0].ID, "said while cut off"))
	w.github.down = true
	w.pass(time.Minute)
	entry, err = w.desk(here.dir).copy.SyncNow(CauseTimer, false, true)
	must(t, err)
	if entry.End != tracker.SyncFailed || entry.Message == "" || entry.Waiting != 1 {
		t.Errorf("cut off: %+v", entry)
	}
	state = w.desk(here.dir).copy.SyncStatus()
	if state.Last == nil || state.Last.End != tracker.SyncFailed || state.SyncedAt == nil || state.Halted {
		t.Errorf("after the failure: %+v", state)
	}
}

func TestAStopHoldsUntilASyncEndsWell(t *testing.T) {
	b, own, open := ownBench(t)
	own.next = tracker.SyncRun{End: tracker.SyncStuck, Message: "unfinished changes"}
	open().SyncNow(CauseTimer, false, true)
	b.clock = b.clock.Add(time.Minute)
	// The owner presses Refresh with the network off.
	own.next = tracker.SyncRun{End: tracker.SyncFailed, Message: "no network"}
	open().SyncNow(CauseAsked, false, true)
	state := open().SyncStatus()
	if _, halted := open().LastRun(); !halted || !state.Halted || state.Trouble.Kind != TroubleStuck || state.Trouble.Message != "unfinished changes" {
		t.Errorf("after a failure that followed the stop: %+v, trouble %+v", state, state.Trouble)
	}
	own.next = tracker.SyncRun{End: tracker.SyncSynced, SentKnown: true}
	open().SyncNow(CauseAsked, false, true)
	if at, halted := open().LastRun(); halted || !at.Equal(b.clock) {
		t.Errorf("after a sync that ended well: halted %t, synced at %s", halted, at)
	}
}

func TestATrackersOwnBusyIsAnEntryAndARemoteNotReachedIsTrouble(t *testing.T) {
	_, own, open := ownBench(t)
	own.next = tracker.SyncRun{End: tracker.SyncBusy, Message: "something else is writing"}
	entry, err := open().SyncNow(CauseTimer, false, true)
	must(t, err)
	if runs := open().Runs(false); entry.End != tracker.SyncBusy || len(runs) != 1 {
		t.Errorf("entry %+v, log %+v", entry, runs)
	}
	// Never synced from here, and the remote cannot be told: the failure
	// is said, though it cannot be said what the issues are synced with.
	_, own, open = ownBench(t)
	own.with, own.reached = "", false
	open().SyncNow(CauseAsked, false, true)
	if state := open().SyncStatus(); state.Remote != nil || state.Trouble == nil || state.Trouble.Kind != TroubleFailing {
		t.Errorf("state %+v, trouble %+v", state, state.Trouble)
	}
}
