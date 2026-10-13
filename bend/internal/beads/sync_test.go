// sync_test.go — tests for the beads adapter's sync (sync.go).
//
// What: checks how `bd sync`'s exit code is read, how journal records
// become changes, and whole runs against a made-up bd: what was sent, the
// journal position, a remote that holds nothing.
//
// Why: these decide what the sync log says a sync did (bead-bb-6a9), and
// whether a repository is synced at all. They were the plugin's tests
// (sync/beads.test.ts) and moved here with the code (bead-bb-c9l.16). The
// journal lines follow beads 1.3.1's documented record.

package beads

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

func TestExitCodeSaysHowASyncEnded(t *testing.T) {
	for code, want := range map[int]tracker.SyncEnd{
		0: tracker.SyncSynced, 1: tracker.SyncFailed, 2: tracker.SyncConflict,
		3: tracker.SyncBusy, 4: tracker.SyncStuck,
		// Killed, or a code beads does not document.
		-1: tracker.SyncFailed, 137: tracker.SyncFailed,
	} {
		if got := EndOf(code); got != want {
			t.Errorf("EndOf(%d) = %s, want %s", code, got, want)
		}
	}
}

// record is one line of the journal.
func record(seq int, op, id string) string {
	return fmt.Sprintf(`{"seq":%d,"ts":"2026-10-10T00:00:00Z","op":"%s","issue_id":"%s","issue":{"id":"%s"}}`, seq, op, id, id)
}

func change(id string, kinds ...string) tracker.SyncChange {
	return tracker.SyncChange{ID: id, Kinds: kinds}
}

func TestJournalRecordsBecomeChangesPerIssue(t *testing.T) {
	changes, head, found := ChangesFrom(strings.Join([]string{
		record(7, "create", "x-1"), record(8, "update", "x-1"), record(9, "comment", "x-2"),
		record(10, "update", "x-1"), record(11, "dep_add", "x-2"), record(12, "dep_remove", "x-2"),
		record(13, "close", "x-3"), record(14, "delete", "x-4"),
		"", "not a record", `{"op":"update"}`,
	}, "\n"))
	want := []tracker.SyncChange{
		change("x-1", "created", "updated"), change("x-2", "comment", "link"),
		change("x-3", "closed"), change("x-4", "deleted"),
	}
	if !reflect.DeepEqual(changes, want) || head != 14 || !found {
		t.Errorf("got %v, head %d, found %t", changes, head, found)
	}
	if changes, _, found := ChangesFrom(""); len(changes) != 0 || found {
		t.Errorf("an empty journal gave %v, found %t", changes, found)
	}
	// An operation this file does not know still counts as a change.
	if changes, _, _ := ChangesFrom(record(1, "something-new", "x-9")); !reflect.DeepEqual(changes, []tracker.SyncChange{change("x-9", "updated")}) {
		t.Errorf("an unknown operation gave %v", changes)
	}
}

// fake is a beads adapter over a made-up bd that answers from a script,
// longest matching beginning first, and records what it was asked.
type fake struct {
	*Tracker
	asked []string
	keep  string
}

// ok is a run that worked and printed out.
func ok(out string) Ran { return Ran{Stdout: out} }

// gitRemote is beads' list of remotes naming a git remote.
const gitRemote = `[{"name":"origin","url":"git+https://example.com/r.git"}]`

// newFake makes one. onRemote is what the git remote answers when asked
// whether it holds issues; reached says whether it answers at all.
func newFake(t *testing.T, answers map[string]func() Ran, onRemote string, reached bool) *fake {
	made := &fake{Tracker: New("/repo", "", ""), keep: t.TempDir()}
	made.runs = func(args []string, long bool) Ran {
		key := strings.Join(args, " ")
		made.asked = append(made.asked, key)
		best := ""
		for start := range answers {
			if strings.HasPrefix(key, start) && len(start) > len(best) {
				best = start
			}
		}
		if best == "" {
			return Ran{}
		}
		return answers[best]()
	}
	made.gits = func([]string) (string, bool) { return onRemote, reached }
	return made
}

// says is an answer that is always the same.
func says(ran Ran) func() Ran { return func() Ran { return ran } }

// position gives the journal position kept, -1 for none.
func (made *fake) position() int {
	if held := readRemembered(made.keep); held.Position != nil {
		return *held.Position
	}
	return -1
}

func TestARunReportsWhatTheJournalSaysWasSent(t *testing.T) {
	made := newFake(t, map[string]func() Ran{
		"dolt remote list":          says(ok(gitRemote)),
		"config get events-journal": says(ok("true\n")),
		"events tail --since 5":     says(ok(record(6, "comment", "x-1"))),
		"events tail --since 6":     says(ok(record(7, "update", "x-9"))),
		"sync":                      says(ok("Sync complete.")),
	}, "abc refs/dolt/data", true)
	made.setPosition(made.keep, 5)
	if words, known := made.SyncsWith(made.keep); words != "the repository's git remote" || !known {
		t.Fatalf("SyncsWith = %q, %t", words, known)
	}
	if pending, known := made.Pending(made.keep); !known || !reflect.DeepEqual(pending, []tracker.SyncChange{change("x-1", "comment")}) {
		t.Fatalf("Pending = %v, %t", pending, known)
	}
	ran := made.SyncOnce(made.keep)
	if ran.End != tracker.SyncSynced || ran.Message != "" || !ran.SentKnown ||
		!reflect.DeepEqual(ran.Sent, []tracker.SyncChange{change("x-1", "comment")}) {
		t.Errorf("the run reported %+v", ran)
	}
	// What was changed here while the sync ran is this side's too.
	if !reflect.DeepEqual(ran.ChangedHere, []string{"x-1", "x-9"}) {
		t.Errorf("changed here = %v", ran.ChangedHere)
	}
	// The position moved to the journal's head as it was before the run,
	// so that what was changed during it is sent next time.
	if made.position() != 6 || !slices.Contains(made.asked, "sync") {
		t.Errorf("position %d, asked %v", made.position(), made.asked)
	}
}

func TestARunThatFailsSaysSoInBeadsWordsAndKeepsWhatIsPending(t *testing.T) {
	made := newFake(t, map[string]func() Ran{
		"config get events-journal": says(ok("true\n")),
		"events tail --since 5":     says(ok(record(6, "update", "x-1"))),
		"sync":                      says(Ran{Code: 2, Stderr: "Error: merge conflict in issues\nresolve by hand"}),
	}, "", true)
	made.setPosition(made.keep, 5)
	ran := made.SyncOnce(made.keep)
	if ran.End != tracker.SyncConflict || !strings.Contains(ran.Message, "merge conflict in issues") || ran.SentKnown {
		t.Errorf("the run reported %+v", ran)
	}
	if made.position() != 5 {
		t.Errorf("the position moved to %d", made.position())
	}
}

func TestWithNoPositionTheJournalIsSwitchedOnAndNothingIsClaimed(t *testing.T) {
	made := newFake(t, map[string]func() Ran{
		"config get events-journal":      says(ok("false\n")),
		"config set events-journal true": says(ok("")),
		"events export":                  says(ok(record(1, "update", "x-1") + "\n" + record(2, "update", "x-1"))),
		"sync":                           says(ok("")),
	}, "", true)
	if _, known := made.Pending(made.keep); known {
		t.Error("what waits was claimed to be known")
	}
	if !slices.Contains(made.asked, "config set events-journal true") {
		t.Errorf("the journal was not switched on: %v", made.asked)
	}
	// The position is the journal's head: what came before is not known.
	if made.position() != 2 {
		t.Errorf("position = %d", made.position())
	}
}

func TestAPositionBeadsCanNoLongerReadIsReplaced(t *testing.T) {
	made := newFake(t, map[string]func() Ran{
		"config get events-journal": says(ok("true\n")),
		"events tail --since 5":     says(Ran{Code: 1, Stderr: "since is below the oldest retained record"}),
		"events export":             says(ok(record(40, "update", "x-1"))),
	}, "", true)
	made.setPosition(made.keep, 5)
	if _, known := made.Pending(made.keep); known {
		t.Error("what waits was claimed to be known")
	}
	if made.position() != 40 {
		t.Errorf("position = %d", made.position())
	}
}

func TestIssuesAreSyncedOnlyWithARemoteThatHoldsThem(t *testing.T) {
	for name, one := range map[string]struct {
		remotes  string
		onRemote string
		reached  bool
		words    string
		known    bool
	}{
		"no remote":                      {"[]", "", true, "", true},
		"a remote nothing was sent to":   {gitRemote, "", true, "", true},
		"a remote that holds the issues": {gitRemote, "abc refs/dolt/data", true, "the repository's git remote", true},
		"a remote that was not reached":  {gitRemote, "", false, "", false},
		// A remote that is not a git repository cannot be asked: taken as
		// holding.
		"a hosted remote": {`[{"name":"origin","url":"https://doltremoteapi.example.com/me/db"}]`, "", true, "the repository's git remote", true},
	} {
		made := newFake(t, map[string]func() Ran{"dolt remote list": says(ok(one.remotes))}, one.onRemote, one.reached)
		if words, known := made.SyncsWith(made.keep); words != one.words || known != one.known {
			t.Errorf("%s: SyncsWith = %q, %t", name, words, known)
		}
	}
}

func TestARemoteThatHoldsIsAskedOnceAndOneThatDoesNotIsBelievedBriefly(t *testing.T) {
	made := newFake(t, map[string]func() Ran{"dolt remote list": says(ok(gitRemote))}, "abc refs/dolt/data", true)
	made.SyncsWith(made.keep)
	made.SyncsWith(made.keep)
	if len(made.asked) != 1 {
		t.Errorf("a remote that holds was asked %d times", len(made.asked))
	}
	empty := newFake(t, map[string]func() Ran{"dolt remote list": says(ok("[]"))}, "", true)
	empty.SyncsWith(empty.keep)
	empty.SyncsWith(empty.keep)
	if len(empty.asked) != 1 {
		t.Errorf("'no remote' was asked %d times within the half minute", len(empty.asked))
	}
}
