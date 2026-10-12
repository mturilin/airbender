// Package tracker is the one shape every issue tracker is seen through.
//
// What: the common description of an issue, of the operations a tracker must
// offer (the Tracker interface), of what a tracker can and cannot hold
// (Capabilities), and the kinds of failure.
//
// Why: the owner wants agents to work on issues without knowing whether they
// live in beads or on GitHub ("the agent doesn't have to think twice").
// Everything above this package (the bend command, and through it the
// Airbender tab) talks only in these terms; everything below it is an
// adapter for one tracker.
//
// Design notes:
//   - The written parts of an issue are named for the owner's way of working
//     (description, requirements, done, plan, notes), not for any tracker's
//     fields. Each adapter decides where a part is kept, and says so in its
//     capabilities when that is not a field of its own.
//   - A failure is an *Error with a kind. The command turns the kind into its
//     exit status: 2 for a wrong request, 3 for something the tracker cannot
//     do, 1 for every other refusal. "The tracker cannot do this" is kept
//     apart from "you asked wrongly" so an agent can adapt instead of
//     retrying. Three refusals have a kind of their own (no program, not set
//     up, not signed in) because a caller with a screen offers a different
//     way out of each.
//   - Three kinds of link are common to every tracker (LinkKinds). A tracker
//     may accept kinds of its own as well; it names them in About, and
//     answers Unsupported for any other.
//   - The field order of the structs is the order of the keys in bend's JSON
//     output, which programs and recorded test output depend on.
//
// Gotchas:
//   - This package imports nothing but the standard library, and no adapter.
//   - A list that is empty is printed as [], never null: adapters must give
//     empty slices, not nil ones (see Issue.Tidy).
package tracker

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Parts are the written parts of an issue that Write can replace.
var Parts = []string{"description", "requirements", "done", "plan", "notes"}

// LinkKinds are the kinds of link every tracker can add; see the package
// comment.
var LinkKinds = []string{"blocked-by", "discovered-from", "related"}

// IssueRef is a short pointer to another issue.
type IssueRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Status is the other issue's status, as the tracker names it; "closed"
	// when done.
	Status string `json:"status"`
}

// Link is one link between an issue and another.
//
// Direction says which end this issue is: "out" when the statement is about
// this issue ("this issue is blocked by the other"), "in" when it is about
// the other ("the other is blocked by this one"). A link with no direction,
// such as "related", is always "out".
type Link struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	// Kind is one of LinkKinds, or a kind of the tracker's own, shown as it
	// is.
	Kind      string `json:"kind"`
	Direction string `json:"direction"`
}

// Issue is an issue in the shape that is the same for every tracker.
type Issue struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Status is "open", "in_progress", "closed", or another status of the
	// tracker's.
	Status string  `json:"status"`
	Type   *string `json:"type"`
	// Priority is 0 (most urgent) to 4; nil when the tracker holds none.
	Priority *int    `json:"priority"`
	Category *string `json:"category"`
	Assignee *string `json:"assignee"`
	// ParentID is the issue this one is a sub-issue of; nil at the top level.
	ParentID *string `json:"parentId"`
	// Description is what is wanted and why.
	Description string `json:"description"`
	// Requirements are the agreed requirements; "" when none are written.
	Requirements string `json:"requirements"`
	// Done is what "done" means.
	Done string `json:"done"`
	// Plan is how it is to be built.
	Plan  string `json:"plan"`
	Notes string `json:"notes"`
	// CloseReason is why it was closed; "" for an open issue or when no
	// reason was given.
	CloseReason string `json:"closeReason"`
	// Labels are the labels other than the ones the adapter uses to hold a
	// field.
	Labels []string `json:"labels"`
	Links  []Link   `json:"links"`
	// SubIssues are the direct sub-issues.
	SubIssues []IssueRef `json:"subIssues"`
	// BlockedBy are the unfinished issues this one waits for, its own or its
	// parents'.
	BlockedBy    []IssueRef `json:"blockedBy"`
	CommentCount int        `json:"commentCount"`
	CreatedAt    *string    `json:"createdAt"`
	UpdatedAt    *string    `json:"updatedAt"`
	// Metadata is free-form data kept with the issue, by key, for a caller
	// that keeps something of its own there and does not want it in a label
	// (the Airbender tab keeps an epic's branch: a label would be sent to
	// GitHub by beads' sync, and GitHub refuses a long one). Always one JSON
	// object, kept as the tracker wrote it so the order of its keys stays;
	// {} when there is none, or the tracker has no place for it.
	Metadata json.RawMessage `json:"metadata"`
	// ExternalRef is the issue's counterpart in another tracker, when it has
	// one.
	ExternalRef *string `json:"externalRef"`
	// Unsent is how many changes to this issue were made on this machine
	// and have not reached the tracker yet. Always 0 for a tracker that is
	// not worked from a local copy.
	Unsent int `json:"unsent"`
}

// Tidy gives the issue with every list made a real, possibly empty, list and
// its metadata an object, so that it is printed as [] and {} and never as
// null. Adapters call it on what they return.
func (issue Issue) Tidy() Issue {
	if issue.Labels == nil {
		issue.Labels = []string{}
	}
	if issue.Links == nil {
		issue.Links = []Link{}
	}
	if issue.SubIssues == nil {
		issue.SubIssues = []IssueRef{}
	}
	if issue.BlockedBy == nil {
		issue.BlockedBy = []IssueRef{}
	}
	if len(issue.Metadata) == 0 {
		issue.Metadata = json.RawMessage("{}")
	}
	return issue
}

// Comment is one comment on an issue.
type Comment struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	CreatedAt string `json:"createdAt"`
	Text      string `json:"text"`
}

// ListFilter is what List can narrow by; a field left nil does not narrow.
type ListFilter struct {
	// Status is a status, or "all" to include closed issues. Open ones when
	// nil.
	Status   *string
	Type     *string
	Priority *int
	Category *string
	Assignee *string
	// ParentID narrows to the direct sub-issues of this issue.
	ParentID *string
	// ChangedSince narrows to issues changed at or after this moment (an ISO
	// date and time). For a caller that keeps a copy and wants only what is
	// new; with it, a hosted tracker is asked for those issues alone.
	ChangedSince *string
}

// Draft is what a new issue is created from. A nil field was not given.
type Draft struct {
	Title       string
	Description *string
	Done        *string
	Type        *string
	Priority    *int
	// Category is inherited from the parent when nil.
	Category *string
	ParentID *string
	// From is the issue this one was discovered while working on.
	From      *string
	BlockedBy []string
}

// MetadataChange sets one key of an issue's free-form data, or with a nil
// Value removes it.
type MetadataChange struct {
	Key   string
	Value *string
}

// Changes is what Edit can change; a field left nil is left as it is.
type Changes struct {
	Title    *string
	Type     *string
	Priority *int
	// Category is the new category; ClearCategory removes it instead.
	Category      *string
	ClearCategory bool
	// Assignee is the new assignee; ClearAssignee removes it instead.
	Assignee      *string
	ClearAssignee bool
	// AddLabels and RemoveLabels are labels to add and to take away, as they
	// are; one already there, or already gone, is left alone. For a caller
	// that keeps something of its own on an issue (the tab's workflow step
	// is the label step:<id>).
	AddLabels    []string
	RemoveLabels []string
	// Metadata is free-form data to keep with the issue, in the order given.
	// Unsupported where the tracker has no place for it.
	Metadata []MetadataChange
}

// Empty reports whether the changes change nothing.
func (changes Changes) Empty() bool {
	return changes.Title == nil && changes.Type == nil && changes.Priority == nil &&
		changes.Category == nil && !changes.ClearCategory &&
		changes.Assignee == nil && !changes.ClearAssignee &&
		len(changes.AddLabels) == 0 && len(changes.RemoveLabels) == 0 &&
		len(changes.Metadata) == 0
}

// Support says how well a tracker holds one thing: Level is "yes" as a field
// of its own, "another way" with a note saying where, or "no".
type Support struct {
	Name  string `json:"name"`
	Level string `json:"level"`
	// Note is where it is kept, or why it is not available; "" for a plain
	// yes.
	Note string `json:"note"`
}

// Capabilities is what `status` reports about a repository's tracker.
type Capabilities struct {
	// Tracker is the tracker's name, e.g. "beads".
	Tracker string `json:"tracker"`
	// Where is one line on which tracker instance this is, e.g. its folder.
	Where string `json:"where"`
	// LinkKinds is every kind of link Link accepts here: the common ones
	// this tracker can hold, then kinds of its own.
	LinkKinds []string  `json:"linkKinds"`
	Supports  []Support `json:"supports"`
	// Warnings are things worth knowing that are not about a single feature.
	Warnings []string `json:"warnings"`
}

// About is what is known about a tracker without asking it anything: no
// program is run and nothing is sent over the network to fill it.
type About struct {
	// Tracker is the tracker's name: "beads" or "github".
	Tracker string `json:"tracker"`
	// Repository is "owner/name" for a hosted tracker; nil for a local one.
	Repository *string `json:"repository"`
	// LinkKinds is every kind of link Link accepts here.
	LinkKinds []string `json:"linkKinds"`
	// Writes says how a change reaches the tracker, for the local copy bend
	// answers from (internal/kept): WritesStraight, or WritesQueued. "" is
	// taken as straight.
	Writes string `json:"-"`
}

// How a tracker's changes are written; see About.Writes.
const (
	// WritesStraight: a change is made by the tracker at once and its
	// answer is certain before the command returns. For a tracker on this
	// machine.
	WritesStraight = "straight"
	// WritesQueued: a change is recorded on this machine and sent to the
	// tracker afterwards. For a tracker reached over the network.
	WritesQueued = "queued"
)

// Signed is implemented by a tracker that has a cheap sign which changes
// whenever its data changes (a file's time, say). The local copy stores the
// sign with what it holds, and knows by it that it is behind without asking
// the tracker anything.
type Signed interface {
	// Sign gives the sign as it is now; never "". Nothing slow is done.
	Sign() string
}

// UnlinkOptions narrow what Unlink removes.
type UnlinkOptions struct {
	// OnlyFrom removes only the link recorded on the first issue that points
	// at the second, and leaves one recorded the other way round. For a
	// caller that shows the two as separate links.
	OnlyFrom bool
	// Kind, when not "", removes only a link of this kind. It matters where
	// two issues can be linked in several ways at once.
	Kind string
}

// Tracker is the set of operations every tracker adapter offers.
//
// Every method fails with an *Error: Refused (or one of its special kinds)
// when the tracker says no (an unknown id, a move into itself), Unsupported
// when the tracker has no way to do it. Who is acting is given to the
// adapter when it is built, not here.
type Tracker interface {
	// About says what is known without asking the tracker; see About.
	About() About
	Capabilities() (Capabilities, error)
	List(filter ListFilter) ([]Issue, error)
	// Ready gives the issues that can be worked on now, by the tracker's own
	// definition.
	Ready() ([]Issue, error)
	Show(id string) (Issue, error)
	Comments(id string) ([]Comment, error)
	Search(text string) ([]Issue, error)
	// Create returns the new issue's id.
	Create(draft Draft) (string, error)
	Edit(id string, changes Changes) error
	// Write replaces one written part (one of Parts); an empty text clears
	// it.
	Write(id, part, text string) error
	Comment(id, text string) error
	// Start marks an issue as being worked on by the actor.
	Start(id string) error
	// Stop puts an issue that is being worked on back to open: nobody is
	// working on it now. An issue that is open and not in progress is left
	// as it is; refused for a closed one. Who it is assigned to is not
	// changed.
	Stop(id string) error
	// Close closes an issue; reason may be "".
	Close(id, reason string) error
	Reopen(id string) error
	// Move puts an issue under a parent, or with nil back at the top level.
	Move(id string, parentID *string) error
	// Link records "id <kind> otherID", e.g. id is blocked by otherID. kind
	// is one of About().LinkKinds; Unsupported otherwise.
	Link(id, otherID, kind string) error
	// Unlink removes whatever link there is between the two, in either
	// direction, unless options narrow it.
	Unlink(id, otherID string, options UnlinkOptions) error
}

// Kind is the kind of a failure.
type Kind string

const (
	// KindRefused: the tracker, or a rule of this layer, said no.
	KindRefused Kind = "refused"
	// KindNoProgram: the tracker's own program is not installed on this
	// machine.
	KindNoProgram Kind = "no-program"
	// KindNotSetUp: the folder has no tracker in it, or the one it has holds
	// no issues yet.
	KindNotSetUp Kind = "not-set-up"
	// KindNotSignedIn: there is no login for the hosted tracker.
	KindNotSignedIn Kind = "not-signed-in"
	// KindUsage: the request itself was wrong: a missing argument, an
	// unknown option.
	KindUsage Kind = "usage"
	// KindUnsupported: this repository's tracker has no way to do what was
	// asked.
	KindUnsupported Kind = "unsupported"
)

// Error is a failure with its kind and its reason in plain words.
type Error struct {
	Kind    Kind
	Message string
	// Later says that the same request may work if it is made again later:
	// the network was down, the service was having trouble, a limit was
	// reached, a login had run out. False for a failure of the request
	// itself, which trying again does not cure. A caller that keeps changes
	// to send (the local copy of a hosted tracker) keeps them for one and
	// gives up on the other.
	Later bool
}

func (failure *Error) Error() string { return failure.Message }

// ExitStatus is the exit status the command gives for this kind of failure.
func (kind Kind) ExitStatus() int {
	switch kind {
	case KindUsage:
		return 2
	case KindUnsupported:
		return 3
	default:
		return 1
	}
}

// Refused makes a plain refusal; the message says why.
func Refused(format string, args ...any) *Error {
	return &Error{Kind: KindRefused, Message: fmt.Sprintf(format, args...)}
}

// Usage makes a wrong-request failure.
func Usage(format string, args ...any) *Error {
	return &Error{Kind: KindUsage, Message: fmt.Sprintf(format, args...)}
}

// Unsupported makes a "the tracker cannot do this" failure.
func Unsupported(format string, args ...any) *Error {
	return &Error{Kind: KindUnsupported, Message: fmt.Sprintf(format, args...)}
}

// Failed makes a failure of any kind.
func Failed(kind Kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// MayWorkLater says whether an error is one that trying again later may
// cure; see Error.Later.
func MayWorkLater(err error) bool {
	var failure *Error
	return errors.As(err, &failure) && failure.Later
}

// KindOf gives the kind of any error: its own when it is an *Error, and a
// plain refusal otherwise (something unexpected went wrong; its text is the
// reason).
func KindOf(err error) Kind {
	var failure *Error
	if errors.As(err, &failure) {
		return failure.Kind
	}
	return KindRefused
}

// Ptr gives a pointer to a value, for the optional fields above.
func Ptr[Value any](value Value) *Value { return &value }
