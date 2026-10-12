// queued_test.go — the queued way of writing, with the GitHub adapter
// under the copy and a stand-in for GitHub under that.
//
// What: runs the copy over the real GitHub adapter, whose "GitHub" is the
// in-memory stand-in, wrapped so that it can be cut off, made to refuse,
// and counted; and checks the owner's rules for a tracker reached over the
// network: reads ask nothing, changes show at once and are sent by a sync
// in order, the two kinds of failure, changes from two sides adding up,
// and the two things that ask the tracker first.
//
// Why: these rules are what make a hosted tracker usable at all, and what
// keep a change from being lost or silently replaced. They were first
// tested with the copy inside the GitHub adapter (bead-bb-c9l.5); these are
// those tests on the new seat (bead-bb-c9l.15), so that nothing was lost in
// the move.
//
// Gotchas:
//   - Nothing here starts a background sync: the tests sync when they mean
//     to. Time is a clock the tests move.
//   - This test knows the GitHub adapter; the copy itself imports none.

package kept

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// line is a "GitHub" that can be cut off or made to refuse.
type line struct {
	*github.Fake
	// down makes every request fail as "not now".
	down bool
	// refuse makes changes to the issue with this number fail as "never".
	refuse int
	// readsFail makes reading one issue fail as a limit would: "not now".
	readsFail bool
	// listsFail makes asking for what changed fail as "not now".
	listsFail bool
	// updatesFail makes changes to the issue with this number fail as "not
	// now", and commentsFail every new comment: a request lost half-way
	// through an operation that takes several.
	updatesFail  int
	commentsFail bool
}

// cutOff is the failure of a request that could not be sent.
func cutOff() error {
	failure := tracker.Refused("GitHub could not be reached. Check the network connection and try again.")
	failure.Later = true
	return failure
}

func (l *line) Issue(number int) (*github.Issue, error) {
	if l.down {
		return nil, cutOff()
	}
	if l.readsFail {
		limited := tracker.Refused("GitHub's hourly limit on requests is used up. Try again within the hour.")
		limited.Later = true
		return nil, limited
	}
	return l.Fake.Issue(number)
}

func (l *line) Issues(options github.ListOptions) ([]github.Issue, error) {
	if l.down || l.listsFail {
		return nil, cutOff()
	}
	return l.Fake.Issues(options)
}

func (l *line) Comments(number int) ([]github.Comment, error) {
	if l.down {
		return nil, cutOff()
	}
	return l.Fake.Comments(number)
}

func (l *line) Create(draft github.NewIssue) (github.Created, error) {
	if l.down {
		return github.Created{}, cutOff()
	}
	return l.Fake.Create(draft)
}

func (l *line) Update(number int, changes github.Changes) error {
	switch {
	case l.down || l.updatesFail == number:
		return cutOff()
	case l.refuse == number:
		return tracker.Refused("GitHub refused: the issue is locked.")
	}
	return l.Fake.Update(number, changes)
}

func (l *line) AddComment(number int, body string) error {
	switch {
	case l.down || l.commentsFail:
		return cutOff()
	case l.refuse == number:
		return tracker.Refused("GitHub refused: the issue is locked.")
	}
	return l.Fake.AddComment(number, body)
}

// desk is one machine's copy of the repository, with the adapter over it.
type desk struct {
	t       *testing.T
	copy    *Tracker
	tracker tracker.Tracker
	dir     string
}

// world is a "GitHub" and a clock, shared by the desks of a test.
type world struct {
	t      *testing.T
	github *line
	clock  time.Time
}

// newWorld makes a "GitHub" with nothing on it.
func newWorld(t *testing.T) *world {
	made := &world{t: t, github: &line{Fake: github.NewFake(github.FakeOptions{})}, clock: time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)}
	made.pass(0)
	return made
}

// pass moves the clock, the stand-in's too.
func (w *world) pass(by time.Duration) {
	w.clock = w.clock.Add(by)
	w.github.SetClock(seconds(w.clock))
}

// desk opens a copy in dir, as a new bend process would: nothing is kept
// in memory from before.
func (w *world) desk(dir string) *desk {
	held := Open(github.New(w.github, ""), dir, Options{Now: func() time.Time { return w.clock }})
	return &desk{t: w.t, copy: held, tracker: held, dir: dir}
}

// sync syncs, failing the test when GitHub could not be asked.
func (d *desk) sync() SyncResult {
	d.t.Helper()
	result, err := d.copy.Sync(false)
	if err != nil {
		d.t.Fatalf("sync: %v", err)
	}
	return result
}

// must fails the test when an operation that should work did not.
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected failure: %v", err)
	}
}

// show gives one issue, failing the test when it cannot be read.
func (d *desk) show(id string) tracker.Issue {
	d.t.Helper()
	issue, err := d.tracker.Show(id)
	must(d.t, err)
	return issue
}

func TestReadsAskNothingAndChangesShowAtOnce(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	first := w.desk(dir)
	id, err := first.tracker.Create(tracker.Draft{Title: "Checkout", Description: tracker.Ptr("Wanted.")})
	must(t, err)
	// Making an issue waited for GitHub: the number is GitHub's own.
	if id != "1" || w.github.BodyOf(1) == "" {
		t.Fatalf("got the id %q", id)
	}

	// A new process, the copy a minute old: nothing is asked.
	w.pass(time.Minute)
	second := w.desk(dir)
	before := w.github.Requests()
	listed, err := second.tracker.List(tracker.ListFilter{})
	must(t, err)
	found, err := second.tracker.Search("checkout")
	must(t, err)
	if len(listed) != 1 || len(found) != 1 || second.show("1").Description != "Wanted." {
		t.Fatalf("got %v and %v", listed, found)
	}
	if asked := w.github.Requests() - before; asked != 0 {
		t.Fatalf("reads sent %d requests", asked)
	}

	// A change shows at once here, and is not on GitHub until a sync.
	must(t, second.tracker.Edit("1", tracker.Changes{Title: tracker.Ptr("Checkout flow")}))
	must(t, second.tracker.Write("1", "plan", "Step one."))
	must(t, second.tracker.Comment("1", "A thought."))
	if asked := w.github.Requests() - before; asked != 0 {
		t.Fatalf("changes sent %d requests", asked)
	}
	shown := second.show("1")
	if shown.Title != "Checkout flow" || shown.Plan != "Step one." || shown.CommentCount != 1 {
		t.Fatalf("got %+v", shown)
	}
	if second.copy.Unsent("1") != 3 || second.copy.Status().Waiting != 3 {
		t.Fatalf("got %d unsent", second.copy.Unsent("1"))
	}
	comments, err := second.tracker.Comments("1")
	must(t, err)
	if len(comments) != 1 || comments[0].Text != "A thought." {
		t.Fatalf("got the comments %v", comments)
	}

	// The queue is on disk: another process sends it, in order.
	third := w.desk(dir)
	result := third.sync()
	if result.Sent != 3 || result.Waiting != 0 || result.Refused != 0 {
		t.Fatalf("got %+v", result)
	}
	if !strings.Contains(w.github.BodyOf(1), "Step one.") || third.copy.Status().Waiting != 0 {
		t.Fatalf("GitHub holds %q", w.github.BodyOf(1))
	}
	after := third.show("1")
	if after.Title != "Checkout flow" || after.Plan != "Step one." || after.CommentCount != 1 || third.copy.Unsent("1") != 0 {
		t.Fatalf("got %+v", after)
	}
}

func TestWithNoNetworkChangesWaitAndAreSentLaterInOrder(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	_, err := one.tracker.Create(tracker.Draft{Title: "First"})
	must(t, err)

	w.github.down = true
	must(t, one.tracker.Edit("1", tracker.Changes{Title: tracker.Ptr("Second")}))
	must(t, one.tracker.Edit("1", tracker.Changes{Title: tracker.Ptr("Third")}))
	if one.show("1").Title != "Third" {
		t.Fatal("the change does not show with no network")
	}
	// Making an issue needs GitHub, and says so.
	if _, err := one.tracker.Create(tracker.Draft{Title: "No"}); err == nil || !strings.Contains(err.Error(), "could not be reached") {
		t.Fatalf("got %v", err)
	}
	// A sync cannot send or bring in: the changes keep waiting.
	result, err := one.copy.Sync(false)
	if err == nil || result.Waiting != 2 || result.Sent != 0 || result.Refused != 0 {
		t.Fatalf("got %+v, %v", result, err)
	}

	w.github.down = false
	sent := w.desk(dir).sync()
	if sent.Sent != 2 || sent.Waiting != 0 {
		t.Fatalf("got %+v", sent)
	}
	live, _ := w.github.Fake.Issue(1)
	if live.Title != "Third" {
		t.Fatalf("GitHub holds the title %q: the order was not kept", live.Title)
	}
}

func TestAChangeGitHubRefusesIsPutAsideAndTheCopyShowsGitHubsVersion(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Locked"})
	one.tracker.Create(tracker.Draft{Title: "Free"})

	w.github.refuse = 1
	must(t, one.tracker.Comment("1", "Words that must not be lost."))
	must(t, one.tracker.Edit("2", tracker.Changes{Title: tracker.Ptr("Still free")}))
	result := one.sync()
	// The refused one does not hold up the one after it.
	if result.Refused != 1 || result.Sent != 1 || result.Waiting != 0 {
		t.Fatalf("got %+v", result)
	}
	two := w.desk(dir)
	if two.show("1").CommentCount != 0 || two.show("2").Title != "Still free" {
		t.Fatal("the copy does not show GitHub's version")
	}
	refused := two.copy.RefusedChanges()
	if len(refused) != 1 || refused[0].Issue != "1" || refused[0].What != "a comment" ||
		!strings.Contains(refused[0].Text, "must not be lost") || !strings.Contains(refused[0].Reason, "locked") {
		t.Fatalf("got %+v", refused)
	}
	if two.copy.Status().Refused != 1 {
		t.Fatal("the status does not count it")
	}

	// Sent again once GitHub would take it.
	w.github.refuse = 0
	if taken, err := two.copy.Dismiss(refused[0].Seq, true); taken != 1 || err != nil {
		t.Fatalf("got %d, %v", taken, err)
	}
	if again := w.desk(dir).sync(); again.Sent != 1 {
		t.Fatalf("got %+v", again)
	}
	if comments, _ := w.github.Fake.Comments(1); len(comments) != 1 {
		t.Fatalf("GitHub holds %d comments", len(comments))
	}
	if _, err := two.copy.Dismiss(99, false); err == nil {
		t.Fatal("a number that names none was accepted")
	}
}

func TestTwoSidesChangesToDifferentPartsAndLabelsAddUp(t *testing.T) {
	w := newWorld(t)
	here, there := w.desk(t.TempDir()), w.desk(t.TempDir())
	_, err := here.tracker.Create(tracker.Draft{Title: "Shared", Description: tracker.Ptr("Wanted.")})
	must(t, err)
	there.sync()

	// Each from its own copy, neither having seen the other's.
	must(t, here.tracker.Write("1", "plan", "The plan, written here."))
	must(t, here.tracker.Edit("1", tracker.Changes{AddLabels: []string{"from-here"}}))
	must(t, there.tracker.Write("1", "notes", "The notes, written there."))
	must(t, there.tracker.Edit("1", tracker.Changes{AddLabels: []string{"from-there"}}))
	here.sync()
	there.sync()
	here.sync()

	for _, d := range []*desk{here, there} {
		shown := d.show("1")
		if shown.Plan != "The plan, written here." || shown.Notes != "The notes, written there." || shown.Description != "Wanted." {
			t.Fatalf("got %+v", shown)
		}
		if strings.Join(shown.Labels, " ") != "from-here from-there" {
			t.Fatalf("got the labels %v", shown.Labels)
		}
	}
	// The very same part: the later one wins.
	must(t, here.tracker.Write("1", "plan", "Here's second plan."))
	must(t, there.tracker.Write("1", "plan", "There's second plan."))
	here.sync()
	there.sync()
	here.sync()
	if got := here.show("1").Plan; got != "There's second plan." {
		t.Fatalf("got %q", got)
	}
}

func TestAStepIsChangedOnlyIfGitHubStillHasTheOneTheCopyShows(t *testing.T) {
	w := newWorld(t)
	owner, agent := w.desk(t.TempDir()), w.desk(t.TempDir())
	_, err := owner.tracker.Create(tracker.Draft{Title: "Moved"})
	must(t, err)
	must(t, owner.tracker.Edit("1", tracker.Changes{AddLabels: []string{"step:review-plan"}}))
	// A step asks first and is on GitHub when the command returns.
	if labels := w.github.LabelsOf(1); len(labels) != 1 || labels[0] != "step:review-plan" || owner.copy.Status().Waiting != 0 {
		t.Fatalf("GitHub holds %v", labels)
	}
	agent.sync()

	// The owner approves; the agent, from its older copy, sends it back.
	move := func(d *desk, to string) error {
		return d.tracker.Edit("1", tracker.Changes{RemoveLabels: []string{"step:review-plan"}, AddLabels: []string{to}})
	}
	must(t, move(owner, "step:implement"))
	err = move(agent, "step:plan")
	if err == nil || !strings.Contains(err.Error(), "step:implement") || !strings.Contains(err.Error(), "Nothing was changed") {
		t.Fatalf("got %v", err)
	}
	if labels := w.github.LabelsOf(1); len(labels) != 1 || labels[0] != "step:implement" {
		t.Fatalf("GitHub holds %v", labels)
	}
	// The agent's copy took GitHub's version: its next look is right.
	if labels := agent.show("1").Labels; len(labels) != 1 || labels[0] != "step:implement" {
		t.Fatalf("the agent sees %v", labels)
	}
	// With no network a step cannot be changed.
	w.github.down = true
	if err := move(owner, "step:plan"); err == nil {
		t.Fatal("a step was changed with no network")
	}
}

func TestWhatOthersChangedComesInAndAStaleCopyAsksForASync(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Seen"})
	one.tracker.Create(tracker.Draft{Title: "To be deleted"})

	// Changed on GitHub behind bend's back.
	w.pass(time.Minute)
	title := "Changed on github.com"
	w.github.Fake.Update(1, github.Changes{Title: &title})
	w.github.Fake.AddComment(1, "From the website.")
	fresh := w.desk(dir)
	if fresh.show("1").Title != "Seen" || fresh.copy.wantsReread {
		t.Fatal("a fresh copy was not answered from as it is")
	}
	w.pass(5 * time.Minute)
	stale := w.desk(dir)
	before := w.github.Requests()
	if stale.show("1").Title != "Seen" || !stale.copy.wantsReread || w.github.Requests() != before {
		t.Fatal("a copy a few minutes old must answer at once and ask for a sync")
	}
	stale.sync()
	next := w.desk(dir)
	if next.show("1").Title != "Changed on github.com" {
		t.Fatal("the change made elsewhere did not come in")
	}
	comments, err := next.tracker.Comments("1")
	must(t, err)
	if len(comments) != 1 || comments[0].Text != "From the website." {
		t.Fatalf("got %v", comments)
	}

	// More than a day old: reread before the read answers.
	w.pass(25 * time.Hour)
	title = "Changed again"
	w.github.Fake.Update(1, github.Changes{Title: &title})
	if old := w.desk(dir); old.show("1").Title != "Changed again" {
		t.Fatal("a copy more than a day old answered without being reread")
	}
	// ...and if it cannot be, it still answers, and says it is old.
	w.pass(25 * time.Hour)
	w.github.down = true
	warned := ""
	cut := Open(github.New(w.github, ""), dir, Options{Now: func() time.Time { return w.clock }, Warn: func(text string) { warned = text }})
	if _, err := cut.Show("1"); err != nil || !strings.Contains(warned, "could not be refreshed") {
		t.Fatalf("got %v, warned %q", err, warned)
	}
	// With no copy at all there is nothing to answer from.
	if _, err := w.desk(t.TempDir()).tracker.List(tracker.ListFilter{}); err == nil {
		t.Fatal("a read with no copy and no network gave an answer")
	}
}

func TestAFullRereadDropsWhatIsGone(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Stays"})
	one.sync()
	// An issue in the copy that GitHub no longer has.
	gone := tracker.Issue{ID: "7", Title: "Deleted on GitHub", Status: "open"}.Tidy()
	must(t, one.copy.keep(gone))
	if listed, _ := w.desk(dir).tracker.List(tracker.ListFilter{}); len(listed) != 2 {
		t.Fatalf("got %d issues", len(listed))
	}
	// An ordinary sync asks only for what changed, and so keeps it.
	w.desk(dir).sync()
	if listed, _ := w.desk(dir).tracker.List(tracker.ListFilter{}); len(listed) != 2 {
		t.Fatal("an ordinary sync dropped an issue")
	}
	if result, err := w.desk(dir).copy.Sync(true); err != nil || !result.Full {
		t.Fatalf("got %+v, %v", result, err)
	}
	if listed, _ := w.desk(dir).tracker.List(tracker.ListFilter{}); len(listed) != 1 || listed[0].Title != "Stays" {
		t.Fatalf("got %v", listed)
	}
	// By itself once a day.
	must(t, w.desk(dir).copy.keep(gone))
	w.pass(25 * time.Hour)
	if result := w.desk(dir).sync(); !result.Full {
		t.Fatalf("got %+v", result)
	}
}

func TestRelationsAreWorkedOutFromTheCopyAndTwoSyncsDoNotRunAtOnce(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	parent, _ := one.tracker.Create(tracker.Draft{Title: "Parent"})
	child, _ := one.tracker.Create(tracker.Draft{Title: "Child"})
	blocker, _ := one.tracker.Create(tracker.Draft{Title: "Blocker"})
	must(t, one.tracker.Move(child, &parent))
	must(t, one.tracker.Link(parent, blocker, "blocked-by"))
	// At once, from both ends, and down to the sub-issue.
	shown := one.show(child)
	if shown.ParentID == nil || *shown.ParentID != parent || len(shown.BlockedBy) != 1 || shown.BlockedBy[0].ID != blocker {
		t.Fatalf("got %+v", shown)
	}
	if subs := one.show(parent).SubIssues; len(subs) != 1 || subs[0].ID != child {
		t.Fatalf("got %v", subs)
	}
	// A loop is refused here, as GitHub would refuse it.
	if err := one.tracker.Move(parent, &child); err == nil {
		t.Fatal("a loop of sub-issues was accepted")
	}
	// While one sync runs, another finds it running and leaves.
	done, free, err := one.copy.store.Syncing()
	if err != nil || !free {
		t.Fatal(err)
	}
	if result, err := w.desk(dir).copy.Sync(false); err != nil || !result.Busy {
		t.Fatalf("got %+v, %v", result, err)
	}
	done()
	if result := w.desk(dir).sync(); result.Sent != 2 {
		t.Fatalf("got %+v", result)
	}
	// The same from GitHub's side now.
	if again := w.desk(dir).show(child); again.ParentID == nil || len(again.BlockedBy) != 1 {
		t.Fatalf("got %+v", again)
	}
}

func TestTheCopyNeverHoldsTheLogin(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Any"})
	one.tracker.Comment("1", "A comment.")
	one.sync()
	entries, _ := os.ReadDir(dir)
	if len(entries) < 4 {
		t.Fatalf("the copy has only %d files", len(entries))
	}
	filepath.WalkDir(dir, func(path string, entry os.DirEntry, _ error) error {
		if entry == nil || entry.IsDir() {
			return nil
		}
		content, _ := os.ReadFile(path)
		for _, secret := range []string{"Bearer", "ghp_", "gho_", "token"} {
			if strings.Contains(string(content), secret) {
				t.Fatalf("%s holds %q", path, secret)
			}
		}
		return nil
	})
}

func TestMakingAnIssueDoesNotHideWhatChangedBeforeIt(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Edited elsewhere"})
	one.sync()
	// A colleague edits it; later an issue is made here, and a step moved.
	w.pass(10 * time.Minute)
	title := "Edited on github.com"
	w.github.Fake.Update(1, github.Changes{Title: &title})
	w.pass(10 * time.Minute)
	two := w.desk(dir)
	_, err := two.tracker.Create(tracker.Draft{Title: "Made later"})
	must(t, err)
	must(t, two.tracker.Edit("2", tracker.Changes{AddLabels: []string{"step:plan"}}))
	two.sync()
	if got := w.desk(dir).show("1").Title; got != "Edited on github.com" {
		t.Fatalf("the earlier change was skipped: the title is %q", got)
	}
}

func TestAStepChangeWithATitleDoesNotJumpTheQueue(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "First"})
	must(t, one.tracker.Edit("1", tracker.Changes{Title: tracker.Ptr("A")}))
	must(t, one.tracker.Edit("1", tracker.Changes{Title: tracker.Ptr("B"), AddLabels: []string{"step:plan"}}))
	// The step is on GitHub already; the titles wait, in order.
	if labels := w.github.LabelsOf(1); len(labels) != 1 || one.copy.Status().Waiting != 2 {
		t.Fatalf("GitHub holds %v, %d waiting", labels, one.copy.Status().Waiting)
	}
	if shown := one.show("1"); shown.Title != "B" || len(shown.Labels) != 1 {
		t.Fatalf("got %+v", shown)
	}
	one.sync()
	live, _ := w.github.Fake.Issue(1)
	if live.Title != "B" || w.desk(dir).show("1").Title != "B" {
		t.Fatalf("GitHub holds the title %q", live.Title)
	}
}

func TestASentChangeStaysVisibleWhenNothingCanBeBroughtIn(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Old"})
	one.sync()
	must(t, one.tracker.Edit("1", tracker.Changes{Title: tracker.Ptr("New")}))
	must(t, one.tracker.Comment("1", "Sent."))
	// The changes go out, but asking what changed fails.
	w.github.listsFail = true
	result, err := one.copy.Sync(false)
	if err == nil || result.Sent != 2 {
		t.Fatalf("got %+v, %v", result, err)
	}
	two := w.desk(dir)
	if shown := two.show("1"); shown.Title != "New" || shown.CommentCount != 1 || two.copy.Unsent("1") != 0 {
		t.Fatalf("the sent changes do not show: %+v", shown)
	}
	// And what GitHub gives next replaces what was laid on.
	w.github.listsFail = false
	w.pass(time.Minute)
	title := "Newer, on GitHub"
	w.github.Fake.Update(1, github.Changes{Title: &title})
	two.sync()
	if got := w.desk(dir).show("1").Title; got != "Newer, on GitHub" {
		t.Fatalf("got %q", got)
	}
	comments, err := w.desk(dir).tracker.Comments("1")
	must(t, err)
	if len(comments) != 1 || comments[0].Text != "Sent." {
		t.Fatalf("got %v", comments)
	}
}

func TestALimitWhileSendingKeepsTheChangeWaiting(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Any"})
	one.sync()
	must(t, one.tracker.Write("1", "plan", "A plan that must not be put aside."))
	w.github.readsFail = true
	result, _ := one.copy.Sync(false)
	if result.Refused != 0 || result.Waiting != 1 || result.Problem == "" {
		t.Fatalf("got %+v", result)
	}
	w.github.readsFail = false
	if again := w.desk(dir).sync(); again.Sent != 1 {
		t.Fatalf("got %+v", again)
	}
}

func TestBringingInNeverPutsAnOlderVersionOverANewerOne(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Any"})
	one.sync()
	// What another process put in while a list was on its way: newer than
	// anything that list can hold.
	newer := tracker.Issue{ID: "1", Title: "Put in meanwhile", Status: "open",
		UpdatedAt: tracker.Ptr(seconds(w.clock.Add(time.Hour))), CreatedAt: tracker.Ptr(seconds(w.clock))}.Tidy()
	must(t, one.copy.keep(newer))
	made := tracker.Issue{ID: "9", Title: "Made meanwhile", Status: "open",
		UpdatedAt: tracker.Ptr(seconds(w.clock)), CreatedAt: tracker.Ptr(seconds(w.clock))}.Tidy()
	must(t, one.copy.keep(made))
	if _, err := w.desk(dir).copy.Sync(true); err != nil {
		t.Fatal(err)
	}
	after := w.desk(dir)
	if got := after.show("1").Title; got != "Put in meanwhile" {
		t.Fatalf("an older version replaced it: %q", got)
	}
	// A full reread does not drop an issue made since it began.
	if listed, _ := after.tracker.List(tracker.ListFilter{}); len(listed) != 2 {
		t.Fatalf("got %d issues", len(listed))
	}
}

func TestACopyThatCannotBeReadIsMadeAnewByAFullSync(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Survives on GitHub"})
	one.sync()
	os.WriteFile(filepath.Join(dir, issuesFile), []byte("{half"), 0o644)
	// The next read makes it anew, by itself.
	if listed, err := w.desk(dir).tracker.List(tracker.ListFilter{}); err != nil || len(listed) != 1 {
		t.Fatalf("got %v, %v", listed, err)
	}
}

func TestAClockSetBackIsNoticed(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	one := w.desk(dir)
	one.tracker.Create(tracker.Draft{Title: "Any"})
	one.sync()
	// The clock goes back a day: how old the copy is cannot be told.
	w.pass(-24 * time.Hour)
	back := w.desk(dir)
	back.show("1")
	if !back.copy.wantsReread {
		t.Fatal("a copy synced in the future was taken for fresh")
	}
}

func TestWhatTheCopySeesIsRefusedAtOnceAndTheRestWhenSent(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	first, _ := one.tracker.Create(tracker.Draft{Title: "First"})
	second, _ := one.tracker.Create(tracker.Draft{Title: "Second"})
	before := one.copy.Status().Waiting

	// What the copy can see itself: refused in the command's own answer,
	// with nothing recorded.
	for what, err := range map[string]error{
		"an issue that is not there":  one.tracker.Comment("99", "To nobody."),
		"a link to itself":            one.tracker.Link(first, first, "related"),
		"a kind of link GitHub lacks": one.tracker.Link(first, second, "supersedes"),
		"a part that is not one":      one.tracker.Write(first, "summary", "No."),
	} {
		if err == nil {
			t.Fatalf("%s was accepted", what)
		}
	}
	must(t, one.tracker.Move(second, &first))
	if err := one.tracker.Move(first, &second); err == nil {
		t.Fatal("a loop of sub-issues was accepted")
	}
	must(t, one.tracker.Close(second, ""))
	if err := one.tracker.Start(second); err == nil {
		t.Fatal("a closed issue was started")
	}
	if waiting := one.copy.Status().Waiting; waiting != before+2 {
		t.Fatalf("%d changes wait; only the move and the close should", waiting-before)
	}
	one.sync()

	// What only the adapter knows: accepted here, refused when it is sent,
	// and then on the list with the reason.
	must(t, one.tracker.Link(first, second, "related"))
	must(t, one.tracker.Link(first, second, "related"))
	result := one.sync()
	if result.Sent != 1 || result.Refused != 1 {
		t.Fatalf("got %+v", result)
	}
	refused := one.copy.RefusedChanges()
	if len(refused) != 1 || refused[0].Issue != first || !strings.Contains(refused[0].What, "linking it to issue "+second) || refused[0].Reason == "" {
		t.Fatalf("got %+v", refused)
	}
	// The link that was sent shows once, from both ends.
	if links := w.desk(one.dir).show(second).Links; len(links) != 1 || links[0].Kind != "related" {
		t.Fatalf("got the links %v", links)
	}
}

func TestAChangeIsSentAsWhoeverMadeIt(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	w.desk(dir).tracker.Create(tracker.Draft{Title: "Whose"})
	// Made as someone, by one process...
	named := Open(github.New(w.github, "agent-7"), dir, Options{Now: func() time.Time { return w.clock }, Actor: "agent-7"})
	must(t, named.Start("1"))
	must(t, named.Comment("1", "Mine."))
	// Whom it is assigned to is GitHub's to say (the signed-in account), so
	// nobody is shown until GitHub has it.
	if shown, _ := named.Show("1"); shown.Status != "in_progress" || shown.Assignee != nil {
		t.Fatalf("got %+v", shown)
	}
	// ...and sent by another, which names nobody.
	if result := w.desk(dir).sync(); result.Sent != 2 {
		t.Fatalf("got %+v", result)
	}
	comments, _ := w.github.Fake.Comments(1)
	if len(comments) != 1 || !strings.Contains(comments[0].Body, "agent-7") {
		t.Fatalf("the comment was not sent as agent-7: %+v", comments)
	}
	viewer, _ := w.github.Fake.Viewer()
	if shown := w.desk(dir).show("1"); shown.Assignee == nil || *shown.Assignee != viewer {
		t.Fatalf("got %+v, want it assigned to %s", shown, viewer)
	}
}

// A change that takes GitHub several requests, sent again after it stopped
// half-way, must not repeat the half that was done nor be refused for it.
func TestAChangeSentAgainDoesNotRepeatWhatWasDone(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	for _, title := range []string{"Closed late", "Closed, comment late", "Linked", "To"} {
		_, err := one.tracker.Create(tracker.Draft{Title: title})
		must(t, err)
	}
	closingComments := func(number int) int {
		comments, _ := w.github.Fake.Comments(number)
		return len(comments)
	}
	// The closing does not get through, twice; then it does.
	must(t, one.tracker.Close("1", "Done with it."))
	w.github.updatesFail = 1
	one.sync()
	one.sync()
	w.github.updatesFail = 0
	if result := one.sync(); result.Sent != 1 || closingComments(1) != 1 || one.show("1").Status != "closed" {
		t.Fatalf("got %+v, %d comments", result, closingComments(1))
	}
	// The closing gets through and its comment does not.
	must(t, one.tracker.Close("2", "Done too."))
	w.github.commentsFail = true
	if result := one.sync(); result.Sent != 0 || result.Waiting != 1 {
		t.Fatalf("got %+v", result)
	}
	w.github.commentsFail = false
	if result := one.sync(); result.Sent != 1 || closingComments(2) != 1 {
		t.Fatalf("got %+v, %d comments", result, closingComments(2))
	}
	// A link kept on both issues: the second line does not get through.
	must(t, one.tracker.Link("3", "4", "related"))
	w.github.updatesFail = 4
	one.sync()
	w.github.updatesFail = 0
	if result := one.sync(); result.Sent != 1 || result.Refused != 0 {
		t.Fatalf("got %+v", result)
	}
	if !strings.Contains(w.github.BodyOf(3), "4") || !strings.Contains(w.github.BodyOf(4), "3") {
		t.Fatalf("the link is on one issue only:\n%s\n---\n%s", w.github.BodyOf(3), w.github.BodyOf(4))
	}
	// And taking it off again, the same way.
	must(t, one.tracker.Unlink("3", "4", tracker.UnlinkOptions{}))
	w.github.updatesFail = 4
	one.sync()
	w.github.updatesFail = 0
	if result := one.sync(); result.Sent != 1 || result.Refused != 0 {
		t.Fatalf("got %+v", result)
	}
	if links := one.show("4").Links; len(links) != 0 {
		t.Fatalf("issue 4 still shows %v", links)
	}
}

func TestAnIdWrittenWithItsSignIsTheSameIssue(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	for _, title := range []string{"Parent", "Child"} {
		_, err := one.tracker.Create(tracker.Draft{Title: title})
		must(t, err)
	}
	asked := w.github.Requests()
	must(t, one.tracker.Comment("#1", "Said."))
	must(t, one.tracker.Move("2", tracker.Ptr("#1")))
	if w.github.Requests() != asked {
		t.Fatal("GitHub was asked for an issue the copy holds")
	}
	one = w.desk(one.dir)
	parent := one.show("#1")
	if parent.CommentCount != 1 || len(parent.SubIssues) != 1 || one.copy.Unsent("#1") != 1 {
		t.Fatalf("got %+v, %d unsent", parent, one.copy.Unsent("#1"))
	}
	// The loop is seen at once, however the ids are written.
	if err := one.tracker.Move("#1", tracker.Ptr("#2")); err == nil {
		t.Fatal("an issue was moved inside its own sub-issue")
	}
}

func TestReopeningAnIssueInProgressLeavesItInProgress(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	_, err := one.tracker.Create(tracker.Draft{Title: "Being worked on"})
	must(t, err)
	must(t, one.tracker.Start("1"))
	one.sync()
	must(t, one.tracker.Reopen("1"))
	if status := w.desk(one.dir).show("1").Status; status != "in_progress" {
		t.Fatalf("while it waits it shows %s", status)
	}
	one.sync()
	if status := w.desk(one.dir).show("1").Status; status != "in_progress" {
		t.Fatalf("once sent it shows %s", status)
	}
}

func TestAStepChangeDoesNotTakeOtherLabelsAheadOfTheQueue(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	_, err := one.tracker.Create(tracker.Draft{Title: "Labelled"})
	must(t, err)
	must(t, one.tracker.Edit("1", tracker.Changes{AddLabels: []string{"foo"}}))
	one.sync()
	must(t, one.tracker.Edit("1", tracker.Changes{RemoveLabels: []string{"foo"}}))
	// The last word on "foo" is that it is there.
	must(t, one.tracker.Edit("1", tracker.Changes{AddLabels: []string{"foo", "step:plan"}}))
	one.sync()
	labels := w.github.LabelsOf(1)
	sort.Strings(labels)
	if strings.Join(labels, " ") != "foo step:plan" {
		t.Fatalf("GitHub holds %v", labels)
	}
}

func TestADamagedFileOfIssuesDoesNotSendAChangeTwice(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	_, err := one.tracker.Create(tracker.Draft{Title: "Commented"})
	must(t, err)
	must(t, one.tracker.Comment("1", "Once."))
	os.WriteFile(filepath.Join(one.dir, issuesFile), []byte("{ not what it was"), 0o644)
	for range 3 {
		w.desk(one.dir).copy.Sync(false)
	}
	comments, _ := w.github.Fake.Comments(1)
	if len(comments) != 1 {
		t.Fatalf("the comment is on GitHub %d times", len(comments))
	}
	// And the copy is whole again.
	if shown := w.desk(one.dir).show("1"); shown.Title != "Commented" || shown.CommentCount != 1 {
		t.Fatalf("got %+v", shown)
	}
}

func TestUnlinkingOnlyTheFirstIssuesLinkLeavesTheOtherIssuesOwn(t *testing.T) {
	w := newWorld(t)
	one := w.desk(t.TempDir())
	for _, title := range []string{"Source", "Found while there"} {
		_, err := one.tracker.Create(tracker.Draft{Title: title})
		must(t, err)
	}
	must(t, one.tracker.Link("2", "1", "discovered-from"))
	one.sync()
	// Issue 1 has no link of its own to issue 2: nothing is hidden meanwhile.
	must(t, one.tracker.Unlink("1", "2", tracker.UnlinkOptions{OnlyFrom: true}))
	if links := w.desk(one.dir).show("2").Links; len(links) != 1 {
		t.Fatalf("while it waits issue 2 shows %v", links)
	}
}

func TestACopyMadeByAnotherVersionIsPutAsideAndSaidSo(t *testing.T) {
	w := newWorld(t)
	w.desk(t.TempDir()).tracker.Create(tracker.Draft{Title: "On GitHub"})
	// As the copy inside the GitHub adapter left it: other files, another
	// shape, and a change still waiting.
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, stateFile), []byte(`{"Login": "octo", "LastSync": "2026-03-01T08:00:00Z", "Cursor": "2026-03-01T08:00:00Z"}`), 0o644)
	os.WriteFile(filepath.Join(dir, issuesFile), []byte(`[{"Number": 1, "ID": 1001, "Title": "Old shape", "State": "open"}]`), 0o644)
	os.WriteFile(filepath.Join(dir, "queue.json"), []byte(`{"Next": 2, "Changes": [{"Seq": 1, "Kind": "comment", "Number": 1, "Text": "Never sent."}]}`), 0o644)
	warned := ""
	held := Open(github.New(w.github, ""), dir, Options{Now: func() time.Time { return w.clock }, Warn: func(text string) { warned = text }})
	listed, err := held.List(tracker.ListFilter{})
	if err != nil || len(listed) != 1 || listed[0].Title != "On GitHub" {
		t.Fatalf("got %v, %v", listed, err)
	}
	if !strings.Contains(warned, "another version") || !strings.Contains(warned, "1 changes were waiting") || !strings.Contains(warned, "NOT sent") {
		t.Fatalf("warned %q", warned)
	}
	// Kept for a person to look at, not sent, not laid on the new copy.
	if kept, _ := os.ReadFile(filepath.Join(dir, "queue.json.unreadable")); !strings.Contains(string(kept), "Never sent.") {
		t.Fatal("the old waiting change was not kept")
	}
	if comments, _ := w.github.Fake.Comments(1); len(comments) != 0 || held.Status().Waiting != 0 {
		t.Fatal("an old-style change was sent or still waits")
	}
}
