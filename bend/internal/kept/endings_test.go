// endings_test.go — terminal outcomes through the real queue/adapter pair.
// Exercises offline overlays, dependency recalculation, retry and reopening.
package kept

import (
	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
	"testing"
)

// TestQueuedCancellationSurvivesOfflineAndStillBlocks checks the common
// closed representation before/after sync and after loading a new copy.
func TestQueuedCancellationSurvivesOfflineAndStillBlocks(t *testing.T) {
	w := newWorld(t)
	path := t.TempDir()
	desk := w.desk(path)
	blocker, err := desk.tracker.Create(tracker.Draft{Title: "Blocker"})
	must(t, err)
	waiter, err := desk.tracker.Create(tracker.Draft{Title: "Waiter"})
	must(t, err)
	must(t, desk.tracker.Link(waiter, blocker, "blocked-by"))
	desk.sync()
	w.github.down = true
	must(t, tracker.CloseWith(desk.tracker, blocker, tracker.CloseOptions{Ending: "cancelled", Commit: "abc", RequestID: "close-1"}))
	desk = w.desk(path)
	if got := desk.show(blocker); got.Status != "closed" || got.Ending != "cancelled" || got.ClosedAt == nil {
		t.Fatalf("overlay lost closing: %+v", got)
	}
	if len(desk.show(waiter).BlockedBy) != 1 {
		t.Fatal("offline cancelled blocker released dependent")
	}
	w.github.down = false
	desk.sync()
	desk = w.desk(path)
	if desk.show(blocker).Ending != "cancelled" || len(desk.show(waiter).BlockedBy) != 1 {
		t.Fatal("sync lost ending or blocking")
	}
	must(t, desk.tracker.Reopen(blocker))
	if got := desk.show(blocker); got.Ending != "" || got.ClosedAt != nil {
		t.Fatal("reopen kept active closing fields")
	}
	desk.sync()
}

// TestQueuedParentCloseRechecksTheLiveTree covers a sub-issue created on
// another computer after the close was accepted in the local copy.
func TestQueuedParentCloseRechecksTheLiveTree(t *testing.T) {
	w := newWorld(t)
	desk := w.desk(t.TempDir())
	parent, err := desk.tracker.Create(tracker.Draft{Title: "Parent"})
	must(t, err)
	must(t, tracker.CloseWith(desk.tracker, parent, tracker.CloseOptions{Ending: "done"}))
	remote := github.New(w.github, "")
	_, err = remote.Create(tracker.Draft{Title: "Late child", ParentID: &parent})
	must(t, err)
	desk.sync()
	if desk.show(parent).Status == "closed" {
		t.Fatal("a stale queued close bypassed the live parent guard")
	}
}

// TestQueuedDuplicateShowsItsNoteAndLinksBeforeSync prevents a terminal
// local overlay from hiding the audit trail until the network returns.
func TestQueuedDuplicateShowsItsNoteAndLinksBeforeSync(t *testing.T) {
	w := newWorld(t)
	desk := w.desk(t.TempDir())
	target, err := desk.tracker.Create(tracker.Draft{Title: "Original"})
	must(t, err)
	id, err := desk.tracker.Create(tracker.Draft{Title: "Duplicate"})
	must(t, err)
	options := tracker.CloseOptions{Ending: "duplicate", DuplicateOf: target, RequestID: "queued-dup"}
	for range 2 {
		must(t, tracker.CloseWith(desk.tracker, id, options))
	}
	for _, issue := range []tracker.Issue{desk.show(id), desk.show(target)} {
		if len(issue.Links) != 1 {
			t.Fatalf("local duplicate links: %+v", issue.Links)
		}
	}
	notes, err := desk.tracker.Comments(id)
	must(t, err)
	if len(notes) != 1 || desk.show(id).CommentCount != 1 {
		t.Fatal("pending close note missing or repeated")
	}
	desk.sync()
	notes, err = desk.tracker.Comments(id)
	must(t, err)
	if len(notes) != 1 {
		t.Fatal("sync duplicated the closing note")
	}
}
