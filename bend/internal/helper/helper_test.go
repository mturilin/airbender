// helper_test.go — the helper's loop, against a stand-in clock and sync.
//
// What: checks when the helper syncs and when it ends: on its clock, not
// while bend is unused, after failures, when the program is replaced, when
// disabled, never two at once; and how long no helper is started after one
// gave up.
//
// Why: this process runs unattended on the path the owner's issues take
// (bead-bb-c9l.16). It must neither stay for ever nor hammer a remote that
// does not answer. Starting and stopping a real one is checked end to end
// (bend/e2e).

package helper

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mturilin/airbender/bend/internal/localcopy"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// rig is a helper's surroundings in a test: a folder, a clock that moves
// only when the helper sleeps, and a sync that answers from a script.
type rig struct {
	t      *testing.T
	config Config
	clock  time.Time
	// ends is how the syncs to come end; the last one repeats.
	ends []tracker.SyncEnd
	// synced is when each sync ran.
	synced []time.Time
	// lastAt and lastEnd are the log's last entry; goodAt is when a sync
	// last ended well, as the helper is told it.
	lastAt  time.Time
	lastEnd tracker.SyncEnd
	goodAt  time.Time
	// on says syncing is switched on; unknown that it cannot be told.
	on      bool
	unknown bool
	// eachSleep is run at every sleep, when set.
	eachSleep func()
}

func newRig(t *testing.T) *rig {
	made := &rig{t: t, clock: time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC), ends: []tracker.SyncEnd{tracker.SyncSynced}, on: true}
	dir := t.TempDir()
	program := filepath.Join(dir, "program")
	os.WriteFile(program, []byte("one"), 0o755)
	made.config = Config{
		Dir: filepath.Join(dir, "copy"), Work: dir, Program: program,
		Times: Times{Every: 3 * time.Minute, Idle: 30 * time.Minute, Wake: 15 * time.Second, Limit: time.Minute},
		On:    func() (bool, bool) { return made.on, !made.unknown },
		Last: func() (time.Time, bool) {
			if made.lastEnd == tracker.SyncSynced {
				made.goodAt = made.lastAt
			}
			return made.goodAt, made.lastEnd.Halts()
		},
		Sync: func() tracker.SyncEnd {
			end := made.ends[0]
			if len(made.ends) > 1 {
				made.ends = made.ends[1:]
			}
			made.synced = append(made.synced, made.clock)
			made.lastAt, made.lastEnd = made.clock, end
			return end
		},
		Now: func() time.Time { return made.clock },
		Sleep: func(by time.Duration) {
			made.clock = made.clock.Add(by)
			if made.eachSleep != nil {
				made.eachSleep()
			}
		},
	}
	os.MkdirAll(made.config.Dir, 0o755)
	made.use()
	return made
}

// use marks bend as used at the rig's time.
func (r *rig) use() {
	mark := filepath.Join(r.config.Dir, usedFile)
	os.WriteFile(mark, nil, 0o644)
	os.Chtimes(mark, r.clock, r.clock)
}

func TestItSyncsOnItsClockAndEndsWhenBendIsNotUsed(t *testing.T) {
	r := newRig(t)
	began := r.clock
	if reason := Run(r.config); reason != "bend was not used for a while" {
		t.Fatalf("ended because: %s", reason)
	}
	if gone := r.clock.Sub(began); gone < 30*time.Minute || gone > 31*time.Minute {
		t.Errorf("ended after %s", gone)
	}
	// The first sync a moment after the start, then every three minutes.
	if len(r.synced) != 10 || r.synced[0].Sub(began) > time.Second {
		t.Fatalf("synced %d times, first after %s", len(r.synced), r.synced[0].Sub(began))
	}
	for index := 1; index < len(r.synced); index++ {
		if gap := r.synced[index].Sub(r.synced[index-1]); gap != 3*time.Minute {
			t.Errorf("sync %d came %s after the one before", index, gap)
		}
	}
}

func TestBendBeingUsedKeepsItAndASyncByAnyonePushesItsOwnBack(t *testing.T) {
	r := newRig(t)
	began := r.clock
	r.eachSleep = func() {
		gone := r.clock.Sub(began)
		// Used for the first hour.
		if gone < time.Hour {
			r.use()
		}
		// Someone syncs by hand every two minutes for the first ten: the
		// helper's own turn never comes in that time.
		if gone < 10*time.Minute && r.clock.Sub(r.lastAt) >= 2*time.Minute {
			r.lastAt, r.lastEnd = r.clock, tracker.SyncSynced
		}
	}
	// Synced a moment before it started.
	r.lastAt, r.lastEnd = began, tracker.SyncSynced
	Run(r.config)
	if gone := r.clock.Sub(began); gone < 89*time.Minute || gone > 91*time.Minute {
		t.Errorf("ended after %s", gone)
	}
	if len(r.synced) == 0 || r.synced[0].Sub(began) < 10*time.Minute || r.synced[0].Sub(began) > 13*time.Minute {
		t.Errorf("its first sync came after %s", r.synced[0].Sub(began))
	}
}

func TestThreeFailedSyncsInARowEndItAndHoldTheNextOneBack(t *testing.T) {
	r := newRig(t)
	r.ends = []tracker.SyncEnd{tracker.SyncFailed, tracker.SyncSynced, tracker.SyncFailed, tracker.SyncBusy, tracker.SyncFailed, tracker.SyncFailed}
	if reason := Run(r.config); reason != "syncs kept failing" {
		t.Fatalf("ended because: %s", reason)
	}
	// One failure, a good one that starts the count again, then three with
	// a busy one between that counts neither way.
	if len(r.synced) != 6 {
		t.Errorf("it ran %d syncs", len(r.synced))
	}
	state := Look(r.config.Dir)
	if state.Running || state.GaveUpAt != r.clock.UnixMilli() {
		t.Errorf("afterwards: %+v", state)
	}
	// Held back from these surroundings for a while after giving up now
	// (Look goes by the real clock), and not from others.
	store := localcopy.Store{Dir: r.config.Dir}
	store.Write(gaveUpFile, gaveUp{Surroundings: surroundings(), At: time.Now().UnixMilli(), Times: 1})
	if state := Look(r.config.Dir); state.HeldBackUntil <= time.Now().UnixMilli() {
		t.Errorf("not held back: %+v", state)
	}
	store.Write(gaveUpFile, gaveUp{Surroundings: "elsewhere", At: time.Now().UnixMilli(), Times: 1})
	if state := Look(r.config.Dir); state.HeldBackUntil != 0 || state.GaveUpAt == 0 {
		t.Errorf("held back by a helper from other surroundings: %+v", state)
	}
	// A sync that works, by anyone, lets the next one be started at once.
	SyncedWell(r.config.Dir)
	if state := Look(r.config.Dir); state.GaveUpAt != 0 || state.HeldBackUntil != 0 {
		t.Errorf("after a good sync: %+v", state)
	}
}

func TestThePauseAfterGivingUpDoublesUpToAnHour(t *testing.T) {
	every := 3 * time.Minute
	for times, want := range map[int]time.Duration{1: 3 * time.Minute, 2: 6 * time.Minute, 3: 12 * time.Minute, 5: 48 * time.Minute, 6: time.Hour, 40: time.Hour} {
		if got := pauseAfter(times, every); got != want {
			t.Errorf("after %d: %s, want %s", times, got, want)
		}
	}
}

func TestItEndsWhenTheProgramIsReplacedOrItIsDisabledOrItsFolderIsGone(t *testing.T) {
	for reason, happen := range map[string]func(*rig){
		"the bend program was replaced": func(r *rig) { os.WriteFile(r.config.Program, []byte("another build"), 0o755) },
		"disabled":                      func(r *rig) { os.WriteFile(filepath.Join(r.config.Dir, disabledFile), nil, 0o644) },
		"its folder is gone":            func(r *rig) { r.config.Work = filepath.Join(r.config.Dir, "not there") },
	} {
		r := newRig(t)
		began := r.clock
		r.eachSleep = func() {
			if r.clock.Sub(began) >= 5*time.Minute {
				r.eachSleep = nil
				happen(r)
			}
		}
		if reason == "its folder is gone" {
			happen(r)
		}
		if got := Run(r.config); got != reason {
			t.Errorf("ended because %q, want %q", got, reason)
		}
		if r.clock.Sub(began) > 6*time.Minute {
			t.Errorf("%s: noticed only after %s", reason, r.clock.Sub(began))
		}
	}
}

func TestItDoesNotSyncAfterAConflictOrWhereSyncingIsOff(t *testing.T) {
	stopped := newRig(t)
	stopped.lastAt, stopped.lastEnd = stopped.clock.Add(-time.Hour), tracker.SyncConflict
	Run(stopped.config)
	if len(stopped.synced) != 0 {
		t.Errorf("it synced %d times after a conflict", len(stopped.synced))
	}
	// A sync asked for that ends well takes it up again.
	resumed := newRig(t)
	began := resumed.clock
	resumed.lastAt, resumed.lastEnd = began.Add(-time.Hour), tracker.SyncStuck
	resumed.eachSleep = func() {
		if resumed.lastEnd == tracker.SyncStuck && resumed.clock.Sub(began) >= 10*time.Minute {
			resumed.lastAt, resumed.lastEnd = resumed.clock, tracker.SyncSynced
		}
	}
	Run(resumed.config)
	if len(resumed.synced) == 0 || resumed.synced[0].Sub(began) < 13*time.Minute || resumed.synced[0].Sub(began) > 14*time.Minute {
		t.Errorf("after it was settled it synced at %v", resumed.synced)
	}
	off := newRig(t)
	off.on = false
	Run(off.config)
	if len(off.synced) != 0 {
		t.Errorf("it synced %d times where syncing is off", len(off.synced))
	}
}

func TestThereAreNeverTwo(t *testing.T) {
	r := newRig(t)
	release, free, err := localcopy.Store{Dir: r.config.Dir}.Hold(lockFile)
	if err != nil || !free {
		t.Fatal("the lock could not be taken")
	}
	if !Look(r.config.Dir).Running {
		t.Error("one that holds the lock is not said to be running")
	}
	if reason := Run(r.config); reason != "another helper is running" {
		t.Errorf("a second one ended because: %s", reason)
	}
	release()
	if Look(r.config.Dir).Running {
		t.Error("still said to be running after it let go")
	}
}

func TestLookingChangesNothingWhereNothingWasEverStarted(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "never made")
	if state := Look(dir); state != (State{}) {
		t.Errorf("state = %+v", state)
	}
	if _, err := os.Stat(dir); err == nil {
		t.Error("looking made the folder")
	}
	if !Stop(dir) {
		t.Error("stopping nothing did not succeed")
	}
}

func TestAFailedSyncByAnyoneDoesNotPushItsOwnBack(t *testing.T) {
	r := newRig(t)
	began := r.clock
	// Synced well a moment before it started; then, every minute, a sync
	// made elsewhere fails (commands run where the remote is not reached).
	r.lastAt, r.lastEnd = began, tracker.SyncSynced
	r.eachSleep = func() {
		if r.clock.Sub(r.lastAt) >= time.Minute && r.lastEnd != tracker.SyncSynced || r.clock.Sub(r.lastAt) >= 2*time.Minute {
			r.lastAt, r.lastEnd = r.clock, tracker.SyncFailed
		}
	}
	Run(r.config)
	if len(r.synced) == 0 || r.synced[0].Sub(began) > 3*time.Minute+30*time.Second {
		t.Errorf("its first sync came at %v", r.synced)
	}
}

func TestWhereTheRemoteCannotBeToldItGivesUpLikeAfterFailedSyncs(t *testing.T) {
	r := newRig(t)
	r.unknown = true
	if reason := Run(r.config); reason != "syncs kept failing" {
		t.Errorf("ended because: %s", reason)
	}
	if len(r.synced) != 0 {
		t.Errorf("it synced %d times", len(r.synced))
	}
}

func TestStoppingNeverSignalsAProcessThatIsNotAHelper(t *testing.T) {
	// This test's own process is named in a helper's file left behind:
	// it is no helper, and must not be signalled.
	if isHelper(os.Getpid()) {
		t.Fatal("the test process is taken for a helper")
	}
	r := newRig(t)
	store := localcopy.Store{Dir: r.config.Dir}
	store.Write(aboutFile, about{Pid: os.Getpid(), StartedAt: 1})
	release, _, _ := store.Hold(lockFile)
	defer release()
	// The lock is held (by this process), so one is "running"; it is not
	// ended, and the caller is told so.
	if Stop(r.config.Dir) {
		t.Error("said to be stopped")
	}
}

func TestTwoThatOnlyLookDoNotSeeEachOtherAsAHelper(t *testing.T) {
	r := newRig(t)
	store := localcopy.Store{Dir: r.config.Dir}
	release, _, _ := store.Hold(lockFile)
	release()
	for range 200 {
		if store.Held(lockFile) {
			t.Fatal("a look saw a holder where there is none")
		}
	}
	// Its file goes with it.
	Run(r.config)
	if there, _ := store.Read(aboutFile, &about{}); there {
		t.Error("the helper's file outlived it")
	}
}
