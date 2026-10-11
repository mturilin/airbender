// steps_test.go — how the steps ask, and what they do when nobody can
// answer.
//
// What: runs the steps that need no tracker's program (choosing the
// tracker) with a stand-in for the keyboard, and reads what `bd memories`
// prints.
//
// Why: the asking cannot be tested from outside without a real terminal;
// here the keyboard is a function. Everything else about the steps is
// tested end to end against real repositories (bend/e2e/setup_test.go).

package setup

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/facts"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// keyboard is a terminal whose person types these answers in turn; said
// collects what they were shown.
func keyboard(said *[]string, typed ...string) Terminal {
	return Terminal{
		Interactive: true,
		Ask: func(question string) string {
			*said = append(*said, question)
			if len(typed) == 0 {
				return ""
			}
			answer := typed[0]
			typed = typed[1:]
			return answer + "\n"
		},
		Say: func(text string) { *said = append(*said, text) },
		Run: func(string, string, ...string) int { return -1 },
	}
}

// nobody is a terminal with no one at the keyboard; asking it is a mistake.
func nobody(t *testing.T) Terminal {
	return Terminal{
		Ask: func(question string) string { t.Fatalf("asked %q with nobody there", question); return "" },
		Say: func(string) {},
		Run: func(string, string, ...string) int { return -1 },
	}
}

func TestTrackerIsAskedForAtAKeyboard(t *testing.T) {
	dir := t.TempDir()
	said := []string{}
	outcome, err := Tracker(dir, keyboard(&said, "2", "someone/thing"), Answers{}, Options{})
	if err != nil || !outcome.Changed {
		t.Fatalf("got %+v, %v", outcome, err)
	}
	file, _ := os.ReadFile(filepath.Join(dir, ".bend.json"))
	if string(file) != `{"tracker": "github", "repository": "someone/thing"}`+"\n" {
		t.Fatalf("got the setting %q", file)
	}
	if !strings.Contains(strings.Join(said, "\n"), "1. beads") {
		t.Fatalf("the choices were not shown: %v", said)
	}
	// Done: nothing is asked and nothing changes.
	again, err := Tracker(dir, nobody(t), Answers{}, Options{})
	if err != nil || again.Changed || !strings.HasPrefix(again.Message, "Already done") {
		t.Fatalf("got %+v, %v", again, err)
	}
	// An answer that is neither is a refusal, and nothing is written.
	other := t.TempDir()
	if _, err := Tracker(other, keyboard(&said, "linear"), Answers{}, Options{}); tracker.KindOf(err) != tracker.KindRefused || err == nil {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(other, ".bend.json")); err == nil {
		t.Fatal("a setting was written")
	}
}

func TestNobodyAtTheKeyboardFailsAtOnceNamingTheOption(t *testing.T) {
	dir := t.TempDir()
	_, err := Tracker(dir, nobody(t), Answers{}, Options{})
	if tracker.KindOf(err) != tracker.KindUsage || !strings.Contains(err.Error(), "--use beads or --use github") {
		t.Fatalf("got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".bend.json")); statErr == nil {
		t.Fatal("a setting was written")
	}
	// With the answer given as an option nobody is needed.
	outcome, err := Tracker(dir, nobody(t), Answers{Use: "beads"}, Options{})
	if err != nil || !outcome.Changed {
		t.Fatalf("got %+v, %v", outcome, err)
	}
	if _, err := Tracker(dir, nobody(t), Answers{Use: "linear"}, Options{}); tracker.KindOf(err) != tracker.KindUsage {
		t.Fatalf("got %v", err)
	}
	if _, err := Run("nonsense", dir, nobody(t), Answers{}, Options{}); tracker.KindOf(err) != tracker.KindUsage {
		t.Fatalf("got %v", err)
	}
}

func TestAYesIsAskedForAndANoChangesNothing(t *testing.T) {
	step := &Step{Title: "Do the thing", Why: "Because.", Explain: []string{"It does this."}, Runs: "some command"}
	said := []string{}
	if err := confirm(keyboard(&said, "n"), Answers{}, step); tracker.KindOf(err) != tracker.KindRefused || err == nil {
		t.Fatalf("got %v", err)
	}
	shown := strings.Join(said, "\n")
	for _, wanted := range []string{"Do the thing", "It does this.", "It runs: some command", "Go ahead?"} {
		if !strings.Contains(shown, wanted) {
			t.Fatalf("%q was not shown:\n%s", wanted, shown)
		}
	}
	if err := confirm(keyboard(&said, "YES"), Answers{}, step); err != nil {
		t.Fatal(err)
	}
	if err := confirm(nobody(t), Answers{Yes: true}, step); err != nil {
		t.Fatal(err)
	}
	if err := confirm(nobody(t), Answers{}, step); tracker.KindOf(err) != tracker.KindUsage || !strings.Contains(err.Error(), "-y") {
		t.Fatalf("got %v", err)
	}
}

func TestSavedFactsAreReadFromWhatBeadsPrints(t *testing.T) {
	got := SavedFactsFrom(`{"zeta": "last by name, first here", "schema_version": 1, "build": "Run make", "odd": 3}`)
	want := []facts.Fact{{Key: "zeta", Text: "last by name, first here"}, {Key: "build", Text: "Run make"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	for _, said := range []string{"", "null", "[]", `"text"`, "not json", `{"a": `} {
		if got := SavedFactsFrom(said); len(got) != 0 {
			t.Fatalf("%q gave %v", said, got)
		}
	}
}
