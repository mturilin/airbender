// endings_test.go — custom Beads outcomes against disposable repositories.
// No live project issues are changed; bd is exercised only by the fixture.
package e2e

import (
	"testing"
)

// TestNativeEndingsAndParentGuard exercises setup, close, list and reopen.
func TestNativeEndingsAndParentGuard(t *testing.T) {
	newOnly(t)
	repo := bare(t)
	repo.ok("setup", "all", "-y", "--use", "beads")
	for _, ending := range []string{"done", "verified", "cancelled", "duplicate"} {
		id := repo.ok("create", "Work "+ending)
		repo.ok("close", id, "--ending", ending, "--reason", "Kept reason", "--request", "test-"+ending)
		var issue struct {
			Status      string  `json:"status"`
			Ending      string  `json:"ending"`
			ClosedAt    *string `json:"closedAt"`
			CloseReason string  `json:"closeReason"`
		}
		repo.parse(repo.ok("show", id, "--json"), &issue)
		if issue.Status != "closed" || issue.Ending != ending || issue.ClosedAt == nil || issue.CloseReason != "Kept reason" {
			t.Fatalf("%s: %+v", ending, issue)
		}
		repo.ok("close", id, "--ending", ending, "--reason", "Kept reason", "--request", "test-"+ending)
		repo.ok("reopen", id)
		issue.Status, issue.Ending, issue.ClosedAt, issue.CloseReason = "", "", nil, ""
		repo.parse(repo.ok("show", id, "--json"), &issue)
		if issue.Status != "open" || issue.Ending != "" || issue.ClosedAt != nil {
			t.Fatalf("reopen: %+v", issue)
		}
	}
	parent := repo.ok("create", "Parent")
	repo.ok("create", "Child", "--parent", parent)
	for _, ending := range []string{"done", "cancelled", "verified", "duplicate"} {
		if repo.status("close", parent, "--ending", ending) != 1 {
			t.Fatal("closed parent with open child")
		}
	}
	original := repo.ok("create", "Original")
	duplicate := repo.ok("create", "Duplicate")
	for range 2 {
		repo.ok("close", duplicate, "--ending", "duplicate", "--duplicate-of", original, "--request", "duplicate-target")
	}
	blocker := repo.ok("create", "Cancelled blocker")
	waiting := repo.ok("create", "Dependent", "--blocked-by", blocker)
	repo.ok("close", blocker, "--ending", "cancelled")
	var ready []struct {
		ID string `json:"id"`
	}
	repo.parse(repo.ok("ready", "--json"), &ready)
	for _, issue := range ready {
		if issue.ID == waiting {
			t.Fatal("native ready released a cancelled dependency")
		}
	}
}
