// sync_test.go — syncing a beads repository through bend, with the real bd.
//
// What: two throwaway repositories that share a bare git remote on disk. A
// sync in one and then the other carries an issue across; a second sync
// started while one runs does nothing; the helper carries a change across
// with no sync typed, is never two, ends when bend is not used, and obeys
// stop, start, disable and enable.
//
// Why: this is the path the owner's issues take between computers, and it
// used to be the plugin's (bead-bb-c9l.16). Whether bend drives the real
// bd rightly, and whether the helper's process really starts, stays single
// and goes away, can only be seen with real processes.
//
// Gotchas:
//   - The helper is started only where a test asks for it, with its times
//     shortened; each such test disables it at the end, and it ends by
//     itself when its folder is removed.

package e2e

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// syncEntry is what `bend sync --json` answers, as far as the tests look.
type syncEntry struct {
	End  string `json:"end"`
	Sent []struct {
		ID    string   `json:"id"`
		Kinds []string `json:"kinds"`
	} `json:"sent"`
	BroughtIn []string `json:"broughtIn"`
	Cause     string   `json:"cause"`
	Message   string   `json:"message"`
}

// syncState is what `bend sync --status --json` answers.
type syncState struct {
	Remote  *string    `json:"remote"`
	Running bool       `json:"running"`
	Halted  bool       `json:"halted"`
	Last    *syncEntry `json:"last"`
	Pending []struct {
		ID string `json:"id"`
	} `json:"pending"`
	Trouble *struct {
		Kind string `json:"kind"`
	} `json:"trouble"`
	Helper helperState `json:"helper"`
}

// helperState is how the helper stands.
type helperState struct {
	Running  bool `json:"running"`
	Pid      int  `json:"pid"`
	Disabled bool `json:"disabled"`
}

// sharing makes two repositories whose issues are published to the same
// remote, with one issue made on the first.
func sharing(t *testing.T) (first, second *repository, id string) {
	t.Helper()
	newOnly(t)
	origin := bare(t)
	origin.run("git", "init", "-q", "--bare", "remote.git")
	remote := filepath.Join(origin.root, "remote.git")
	first = bare(t)
	first.run("git", "commit", "-q", "--allow-empty", "-m", "start")
	first.run("git", "remote", "add", "origin", remote)
	first.run("git", "push", "-q", "origin", "HEAD")
	first.ok("setup", "tracker", "--use", "beads")
	first.ok("setup", "issues", "-y")
	id = first.ok("create", "Made on the first computer")
	first.ok("setup", "publish", "-y")
	second = bare(t)
	second.run("git", "remote", "add", "origin", remote)
	second.ok("setup", "tracker", "--use", "beads")
	second.ok("setup", "issues", "-y")
	return first, second, id
}

// sync runs `bend sync` and gives its entry.
func (repo *repository) sync(argv ...string) syncEntry {
	repo.t.Helper()
	var entry syncEntry
	repo.parse(repo.ok(append([]string{"sync", "--json"}, argv...)...), &entry)
	return entry
}

// syncState gives how the syncing stands.
func (repo *repository) syncState() syncState {
	repo.t.Helper()
	var state syncState
	repo.parse(repo.ok("sync", "--status", "--json"), &state)
	return state
}

func TestBeadsSyncCarriesIssuesAcrossAndSaysWhatItDid(t *testing.T) {
	first, second, id := sharing(t)
	state := second.syncState()
	if state.Remote == nil || *state.Remote != "the repository's git remote" || state.Last != nil || state.Trouble != nil {
		t.Fatalf("before any sync: %+v", state)
	}
	// The first sync on each takes a place in beads' journal: what was sent
	// before it is not known, and is not guessed.
	opening := first.sync()
	same(t, opening.End, "synced", "the first sync on the first computer")
	if opening.Sent != nil {
		t.Errorf("the first sync claims to know what it sent: %+v", opening.Sent)
	}
	same(t, second.sync().End, "synced", "the first sync on the second computer")
	same(t, second.show(id).Title, "Made on the first computer", "the issue, on the second computer")

	made := second.ok("create", "Made on the second computer")
	second.ok("comment", id, "Said on the second computer")
	waiting := []string{}
	for _, one := range second.syncState().Pending {
		waiting = append(waiting, one.ID)
	}
	slices.Sort(waiting)
	want := []string{made, id}
	slices.Sort(want)
	same(t, strings.Join(waiting, " "), strings.Join(want, " "), "what waits to be sent")

	sent := second.sync()
	same(t, sent.End, "synced", "the sync that sends")
	same(t, sent.Cause, "asked", "what set it off")
	if len(sent.Sent) != 2 || sent.BroughtIn == nil || len(sent.BroughtIn) != 0 {
		t.Errorf("the sending sync reported %+v", sent)
	}
	same(t, len(second.syncState().Pending), 0, "what waits afterwards")

	got := first.sync()
	same(t, got.End, "synced", "the sync that brings in")
	slices.Sort(got.BroughtIn)
	same(t, strings.Join(got.BroughtIn, " "), strings.Join(want, " "), "what came in")
	same(t, len(got.Sent), 0, "what the first computer sent")
	same(t, first.show(made).Title, "Made on the second computer", "the new issue, on the first computer")

	// The log is the repository's: every run is in it, newest first.
	var runs []syncEntry
	first.parse(first.ok("sync", "--log", "--json"), &runs)
	if len(runs) != 2 || len(runs[0].BroughtIn) != 2 {
		t.Errorf("the log holds %+v", runs)
	}
	if text := first.ok("sync", "--log"); !strings.Contains(text, "brought in") {
		t.Errorf("the log reads:\n%s", text)
	}
	same(t, first.ok("sync", "--log", "--failed"), "No syncs to list.", "the failed runs")
}

func TestASecondBeadsSyncGivesWayToOneThatIsRunning(t *testing.T) {
	first, _, _ := sharing(t)
	first.sync()
	// As a sync under way holds it.
	lock, err := os.OpenFile(filepath.Join(first.root, ".git", "bend", "beads", "sync.lock"), os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	same(t, first.syncState().Running, true, "said to be running")
	same(t, first.sync("--no-wait").End, "busy", "a sync started meanwhile")
	var runs []syncEntry
	first.parse(first.ok("sync", "--log", "--json"), &runs)
	same(t, len(runs), 1, "entries in the log")
	syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	same(t, first.sync("--no-wait").End, "synced", "a sync after it let go")
}

func TestARepositorySyncedWithNothingSaysSo(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	repo.ok("create", "Here only")
	state := repo.syncState()
	if state.Remote != nil || state.Trouble != nil {
		t.Errorf("state = %+v", state)
	}
	same(t, repo.status("sync"), 1, "the exit status of a sync with nothing")
}

// helper gives how the helper stands. Asking is not bend being used, and
// starts none.
func (repo *repository) helper() helperState {
	repo.t.Helper()
	var answer struct {
		Helper helperState `json:"helper"`
	}
	repo.parse(repo.ok("helper", "--json"), &answer)
	return answer.Helper
}

// until waits for something to become true, for at most limit.
func until(limit time.Duration, is func() bool) bool {
	for began := time.Now(); time.Since(began) < limit; time.Sleep(200 * time.Millisecond) {
		if is() {
			return true
		}
	}
	return is()
}

func TestTheHelperSyncsOnItsClockAndGoesAwayByItself(t *testing.T) {
	first, second, _ := sharing(t)
	fast := []string{"BEND_NO_BACKGROUND=", "BEND_HELPER_EVERY=1s", "BEND_HELPER_WAKE=200ms", "BEND_HELPER_IDLE=6s"}
	first.env, second.env = append(first.env, fast...), append(second.env, fast...)
	for _, repo := range []*repository{first, second} {
		t.Cleanup(func() { repo.bend("helper", "disable") })
	}
	same(t, second.helper().Running, false, "a helper before any command")
	// A command run only because a file changed (the tab's watcher) is not
	// bend being used: it starts no helper.
	watching := &repository{t: t, root: second.root, env: append(slices.Clone(second.env), "BEND_PASSIVE=1")}
	watching.ok("list")
	watching.ok("sync", "--status")
	time.Sleep(time.Second)
	same(t, second.helper().Running, false, "a helper after commands that were not bend being used")

	// Any command starts it; a second command does not start another.
	made := second.ok("create", "Made with no sync typed")
	if !until(5*time.Second, func() bool { return second.helper().Running }) {
		t.Fatal("no helper was started by a command")
	}
	pid := second.helper().Pid
	second.ok("list")
	same(t, second.helper().Pid, pid, "the helper after another command")

	// The change crosses with no sync typed on either side.
	arrived := until(30*time.Second, func() bool { return first.bend("show", made).status == 0 })
	if !arrived {
		t.Fatalf("the issue did not arrive:\n%s\n%s", second.ok("sync", "--log"), first.ok("sync", "--log"))
	}
	var runs []syncEntry
	second.parse(second.ok("sync", "--log", "--json"), &runs)
	if !slices.ContainsFunc(runs, func(entry syncEntry) bool { return entry.Cause == "timer" }) {
		t.Errorf("no sync set off by the clock in the log: %+v", runs)
	}

	// Stop ends the one running; the next command starts one again.
	second.ok("helper", "stop")
	same(t, second.helper().Running, false, "the helper after stop")
	second.ok("list")
	if !until(5*time.Second, func() bool { return second.helper().Running }) {
		t.Fatal("no helper after the command that followed a stop")
	}
	if second.helper().Pid == pid {
		t.Error("the same process after a stop")
	}
	// Disable keeps it away; enable brings it back.
	second.ok("helper", "disable")
	second.ok("list")
	time.Sleep(time.Second)
	state := second.helper()
	if state.Running || !state.Disabled {
		t.Errorf("after disable and a command: %+v", state)
	}
	same(t, second.syncState().Trouble.Kind, "disabled", "the trouble said while it is disabled")
	second.ok("helper", "enable")
	if !until(5*time.Second, func() bool { return second.helper().Running }) {
		t.Fatal("no helper after enable")
	}

	// Left alone, it goes, also while commands that are not bend being used
	// go on (an open tab re-reading after each of the helper's syncs).
	if !until(15*time.Second, func() bool {
		watching.ok("list")
		watching.ok("refused")
		return !second.helper().Running
	}) {
		t.Fatal("the helper is still there long after bend was last used")
	}
}
