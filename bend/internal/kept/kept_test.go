// kept_test.go — the copy, over a stand-in tracker.
//
// What: checks when a read is answered from the copy and when the tracker
// is asked: a fresh copy, the tracker's sign changed, a change made through
// the copy, a copy a few minutes old, one more than a day old; and that
// "ready" and comments are kept and asked for again at the right moments.
//
// Why: the copy is only worth having if it is never wrong where the
// tracker's own answer would have been right. These are the rules that
// keep it so (bead-bb-c9l.14).

package kept

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// standIn is a tracker in memory that counts how often it is asked.
type standIn struct {
	issues   []tracker.Issue
	comments map[string][]tracker.Comment
	// mark is its sign; changed by the test to say "something changed".
	mark string
	// asked counts the reads made of it, by kind.
	lists, readies, commentReads int
	// down makes every read fail.
	down bool
	// searches counts the searches asked of it.
	searches int
	// duringList is run while a list is on its way back, when set.
	duringList func()
}

// offline is the failure of a stand-in that is down.
func offline() error { return tracker.Refused("The tracker could not be reached.") }

func (s *standIn) Sign() string { return s.mark }
func (s *standIn) About() tracker.About {
	return tracker.About{Tracker: "stand-in", Writes: tracker.WritesStraight}
}
func (s *standIn) Capabilities() (tracker.Capabilities, error) {
	return tracker.Capabilities{Tracker: "stand-in"}, nil
}

func (s *standIn) List(filter tracker.ListFilter) ([]tracker.Issue, error) {
	s.lists++
	if s.down {
		return nil, offline()
	}
	// As a slow tracker would: the list is what it was when asked, whatever
	// happens before the answer is back.
	listed, err := tracker.Narrow(slices.Clone(s.issues), filter)
	if s.duringList != nil {
		s.duringList()
	}
	return listed, err
}

func (s *standIn) Ready() ([]tracker.Issue, error) {
	s.readies++
	if s.down {
		return nil, offline()
	}
	return tracker.Narrow(s.issues, tracker.ListFilter{Status: tracker.Ptr("open")})
}

func (s *standIn) Show(id string) (tracker.Issue, error) {
	for _, issue := range s.issues {
		if issue.ID == id {
			return issue, nil
		}
	}
	return tracker.Issue{}, tracker.Refused("There is no issue with id %s.", id)
}

func (s *standIn) Comments(id string) ([]tracker.Comment, error) {
	s.commentReads++
	if s.down {
		return nil, offline()
	}
	return s.comments[id], nil
}

func (s *standIn) Search(string) ([]tracker.Issue, error) {
	s.searches++
	return []tracker.Issue{}, nil
}

// make adds an issue, as the tracker itself would: its sign changes.
func (s *standIn) add(id, title, status string) {
	at := "2026-03-01T09:00:00Z"
	s.issues = append(s.issues, tracker.Issue{ID: id, Title: title, Status: status, UpdatedAt: &at}.Tidy())
	s.mark += "+"
}

func (s *standIn) Create(draft tracker.Draft) (string, error) {
	id := "s-" + string(rune('a'+len(s.issues)))
	s.add(id, draft.Title, "open")
	return id, nil
}

func (s *standIn) Edit(id string, changes tracker.Changes) error {
	for index := range s.issues {
		if s.issues[index].ID == id && changes.Title != nil {
			s.issues[index].Title = *changes.Title
			return nil
		}
	}
	return tracker.Refused("There is no issue with id %s.", id)
}

func (s *standIn) Comment(id, text string) error {
	if s.comments == nil {
		s.comments = map[string][]tracker.Comment{}
	}
	s.comments[id] = append(s.comments[id], tracker.Comment{ID: "c", Text: text})
	for index := range s.issues {
		if s.issues[index].ID == id {
			s.issues[index].CommentCount++
		}
	}
	return nil
}

func (s *standIn) Write(string, string, string) error                 { return nil }
func (s *standIn) Start(string) error                                 { return nil }
func (s *standIn) Stop(string) error                                  { return nil }
func (s *standIn) Close(string, string) error                         { return nil }
func (s *standIn) Reopen(string) error                                { return nil }
func (s *standIn) Defer(string) error                                 { return nil }
func (s *standIn) Undefer(string) error                               { return nil }
func (s *standIn) Move(string, *string) error                         { return nil }
func (s *standIn) Link(string, string, string) error                  { return nil }
func (s *standIn) Unlink(string, string, tracker.UnlinkOptions) error { return nil }

// bench is a stand-in tracker, a folder for its copy and a clock.
type bench struct {
	t     *testing.T
	inner *standIn
	dir   string
	clock time.Time
}

// newBench makes a tracker with two issues and no copy yet.
func newBench(t *testing.T) *bench {
	made := &bench{t: t, inner: &standIn{mark: "start"}, dir: t.TempDir(), clock: time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)}
	made.inner.add("s-a", "First", "open")
	made.inner.add("s-b", "Second", "closed")
	return made
}

// open opens the copy as a new bend process would: nothing is kept in
// memory from before. warned collects what it says.
func (b *bench) open(warned *string) *Tracker {
	return Open(b.inner, b.dir, Options{
		Now: func() time.Time { return b.clock },
		Warn: func(text string) {
			if warned != nil {
				*warned = text
			}
		},
	})
}

// titles gives the titles of every issue a copy lists, joined.
func (b *bench) titles(held *Tracker) string {
	b.t.Helper()
	listed, err := held.List(tracker.ListFilter{Status: tracker.Ptr("all")})
	if err != nil {
		b.t.Fatal(err)
	}
	found := []string{}
	for _, issue := range listed {
		found = append(found, issue.Title)
	}
	return strings.Join(found, ", ")
}

func TestAFreshCopyAnswersWithoutAskingTheTracker(t *testing.T) {
	b := newBench(t)
	if got := b.titles(b.open(nil)); got != "First, Second" || b.inner.lists != 1 {
		t.Fatalf("got %q after %d reads of the tracker", got, b.inner.lists)
	}
	// A new process, a minute later: nothing is asked, for any kind of read.
	b.clock = b.clock.Add(time.Minute)
	held := b.open(nil)
	open, _ := held.List(tracker.ListFilter{})
	shown, err := held.Show("s-b")
	if len(open) != 1 || err != nil || shown.Title != "Second" || b.titles(held) != "First, Second" {
		t.Fatalf("got %v, %v", open, shown)
	}
	if _, err := held.Show("s-nope"); err == nil || err.Error() != "There is no issue with id s-nope." {
		t.Fatalf("got %v", err)
	}
	if b.inner.lists != 1 || held.wantsReread {
		t.Fatalf("the tracker was asked %d times", b.inner.lists)
	}
	// The tracker gone, the copy still answers.
	b.inner.down = true
	if got := b.titles(b.open(nil)); got != "First, Second" {
		t.Fatalf("got %q", got)
	}
}

func TestTheTrackersSignSaysTheCopyIsBehind(t *testing.T) {
	b := newBench(t)
	b.titles(b.open(nil))
	// Changed with the tracker's own program, behind bend's back.
	b.inner.add("s-c", "Third", "open")
	if got := b.titles(b.open(nil)); got != "First, Second, Third" || b.inner.lists != 2 {
		t.Fatalf("got %q after %d reads", got, b.inner.lists)
	}
	// And then fresh again.
	if b.titles(b.open(nil)); b.inner.lists != 2 {
		t.Fatalf("asked %d times", b.inner.lists)
	}
}

func TestAChangeMadeThroughTheCopyIsSeenByTheNextRead(t *testing.T) {
	b := newBench(t)
	held := b.open(nil)
	b.titles(held)
	// This tracker's sign does not move for an edit: the copy must know by
	// itself that it is behind.
	if err := held.Edit("s-a", tracker.Changes{Title: tracker.Ptr("First, renamed")}); err != nil {
		t.Fatal(err)
	}
	// In the same process...
	if got := b.titles(held); got != "First, renamed, Second" {
		t.Fatalf("got %q", got)
	}
	// ...and in the next, when no reread ran behind the command.
	if err := held.Edit("s-a", tracker.Changes{Title: tracker.Ptr("First, twice")}); err != nil || !held.wantsReread {
		t.Fatalf("got %v, wants a reread: %v", err, held.wantsReread)
	}
	if got := b.titles(b.open(nil)); got != "First, twice, Second" {
		t.Fatalf("got %q", got)
	}
	// A change that fails is reported, and the copy is reread all the same.
	before := b.inner.lists
	if err := b.open(nil).Edit("s-nope", tracker.Changes{Title: tracker.Ptr("x")}); err == nil {
		t.Fatal("a change to an issue that is not there worked")
	}
	if b.titles(b.open(nil)); b.inner.lists != before+1 {
		t.Fatalf("asked %d times more", b.inner.lists-before)
	}
	id, err := b.open(nil).Create(tracker.Draft{Title: "Made"})
	if err != nil || !strings.Contains(b.titles(b.open(nil)), "Made") || id == "" {
		t.Fatalf("got %q, %v", id, err)
	}
}

func TestACopysAgeDecidesWhenItIsRereadWithoutASign(t *testing.T) {
	b := newBench(t)
	b.titles(b.open(nil))
	// Something the sign does not show: an issue removed.
	b.inner.issues = b.inner.issues[:1]
	// A few minutes old: answers at once, and asks for a reread behind.
	b.clock = b.clock.Add(5 * time.Minute)
	stale := b.open(nil)
	if got := b.titles(stale); got != "First, Second" || !stale.wantsReread || b.inner.lists != 1 {
		t.Fatalf("got %q, wants a reread: %v, asked %d times", got, stale.wantsReread, b.inner.lists)
	}
	// What the reread behind the command does.
	if err := stale.Reread(); err != nil {
		t.Fatal(err)
	}
	if got := b.titles(b.open(nil)); got != "First" {
		t.Fatalf("got %q", got)
	}
	// More than a day old: reread before the read answers.
	b.inner.issues = nil
	b.clock = b.clock.Add(25 * time.Hour)
	if got := b.titles(b.open(nil)); got != "" {
		t.Fatalf("a copy more than a day old answered without being reread: %q", got)
	}
	// ...and if it cannot be, it still answers, and says it is old.
	b.clock = b.clock.Add(25 * time.Hour)
	b.inner.down = true
	warned := ""
	if _, err := b.open(&warned).List(tracker.ListFilter{}); err != nil || !strings.Contains(warned, "more than a day old") {
		t.Fatalf("got %v, warned %q", err, warned)
	}
	// With no copy at all there is nothing to answer from.
	if _, err := Open(b.inner, t.TempDir(), Options{}).List(tracker.ListFilter{}); err == nil {
		t.Fatal("a read with no copy and no tracker gave an answer")
	}
	// A clock set back: how old the copy is cannot be told.
	b.inner.down = false
	b.clock = b.clock.Add(-72 * time.Hour)
	back := b.open(nil)
	if b.titles(back); !back.wantsReread {
		t.Fatal("a copy reread in the future was taken for fresh")
	}
}

func TestReadyAndCommentsAreKeptAndAskedForAgainWhenTheyMayHaveChanged(t *testing.T) {
	b := newBench(t)
	held := b.open(nil)
	for range 2 {
		ready, err := held.Ready()
		if err != nil || len(ready) != 1 || ready[0].ID != "s-a" {
			t.Fatalf("got %v, %v", ready, err)
		}
	}
	if b.open(nil).Ready(); b.inner.readies != 1 {
		t.Fatalf("the tracker was asked what is ready %d times", b.inner.readies)
	}
	// After a reread it is asked again: what is ready may have changed.
	b.inner.add("s-c", "Third", "open")
	if ready, _ := b.open(nil).Ready(); len(ready) != 2 || b.inner.readies != 2 {
		t.Fatalf("got %v after %d asks", ready, b.inner.readies)
	}

	for range 2 {
		comments, err := b.open(nil).Comments("s-a")
		if err != nil || len(comments) != 0 {
			t.Fatalf("got %v, %v", comments, err)
		}
	}
	if b.inner.commentReads != 1 {
		t.Fatalf("the comments were read %d times", b.inner.commentReads)
	}
	if err := b.open(nil).Comment("s-a", "A thought."); err != nil {
		t.Fatal(err)
	}
	comments, err := b.open(nil).Comments("s-a")
	if err != nil || len(comments) != 1 || comments[0].Text != "A thought." || b.inner.commentReads != 2 {
		t.Fatalf("got %v, %v after %d reads", comments, err, b.inner.commentReads)
	}
	if _, err := b.open(nil).Comments("s-nope"); err == nil {
		t.Fatal("the comments of an issue that is not there were given")
	}
}

func TestARereadOvertakenByAChangeDoesNotCallItselfFresh(t *testing.T) {
	b := newBench(t)
	b.titles(b.open(nil))
	// A reread begins (as one started behind an earlier command would)...
	slow := b.open(nil)
	overtaken := false
	b.inner.duringList = func() {
		// ...and while its list is being read, a change is made through the
		// copy by another process. This tracker's sign does not move for it.
		if overtaken {
			return
		}
		overtaken = true
		if err := b.open(nil).Edit("s-a", tracker.Changes{Title: tracker.Ptr("Changed meanwhile")}); err != nil {
			t.Fatal(err)
		}
	}
	if err := slow.Reread(); err != nil {
		t.Fatal(err)
	}
	b.inner.duringList = nil
	// The next read must not be answered from what that reread wrote.
	before := b.inner.lists
	if got := b.titles(b.open(nil)); got != "Changed meanwhile, Second" || b.inner.lists != before+1 {
		t.Fatalf("got %q after %d more reads of the tracker", got, b.inner.lists-before)
	}
}

func TestSearchIsTheTrackersOwn(t *testing.T) {
	b := newBench(t)
	held := b.open(nil)
	b.titles(held)
	if _, err := held.Search("anything"); err != nil || b.inner.searches != 1 {
		t.Fatalf("the tracker was asked to search %d times, %v", b.inner.searches, err)
	}
}

func TestACopyThatCannotBeReadIsMadeAnew(t *testing.T) {
	b := newBench(t)
	b.titles(b.open(nil))
	for _, name := range []string{issuesFile, stateFile} {
		os.WriteFile(filepath.Join(b.dir, name), []byte("{half"), 0o644)
		if got := b.titles(b.open(nil)); got != "First, Second" {
			t.Fatalf("with %s unreadable: got %q", name, got)
		}
	}
	os.RemoveAll(b.dir)
	if got := b.titles(b.open(nil)); got != "First, Second" {
		t.Fatalf("with the copy deleted: got %q", got)
	}
	status := b.open(nil).Status()
	if status.Folder != b.dir || status.LastSync == nil || status.Waiting != 0 {
		t.Fatalf("got %+v", status)
	}
}
