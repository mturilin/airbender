// beads_test.go — tests for the pure half of the beads adapter.
//
// What: checks how beads' rows become issues in the common shape (parts,
// links from both ends, sub-issues, what blocks what), and how bd's
// refusals are put into words.
//
// Why: this mapping is where a slip would show wrong links or wrong
// "blocked" marks everywhere. How the adapter drives the real bd is checked
// by the end-to-end suite (bend/e2e).

package beads

import (
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// row is a row as `bd list --json` gives it; change adjusts it.
func row(id string, change func(*Row)) Row {
	made := Row{ID: id, Title: strings.ToUpper(id), Status: "open"}
	if change != nil {
		change(&made)
	}
	return made
}

// deps gives a change that sets a row's dependencies from pairs of (other
// id, type).
func deps(pairs ...string) func(*Row) {
	return func(made *Row) {
		for at := 0; at < len(pairs); at += 2 {
			made.Dependencies = append(made.Dependencies, Dependency{DependsOnID: pairs[at], Type: pairs[at+1]})
		}
	}
}

// under gives a change that puts a row under a parent.
func under(parent string) func(*Row) {
	return func(made *Row) { made.Parent = &parent }
}

// find gives the issue with an id among the issues made from rows.
func find(t *testing.T, rows []Row, id string) tracker.Issue {
	t.Helper()
	for _, issue := range ToIssues(rows) {
		if issue.ID == id {
			return issue
		}
	}
	t.Fatalf("no issue %s", id)
	return tracker.Issue{}
}

// linksOf gives an issue's links as "kind direction id".
func linksOf(issue tracker.Issue) []string {
	found := []string{}
	for _, link := range issue.Links {
		found = append(found, link.Kind+" "+link.Direction+" "+link.ID)
	}
	return found
}

// refIDs gives the ids of some pointers to issues.
func refIDs(refs []tracker.IssueRef) []string {
	found := []string{}
	for _, ref := range refs {
		found = append(found, ref.ID)
	}
	return found
}

// equal fails the test when got is not want.
func equal(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestFieldsLandInTheCommonParts(t *testing.T) {
	issue := find(t, []Row{row("a", func(made *Row) {
		made.Description = "Wanted.\n\n<!-- bend:requirements -->\n## Requirements\n\nR1\n<!-- /bend:requirements -->"
		made.AcceptanceCriteria = "Done when…"
		made.Design = "The plan"
		made.Notes = "A note"
		made.IssueType = tracker.Ptr("bug")
		made.Priority = tracker.Ptr(1)
		made.Assignee = tracker.Ptr("sam")
		made.Labels = []string{"category:ux", "urgent"}
		made.CommentCount = 2
	})}, "a")
	equal(t, []string{issue.Description, issue.Requirements, issue.Done, issue.Plan, issue.Notes},
		[]string{"Wanted.", "R1", "Done when…", "The plan", "A note"})
	equal(t, *issue.Category, "ux")
	equal(t, issue.Labels, []string{"urgent"})
	equal(t, []any{*issue.Type, *issue.Priority, *issue.Assignee, issue.CommentCount}, []any{"bug", 1, "sam", 2})
}

func TestBlockingLinkShowsFromBothEnds(t *testing.T) {
	rows := []Row{row("a", deps("b", "blocks")), row("b", nil)}
	equal(t, linksOf(find(t, rows, "a")), []string{"blocked-by out b"})
	equal(t, linksOf(find(t, rows, "b")), []string{"blocked-by in a"})
	equal(t, refIDs(find(t, rows, "a").BlockedBy), []string{"b"})
}

func TestClosedBlockerNoLongerBlocks(t *testing.T) {
	issue := find(t, []Row{
		row("a", deps("b", "blocks")),
		row("b", func(made *Row) { made.Status = "closed" }),
	}, "a")
	equal(t, issue.BlockedBy, []tracker.IssueRef{})
	equal(t, issue.Links[0].Status, "closed")
}

func TestRelatedLinkShowsOncePerIssue(t *testing.T) {
	both := []Row{row("a", deps("b", "relates-to")), row("b", deps("a", "relates-to"))}
	oneWay := []Row{row("a", deps("b", "relates-to")), row("b", nil)}
	for _, rows := range [][]Row{both, oneWay} {
		equal(t, linksOf(find(t, rows, "a")), []string{"related out b"})
		equal(t, linksOf(find(t, rows, "b")), []string{"related out a"})
	}
}

func TestSubIssuesAreNotLinks(t *testing.T) {
	rows := []Row{row("p", nil), row("c", func(made *Row) {
		under("p")(made)
		deps("p", "parent-child")(made)
	})}
	equal(t, refIDs(find(t, rows, "p").SubIssues), []string{"c"})
	equal(t, *find(t, rows, "c").ParentID, "p")
	equal(t, find(t, rows, "c").Links, []tracker.Link{})
}

func TestSubIssueOfBlockedIssueIsBlocked(t *testing.T) {
	rows := []Row{row("x", nil), row("p", deps("x", "blocks")), row("c", under("p")), row("g", under("c"))}
	equal(t, refIDs(find(t, rows, "g").BlockedBy), []string{"x"})
	// A loop in the parent data is not followed.
	loop := []Row{row("a", under("b")), row("b", under("a"))}
	equal(t, find(t, loop, "a").BlockedBy, []tracker.IssueRef{})
}

func TestLinkOutsideTheListAndUnknownKind(t *testing.T) {
	rows := []Row{row("a", deps("gone", "blocks", "b", "supersedes")), row("b", nil)}
	equal(t, linksOf(find(t, rows, "a")), []string{"supersedes out b"})
}

func TestDescendantIDs(t *testing.T) {
	rows := []Row{row("p", nil), row("c", under("p")), row("g", under("c")), row("o", nil)}
	keys := func(set map[string]bool) []string {
		found := []string{}
		for id := range set {
			found = append(found, id)
		}
		sort.Strings(found)
		return found
	}
	equal(t, keys(DescendantIDs("p", rows)), []string{"c", "g"})
	equal(t, keys(DescendantIDs("a", []Row{row("a", under("b")), row("b", under("a"))})), []string{"b"})
}

func TestRefusalsArePutIntoWords(t *testing.T) {
	equal(t,
		Explain("cannot close t-1: 2 open child issue(s); close children first or use --force to override"),
		"cannot close t-1: 2 open child issue(s); close them first")
	assigned := Explain(`cannot close t-1: assignee is "sam", actor is "kim"; reclaim or use --force to override`)
	if !strings.Contains(assigned, "assigned to sam, and you are acting as kim") {
		t.Fatalf("got %q", assigned)
	}
	// No command of bend's or of bd's is named: the tab shows these too.
	if regexp.MustCompile(`bend |bd |--`).MatchString(assigned) {
		t.Fatalf("got %q", assigned)
	}
	if !strings.Contains(Explain("Error updating t-1: adding dependency would create a cycle"), "make a loop") {
		t.Fatal("a cycle was not explained")
	}
	equal(t, Explain("Error: no such thing\nUsage:\n  bd …"), "no such thing")
}

func TestMetadataAndExternalRef(t *testing.T) {
	rows := []Row{
		row("a", func(made *Row) {
			made.Metadata = []byte(`{"branch": "a-kanban"}`)
			made.ExternalRef = tracker.Ptr("gh-12")
		}),
		row("b", func(made *Row) { made.Metadata = []byte(`"text"`) }),
		row("c", func(made *Row) { made.Metadata = []byte(`["x"]`) }),
		row("d", nil),
	}
	issues := ToIssues(rows)
	equal(t, string(issues[0].Metadata), `{"branch": "a-kanban"}`)
	equal(t, *issues[0].ExternalRef, "gh-12")
	for _, issue := range issues[1:] {
		equal(t, string(issue.Metadata), "{}")
		if issue.ExternalRef != nil {
			t.Fatalf("%s has a counterpart", issue.ID)
		}
	}
}
