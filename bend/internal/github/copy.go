// copy.go — GitHub issues from a copy kept on this machine.
//
// What: a second Client. It answers every read from a copy of the
// repository's issues on disk, records changes in a queue and lets them be
// sent to GitHub afterwards, and brings in what changed on GitHub (Sync).
//
// Why: asked for every command, GitHub takes most of a second each time
// and counts the requests; a caller that reads the whole list often (the
// Airbender tab) cannot work that way at all. The owner: "bend command
// should write local copy and sync asynchronously" (bead-bb-c9l.5). It is a
// Client, under the adapter, so that every rule about how an issue is
// mapped (github.go) is used as it is and knows nothing of the copy.
//
// Design notes:
//   - The copy keeps each issue **as GitHub holds it** (issues.json). The
//     changes made here and not yet sent are a queue beside it (queue.json).
//     A read is the one with the other laid on top, put together in memory.
//     So bringing in what changed on GitHub can never overwrite a change
//     that still waits, and a change GitHub refuses simply stops being laid
//     on top: there is no undo to get wrong.
//   - Two things do not go through the queue, the owner's decisions: making
//     an issue waits for GitHub, because only GitHub gives the number; and a
//     change to a guarded label (the workflow's step and size) asks GitHub
//     first and is refused when the issue was moved meanwhile, because a
//     step decides who acts next.
//   - A change that cannot be sent is one of two kinds (tracker.Error.Later).
//     "Not now" stays in the queue and stops the sending, so that order is
//     kept. "Never" is moved to a list of refused changes with GitHub's
//     reason, and the sending goes on.
//   - Sending a change to the description rereads it from GitHub and
//     replaces only the written parts that were changed here; labels are
//     sent as "add these, take those off" against what GitHub holds. So two
//     sides' changes to different parts, and their labels, add up.
//   - Only an issue's parent and what it waits for are kept; its sub-issues
//     and what it blocks are worked out from the other issues when read.
//   - Comments are kept per issue from the first time they are asked for,
//     and asked for again when the issue has changed since.
//   - How fresh, the owner's rule: a read answers from the copy at once
//     while it is less than a day old; older, or none yet, it is reread
//     first. A read that finds it older than a few minutes, and every
//     change, asks for a sync in the background (see background.go), which
//     holds nothing up.
//
// Gotchas:
//   - The files are shared by every bend process of the repository's work
//     trees. A file is read whole and written whole under a short lock;
//     nothing slow is done while holding it.
//   - GitHub's "changed since" does not report an issue that was deleted or
//     moved to another repository, hence the full reread once a day.
//   - The copy holds issue texts. It never holds the login.

package github

import (
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/localcopy"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

const (
	// freshFor is how old the copy may be before a read asks for a refresh
	// in the background.
	freshFor = 3 * time.Minute
	// trustedFor is how old the copy may be and still answer a read without
	// being refreshed first.
	trustedFor = 24 * time.Hour
	// fullEvery is how often everything is reread, to drop what was deleted.
	fullEvery = 24 * time.Hour
	// overlap is how far before the latest change seen "changed since"
	// asks, so that a change made while a sync ran is not missed.
	overlap = 2 * time.Minute
)

// guardedPrefixes are the labels whose change asks GitHub first: the
// workflow's step and an issue's size. Two sides moving an issue from
// copies a few minutes old must not silently replace each other.
var guardedPrefixes = []string{"step:", "size:"}

// The files of the copy.
const (
	issuesFile  = "issues.json"
	queueFile   = "queue.json"
	refusedFile = "refused.json"
	stateFile   = "state.json"
	logFile     = "sync.log"
)

// row is one issue as GitHub holds it, in the copy.
type row struct {
	Number       int
	ID           int64
	Title        string
	Body         string
	State        string
	StateReason  *string
	CreatedAt    string
	UpdatedAt    string
	Assignee     *string
	Labels       []string
	CommentCount int
	// Parent is the number of the issue this one sits inside; 0 for none.
	Parent int
	// BlockedBy are the numbers of the issues this one waits for.
	BlockedBy []int
}

// rowOf turns an issue as GitHub gives it into a row.
func rowOf(issue Issue) *row {
	kept := &row{
		Number: issue.Number, ID: issue.ID, Title: issue.Title, Body: issue.Body,
		State: issue.State, StateReason: issue.StateReason,
		CreatedAt: issue.CreatedAt, UpdatedAt: issue.UpdatedAt,
		Assignee: issue.Assignee, Labels: slices.Clone(issue.Labels),
		CommentCount: issue.CommentCount, BlockedBy: []int{},
	}
	if issue.Parent != nil {
		kept.Parent = issue.Parent.Number
	}
	for _, blocker := range issue.BlockedBy {
		kept.BlockedBy = append(kept.BlockedBy, blocker.Number)
	}
	if kept.Labels == nil {
		kept.Labels = []string{}
	}
	return kept
}

// The kinds of change the queue holds.
const (
	opUpdate          = "update"
	opComment         = "comment"
	opSetParent       = "set-parent"
	opRemoveParent    = "remove-parent"
	opAddBlockedBy    = "add-blocked-by"
	opRemoveBlockedBy = "remove-blocked-by"
)

// change is one change made here and not yet on GitHub.
type change struct {
	// Seq numbers the changes of a copy in the order they were made.
	Seq int
	// At is when it was made.
	At   string
	Kind string
	// Number is the issue changed; for the parent changes, the parent.
	Number int
	// For an update: what to set. BodyBase is the description the change
	// was made from, so that sending can tell which written parts it
	// changed.
	Title        *string   `json:",omitempty"`
	Body         *string   `json:",omitempty"`
	BodyBase     *string   `json:",omitempty"`
	AddLabels    []string  `json:",omitempty"`
	RemoveLabels []string  `json:",omitempty"`
	Assignees    *[]string `json:",omitempty"`
	State        string    `json:",omitempty"`
	StateReason  string    `json:",omitempty"`
	// For a comment: its text.
	Text string `json:",omitempty"`
	// For the relation changes: the other issue's database id (the child,
	// or the blocker), as GitHub is to be told, and its number, for the
	// copy.
	OtherID     int64 `json:",omitempty"`
	OtherNumber int   `json:",omitempty"`
}

// queued is the queue's file.
type queued struct {
	// Next is the Seq the next change gets.
	Next    int
	Changes []change
}

// RefusedChange is a change GitHub refused for good.
type RefusedChange struct {
	// Seq is the change's number, by which it is dismissed or sent again.
	Seq int `json:"seq"`
	// At is when GitHub refused it.
	At string `json:"at"`
	// Issue is the issue it was a change to, as an id.
	Issue string `json:"issue"`
	// What says what the change was, in a few words; Text is the text it
	// carried, where it carried one, so that nothing written is lost.
	What string `json:"what"`
	Text string `json:"text"`
	// Reason is what GitHub said.
	Reason string `json:"reason"`
}

// refusedEntry is a refused change as kept in the file.
type refusedEntry struct {
	At     string
	Reason string
	Change change
}

// copyState is what the copy knows about itself.
type copyState struct {
	// Login is the signed-in account, kept so that comments can be signed
	// with no network.
	Login string
	// LastSync is when what changed on GitHub was last brought in; LastFull
	// when everything was last reread. "" for never.
	LastSync string
	LastFull string
	// Cursor is the latest "last changed" GitHub has given for any issue.
	// What changed since is asked from there, by GitHub's own clock: this
	// machine's clock may run ahead of it, and asking from a moment GitHub
	// has not reached yet would miss changes.
	Cursor string
}

// keptComments is an issue's comments as kept, with the issue's own "last
// changed" at the time: a later one means they may be out of date.
type keptComments struct {
	For      string
	Comments []Comment
}

// Copy is a Client that works from the copy on this machine. Make one with
// OpenCopy.
type Copy struct {
	remote Client
	store  localcopy.Store
	// now tells the time; replaced in tests.
	now func() time.Time
	// warn says something worth knowing that is not a failure.
	warn func(text string)

	loaded bool
	// rows is what GitHub holds, by number; changes what waits to be sent.
	rows    map[int]*row
	changes []change
	state   copyState
	// seen is the rows with the changes laid on top; nil until asked for,
	// and again after a change.
	seen map[int]*row
	// wantsSync says that a sync should follow this command.
	wantsSync bool
}

// CopyOptions adjust a copy; the zero value is the usual one.
type CopyOptions struct {
	// Now tells the time; time.Now when nil.
	Now func() time.Time
	// Warn is told what is worth knowing and is not a failure; nothing is
	// said when nil.
	Warn func(text string)
}

// OpenCopy gives the Client that works from the copy in dir, syncing with
// remote.
//
// Side effects: none until a method is called. The first read loads the
// copy, and rereads it from GitHub first where there is none or it is more
// than a day old.
func OpenCopy(remote Client, dir string, options CopyOptions) *Copy {
	made := &Copy{remote: remote, store: localcopy.Store{Dir: dir}, now: options.Now, warn: options.Warn}
	if made.now == nil {
		made.now = time.Now
	}
	if made.warn == nil {
		made.warn = func(string) {}
	}
	return made
}

// stamp gives a moment as the copy writes it.
func stamp(at time.Time) string { return at.UTC().Format(time.RFC3339) }

// readFiles reads the copy's files into memory, as they are now.
func (c *Copy) readFiles() error {
	var rows []*row
	if _, err := c.store.Read(issuesFile, &rows); err != nil {
		return unreadable(issuesFile)
	}
	c.rows = make(map[int]*row, len(rows))
	for _, one := range rows {
		c.rows[one.Number] = one
	}
	var queue queued
	if _, err := c.store.Read(queueFile, &queue); err != nil {
		return unreadable(queueFile)
	}
	c.changes = queue.Changes
	c.state = copyState{}
	if _, err := c.store.Read(stateFile, &c.state); err != nil {
		return unreadable(stateFile)
	}
	c.seen = nil
	return nil
}

// unreadable is the failure for a file of the copy that cannot be read.
func unreadable(name string) error {
	return tracker.Refused("The local copy of the GitHub issues cannot be read (%s). Run `bend sync --all` to make it anew.", name)
}

// load makes the copy ready for a read: reads its files and, where the
// owner's rule asks for it, refreshes it first.
//
// Side effects: may sync with GitHub, which a first read and a read of a
// copy more than a day old wait for.
func (c *Copy) load() error {
	if c.loaded {
		return nil
	}
	if err := c.readFiles(); err != nil {
		return err
	}
	age := trustedFor + 1
	if at, err := time.Parse(time.RFC3339, c.state.LastSync); err == nil {
		age = c.now().Sub(at)
		// Synced "in the future": this machine's clock was set back. How
		// old the copy is cannot be told, so it is refreshed, unwaited for.
		if age < 0 {
			age = freshFor + 1
		}
	}
	switch {
	case c.state.LastSync == "":
		// No copy yet: there is nothing to answer from.
		if _, err := c.syncNow(true); err != nil {
			return err
		}
	case age > trustedFor:
		// Too old to be trusted. If it cannot be refreshed it is still the
		// best there is, and said to be old.
		if _, err := c.syncNow(false); err != nil {
			c.warn(fmt.Sprintf("The local copy of the GitHub issues is %d hours old and could not be refreshed: %s", int(age.Hours()), err))
		}
	case age > freshFor:
		c.wantsSync = true
	}
	c.loaded = true
	return nil
}

// syncNow syncs while a command waits, and waits for another process's
// sync where one is running, since its result is what is needed.
func (c *Copy) syncNow(full bool) (SyncResult, error) {
	for attempt := 0; ; attempt++ {
		result, err := c.Sync(full)
		switch {
		case err != nil:
			return result, err
		case !result.Busy:
			return result, c.readFiles()
		case attempt > 120:
			return result, tracker.Refused("Another sync of this repository's issues has been running for over a minute. Try again in a moment; if it never ends, look at %s.",
				filepath.Join(c.store.Dir, logFile))
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// view gives the issues as they are to be read: what GitHub holds, with
// the waiting changes laid on top.
func (c *Copy) view() map[int]*row {
	if c.seen != nil {
		return c.seen
	}
	seen := make(map[int]*row, len(c.rows))
	for number, one := range c.rows {
		laid := *one
		laid.Labels = slices.Clone(one.Labels)
		laid.BlockedBy = slices.Clone(one.BlockedBy)
		seen[number] = &laid
	}
	for _, one := range c.changes {
		lay(seen, one)
	}
	c.seen = seen
	return seen
}

// byID finds a row by its database id.
func byID(rows map[int]*row, id int64) *row {
	for _, one := range rows {
		if one.ID == id {
			return one
		}
	}
	return nil
}

// lay puts one waiting change on top of the rows.
func lay(rows map[int]*row, one change) {
	issue := rows[one.Number]
	switch one.Kind {
	case opUpdate:
		if issue == nil {
			return
		}
		if one.Title != nil {
			issue.Title = *one.Title
		}
		if one.Body != nil {
			issue.Body = *one.Body
		}
		issue.Labels = withLabels(issue.Labels, one.AddLabels, one.RemoveLabels)
		if one.Assignees != nil {
			issue.Assignee = nil
			if len(*one.Assignees) > 0 {
				issue.Assignee = &(*one.Assignees)[0]
			}
		}
		if one.State != "" {
			issue.State = one.State
			issue.StateReason = nil
			if one.State != "open" {
				reason := one.StateReason
				if reason == "" {
					reason = "completed"
				}
				// As GitHub words it back: lower case, with spaces.
				reason = strings.ReplaceAll(reason, "_", " ")
				issue.StateReason = &reason
			}
		}
		issue.UpdatedAt = one.At
	case opComment:
		if issue != nil {
			issue.CommentCount++
			issue.UpdatedAt = one.At
		}
	case opSetParent, opRemoveParent:
		child := rows[one.OtherNumber]
		if child == nil {
			return
		}
		child.Parent = 0
		if one.Kind == opSetParent {
			child.Parent = one.Number
		}
		child.UpdatedAt = one.At
	case opAddBlockedBy, opRemoveBlockedBy:
		if issue == nil {
			return
		}
		issue.BlockedBy = slices.DeleteFunc(issue.BlockedBy, func(had int) bool { return had == one.OtherNumber })
		if one.Kind == opAddBlockedBy {
			issue.BlockedBy = append(issue.BlockedBy, one.OtherNumber)
		}
		issue.UpdatedAt = one.At
	}
}

// withLabels gives a set of labels with some added and some taken off; one
// already there, or already gone, changes nothing.
func withLabels(labels, add, remove []string) []string {
	kept := []string{}
	for _, label := range labels {
		if !slices.Contains(remove, label) {
			kept = append(kept, label)
		}
	}
	for _, label := range add {
		if !slices.Contains(kept, label) {
			kept = append(kept, label)
		}
	}
	return kept
}

// refTo gives the short pointer to a row.
func refTo(one *row) Ref { return Ref{Number: one.Number, Title: one.Title, State: one.State} }

// refsTo gives pointers to the issues with these numbers; one that is not
// in the copy is left out.
func refsTo(rows map[int]*row, numbers []int) []Ref {
	found := []Ref{}
	for _, number := range numbers {
		if one := rows[number]; one != nil {
			found = append(found, refTo(one))
		}
	}
	return found
}

// chain gives the issues an issue sits inside, with what each waits for,
// four levels up, as GitHub gives them.
func chain(rows map[int]*row, number, levels int) *Parent {
	one := rows[number]
	if one == nil || levels == 0 {
		return nil
	}
	return &Parent{Ref: refTo(one), BlockedBy: refsTo(rows, one.BlockedBy), Parent: chain(rows, one.Parent, levels-1)}
}

// numbers gives the numbers of the rows, lowest first: oldest first.
func numbers(rows map[int]*row) []int {
	found := make([]int, 0, len(rows))
	for number := range rows {
		found = append(found, number)
	}
	sort.Ints(found)
	return found
}

// full gives a row as an issue, with everything worked out from the other
// rows: the chain above it, its sub-issues, what it blocks.
func full(rows map[int]*row, order []int, one *row) Issue {
	given := Issue{
		Ref: refTo(one), ID: one.ID, Body: one.Body, StateReason: one.StateReason,
		CreatedAt: one.CreatedAt, UpdatedAt: one.UpdatedAt, Assignee: one.Assignee,
		Labels: slices.Clone(one.Labels), CommentCount: one.CommentCount,
		Parent:    chain(rows, one.Parent, 4),
		SubIssues: []Ref{}, BlockedBy: refsTo(rows, one.BlockedBy), Blocking: []Ref{},
	}
	for _, number := range order {
		other := rows[number]
		if other.Parent == one.Number {
			given.SubIssues = append(given.SubIssues, refTo(other))
		}
		if slices.Contains(other.BlockedBy, one.Number) {
			given.Blocking = append(given.Blocking, refTo(other))
		}
	}
	return given
}

// Repository is "owner/name". Nothing is asked of GitHub.
func (c *Copy) Repository() string { return c.remote.Repository() }

// Requests is how many requests were sent to GitHub.
func (c *Copy) Requests() int { return c.remote.Requests() }

// HasIssues says whether the repository has issues switched on; asked of
// GitHub, as it is only asked for the status.
func (c *Copy) HasIssues() (bool, error) { return c.remote.HasIssues() }

// Viewer is the login of the signed-in account: the one kept, else asked
// of GitHub and kept.
func (c *Copy) Viewer() (string, error) {
	if err := c.load(); err != nil {
		return "", err
	}
	if c.state.Login != "" {
		return c.state.Login, nil
	}
	login, err := c.remote.Viewer()
	if err != nil {
		return "", err
	}
	return login, c.store.Changing(func() error {
		var state copyState
		c.store.Read(stateFile, &state)
		state.Login = login
		c.state.Login = login
		return c.store.Write(stateFile, state)
	})
}

// keep puts issues as GitHub gives them into the copy's file and memory.
func (c *Copy) keep(issues ...Issue) error {
	return c.store.Changing(func() error {
		var rows []*row
		if _, err := c.store.Read(issuesFile, &rows); err != nil {
			return unreadable(issuesFile)
		}
		held := map[int]*row{}
		for _, one := range rows {
			held[one.Number] = one
		}
		for _, issue := range issues {
			held[issue.Number] = rowOf(issue)
			// In memory too, where the copy is loaded.
			if c.rows != nil {
				c.rows[issue.Number] = held[issue.Number]
			}
		}
		c.seen = nil
		// The point "changed since" is asked from is not moved here: one
		// issue read now says nothing about what else changed before it.
		return c.store.Write(issuesFile, sorted(held))
	})
}

// sorted gives rows as a list, lowest number first, as the file holds them.
func sorted(rows map[int]*row) []*row {
	list := make([]*row, 0, len(rows))
	for _, number := range numbers(rows) {
		list = append(list, rows[number])
	}
	return list
}

// Issue gives one issue from the copy. One the copy does not hold is asked
// of GitHub once: it may have been made elsewhere a moment ago.
func (c *Copy) Issue(number int) (*Issue, error) {
	if err := c.load(); err != nil {
		return nil, err
	}
	rows := c.view()
	if rows[number] == nil {
		live, err := c.remote.Issue(number)
		if err != nil || live == nil {
			return nil, err
		}
		if err := c.keep(*live); err != nil {
			return nil, err
		}
		rows = c.view()
	}
	given := full(rows, numbers(rows), rows[number])
	return &given, nil
}

// Refs gives pointers to these issues, from the copy.
func (c *Copy) Refs(wanted []int) ([]Ref, error) {
	if err := c.load(); err != nil {
		return nil, err
	}
	return refsTo(c.view(), wanted), nil
}

// Issues gives every issue in a state, oldest first, from the copy.
func (c *Copy) Issues(options ListOptions) ([]Issue, error) {
	if err := c.load(); err != nil {
		return nil, err
	}
	rows := c.view()
	order := numbers(rows)
	found := []Issue{}
	for _, number := range order {
		one := rows[number]
		if options.State != "all" && options.State != "" && one.State != options.State {
			continue
		}
		if options.Since != nil && moment(one.UpdatedAt).Before(moment(*options.Since)) {
			continue
		}
		found = append(found, full(rows, order, one))
	}
	return found, nil
}

// Search gives the issues whose title, description or number holds every
// word of the text, newest first; at most fifty, as GitHub's own search
// gives. It searches the copy, so it needs no network and finds an issue
// made a moment ago.
func (c *Copy) Search(text string) ([]Issue, error) {
	if err := c.load(); err != nil {
		return nil, err
	}
	rows := c.view()
	order := numbers(rows)
	words := strings.Fields(strings.ToLower(text))
	found := []Issue{}
	for at := len(order) - 1; at >= 0 && len(found) < 50; at-- {
		one := rows[order[at]]
		searched := strings.ToLower("#" + strconv.Itoa(one.Number) + "\n" + one.Title + "\n" + one.Body)
		every := len(words) > 0
		for _, word := range words {
			every = every && strings.Contains(searched, word)
		}
		if every {
			found = append(found, full(rows, order, one))
		}
	}
	return found, nil
}

// commentsName is the file an issue's comments are kept in.
func commentsName(number int) string { return "comments/" + strconv.Itoa(number) + ".json" }

// Comments gives an issue's comments, oldest first: the ones kept, asked
// of GitHub again when the issue has changed since, and after them the
// comments made here that still wait to be sent.
//
// Side effects: one request the first time an issue's comments are read,
// and after the issue changed on GitHub.
func (c *Copy) Comments(number int) ([]Comment, error) {
	if err := c.load(); err != nil {
		return nil, err
	}
	held := c.rows[number]
	if c.view()[number] == nil || held == nil {
		return nil, noSuchRepository()
	}
	var kept keptComments
	there, _ := c.store.Read(commentsName(number), &kept)
	if !there || kept.For != held.UpdatedAt {
		fetched, err := c.remote.Comments(number)
		switch {
		case err == nil:
			kept = keptComments{For: held.UpdatedAt, Comments: fetched}
			if err := c.store.Changing(func() error { return c.store.Write(commentsName(number), kept) }); err != nil {
				return nil, err
			}
		case !there:
			return nil, err
		default:
			c.warn("The comments could not be refreshed and may be out of date: " + err.Error())
		}
	}
	comments := slices.Clone(kept.Comments)
	if comments == nil {
		comments = []Comment{}
	}
	for _, one := range c.changes {
		if one.Kind == opComment && one.Number == number {
			comments = append(comments, Comment{
				ID: "waiting-" + strconv.Itoa(one.Seq), Author: c.state.Login, CreatedAt: one.At, Body: one.Text,
			})
		}
	}
	return comments, nil
}

// Create makes an issue on GitHub and waits for it, because only GitHub
// gives the number; then puts it into the copy.
func (c *Copy) Create(draft NewIssue) (Created, error) {
	if err := c.load(); err != nil {
		return Created{}, err
	}
	made, err := c.remote.Create(draft)
	if err != nil {
		return Created{}, err
	}
	// As GitHub holds it now; if that cannot be asked, as it was sent, and
	// the next sync brings the rest.
	issue, err := c.remote.Issue(made.Number)
	if err != nil || issue == nil {
		at := stamp(c.now())
		issue = &Issue{
			Ref: Ref{Number: made.Number, Title: draft.Title, State: "open"}, ID: made.ID,
			Body: draft.Body, CreatedAt: at, UpdatedAt: at, Labels: slices.Clone(draft.Labels),
		}
	}
	c.wantsSync = true
	return made, c.keep(*issue)
}

// record adds a change to the queue, on disk before it is in memory, so
// that a change the command reports as done is never only in memory.
func (c *Copy) record(one change) error {
	one.At = stamp(c.now())
	err := c.store.Changing(func() error {
		var queue queued
		if _, err := c.store.Read(queueFile, &queue); err != nil {
			return unreadable(queueFile)
		}
		if queue.Next == 0 {
			queue.Next = 1
		}
		one.Seq = queue.Next
		queue.Next++
		queue.Changes = append(queue.Changes, one)
		c.changes = queue.Changes
		return c.store.Write(queueFile, queue)
	})
	c.seen = nil
	c.wantsSync = true
	return err
}

// guarded gives the labels of a set whose change asks GitHub first.
func guarded(labels []string) []string {
	found := []string{}
	for _, label := range labels {
		for _, prefix := range guardedPrefixes {
			if strings.HasPrefix(label, prefix) {
				found = append(found, label)
			}
		}
	}
	sort.Strings(found)
	return found
}

// need gives the issue with a number as it is to be read, or the failure
// GitHub would give for one that is not there.
func (c *Copy) need(number int) (*row, error) {
	if err := c.load(); err != nil {
		return nil, err
	}
	if one := c.view()[number]; one != nil {
		return one, nil
	}
	return nil, noSuchRepository()
}

// Update changes an issue. It is recorded in the copy and sent later,
// unless it changes a guarded label: then GitHub is asked first, and the
// change is made there before this returns.
func (c *Copy) Update(number int, changes Changes) error {
	issue, err := c.need(number)
	if err != nil {
		return err
	}
	one := change{Kind: opUpdate, Number: number, Title: changes.Title, Assignees: changes.Assignees,
		State: changes.State, StateReason: changes.StateReason}
	if changes.Body != nil && *changes.Body != issue.Body {
		base := issue.Body
		one.Body, one.BodyBase = changes.Body, &base
	}
	if changes.Labels != nil {
		for _, label := range *changes.Labels {
			if !slices.Contains(issue.Labels, label) {
				one.AddLabels = append(one.AddLabels, label)
			}
		}
		for _, label := range issue.Labels {
			if !slices.Contains(*changes.Labels, label) {
				one.RemoveLabels = append(one.RemoveLabels, label)
			}
		}
	}
	if len(guarded(one.AddLabels))+len(guarded(one.RemoveLabels)) > 0 {
		// Only the labels go straight to GitHub. Whatever else the change
		// carries takes its place in the queue, behind what already waits:
		// sent ahead of that, an older waiting value would later replace
		// it.
		labels := change{Kind: opUpdate, Number: number, AddLabels: one.AddLabels, RemoveLabels: one.RemoveLabels}
		if err := c.updateAsking(issue, labels); err != nil {
			return err
		}
		one.AddLabels, one.RemoveLabels = nil, nil
	}
	// Nothing would change: nothing waits to be sent.
	if one.Title == nil && one.Body == nil && one.Assignees == nil && one.State == "" &&
		len(one.AddLabels)+len(one.RemoveLabels) == 0 {
		return nil
	}
	return c.record(one)
}

// updateAsking makes a change that touches a guarded label: it reads the
// issue from GitHub, refuses when its guarded labels are not what the copy
// says, and otherwise makes the change on GitHub at once.
//
// Side effects: two or three requests; the copy takes GitHub's version of
// the issue either way.
func (c *Copy) updateAsking(seen *row, one change) error {
	live, err := c.remote.Issue(one.Number)
	if err != nil {
		return err
	}
	if live == nil {
		return noSuchRepository()
	}
	if now, thought := guarded(live.Labels), guarded(seen.Labels); !slices.Equal(now, thought) {
		// The copy takes what GitHub holds, so the next look is right.
		if err := c.keep(*live); err != nil {
			return err
		}
		is := "none of them"
		if len(now) > 0 {
			is = strings.Join(now, ", ")
		}
		return tracker.Refused("Issue %d was changed on GitHub since this copy was read: of the labels %s it now has %s. Nothing was changed; look at the issue again.",
			one.Number, strings.Join(guardedPrefixes, " and "), is)
	}
	if err := c.send(one, live); err != nil {
		return err
	}
	c.wantsSync = true
	if after, err := c.remote.Issue(one.Number); err == nil && after != nil {
		return c.keep(*after)
	}
	// Not reread: the change is on GitHub, and laid on GitHub's earlier
	// version here until the next sync brings the real one.
	changed := rowOf(*live)
	rows := map[int]*row{one.Number: changed}
	one.At = stamp(c.now())
	lay(rows, one)
	return c.keep(full(rows, []int{one.Number}, changed))
}

// AddComment records a comment, to be sent later.
func (c *Copy) AddComment(number int, body string) error {
	if _, err := c.need(number); err != nil {
		return err
	}
	return c.record(change{Kind: opComment, Number: number, Text: body})
}

// other finds the issue a relation change names by its database id.
func (c *Copy) other(id int64) (*row, error) {
	if one := byID(c.view(), id); one != nil {
		return one, nil
	}
	return nil, tracker.Refused("GitHub refused: no such issue id.")
}

// SetParent puts an issue under a parent, taking it out of any other. A
// loop of sub-issues is refused here, as GitHub would refuse it.
func (c *Copy) SetParent(parentNumber int, childID int64) error {
	parent, err := c.need(parentNumber)
	if err != nil {
		return err
	}
	child, err := c.other(childID)
	if err != nil {
		return err
	}
	rows := c.view()
	for at, steps := parent, 0; at != nil && steps <= len(rows); at, steps = rows[at.Parent], steps+1 {
		if at.Number == child.Number {
			return tracker.Refused("GitHub refused: that would make a loop of sub-issues.")
		}
	}
	return c.record(change{Kind: opSetParent, Number: parentNumber, OtherID: childID, OtherNumber: child.Number})
}

// RemoveParent takes an issue out of its parent.
func (c *Copy) RemoveParent(parentNumber int, childID int64) error {
	if _, err := c.need(parentNumber); err != nil {
		return err
	}
	child, err := c.other(childID)
	if err != nil {
		return err
	}
	if child.Parent != parentNumber {
		return tracker.Refused("GitHub refused: it is not a sub-issue of that issue.")
	}
	return c.record(change{Kind: opRemoveParent, Number: parentNumber, OtherID: childID, OtherNumber: child.Number})
}

// AddBlockedBy records that an issue waits for another.
func (c *Copy) AddBlockedBy(number int, blockerID int64) error {
	return c.blockedBy(opAddBlockedBy, number, blockerID)
}

// RemoveBlockedBy records that an issue no longer waits for another.
func (c *Copy) RemoveBlockedBy(number int, blockerID int64) error {
	return c.blockedBy(opRemoveBlockedBy, number, blockerID)
}

// blockedBy records one of the two changes to what an issue waits for.
func (c *Copy) blockedBy(kind string, number int, blockerID int64) error {
	if _, err := c.need(number); err != nil {
		return err
	}
	blocker, err := c.other(blockerID)
	if err != nil {
		return err
	}
	return c.record(change{Kind: kind, Number: number, OtherID: blockerID, OtherNumber: blocker.Number})
}

// mergedBody gives the description to send for a change to it: GitHub's
// present text, with only the written parts replaced that the change
// altered from what it was made from. So a part changed on GitHub
// meanwhile, and not here, is kept.
func mergedBody(base, changed, live string) string {
	if live == base {
		return changed
	}
	from, to, now := splitBody(base), splitBody(changed), splitBody(live)
	pick := func(was, is, held string) string {
		if is != was {
			return is
		}
		return held
	}
	now.Description = pick(from.Description, to.Description, now.Description)
	now.Requirements = pick(from.Requirements, to.Requirements, now.Requirements)
	now.Done = pick(from.Done, to.Done, now.Done)
	now.Plan = pick(from.Plan, to.Plan, now.Plan)
	now.Notes = pick(from.Notes, to.Notes, now.Notes)
	// Links kept as text: the ones this change added are added, the ones it
	// took away are taken away, and GitHub's others stay.
	for _, link := range to.Links {
		if !slices.Contains(from.Links, link) && !slices.Contains(now.Links, link) {
			now.Links = append(now.Links, link)
		}
	}
	for _, link := range from.Links {
		if !slices.Contains(to.Links, link) {
			now.Links = slices.DeleteFunc(now.Links, func(had tracker.TextLink) bool { return had == link })
		}
	}
	return joinBody(now)
}

// send makes one change on GitHub.
//
// live is the issue as GitHub holds it, for a caller that has just read it;
// nil has it read here where the change needs it (a description or labels,
// which are merged with GitHub's).
func (c *Copy) send(one change, live *Issue) error {
	switch one.Kind {
	case opComment:
		return c.remote.AddComment(one.Number, one.Text)
	case opSetParent:
		return c.remote.SetParent(one.Number, one.OtherID)
	case opRemoveParent:
		return c.remote.RemoveParent(one.Number, one.OtherID)
	case opAddBlockedBy:
		return c.remote.AddBlockedBy(one.Number, one.OtherID)
	case opRemoveBlockedBy:
		return c.remote.RemoveBlockedBy(one.Number, one.OtherID)
	}
	changes := Changes{Title: one.Title, Assignees: one.Assignees, State: one.State, StateReason: one.StateReason}
	if one.Body != nil || len(one.AddLabels)+len(one.RemoveLabels) > 0 {
		if live == nil {
			asked, err := c.remote.Issue(one.Number)
			if err != nil {
				// Reading the issue failed, not the change: whatever the
				// reason, the change is not refused by it, and waits.
				return notNow(err)
			}
			if asked == nil {
				return noSuchRepository()
			}
			live = asked
		}
		if one.Body != nil {
			base := ""
			if one.BodyBase != nil {
				base = *one.BodyBase
			}
			body := mergedBody(base, *one.Body, live.Body)
			changes.Body = &body
		}
		if len(one.AddLabels)+len(one.RemoveLabels) > 0 {
			labels := withLabels(live.Labels, one.AddLabels, one.RemoveLabels)
			changes.Labels = &labels
		}
	}
	return c.remote.Update(one.Number, changes)
}

// notNow gives a failure as one that trying again later may cure.
func notNow(err error) error {
	later := tracker.Refused("%s", err.Error())
	later.Kind = tracker.KindOf(err)
	later.Later = true
	return later
}

// SyncResult is what a sync did.
type SyncResult struct {
	// Busy says that another process was syncing, so this one did nothing.
	Busy bool `json:"busy"`
	// Sent is how many waiting changes reached GitHub; Refused how many it
	// refused for good; Waiting how many still wait.
	Sent    int `json:"sent"`
	Refused int `json:"refused"`
	Waiting int `json:"waiting"`
	// BroughtIn is how many issues were read from GitHub; Full says that
	// everything was reread.
	BroughtIn int  `json:"broughtIn"`
	Full      bool `json:"full"`
	// Problem is why changes still wait, or why nothing could be brought
	// in; "" when all went well.
	Problem string `json:"problem"`
}

// Sync sends the waiting changes to GitHub, in the order they were made,
// and brings in what changed there.
//
// full rereads everything, which also drops issues that are gone; it
// happens by itself once a day and the first time.
// Returns what was done. An error means GitHub could not be asked for what
// changed; changes that could not be sent are not an error, they wait.
// Side effects: requests to GitHub; the copy's files; a line in its log.
func (c *Copy) Sync(full bool) (SyncResult, error) {
	result, err := c.syncOnce(full)
	// A change recorded while the sync ran found the lock held, so nothing
	// else will send it: this sync goes round again for it. A few times at
	// most; what comes after that waits for the next sync.
	for round := 0; round < 3 && err == nil && !result.Busy && result.Waiting > 0 && result.Problem == ""; round++ {
		var more SyncResult
		more, err = c.syncOnce(false)
		result.Sent += more.Sent
		result.Refused += more.Refused
		result.Waiting, result.Problem = more.Waiting, more.Problem
		result.BroughtIn += more.BroughtIn
	}
	return result, err
}

// WaitAndSync is Sync for a caller that wants its result: where another
// process is syncing, it waits for that one to finish and then syncs.
func (c *Copy) WaitAndSync(full bool) (SyncResult, error) { return c.syncNow(full) }

// syncOnce is one round of Sync: send what waits, then bring in.
func (c *Copy) syncOnce(full bool) (SyncResult, error) {
	result := SyncResult{}
	done, free, err := c.store.Syncing()
	if err != nil {
		return result, tracker.Refused("The local copy of the GitHub issues cannot be written (%s).", c.store.Dir)
	}
	if !free {
		result.Busy = true
		return result, nil
	}
	defer done()
	if err := c.readFiles(); err != nil {
		if !full {
			return result, err
		}
		// Rereading everything is the cure for a copy that cannot be read:
		// each such file is put aside, kept for a person to look at, and
		// the copy is made anew. Waiting changes in a queue that cannot be
		// read are not sent; the file they were in is named.
		for _, name := range []string{issuesFile, stateFile, queueFile} {
			var probe any
			if _, err := c.store.Read(name, &probe); err != nil {
				aside := c.store.SetAside(name)
				c.warn("The file " + name + " of the local copy could not be read and was put aside as " + aside + ".")
			}
		}
		if err := c.readFiles(); err != nil {
			return result, err
		}
	}
	// --- Send, oldest first. A "not now" stops the sending, to keep the
	// order; a "never" is put aside and the sending goes on.
	for {
		var queue queued
		c.store.Read(queueFile, &queue)
		if len(queue.Changes) == 0 {
			break
		}
		one := queue.Changes[0]
		sendErr := c.send(one, nil)
		if sendErr != nil && tracker.MayWorkLater(sendErr) {
			result.Problem = sendErr.Error()
			break
		}
		if err := c.store.Changing(func() error {
			var now queued
			if _, err := c.store.Read(queueFile, &now); err != nil {
				return unreadable(queueFile)
			}
			now.Changes = slices.DeleteFunc(now.Changes, func(had change) bool { return had.Seq == one.Seq })
			if sendErr == nil {
				// GitHub has it now, so the copy's "what GitHub holds" gets
				// it in the same moment it leaves the queue: there is no
				// while in which the change shows in neither. The row's
				// "last changed" is left as GitHub gave it, so that what
				// GitHub gives next replaces this.
				if err := c.laidOnHeld(one); err != nil {
					return err
				}
			}
			if sendErr != nil {
				var refused []refusedEntry
				c.store.Read(refusedFile, &refused)
				refused = append(refused, refusedEntry{At: stamp(c.now()), Reason: sendErr.Error(), Change: one})
				if err := c.store.Write(refusedFile, refused); err != nil {
					return err
				}
			}
			return c.store.Write(queueFile, now)
		}); err != nil {
			return result, err
		}
		if sendErr != nil {
			result.Refused++
		} else {
			result.Sent++
		}
	}
	// --- Bring in. The moment is taken before asking, so that a change
	// made on GitHub while the answer travels is asked for next time.
	started := c.now()
	if at, err := time.Parse(time.RFC3339, c.state.LastFull); err != nil || started.Sub(at) > fullEvery {
		full = true
	}
	options := ListOptions{State: "all"}
	if !full {
		if at, err := time.Parse(time.RFC3339, c.state.Cursor); err == nil {
			since := stamp(at.Add(-overlap))
			options.Since = &since
		} else {
			// Nothing was ever given: there is no moment to ask from.
			full = true
		}
	}
	issues, pullErr := c.remote.Issues(options)
	if pullErr == nil {
		// For signing comments with no network later; asked at every sync,
		// because the owner may have signed in as someone else. Not worth
		// failing for.
		if login, err := c.remote.Viewer(); err == nil {
			c.state.Login = login
		}
	}
	if pullErr == nil {
		pullErr = c.store.Changing(func() error {
			// As the file is now: another process may have put an issue in
			// it (one just made, one whose step was just moved) while the
			// answer travelled.
			var rows []*row
			if _, err := c.store.Read(issuesFile, &rows); err != nil {
				return unreadable(issuesFile)
			}
			given := map[int]bool{}
			for _, issue := range issues {
				given[issue.Number] = true
			}
			held := map[int]*row{}
			for _, one := range rows {
				// A full reread drops what GitHub no longer gives, except
				// an issue made since the reread began, which the answer
				// could not hold yet.
				if full && !given[one.Number] && !moment(one.CreatedAt).After(started.Add(-overlap)) {
					continue
				}
				held[one.Number] = one
			}
			for _, issue := range issues {
				// Never an older version over a newer one.
				if had := held[issue.Number]; had == nil || !moment(issue.UpdatedAt).Before(moment(had.UpdatedAt)) {
					held[issue.Number] = rowOf(issue)
				}
				if moment(issue.UpdatedAt).After(moment(c.state.Cursor)) {
					c.state.Cursor = issue.UpdatedAt
				}
			}
			if err := c.store.Write(issuesFile, sorted(held)); err != nil {
				return err
			}
			c.state.LastSync = stamp(started)
			if full {
				c.state.LastFull = stamp(started)
			}
			return c.store.Write(stateFile, c.state)
		})
		result.BroughtIn, result.Full = len(issues), full
	}
	var queue queued
	c.store.Read(queueFile, &queue)
	result.Waiting = len(queue.Changes)
	if pullErr != nil && result.Problem == "" {
		result.Problem = pullErr.Error()
	}
	c.store.Append(logFile, fmt.Sprintf("%s sent %d, refused %d, waiting %d, brought in %d (full: %t) %s",
		stamp(c.now()), result.Sent, result.Refused, result.Waiting, result.BroughtIn, result.Full, result.Problem))
	if err := c.readFiles(); err != nil {
		return result, err
	}
	c.wantsSync = false
	return result, pullErr
}

// laidOnHeld puts a change that has reached GitHub onto the row the copy
// holds for it. Call it holding the files lock.
func (c *Copy) laidOnHeld(one change) error {
	var rows []*row
	if _, err := c.store.Read(issuesFile, &rows); err != nil {
		return unreadable(issuesFile)
	}
	held := map[int]*row{}
	was := map[int]string{}
	for _, kept := range rows {
		held[kept.Number] = kept
		was[kept.Number] = kept.UpdatedAt
	}
	lay(held, one)
	for number, kept := range held {
		kept.UpdatedAt = was[number]
	}
	if one.Kind == opComment {
		// The comments kept for the issue lack the new one: asked for again
		// the next time they are read.
		c.store.Remove(commentsName(one.Number))
	}
	return c.store.Write(issuesFile, sorted(held))
}

// CopyStatus says how the copy stands.
type CopyStatus struct {
	// Folder is where the copy is kept.
	Folder string `json:"folder"`
	// LastSync is when what changed on GitHub was last brought in; nil for
	// never.
	LastSync *string `json:"lastSync"`
	// Waiting is how many changes made here are not yet on GitHub; Refused
	// how many GitHub refused for good and nobody has dismissed.
	Waiting int `json:"waiting"`
	Refused int `json:"refused"`
}

// Status says how the copy stands, from its files; nothing is asked of
// GitHub and nothing is refreshed.
func (c *Copy) Status() CopyStatus {
	var queue queued
	c.store.Read(queueFile, &queue)
	var refused []refusedEntry
	c.store.Read(refusedFile, &refused)
	var state copyState
	c.store.Read(stateFile, &state)
	status := CopyStatus{Folder: c.store.Dir, Waiting: len(queue.Changes), Refused: len(refused)}
	if state.LastSync != "" {
		status.LastSync = &state.LastSync
	}
	return status
}

// Unsent says how many changes to an issue made here are not yet on
// GitHub.
func (c *Copy) Unsent(number int) int {
	count := 0
	for _, one := range c.changes {
		if one.Number == number || (one.OtherNumber == number && (one.Kind == opSetParent || one.Kind == opRemoveParent)) {
			count++
		}
	}
	return count
}

// describe says what a change was, in a few words, and gives the text it
// carried, where it carried one.
func describe(one change) (what, text string) {
	switch one.Kind {
	case opComment:
		return "a comment", one.Text
	case opSetParent:
		return "putting issue " + strconv.Itoa(one.OtherNumber) + " under it", ""
	case opRemoveParent:
		return "taking issue " + strconv.Itoa(one.OtherNumber) + " out of it", ""
	case opAddBlockedBy:
		return "recording that it waits for issue " + strconv.Itoa(one.OtherNumber), ""
	case opRemoveBlockedBy:
		return "recording that it no longer waits for issue " + strconv.Itoa(one.OtherNumber), ""
	}
	parts := []string{}
	if one.Title != nil {
		parts = append(parts, "the title")
		text = *one.Title
	}
	if one.Body != nil {
		parts = append(parts, "the written parts")
		text = *one.Body
	}
	if len(one.AddLabels)+len(one.RemoveLabels) > 0 {
		parts = append(parts, "labels")
	}
	if one.Assignees != nil {
		parts = append(parts, "the assignee")
	}
	if one.State != "" {
		parts = append(parts, "open or closed")
	}
	return "a change of " + strings.Join(parts, ", "), text
}

// RefusedChanges gives the changes GitHub refused for good, oldest first.
func (c *Copy) RefusedChanges() []RefusedChange {
	var refused []refusedEntry
	c.store.Read(refusedFile, &refused)
	found := []RefusedChange{}
	for _, entry := range refused {
		what, text := describe(entry.Change)
		found = append(found, RefusedChange{
			Seq: entry.Change.Seq, At: entry.At, Issue: strconv.Itoa(entry.Change.Number),
			What: what, Text: text, Reason: entry.Reason,
		})
	}
	return found
}

// Dismiss takes a refused change off the list; again puts it back into the
// queue to be sent once more. seq 0 means all of them.
//
// Returns how many were taken off. Fails when seq names none.
func (c *Copy) Dismiss(seq int, again bool) (int, error) {
	taken := 0
	err := c.store.Changing(func() error {
		var refused []refusedEntry
		c.store.Read(refusedFile, &refused)
		var queue queued
		if _, err := c.store.Read(queueFile, &queue); err != nil {
			return unreadable(queueFile)
		}
		if queue.Next == 0 {
			queue.Next = 1
		}
		kept := []refusedEntry{}
		for _, entry := range refused {
			if seq != 0 && entry.Change.Seq != seq {
				kept = append(kept, entry)
				continue
			}
			taken++
			if again {
				// At the end of the queue, under a new number: it is sent
				// after what was made since.
				entry.Change.Seq = queue.Next
				queue.Next++
				queue.Changes = append(queue.Changes, entry.Change)
			}
		}
		if taken == 0 {
			return nil
		}
		if again {
			if err := c.store.Write(queueFile, queue); err != nil {
				return err
			}
			c.wantsSync = true
		}
		return c.store.Write(refusedFile, kept)
	})
	if err == nil && taken == 0 && seq != 0 {
		err = tracker.Refused("There is no refused change with the number %d.", seq)
	}
	return taken, err
}
