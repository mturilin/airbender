// fake.go — an in-memory stand-in for GitHub, for tests.
//
// What: a Client (api.go) that keeps its issues in memory and behaves as
// GitHub was seen to behave for the calls the adapter makes.
//
// Why: the adapter's rules (where each field is kept, links written on both
// issues, what blocks what, who a comment is from) are worth testing on
// every run, without a network, a login or a rate limit. It is in the
// package proper, not in a test file, so that the tests of other packages
// (the command's) can build a GitHub tracker on it too.
//
// Design notes:
//   - It imitates only what was checked against real GitHub on 2026-10-09
//     (bead-bb-c9l.1): a label exists once it is applied; a sub-issue has one
//     parent and adding it elsewhere moves it; a blocker is named by its
//     database id; a missing issue is "no such issue", not an error.
//   - It counts requests the way the real client does: one per call, so a
//     test can say what a read costs.
//   - Issues are numbered 1, 2, 3 in the order they are made and never
//     removed, so "every issue, oldest first" is the numbers in order.
//   - Every method takes one lock, so tests that use it from several
//     goroutines are safe.
//
// Gotchas:
//   - A stand-in can drift from the real thing. When a test against real
//     GitHub and this file disagree, GitHub is right and this file is wrong.

package github

import (
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// stored is one issue as the stand-in keeps it.
type stored struct {
	number      int
	id          int64
	title       string
	body        string
	state       string
	stateReason *string
	createdAt   string
	updatedAt   string
	assignees   []string
	labels      []string
	// parent is the number of the issue this one sits inside; 0 at the top
	// level.
	parent int
	// blockedBy are the numbers of the issues this one waits for.
	blockedBy []int
	comments  []Comment
}

// Fake is the stand-in: a Client, with a few extras for tests to look
// inside (BodyOf, LabelsOf, SetClock).
type Fake struct {
	lock       sync.Mutex
	repository string
	login      string
	// issues are the stored issues; the one numbered n is at n-1.
	issues     []*stored
	sent       int
	now        string
	commentIDs int
}

// FakeOptions say what the stand-in repository is; both may be left empty.
type FakeOptions struct {
	// Repository is "owner/name"; "someone/scratch" when "".
	Repository string
	// Login is the account it is signed in as; "octo" when "".
	Login string
}

// NewFake builds an empty stand-in repository.
func NewFake(options FakeOptions) *Fake {
	fake := &Fake{
		repository: options.Repository,
		login:      options.Login,
		now:        "2026-01-01T00:00:00Z",
	}
	if fake.repository == "" {
		fake.repository = "someone/scratch"
	}
	if fake.login == "" {
		fake.login = "octo"
	}
	return fake
}

// find gives the stored issue with a number; nil when there is none.
func (fake *Fake) find(number int) *stored {
	if number < 1 || number > len(fake.issues) {
		return nil
	}
	return fake.issues[number-1]
}

// need gives the stored issue, or GitHub's refusal for one that does not
// exist.
func (fake *Fake) need(number int) (*stored, error) {
	issue := fake.find(number)
	if issue == nil {
		return nil, tracker.Refused("GitHub found no such repository or issue, or this login may not see it.")
	}
	return issue, nil
}

// byID gives the stored issue with a database id, or GitHub's refusal.
func (fake *Fake) byID(id int64) (*stored, error) {
	for _, candidate := range fake.issues {
		if candidate.id == id {
			return candidate, nil
		}
	}
	return nil, tracker.Refused("GitHub refused: no such issue id.")
}

// ref gives the pointer to a stored issue.
func ref(issue *stored) Ref {
	return Ref{Number: issue.number, Title: issue.title, State: issue.state}
}

// refs gives pointers to the issues with these numbers; one that does not
// exist is left out. Never nil.
func (fake *Fake) refs(numbers []int) []Ref {
	found := []Ref{}
	for _, number := range numbers {
		if issue := fake.find(number); issue != nil {
			found = append(found, ref(issue))
		}
	}
	return found
}

// up gives the parent chain, levels levels up (four, as the real client
// reads it); nil for no parent.
func (fake *Fake) up(number, levels int) *Parent {
	issue := fake.find(number)
	if issue == nil || levels == 0 {
		return nil
	}
	return &Parent{
		Ref:       ref(issue),
		BlockedBy: fake.refs(issue.blockedBy),
		Parent:    fake.up(issue.parent, levels-1),
	}
}

// full gives a stored issue as the real client would: with its parents,
// sub-issues, blockers and what it blocks. The lists are copies.
func (fake *Fake) full(issue *stored) Issue {
	given := Issue{
		Ref:          ref(issue),
		ID:           issue.id,
		Body:         issue.body,
		CreatedAt:    issue.createdAt,
		UpdatedAt:    issue.updatedAt,
		Labels:       append([]string{}, issue.labels...),
		CommentCount: len(issue.comments),
		Parent:       fake.up(issue.parent, 4),
		SubIssues:    []Ref{},
		BlockedBy:    fake.refs(issue.blockedBy),
		Blocking:     []Ref{},
	}
	if issue.stateReason != nil {
		reason := *issue.stateReason
		given.StateReason = &reason
	}
	if len(issue.assignees) > 0 {
		assignee := issue.assignees[0]
		given.Assignee = &assignee
	}
	for _, other := range fake.issues {
		if other.parent == issue.number {
			given.SubIssues = append(given.SubIssues, ref(other))
		}
		for _, blocker := range other.blockedBy {
			if blocker == issue.number {
				given.Blocking = append(given.Blocking, ref(other))
				break
			}
		}
	}
	return given
}

// touch marks an issue as changed now.
func (fake *Fake) touch(issue *stored) { issue.updatedAt = fake.now }

// moment reads an ISO date and time; the zero time when it cannot be read.
func moment(iso string) time.Time {
	at, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return time.Time{}
	}
	return at
}

// Repository is "owner/name".
func (fake *Fake) Repository() string { return fake.repository }

// Viewer is the account the stand-in is signed in as. Counts as a request
// every time, unlike the real client, which keeps the answer.
func (fake *Fake) Viewer() (string, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	return fake.login, nil
}

// HasIssues is always true here.
func (fake *Fake) HasIssues() (bool, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	return true, nil
}

// Issue gives one issue; nil when there is none with that number.
func (fake *Fake) Issue(number int) (*Issue, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	issue := fake.find(number)
	if issue == nil {
		return nil, nil
	}
	given := fake.full(issue)
	return &given, nil
}

// Refs gives pointers to these issues; an empty list costs no request, as
// with the real client.
func (fake *Fake) Refs(numbers []int) ([]Ref, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	if len(numbers) == 0 {
		return []Ref{}, nil
	}
	fake.sent++
	return fake.refs(numbers), nil
}

// Issues gives every issue in a state, oldest first.
func (fake *Fake) Issues(options ListOptions) ([]Issue, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	found := []Issue{}
	for _, issue := range fake.issues {
		if options.State != "all" && issue.state != options.State {
			continue
		}
		if options.Since != nil && moment(issue.updatedAt).Before(moment(*options.Since)) {
			continue
		}
		found = append(found, fake.full(issue))
	}
	return found, nil
}

// Search gives the issues whose title or description holds every word of
// the text, whatever the case.
func (fake *Fake) Search(text string) ([]Issue, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	words := strings.Fields(strings.ToLower(text))
	found := []Issue{}
	for _, issue := range fake.issues {
		searched := strings.ToLower(issue.title + "\n" + issue.body)
		every := true
		for _, word := range words {
			every = every && strings.Contains(searched, word)
		}
		if every {
			found = append(found, fake.full(issue))
		}
	}
	return found, nil
}

// Comments gives a copy of an issue's comments, oldest first.
func (fake *Fake) Comments(number int) ([]Comment, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	issue, err := fake.need(number)
	if err != nil {
		return nil, err
	}
	return append([]Comment{}, issue.comments...), nil
}

// Create makes an issue with the next number; its database id is 1000 more.
func (fake *Fake) Create(draft NewIssue) (Created, error) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	number := len(fake.issues) + 1
	issue := &stored{
		number:    number,
		id:        int64(1000 + number),
		title:     draft.Title,
		body:      draft.Body,
		state:     "open",
		createdAt: fake.now,
		updatedAt: fake.now,
		assignees: []string{},
		labels:    append([]string{}, draft.Labels...),
		blockedBy: []int{},
		comments:  []Comment{},
	}
	fake.issues = append(fake.issues, issue)
	return Created{Number: number, ID: issue.id}, nil
}

// Update changes an issue; what changes leaves out is left as it is.
func (fake *Fake) Update(number int, changes Changes) error {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	issue, err := fake.need(number)
	if err != nil {
		return err
	}
	if changes.Title != nil {
		issue.title = *changes.Title
	}
	if changes.Body != nil {
		issue.body = *changes.Body
	}
	if changes.Labels != nil {
		issue.labels = append([]string{}, *changes.Labels...)
	}
	if changes.Assignees != nil {
		issue.assignees = append([]string{}, *changes.Assignees...)
	}
	if changes.State != "" {
		issue.state = changes.State
		issue.stateReason = nil
		if changes.State != "open" {
			reason := changes.StateReason
			if reason == "" {
				reason = "completed"
			}
			reason = strings.ReplaceAll(reason, "_", " ")
			issue.stateReason = &reason
		}
	}
	fake.touch(issue)
	return nil
}

// AddComment adds a comment from the signed-in account.
func (fake *Fake) AddComment(number int, body string) error {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	issue, err := fake.need(number)
	if err != nil {
		return err
	}
	fake.commentIDs++
	// A later comment gets a later time, as on GitHub.
	at := moment(fake.now).Add(time.Duration(fake.commentIDs) * time.Second)
	issue.comments = append(issue.comments, Comment{
		ID:        strconv.Itoa(fake.commentIDs),
		Author:    fake.login,
		CreatedAt: at.UTC().Format("2006-01-02T15:04:05.000Z"),
		Body:      body,
	})
	fake.touch(issue)
	return nil
}

// SetParent puts an issue under a parent, taking it out of any other.
func (fake *Fake) SetParent(parentNumber int, childID int64) error {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	parent, err := fake.need(parentNumber)
	if err != nil {
		return err
	}
	child, err := fake.byID(childID)
	if err != nil {
		return err
	}
	// GitHub refuses a loop itself.
	for at := parent; at != nil; at = fake.find(at.parent) {
		if at.number == child.number {
			return tracker.Refused("GitHub refused: that would make a loop of sub-issues.")
		}
	}
	child.parent = parent.number
	fake.touch(child)
	return nil
}

// RemoveParent takes an issue out of its parent; refused when it is not a
// sub-issue of that one.
func (fake *Fake) RemoveParent(parentNumber int, childID int64) error {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	child, err := fake.byID(childID)
	if err != nil {
		return err
	}
	parent, err := fake.need(parentNumber)
	if err != nil {
		return err
	}
	if child.parent != parent.number {
		return tracker.Refused("GitHub refused: it is not a sub-issue of that issue.")
	}
	child.parent = 0
	fake.touch(child)
	return nil
}

// AddBlockedBy records that number waits for the issue with database id
// blockerID; once, however often it is asked.
func (fake *Fake) AddBlockedBy(number int, blockerID int64) error {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	issue, err := fake.need(number)
	if err != nil {
		return err
	}
	blocker, err := fake.byID(blockerID)
	if err != nil {
		return err
	}
	already := false
	for _, had := range issue.blockedBy {
		already = already || had == blocker.number
	}
	if !already {
		issue.blockedBy = append(issue.blockedBy, blocker.number)
	}
	fake.touch(issue)
	return nil
}

// RemoveBlockedBy removes the record that number waits for the issue with
// database id blockerID.
func (fake *Fake) RemoveBlockedBy(number int, blockerID int64) error {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.sent++
	issue, err := fake.need(number)
	if err != nil {
		return err
	}
	blocker, err := fake.byID(blockerID)
	if err != nil {
		return err
	}
	kept := []int{}
	for _, had := range issue.blockedBy {
		if had != blocker.number {
			kept = append(kept, had)
		}
	}
	issue.blockedBy = kept
	fake.touch(issue)
	return nil
}

// Requests is how many requests the stand-in has been sent.
func (fake *Fake) Requests() int {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	return fake.sent
}

// BodyOf gives the description of an issue exactly as it is stored; "" when
// there is no such issue.
func (fake *Fake) BodyOf(number int) string {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	if issue := fake.find(number); issue != nil {
		return issue.body
	}
	return ""
}

// LabelsOf gives a copy of the labels of an issue exactly as they are
// stored; nil when there is no such issue.
func (fake *Fake) LabelsOf(number int) []string {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	if issue := fake.find(number); issue != nil {
		return append([]string{}, issue.labels...)
	}
	return nil
}

// SetClock moves the stand-in's clock (an ISO date and time), so "changed
// since" can be tested.
func (fake *Fake) SetClock(iso string) {
	fake.lock.Lock()
	defer fake.lock.Unlock()
	fake.now = iso
}
