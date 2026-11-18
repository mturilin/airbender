package kept

import (
	"testing"
	"time"

	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

func TestObservationRefreshPreservesPendingWrites(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	writer := w.desk(dir)
	id, err := writer.tracker.Create(tracker.Draft{Title: "Original"})
	must(t, err)
	must(t, writer.tracker.Write(id, "plan", "Pending plan"))
	must(t, writer.tracker.Comment(id, "Pending comment"))
	before := w.github.BodyOf(1)
	w.pass(25 * time.Hour)
	observer := Open(github.New(w.github, ""), dir, Options{
		Now: func() time.Time { return w.clock }, NoSend: true,
	})
	listed, err := observer.List(tracker.ListFilter{})
	must(t, err)
	if len(listed) != 1 || listed[0].Plan != "Pending plan" || observer.Unsent(id) != 2 {
		t.Fatalf("pending work disappeared from observation: %+v", listed)
	}
	must(t, observer.Reread())
	if w.github.BodyOf(1) != before || observer.Status().Waiting != 2 {
		t.Fatal("observation sent or discarded pending writes")
	}
	comments, err := w.github.Comments(1)
	must(t, err)
	if len(comments) != 0 {
		t.Fatal("observation posted a queued comment")
	}
	// Explicit synchronization is still the operation that sends the queue.
	result := w.desk(dir).sync()
	if result.Sent != 2 || result.Waiting != 0 {
		t.Fatalf("explicit sync did not deliver preserved work: %+v", result)
	}
}

func TestStaleObservationPullsRemoteChangesWithoutSending(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	writer := w.desk(dir)
	id, err := writer.tracker.Create(tracker.Draft{Title: "Original"})
	must(t, err)
	must(t, writer.tracker.Comment(id, "Pending comment"))
	w.pass(4 * time.Minute)
	title := "Changed remotely"
	must(t, w.github.Update(1, github.Changes{Title: &title}))
	observer := Open(github.New(w.github, ""), dir, Options{
		Now: func() time.Time { return w.clock }, NoSend: true,
	})
	shown, err := observer.Show(id)
	must(t, err)
	if shown.Title != title || observer.Unsent(id) != 1 {
		t.Fatalf("stale observation did not pull while preserving pending work: %+v", shown)
	}
	comments, err := w.github.Comments(1)
	must(t, err)
	if len(comments) != 0 {
		t.Fatal("stale observation sent its pending comment")
	}
}

func TestOfflineObservationKeepsCachedIssuesAndPendingChanges(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	writer := w.desk(dir)
	id, err := writer.tracker.Create(tracker.Draft{Title: "Cached issue"})
	must(t, err)
	must(t, writer.tracker.Comment(id, "Pending comment"))
	w.pass(4 * time.Minute)
	w.github.down = true
	warnings := 0
	observer := Open(github.New(w.github, ""), dir, Options{
		Now: func() time.Time { return w.clock }, NoSend: true,
		Warn: func(string) { warnings++ },
	})
	shown, err := observer.Show(id)
	must(t, err)
	if shown.Title != "Cached issue" || shown.CommentCount != 1 || observer.Unsent(id) != 1 {
		t.Fatalf("offline observation hid cached or pending work: %+v", shown)
	}
	if warnings != 1 {
		t.Fatalf("refresh failure must be reported once; got %d warnings", warnings)
	}
}
