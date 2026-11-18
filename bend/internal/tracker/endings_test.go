// Regression coverage for terminal outcomes versus resolved dependencies.
package tracker

import (
	"encoding/json"
	"testing"
)

// TestEndingsNormalizeWithoutLosingCancellation exercises the adapter contract.
func TestEndingsNormalizeWithoutLosingCancellation(t *testing.T) {
	for _, ending := range Endings {
		status := ending
		if ending == "done" {
			status = "closed"
		}
		options := CloseOptions{Ending: ending, Reason: "reason", At: "2026-10-25T00:00:00Z", Commit: "abc"}
		metadata, _ := json.Marshal(map[string]any{ClosingKey: options, "owner": "keep"})
		issue := (Issue{ID: "x", Status: status, Metadata: metadata}).Tidy()
		if issue.Status != "closed" || issue.Ending != ending || issue.CloseReason != "reason" || issue.ClosedAt == nil {
			t.Fatalf("%s: %+v", ending, issue)
		}
		if Blocks(issue.Status, issue.Ending) != (ending == "cancelled") {
			t.Fatalf("blocking differs for %s", ending)
		}
		issue.Status = "open"
		issue = issue.Tidy()
		if issue.Ending != "" || issue.ClosedAt != nil {
			t.Fatal("reopened issue kept closing data")
		}
	}
	if got := (Issue{Status: "closed"}).Tidy(); got.Ending != "done" {
		t.Fatal("old closed issue did not read as Done")
	}
}

// TestCloseRejectsOpenDescendantsAndBadDuplicate validates before any write.
func TestCloseRejectsOpenDescendantsAndBadDuplicate(t *testing.T) {
	all := []Issue{{ID: "parent", Status: "open"}, {ID: "child", ParentID: Ptr("parent"), Status: "closed"}, {ID: "grandchild", ParentID: Ptr("child"), Status: "open"}}
	if ValidateClose(all, "parent", CloseOptions{}) == nil {
		t.Fatal("open descendant was ignored")
	}
	all[2].Status = "verified"
	if err := ValidateClose(all, "parent", CloseOptions{}); err != nil {
		t.Fatal(err)
	}
	if ValidateClose(all, "parent", CloseOptions{Ending: "duplicate", DuplicateOf: "parent"}) == nil {
		t.Fatal("self duplicate accepted")
	}
	if _, err := (CloseOptions{Ending: "wrong"}).Prepared(); err == nil {
		t.Fatal("unknown ending accepted")
	}
}
