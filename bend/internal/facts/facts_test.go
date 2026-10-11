// facts_test.go — tests for the facts file.
//
// What: checks the pure text work (adding, replacing, reading, taking the
// old section out of AGENTS.md) and the file operations in throwaway
// folders.
//
// Why: facts are written into a file the owner also edits by hand; a slip
// here would damage their text.

package facts

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// oldAgents is an AGENTS.md with facts in the section they used to be kept
// in.
const oldAgents = "# Rules\n\nHand-written text.\n\n<!-- bend:facts:start -->\n## Remembered facts\n\n" +
	"Standing facts for every session, kept by `bend remember`. One line per fact; do not edit the markers.\n\n" +
	"- **build** — Run npm test\n- **deploys** — Tuesdays\n<!-- bend:facts:end -->\n\n## After\n\nMore of the owner's text.\n"

// read gives a file's text, failing the test when it cannot be read.
func read(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

// keys gives the keys of some facts, in order.
func keys(facts []Fact) []string {
	found := []string{}
	for _, fact := range facts {
		found = append(found, fact.Key)
	}
	return found
}

// recall gives a folder's facts, failing the test on an error.
func recall(t *testing.T, root string, words ...string) []Fact {
	t.Helper()
	found, err := Recall(root, words)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestFactIntoEmptyTextMakesAFile(t *testing.T) {
	text, replaced := WithFact("", Fact{"build", "Run npm test"})
	if replaced || !strings.HasPrefix(text, "# Facts\n\nStanding facts about this project") ||
		!strings.HasSuffix(text, "\n\n- **build** — Run npm test\n") {
		t.Fatalf("got %q", text)
	}
	if got := Read(text); !reflect.DeepEqual(got, []Fact{{"build", "Run npm test"}}) {
		t.Fatalf("got %v", got)
	}
}

func TestFactIsAddedOrReplacesItsOwnLine(t *testing.T) {
	file := "# Facts\n\nMy own words.\n\n- **a** — one\n- **b** — two\n"
	added, _ := WithFact(file, Fact{"c", "three"})
	if added != file+"- **c** — three\n" {
		t.Fatalf("got %q", added)
	}
	text, replaced := WithFact(added, Fact{"a", "ONE"})
	if !replaced || text != "# Facts\n\nMy own words.\n\n- **a** — ONE\n- **b** — two\n- **c** — three\n" {
		t.Fatalf("got %q", text)
	}
}

func TestHandWrittenFactLines(t *testing.T) {
	got := Read("# Facts\n\n- **a**: one\n- **b** - two\n- not a fact\nplain text\n- **c** — three\n")
	if !reflect.DeepEqual(got, []Fact{{"a", "one"}, {"b", "two"}, {"c", "three"}}) {
		t.Fatalf("got %v", got)
	}
	if got := Read("# Rules\n"); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestKeyFromFirstWords(t *testing.T) {
	if got := KeyFor("Run npm test, then hand over!"); got != "run-npm-test-then-hand-over" {
		t.Fatalf("got %q", got)
	}
}

func TestOldSectionIsTakenOutWhole(t *testing.T) {
	found, rest := SplitOld(oldAgents)
	if !reflect.DeepEqual(found, []Fact{{"build", "Run npm test"}, {"deploys", "Tuesdays"}}) {
		t.Fatalf("got %v", found)
	}
	if rest != "# Rules\n\nHand-written text.\n\n## After\n\nMore of the owner's text.\n" {
		t.Fatalf("got %q", rest)
	}
	// No section: the very same text, so nothing is rewritten.
	plain := "# Rules\n\nKeep me.\n"
	if _, same := SplitOld(plain); same != plain {
		t.Fatalf("got %q", same)
	}
}

func TestRememberReplacesAndRecallFilters(t *testing.T) {
	root := t.TempDir()
	agents := filepath.Join(root, "AGENTS.md")
	os.WriteFile(agents, []byte("# Rules\n\nKeep me.\n"), 0o644)
	if key, replaced, err := Remember(root, "Deploys go out\non Mondays", "deploys"); key != "deploys" || replaced || err != nil {
		t.Fatalf("got %q %v %v", key, replaced, err)
	}
	if _, replaced, _ := Remember(root, "Deploys go out on Tuesdays", "deploys"); !replaced {
		t.Fatal("not replaced")
	}
	if key, _, _ := Remember(root, "Run npm test", ""); key != "run-npm-test" {
		t.Fatalf("got %q", key)
	}
	want := []Fact{{"deploys", "Deploys go out on Tuesdays"}, {"run-npm-test", "Run npm test"}}
	if got := recall(t, root); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if got := keys(recall(t, root, "TUESDAY")); !reflect.DeepEqual(got, []string{"deploys"}) {
		t.Fatalf("got %v", got)
	}
	if read(t, agents) != "# Rules\n\nKeep me.\n" {
		t.Fatal("AGENTS.md was written")
	}
	if !strings.HasPrefix(read(t, filepath.Join(root, File)), "# Facts\n") {
		t.Fatal("no heading")
	}
	if _, _, err := Remember(root, "   ", ""); tracker.KindOf(err) != tracker.KindUsage {
		t.Fatalf("got %v", err)
	}
}

func TestFolderWithoutAnyFile(t *testing.T) {
	root := t.TempDir()
	if got := recall(t, root); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
	Remember(root, "First fact", "")
	if got := recall(t, root); len(got) != 1 || got[0].Text != "First fact" {
		t.Fatalf("got %v", got)
	}
}

func TestOldFactsAreRecalledAndMoveOnNextSave(t *testing.T) {
	root := t.TempDir()
	agents := filepath.Join(root, "AGENTS.md")
	os.WriteFile(agents, []byte(oldAgents), 0o644)
	// Reading moves nothing.
	if got := keys(recall(t, root)); !reflect.DeepEqual(got, []string{"build", "deploys"}) {
		t.Fatalf("got %v", got)
	}
	if read(t, agents) != oldAgents {
		t.Fatal("a read wrote AGENTS.md")
	}
	// A fact FACTS.md already holds under the same key is the newer one.
	os.WriteFile(filepath.Join(root, File), []byte("# Facts\n\n- **deploys** — Wednesdays\n"), 0o644)
	want := []Fact{{"deploys", "Wednesdays"}, {"build", "Run npm test"}}
	if got := recall(t, root); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	Remember(root, "Ids are monospace", "ids")
	want = append(want, Fact{"ids", "Ids are monospace"})
	if got := recall(t, root); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if read(t, agents) != "# Rules\n\nHand-written text.\n\n## After\n\nMore of the owner's text.\n" {
		t.Fatalf("got %q", read(t, agents))
	}
	if moved, _ := MoveOld(root); moved != 0 {
		t.Fatal("something was left to move")
	}
}

func TestEnsureFile(t *testing.T) {
	root := t.TempDir()
	if created, err := EnsureFile(root); !created || err != nil {
		t.Fatalf("got %v %v", created, err)
	}
	if created, _ := EnsureFile(root); created {
		t.Fatal("created twice")
	}
	if !strings.HasPrefix(read(t, filepath.Join(root, File)), "# Facts\n") {
		t.Fatal("no heading")
	}
}
