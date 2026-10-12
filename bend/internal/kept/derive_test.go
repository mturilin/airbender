// derive_test.go — the copy's rule for what depends on other issues, held
// to the GitHub adapter's.
//
// What: builds repositories on the stand-in for GitHub, asks the GitHub
// adapter for the full list, throws away everything in it that depends on
// another issue, and checks that the copy puts exactly the adapter's own
// answer back together.
//
// Why: on a tracker reached over the network the copy always works those
// things out itself (derive.go says why). Its rule decides what "blocked"
// means in every list on such a repository, so it must be the adapter's.

package kept

import (
	"encoding/json"
	"testing"

	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// stripped gives issues with everything that depends on another issue
// thrown away or made wrong: what is left is each issue's own facts.
func stripped(issues []tracker.Issue) []tracker.Issue {
	bare := make([]tracker.Issue, len(issues))
	for index, issue := range issues {
		issue.Links = ownLinks(issue)
		for at := range issue.Links {
			issue.Links[at].Title, issue.Links[at].Status = "stale title", "open"
		}
		issue.SubIssues, issue.BlockedBy = nil, []tracker.IssueRef{{ID: "999", Title: "stale", Status: "open"}}
		bare[index] = issue
	}
	return bare
}

// sameAnswer fails the test unless the copy puts the adapter's own answer
// back together.
func sameAnswer(t *testing.T, adapter tracker.Tracker, what string) {
	t.Helper()
	want, err := adapter.List(tracker.ListFilter{Status: tracker.Ptr("all")})
	must(t, err)
	got := derive(stripped(want))
	for index := range want {
		wanted, _ := json.Marshal(want[index])
		had, _ := json.Marshal(got[index])
		if string(wanted) != string(had) {
			t.Fatalf("%s, issue %s:\n the adapter: %s\n the copy:    %s", what, want[index].ID, wanted, had)
		}
	}
}

func TestTheCopyPutsTogetherWhatTheAdapterAnswers(t *testing.T) {
	adapter := github.New(github.NewFake(github.FakeOptions{}), "")
	make := func(title string) string {
		id, err := adapter.Create(tracker.Draft{Title: title})
		must(t, err)
		return id
	}
	epic, child, grandchild := make("Epic"), make("Child"), make("Grandchild")
	blocker, other, lone := make("Blocker"), make("Other"), make("Lone")
	sameAnswer(t, adapter, "with nothing linked")

	must(t, adapter.Move(child, &epic))
	must(t, adapter.Move(grandchild, &child))
	sameAnswer(t, adapter, "with sub-issues")

	// What an issue waits for passes down to the issues inside it.
	must(t, adapter.Link(epic, blocker, "blocked-by"))
	must(t, adapter.Link(grandchild, other, "blocked-by"))
	sameAnswer(t, adapter, "with blockers")

	// Links kept as text, on both issues.
	must(t, adapter.Link(other, epic, "discovered-from"))
	must(t, adapter.Link(lone, blocker, "related"))
	must(t, adapter.Link(child, blocker, "related"))
	sameAnswer(t, adapter, "with links kept as text")

	// A closed blocker no longer blocks; a closed issue waits for nothing;
	// an issue in progress is pointed at as open.
	must(t, adapter.Close(other, "done"))
	must(t, adapter.Start(blocker))
	sameAnswer(t, adapter, "with a closed blocker and one in progress")
	must(t, adapter.Close(child, ""))
	sameAnswer(t, adapter, "with a closed issue between an epic and its grandchild")
	must(t, adapter.Reopen(child))
	must(t, adapter.Edit(blocker, tracker.Changes{Title: tracker.Ptr("Blocker, renamed")}))
	must(t, adapter.Unlink(lone, blocker, tracker.UnlinkOptions{}))
	must(t, adapter.Move(grandchild, nil))
	sameAnswer(t, adapter, "after renaming, unlinking and moving out")
}
