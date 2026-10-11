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
		check("RulesIn", RulesIn(want.Text), want.RulesIn)
		check("AgentsFileWith", AgentsFileWith(want.Text), want.AgentsFileWith)
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
