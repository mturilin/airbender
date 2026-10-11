// parts_test.go — tests for the pure text helpers.
//
// What: checks keeping a part as a marked section inside another text, links
// kept as text, tidying category names, and the shape of a hand-over.
//
// Why: requirements live inside the description on trackers without a field
// for them; a slip here would lose or duplicate an issue's text.

package tracker

import (
	"reflect"
	"strings"
	"testing"
)

func TestSectionRoundTrip(t *testing.T) {
	joined := JoinSection("What is wanted.", "requirements", "Requirements", "1. A\n2. B")
	if !strings.HasPrefix(joined, "What is wanted.") || !strings.Contains(joined, "## Requirements") {
		t.Fatalf("unexpected text: %q", joined)
	}
	rest, section := SplitSection(joined, "requirements")
	if rest != "What is wanted." || section != "1. A\n2. B" {
		t.Fatalf("got rest %q, section %q", rest, section)
	}
}

func TestTextWithoutSectionIsAllRest(t *testing.T) {
	rest, section := SplitSection("  Just text.\n", "requirements")
	if rest != "Just text." || section != "" {
		t.Fatalf("got rest %q, section %q", rest, section)
	}
}

func TestEmptySectionLeavesNoMarkers(t *testing.T) {
	if got := JoinSection("Text.", "requirements", "Requirements", "  "); got != "Text." {
		t.Fatalf("got %q", got)
	}
}

func TestSectionCanStandAlone(t *testing.T) {
	alone := JoinSection("", "requirements", "Requirements", "Only this")
	rest, section := SplitSection(alone, "requirements")
	if rest != "" || section != "Only this" {
		t.Fatalf("got rest %q, section %q", rest, section)
	}
}

func TestRewritingEitherHalfKeepsTheOther(t *testing.T) {
	_, section := SplitSection(WithRequirements("Old description.", "R1"), "requirements")
	description, requirements := SplitRequirements(WithRequirements("New description.", section))
	if description != "New description." || requirements != "R1" {
		t.Fatalf("got %q and %q", description, requirements)
	}
}

func TestSeveralSections(t *testing.T) {
	text := JoinSections("Body.", []Section{
		{Name: "plan", Heading: "Plan", Text: "Step 1"},
		{Name: "notes", Heading: "Notes", Text: ""},
		{Name: "done", Heading: "Done means", Text: "It works"},
	})
	rest, sections := SplitSections(text, []string{"plan", "notes", "done"})
	want := map[string]string{"plan": "Step 1", "notes": "", "done": "It works"}
	if rest != "Body." || !reflect.DeepEqual(sections, want) {
		t.Fatalf("got rest %q, sections %v", rest, sections)
	}
}

func TestTextLinks(t *testing.T) {
	links := []TextLink{
		{Kind: "discovered-from", Direction: "out", ID: "12"},
		{Kind: "discovered-from", Direction: "in", ID: "7"},
		{Kind: "related", Direction: "out", ID: "3"},
	}
	text := FormatTextLinks(links)
	if text != "- discovered from #12\n- led to #7\n- related to #3" {
		t.Fatalf("got %q", text)
	}
	read := ParseTextLinks(text + "\n- something a person wrote\n* Related To #3\n")
	if !reflect.DeepEqual(read, links) {
		t.Fatalf("got %v", read)
	}
}

func TestCategoryNames(t *testing.T) {
	if name, err := CleanCategory("  UX   Polish "); err != nil || name != "ux polish" {
		t.Fatalf("got %q, %v", name, err)
	}
	for _, bad := range []string{"  ", "a,b", strings.Repeat("x", 41)} {
		if _, err := CleanCategory(bad); KindOf(err) != KindRefused || err == nil {
			t.Fatalf("%q was not refused", bad)
		}
	}
}

func TestHandoverMustSayAllThree(t *testing.T) {
	text, err := HandoverText("Built it", "Tests", "nothing")
	if err != nil || !strings.HasPrefix(text, "Hand-over:") ||
		!strings.Contains(text, "What was done: Built it") ||
		!strings.Contains(text, "Not checked: nothing") {
		t.Fatalf("got %q, %v", text, err)
	}
	_, err = HandoverText("Built it", "Tests", " ")
	if KindOf(err) != KindUsage || !strings.Contains(err.Error(), "--not-checked") {
		t.Fatalf("got %v", err)
	}
}
