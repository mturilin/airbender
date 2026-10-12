// instructions_test.go — the instruction rules, against the answers the
// plugin's TypeScript gave.
//
// What: runs every function over the inputs in testdata/vectors.json and
// compares with the answers recorded there, which were produced by
// server/prompts.ts before it was removed (bead-bb-c9l.9). The inputs
// include files that a real `bd init` and `bd setup codex` wrote.
//
// Why: a repository set up by an earlier version must be read exactly as
// before: an old rules block still recognised as ours, the owner's own
// still left alone, beads' text removed to the same letter.

package instructions

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// vector is one input with the answers the TypeScript gave for it.
type vector struct {
	Text               string   `json:"text"`
	RulesIn            string   `json:"rulesIn"`
	AgentsFileWith     string   `json:"agentsFileWith"`
	HasBeadsBlocks     bool     `json:"hasBeadsBlocks"`
	WithoutBeadsBlocks string   `json:"withoutBeadsBlocks"`
	BeadsLeftovers     []string `json:"beadsLeftovers"`
	// ClaudeFileFor is nil where nothing is to be written.
	ClaudeFileFor *string `json:"claudeFileFor"`
}

func TestSameAnswersAsThePluginGave(t *testing.T) {
	content, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(content, &recorded); err != nil {
		t.Fatal(err)
	}
	if len(recorded.Vectors) < 30 {
		t.Fatalf("only %d inputs", len(recorded.Vectors))
	}
	earlier, err := os.ReadFile("testdata/rules-v2-beads.md")
	if err != nil {
		t.Fatal(err)
	}
	recordedRules := string(earlier)
	for index, want := range recorded.Vectors {
		start := want.Text
		if len(start) > 40 {
			start = start[:40]
		}
		check := func(what string, got, wanted any) {
			t.Helper()
			if !reflect.DeepEqual(got, wanted) {
				t.Errorf("input %d (%q...): %s:\n got  %q\n want %q", index, start, what, got, wanted)
			}
		}
		// The recording was made when version 2 was current: what it
		// calls current is an earlier version of ours now, and where it
		// wrote those rules the present ones stand.
		wantIn := want.RulesIn
		if wantIn == "current" {
			wantIn = "old"
		}
		// A block the owner changed was "edited" whatever its version; one
		// that does not name the present version is now told apart as
		// "behind". Either way it is left as it is, which the next check
		// holds.
		if wantIn == "edited" && VersionIn(want.Text) != CurrentVersion {
			wantIn = "behind"
		}
		check("RulesIn", RulesIn(want.Text), wantIn)
		got := AgentsFileWith(want.Text)
		if want.RulesIn == "current" && !strings.Contains(want.AgentsFileWith, recordedRules) {
			// Version 2 with other white space than it was written with
			// (indented, say): still ours, so replaced by the present
			// rules as they are written, with what stood before it kept.
			before := want.Text[:strings.Index(want.Text, RulesStart)]
			if !strings.HasPrefix(got, before+Rules) || RulesIn(got) != "current" {
				t.Errorf("input %d (%q...): a reflowed version 2 was not replaced in place:\n%q", index, start, got)
			}
		} else {
			check("AgentsFileWith", got, strings.ReplaceAll(want.AgentsFileWith, recordedRules, Rules))
		}
		check("HasBeadsBlocks", HasBeadsBlocks(want.Text), want.HasBeadsBlocks)
		check("WithoutBeadsBlocks", WithoutBeadsBlocks(want.Text), want.WithoutBeadsBlocks)
		check("BeadsLeftovers", BeadsLeftovers(WithoutBeadsBlocks(want.Text)), want.BeadsLeftovers)
		next, change := ClaudeFileFor(want.Text, true)
		if want.ClaudeFileFor == nil {
			check("ClaudeFileFor changes", change, false)
		} else {
			check("ClaudeFileFor", next, *want.ClaudeFileFor)
			check("ClaudeFileFor changes", change, true)
		}
	}
}

func TestEarlierVersionIsRecognisedAndReplacedInPlace(t *testing.T) {
	old, err := os.ReadFile("testdata/rules-v1.md")
	if err != nil {
		t.Fatal(err)
	}
	if got := RulesIn(string(old)); got != "old" {
		t.Fatalf("the version 1 block is %q", got)
	}
	file := "# Mine\n\nAbove.\n\n" + strings.TrimRight(string(old), "\n") + "\n\n## After\n\nBelow.\n"
	if got := AgentsFileWith(file); got != "# Mine\n\nAbove.\n\n"+Rules+"\n## After\n\nBelow.\n" {
		t.Fatalf("got %q", got)
	}
}

func TestRulesStandOnTheirOwn(t *testing.T) {
	if !strings.HasPrefix(Rules, RulesStart) || !strings.HasSuffix(Rules, rulesEnd+"\n") {
		t.Fatal("the rules are not between their markers")
	}
	if RulesIn(Rules) != "current" || AgentsFileWith(AgentsFileWith("# Mine\n")) != AgentsFileWith("# Mine\n") {
		t.Fatal("adding twice changes something")
	}
	if _, change := ClaudeFileFor("", false); change {
		t.Fatal("a CLAUDE.md is created where there is none")
	}
}

func TestOneWordingNamesOnlyBendAndReplacesBothEarlierOnes(t *testing.T) {
	// Nothing of beads but its name in the one sentence that rules its
	// program out.
	for _, word := range []string{"`bd ", "bd show", "bd update", "bd close", "beads issue", "beads_", "Working with beads"} {
		if strings.Contains(Rules, word) {
			t.Fatalf("the rules still say %q", word)
		}
	}
	for _, wanted := range []string{
		"**Issues only through `bend`.**", "(`bd`, `gh`) or on its website",
		"`bend show <id>`", "`bend write <id> plan", "`bend start <id>`", "`bend stop <id>`", "`bend note <id>",
		"`bend comment <id>", "`bend decide <id>", "`bend create", "bend link <id> <other-id> --kind blocked-by",
		"`airbender_set_current`", "`airbender_workflow_move`",
		"not by closing words in a commit or a pull request",
	} {
		if !strings.Contains(Rules, wanted) {
			t.Fatalf("the rules lack %s", wanted)
		}
	}
	// Both wordings of version 2 are ours, unchanged, and are replaced
	// where they stand; so is version 1.
	for _, name := range []string{"rules-v2-beads.md", "rules-v2-bend.md", "rules-v1.md"} {
		earlier, err := os.ReadFile("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		file := "# Mine\n\nAbove.\n\n" + string(earlier) + "\n## After\n\nBelow.\n"
		if got := RulesIn(file); got != "old" {
			t.Fatalf("%s is taken as %q", name, got)
		}
		if got := AgentsFileWith(file); got != "# Mine\n\nAbove.\n\n"+Rules+"\n## After\n\nBelow.\n" {
			t.Fatalf("%s was not replaced in place:\n%s", name, got)
		}
		// One the owner changed is theirs, and is left alone.
		// One the owner changed is theirs: never replaced unasked. Being
		// of an earlier version, it is behind, which the owner is told.
		edited := strings.Replace(file, "Every piece of work has an issue", "Every piece of work has an issue, here too", 1)
		if RulesIn(edited) != "behind" || AgentsFileWith(edited) != edited {
			t.Fatalf("an edited %s was not left alone, or not seen as behind", name)
		}
		// Replacing it gives the current rules in place and hands back
		// what was there; keeping it changes only the version it names.
		next, was := ReplaceRules(edited)
		if next != "# Mine\n\nAbove.\n\n"+Rules+"\n## After\n\nBelow.\n" || !strings.Contains(was, "here too") || !strings.HasPrefix(was, RulesStart) {
			t.Fatalf("replacing an edited %s gave:\n%s", name, next)
		}
		kept := KeepRules(edited)
		if RulesIn(kept) != "edited" || !strings.Contains(kept, "here too") || KeepRules(kept) != kept {
			t.Fatalf("keeping an edited %s gave %q:\n%s", name, RulesIn(kept), kept)
		}
	}
}

func TestRulesOfANewerVersionAndKeepingTouchOnlyWhatTheyMust(t *testing.T) {
	// Written by a newer bend than this one: not this bend's to call
	// behind, whether its owner changed it or not.
	newer := strings.Replace(Rules, "rules:version 3 -->", "rules:version 4 -->", 1)
	if got := RulesIn(newer); got != "edited" {
		t.Fatalf("rules of a newer version are taken as %q", got)
	}
	if AgentsFileWith(newer) != newer {
		t.Fatal("rules of a newer version were changed")
	}
	// Keeping changes the block's own version line and no other: one the
	// owner quotes further down stays as written.
	mine := "<!-- airbender:rules:start -->\n<!-- airbender:rules:version 1 -->\n## Mine\n\nThe line reads `<!-- airbender:rules:version 1 -->`.\n<!-- airbender:rules:end -->\n\n# After\n"
	want := "<!-- airbender:rules:start -->\n<!-- airbender:rules:version 3 -->\n## Mine\n\nThe line reads `<!-- airbender:rules:version 1 -->`.\n<!-- airbender:rules:end -->\n\n# After\n"
	if got := KeepRules(mine); got != want {
		t.Fatalf("keeping gave:\n%s", got)
	}
	// Whether a block says where it ends.
	if !RulesEnd(mine) || RulesEnd(strings.Replace(mine, "<!-- airbender:rules:end -->\n", "", 1)) || RulesEnd("# Nothing\n") {
		t.Fatal("the end marker was not told rightly")
	}
}
