// copy_test.go — the copy on this machine, against a stand-in for GitHub.
//
// What: runs the adapter over a Copy whose "GitHub" is the in-memory
// stand-in, wrapped so that it can be cut off, made to refuse, and
// counted, and checks the owner's rules for the copy: reads ask nothing,
// changes show at once and are sent by a sync in order, the two kinds of
// failure, changes from two sides adding up, and the two things that ask
// GitHub first.
//
// Why: these rules are what make a hosted tracker usable at all, and what
// keep a change from being lost or silently replaced (bead-bb-c9l.5).
//
// Gotchas:
//   - Nothing here starts a background sync: the tests sync when they mean
//     to. Time is a clock the tests move.

package github

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// line is a "GitHub" that can be cut off or made to refuse.
type line struct {
	*Fake
	// down makes every request fail as "not now".
	down bool
	// refuse makes changes to the issue with this number fail as "never".
	refuse int
	// readsFail makes reading one issue fail, in words that do not say
	// whether trying again helps (a limit reported in an unusual way, say).
	readsFail bool
	// listsFail makes asking for what changed fail as "not now".
	listsFail bool
}

// offline is the failure of a request that could not be sent.
func offline() error {
	failure := tracker.Refused("GitHub could not be reached. Check the network connection and try again.")
	failure.Later = true
	return failure
}

func (l *line) Issue(number int) (*Issue, error) {
	if l.down {
		return nil, offline()
	}
	if l.readsFail {
		return nil, tracker.Refused("GitHub refused: something went wrong.")
	}
	return l.Fake.Issue(number)
}

func (l *line) Issues(options ListOptions) ([]Issue, error) {
	if l.down || l.listsFail {
		return nil, offline()
	}
	return l.Fake.Issues(options)
}

func (l *line) Comments(number int) ([]Comment, error) {
	if l.down {
		return nil, offline()
	}
	return l.Fake.Comments(number)
}

func (l *line) Create(draft NewIssue) (Created, error) {
	if l.down {
		return Created{}, offline()
	}
	return l.Fake.Create(draft)
}

func (l *line) Update(number int, changes Changes) error {
	switch {
	case l.down:
		return offline()
	case l.refuse == number:
		return tracker.Refused("GitHub refused: the issue is locked.")
	}
	return l.Fake.Update(number, changes)
}

func (l *line) AddComment(number int, body string) error {
	switch {
	case l.down:
		return offline()
	case l.refuse == number:
		return tracker.Refused("GitHub refused: the issue is locked.")
	}
	return l.Fake.AddComment(number, body)
}

// desk is one machine's copy of the repository, with the adapter over it.
type desk struct {
	t       *testing.T
	copy    *Copy
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
	made := &world{t: t, github: &line{Fake: NewFake(FakeOptions{})}, clock: time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)}
	made.pass(0)
	return made
}

// pass moves the clock, the stand-in's too.
func (w *world) pass(by time.Duration) {
	w.clock = w.clock.Add(by)
	w.github.SetClock(stamp(w.clock))
}

// desk opens a copy in dir, as a new bend process would: nothing is kept
// in memory from before.
func (w *world) desk(dir string) *desk {
	held := OpenCopy(w.github, dir, CopyOptions{Now: func() time.Time { return w.clock }})
	return &desk{t: w.t, copy: held, tracker: New(held, ""), dir: dir}
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
	if second.copy.Unsent(1) != 3 || second.copy.Status().Waiting != 3 {
		t.Fatalf("got %d unsent", second.copy.Unsent(1))
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
	if after.Title != "Checkout flow" || after.Plan != "Step one." || after.CommentCount != 1 || third.copy.Unsent(1) != 0 {
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
	w.github.Fake.Update(1, Changes{Title: &title})
	w.github.Fake.AddComment(1, "From the website.")
	fresh := w.desk(dir)
	if fresh.show("1").Title != "Seen" || fresh.copy.wantsSync {
		t.Fatal("a fresh copy was not answered from as it is")
	}
	w.pass(5 * time.Minute)
	stale := w.desk(dir)
	before := w.github.Requests()
	if stale.show("1").Title != "Seen" || !stale.copy.wantsSync || w.github.Requests() != before {
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
	w.github.Fake.Update(1, Changes{Title: &title})
	if old := w.desk(dir); old.show("1").Title != "Changed again" {
		t.Fatal("a copy more than a day old answered without being reread")
	}
	// ...and if it cannot be, it still answers, and says it is old.
	w.pass(25 * time.Hour)
	w.github.down = true
	warned := ""
	cut := OpenCopy(w.github, dir, CopyOptions{Now: func() time.Time { return w.clock }, Warn: func(text string) { warned = text }})
	if _, err := New(cut, "").Show("1"); err != nil || !strings.Contains(warned, "could not be refreshed") {
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
	gone := Issue{Ref: Ref{Number: 7, Title: "Deleted on GitHub", State: "open"}, ID: 1007}
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
	w.github.Fake.Update(1, Changes{Title: &title})
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
	if shown := two.show("1"); shown.Title != "New" || shown.CommentCount != 1 || two.copy.Unsent(1) != 0 {
		t.Fatalf("the sent changes do not show: %+v", shown)
	}
	// And what GitHub gives next replaces what was laid on.
	w.github.listsFail = false
	w.pass(time.Minute)
	title := "Newer, on GitHub"
	w.github.Fake.Update(1, Changes{Title: &title})
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

func TestAFailedReadBeforeSendingIsNotARefusal(t *testing.T) {
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
	newer := Issue{Ref: Ref{Number: 1, Title: "Put in meanwhile", State: "open"}, ID: 1001,
		UpdatedAt: stamp(w.clock.Add(time.Hour)), CreatedAt: stamp(w.clock)}
	must(t, one.copy.keep(newer))
	made := Issue{Ref: Ref{Number: 9, Title: "Made meanwhile", State: "open"}, ID: 1009,
		UpdatedAt: stamp(w.clock), CreatedAt: stamp(w.clock)}
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
	if _, err := w.desk(dir).tracker.List(tracker.ListFilter{}); err == nil || !strings.Contains(err.Error(), "bend sync --all") {
		t.Fatalf("got %v", err)
	}
	warned := ""
	mended := OpenCopy(w.github, dir, CopyOptions{Now: func() time.Time { return w.clock }, Warn: func(text string) { warned = text }})
	if _, err := mended.Sync(true); err != nil || !strings.Contains(warned, issuesFile+".unreadable") {
		t.Fatalf("got %v, warned %q", err, warned)
	}
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
	if !back.copy.wantsSync {
		t.Fatal("a copy synced in the future was taken for fresh")
	}
}
