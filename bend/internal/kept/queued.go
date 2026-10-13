// queued.go — the queued way of writing, for a tracker reached over the
// network.
//
// What: records a change in a queue on disk and shows it at once; sends
// the queue to the tracker afterwards, in order (Sync), and brings in what
// changed there; keeps the changes the tracker refused for good.
//
// Why: asked for every command, a hosted tracker takes most of a second
// each time and counts the requests. The owner: "bend command should write
// local copy and sync asynchronously" (bead-bb-c9l.5). It was first built
// inside the GitHub adapter; it is here, above the adapters and in bend's
// common terms, so that it is written once for every such tracker
// (bead-bb-c9l.15, the owner: "it replaces GH copy").
//
// Design notes:
//   - A waiting change is what was asked of the tracker ("write the plan of
//     issue 12", "add this label", "comment"), not the tracker's own
//     fields. Sending it is calling that same operation on the adapter,
//     which asks the tracker directly. So whatever the adapter does to make
//     a change safe against the other side's (GitHub: rereading the
//     description and replacing one part; applying a label to the labels
//     held now) holds for a change sent late as well.
//   - The copy holds each issue as the tracker gave it. A read is those
//     issues with the waiting changes laid on their own facts, and then put
//     together (derive.go). So bringing in what changed can never overwrite
//     a change that still waits, and a refused change simply stops being
//     laid on.
//   - Two things do not wait, the owner's decisions: making an issue goes
//     to the tracker at once, because only it gives the id; and a change to
//     a guarded label (the workflow's step and size) asks the tracker
//     first and is refused when the issue was moved meanwhile.
//   - A change that cannot be sent is one of two kinds
//     (tracker.Error.Later). "Not now" stays in the queue and stops the
//     sending, so that order is kept. "Never" is moved to a list of refused
//     changes with the tracker's reason, and the sending goes on.
//   - The copy refuses at once only what it can see itself: an issue that
//     is not there, a loop of sub-issues, a link of an issue to itself, a
//     closed issue started. The adapter's own rules are applied when the
//     change is sent; what they refuse shows on the refused list.
//
// Gotchas:
//   - A change can reach the tracker twice if bend is stopped between
//     sending it and taking it off the queue, or if the tracker got the
//     request and its answer was lost. Known, and documented.
//   - What changed is asked "since the latest change the tracker itself
//     reported", not by this machine's clock, which may run ahead of it.
//   - "Changed since" does not report an issue that was deleted, hence the
//     full reread once a day.

package kept

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

const (
	// fullEvery is how often everything is reread, to drop what was deleted.
	fullEvery = 24 * time.Hour
	// overlap is how far before the latest change seen "changed since"
	// asks, so that a change made while a sync ran is not missed.
	overlap = 2 * time.Minute
	// format numbers the way a queued copy's files are written. A copy with
	// another number was made by another version and is put aside.
	format = 2
)

// GuardedPrefixes are the labels whose change asks the tracker first: the
// workflow's step and an issue's size. Two sides moving an issue from
// copies a few minutes old must not silently replace each other.
var GuardedPrefixes = []string{"step:", "size:"}

// The files of a queued copy, beside the ones every copy has.
const (
	queueFile   = "changes.json"
	refusedFile = "refused.json"
	syncLogFile = "sync.log"
)

// The kinds of change the queue holds. A kind added here is one an older
// bend does not know: it refuses such a change when it sends the queue.
const (
	opEdit    = "edit"
	opWrite   = "write"
	opComment = "comment"
	opNote    = "note"
	opStart   = "start"
	opStop    = "stop"
	opClose   = "close"
	opReopen  = "reopen"
	opMove    = "move"
	opLink    = "link"
	opUnlink  = "unlink"
)

// change is one change made here and not yet on the tracker: what was
// asked, as it was asked.
type change struct {
	// Seq numbers the changes of a copy in the order they were made.
	Seq int
	// At is when it was made; Actor who was acting, "" for nobody named.
	At    string
	Actor string `json:",omitempty"`
	Kind  string
	// ID is the issue changed.
	ID string
	// For an edit.
	Title         *string                  `json:",omitempty"`
	Type          *string                  `json:",omitempty"`
	Priority      *int                     `json:",omitempty"`
	Category      *string                  `json:",omitempty"`
	ClearCategory bool                     `json:",omitempty"`
	Assignee      *string                  `json:",omitempty"`
	ClearAssignee bool                     `json:",omitempty"`
	AddLabels     []string                 `json:",omitempty"`
	RemoveLabels  []string                 `json:",omitempty"`
	Metadata      []tracker.MetadataChange `json:",omitempty"`
	// For a written part: which, and its text. For a comment: its text.
	Part string `json:",omitempty"`
	Text string `json:",omitempty"`
	// For closing: why.
	Reason string `json:",omitempty"`
	// For a move: the new parent; nil for the top level.
	Parent *string `json:",omitempty"`
	// For a link and an unlink: the other issue, the kind, and for an
	// unlink whether only the link recorded on ID goes.
	Other    string `json:",omitempty"`
	LinkKind string `json:",omitempty"`
	OnlyFrom bool   `json:",omitempty"`
}

// queued is the queue's file.
type queued struct {
	// Next is the Seq the next change gets.
	Next    int
	Changes []change
}

// refusedEntry is a refused change as kept in the file.
type refusedEntry struct {
	At     string
	Reason string
	Change change
}

// RefusedChange is a change the tracker refused for good.
type RefusedChange struct {
	// Seq is the change's number, by which it is dismissed or sent again.
	Seq int `json:"seq"`
	// At is when the tracker refused it.
	At string `json:"at"`
	// Issue is the issue it was a change to.
	Issue string `json:"issue"`
	// What says what the change was, in a few words; Text is the text it
	// carried, where it carried one, so that nothing written is lost.
	What string `json:"what"`
	Text string `json:"text"`
	// Reason is what the tracker said.
	Reason string `json:"reason"`
}

// SyncResult is what a sync did.
type SyncResult struct {
	// Busy says that another process was syncing, so this one did nothing.
	Busy bool `json:"busy"`
	// Sent is how many waiting changes reached the tracker; Refused how
	// many it refused for good; Waiting how many still wait.
	Sent    int `json:"sent"`
	Refused int `json:"refused"`
	Waiting int `json:"waiting"`
	// BroughtIn is how many issues were read from the tracker; Full says
	// that everything was reread.
	BroughtIn int  `json:"broughtIn"`
	Full      bool `json:"full"`
	// SentIssues and BroughtInIssues name the issues: those whose changes
	// reached the tracker, and those that came from it new or changed (not
	// every issue read: BroughtIn counts those), each once, in the order
	// met. For a caller that keeps a log of syncs (the Airbender tab);
	// never nil.
	SentIssues      []string `json:"sentIssues"`
	BroughtInIssues []string `json:"broughtInIssues"`
	// Problem is why changes still wait, or why nothing could be brought
	// in; "" when all went well.
	Problem string `json:"problem"`
}

// isQueued says whether the tracker's changes are queued.
func (kept *Tracker) isQueued() bool {
	return kept.inner.About().Writes == tracker.WritesQueued
}

// seconds gives a moment to the second, as the queue and the log write it.
func seconds(at time.Time) string { return at.UTC().Format(time.RFC3339) }

// moment reads a moment the tracker or the copy wrote; the zero time for
// one that cannot be read.
func moment(text string) time.Time {
	at, ok := tracker.ParseMoment(text)
	if !ok {
		return time.Time{}
	}
	return at
}

// --- What a waiting change does to an issue's own facts.

// withLabels gives a set of labels with some added and some taken off; one
// already there, or already gone, changes nothing.
func withLabels(labels, add, remove []string) []string {
	result := []string{}
	for _, label := range labels {
		if !slices.Contains(remove, label) {
			result = append(result, label)
		}
	}
	for _, label := range add {
		if !slices.Contains(result, label) {
			result = append(result, label)
		}
	}
	return result
}

// twoWay says whether a kind of link reads the same from both ends, and is
// recorded on both.
func twoWay(kind string) bool { return kind == "related" }

// lay puts one waiting change on the issues' own facts. Issues are found by
// id in the list given, which is changed in place.
//
// touch says whether to mark the issue as changed at the change's time: so
// for a change that waits, not for one that has been sent (what the tracker
// gives next must then replace it).
func lay(issues []tracker.Issue, one change, touch bool) {
	find := func(id string) *tracker.Issue {
		for index := range issues {
			if issues[index].ID == id {
				return &issues[index]
			}
		}
		return nil
	}
	issue := find(one.ID)
	if issue == nil {
		return
	}
	if touch {
		issue.UpdatedAt = &one.At
	}
	// dropLinks takes off an issue the links to another that match.
	dropLinks := func(from *tracker.Issue, to, kind, direction string) {
		if from == nil {
			return
		}
		from.Links = slices.DeleteFunc(from.Links, func(had tracker.Link) bool {
			return had.ID == to && (kind == "" || had.Kind == kind) && (direction == "" || had.Direction == direction)
		})
	}
	switch one.Kind {
	case opEdit:
		if one.Title != nil {
			issue.Title = *one.Title
		}
		if one.Type != nil {
			issue.Type = one.Type
		}
		if one.Priority != nil {
			issue.Priority = one.Priority
		}
		switch {
		case one.ClearCategory:
			issue.Category = nil
		case one.Category != nil:
			if name, err := tracker.CleanCategory(*one.Category); err == nil {
				issue.Category = &name
			}
		}
		switch {
		case one.ClearAssignee:
			issue.Assignee = nil
		case one.Assignee != nil:
			issue.Assignee = one.Assignee
		}
		issue.Labels = withLabels(issue.Labels, one.AddLabels, one.RemoveLabels)
		if len(one.Metadata) > 0 {
			// The kept data is one JSON object; a key is set to a text or
			// taken out, and the object written anew (never changed in
			// place: the issue given may share it with the copy).
			data := map[string]json.RawMessage{}
			json.Unmarshal(issue.Metadata, &data)
			for _, kept := range one.Metadata {
				if kept.Value == nil {
					delete(data, kept.Key)
				} else if text, err := json.Marshal(*kept.Value); err == nil {
					data[kept.Key] = text
				}
			}
			if written, err := json.Marshal(data); err == nil {
				issue.Metadata = written
			}
		}
	case opWrite:
		text := strings.TrimSpace(one.Text)
		switch one.Part {
		case "description":
			issue.Description = text
		case "requirements":
			issue.Requirements = text
		case "done":
			issue.Done = text
		case "plan":
			issue.Plan = text
		case "notes":
			issue.Notes = text
		}
	case opComment:
		issue.CommentCount++
	case opNote:
		issue.Notes = withNote(issue.Notes, one.Text)
	case opStart:
		// Whom it is assigned to is the tracker's to say (GitHub assigns the
		// signed-in account, whoever is named as acting), so the assignee
		// is left as it is until the tracker gives it.
		issue.Status = "in_progress"
	case opStop:
		// Only one in progress: a closed issue stays closed.
		if issue.Status == "in_progress" {
			issue.Status = "open"
		}
	case opClose:
		issue.Status, issue.CloseReason = closedStatus, strings.TrimSpace(one.Reason)
	case opReopen:
		// One that is not closed is left alone, as the adapters leave it:
		// an issue in progress stays in progress.
		if issue.Status == closedStatus {
			issue.Status, issue.CloseReason = "open", ""
		}
	case opMove:
		issue.ParentID = one.Parent
	case opLink:
		other := find(one.Other)
		if other == nil {
			return
		}
		issue.Links = append(issue.Links, tracker.Link{ID: other.ID, Title: other.Title, Status: other.Status, Kind: one.LinkKind, Direction: "out"})
		// A link the tracker keeps as text is written on both issues; one
		// that makes an issue wait is the waiting issue's alone, and is
		// seen from the other end when read.
		if one.LinkKind != blockedBy {
			direction := "in"
			if twoWay(one.LinkKind) {
				direction = "out"
			}
			other.Links = append(other.Links, tracker.Link{ID: issue.ID, Title: issue.Title, Status: issue.Status, Kind: one.LinkKind, Direction: direction})
			if touch {
				other.UpdatedAt = &one.At
			}
		}
	case opUnlink:
		other := find(one.Other)
		// The link recorded on the issue, and its other half where the
		// tracker keeps one on the other issue.
		dropLinks(issue, one.Other, one.LinkKind, "out")
		for _, kind := range []string{"discovered-from", "related"} {
			if one.LinkKind != "" && one.LinkKind != kind {
				continue
			}
			switch {
			case !one.OnlyFrom:
				dropLinks(other, one.ID, kind, "")
				dropLinks(issue, one.Other, kind, "")
			case twoWay(kind):
				dropLinks(other, one.ID, kind, "")
			default:
				// Only the first issue's own link was asked for: its other
				// half is the line that points back at it. A link the other
				// issue made to this one stays, on both.
				dropLinks(other, one.ID, kind, "in")
			}
		}
		// Whichever way round, unless only the first issue's was asked for.
		if !one.OnlyFrom && (one.LinkKind == "" || one.LinkKind == blockedBy) {
			dropLinks(other, one.ID, blockedBy, "out")
		}
		if touch && other != nil {
			other.UpdatedAt = &one.At
		}
	}
}

// describe says what a change was, in a few words, and gives the text it
// carried, where it carried one.
func describe(one change) (what, text string) {
	switch one.Kind {
	case opComment:
		return "a comment", one.Text
	case opNote:
		return "adding to its notes", one.Text
	case opWrite:
		return "writing its " + one.Part, one.Text
	case opStart:
		return "starting it", ""
	case opStop:
		return "putting it back to open", ""
	case opClose:
		return "closing it", one.Reason
	case opReopen:
		return "reopening it", ""
	case opMove:
		if one.Parent == nil {
			return "moving it to the top level", ""
		}
		return "moving it under issue " + *one.Parent, ""
	case opLink:
		return "linking it to issue " + one.Other + " (" + one.LinkKind + ")", ""
	case opUnlink:
		return "removing its link to issue " + one.Other, ""
	}
	parts := []string{}
	if one.Title != nil {
		parts = append(parts, "the title")
		text = *one.Title
	}
	if one.Type != nil {
		parts = append(parts, "the type")
	}
	if one.Priority != nil {
		parts = append(parts, "the priority")
	}
	if one.Category != nil || one.ClearCategory {
		parts = append(parts, "the category")
	}
	if one.Assignee != nil || one.ClearAssignee {
		parts = append(parts, "the assignee")
	}
	if len(one.AddLabels)+len(one.RemoveLabels) > 0 {
		parts = append(parts, "labels")
	}
	if len(one.Metadata) > 0 {
		parts = append(parts, "kept data")
	}
	return "a change of " + strings.Join(parts, ", "), text
}

// withNote gives an issue's notes with a paragraph added at the end.
func withNote(notes, text string) string {
	notes, text = strings.TrimSpace(notes), strings.TrimSpace(text)
	if notes == "" {
		return text
	}
	return notes + "\n\n" + text
}

// Note adds a paragraph to an issue's notes and keeps what is there.
//
// For a queued tracker it waits as a change of its own, "add this to the
// notes", and is added to whatever the tracker holds when it is sent. It was
// first queued as the whole notes written anew, which silently dropped a
// note made elsewhere before the sync (bead-bb-c9l.10, found in review).
// Written straight through, the notes are read and written back at once.
func (kept *Tracker) Note(id, text string) error {
	if strings.TrimSpace(text) == "" {
		return tracker.Usage("The text is empty.")
	}
	id = kept.canon(id)
	issue, err := kept.known(id)
	if err != nil {
		return err
	}
	if !kept.isQueued() {
		return kept.changed(kept.inner.Write(id, "notes", withNote(issue.Notes, text)))
	}
	return kept.record(change{Kind: opNote, ID: id, Text: text})
}

// --- Reading.

// readQueue gives the changes that wait, from the file.
func (kept *Tracker) readQueue() ([]change, error) {
	var queue queued
	if _, err := kept.store.Read(queueFile, &queue); err != nil {
		return nil, unreadable(queueFile)
	}
	return queue.Changes, nil
}

// seen gives the issues as they are to be read: what the copy holds, with
// the waiting changes laid on, put together.
func (kept *Tracker) seen(held []tracker.Issue, waiting []change) []tracker.Issue {
	laid := make([]tracker.Issue, len(held))
	for index, issue := range held {
		issue.Labels = slices.Clone(issue.Labels)
		issue.Links = ownLinks(issue)
		laid[index] = issue
	}
	for _, one := range waiting {
		lay(laid, one, true)
	}
	return derive(laid)
}

// keep puts issues as the tracker gives them into the copy's file, and has
// the copy read anew by whatever reads next in this process.
func (kept *Tracker) keep(issues ...tracker.Issue) error {
	kept.loaded = false
	return kept.store.Changing(func() error {
		var held []tracker.Issue
		if _, err := kept.store.Read(issuesFile, &held); err != nil {
			return unreadable(issuesFile)
		}
		for _, issue := range issues {
			at := slices.IndexFunc(held, func(had tracker.Issue) bool { return had.ID == issue.ID })
			if at == -1 {
				held = append(held, issue)
			} else {
				held[at] = issue
			}
		}
		_, err := kept.store.WriteIfChanged(issuesFile, held)
		return err
	})
}

// searchCopy gives the issues whose id, title or written parts hold every
// word of the text, newest first; at most fifty. For a queued tracker the
// copy is searched: it needs no network, and finds an issue made a moment
// ago, which a hosted tracker's own search may not yet.
func (kept *Tracker) searchCopy(text string) []tracker.Issue {
	words := strings.Fields(strings.ToLower(text))
	found := []tracker.Issue{}
	for at := len(kept.issues) - 1; at >= 0 && len(found) < 50; at-- {
		issue := kept.issues[at]
		searched := strings.ToLower(strings.Join([]string{
			"#" + issue.ID, issue.Title, issue.Description, issue.Requirements, issue.Done, issue.Plan, issue.Notes,
		}, "\n"))
		every := len(words) > 0
		for _, word := range words {
			every = every && strings.Contains(searched, word)
		}
		if every {
			found = append(found, issue)
		}
	}
	return found
}

// readyFromCopy gives the issues that can be worked on now, by the rule a
// hosted tracker has no judgement of its own to replace: open, not in
// progress, and waiting for nothing.
func (kept *Tracker) readyFromCopy() []tracker.Issue {
	ready := []tracker.Issue{}
	for _, issue := range kept.issues {
		if issue.Status == "open" && len(issue.BlockedBy) == 0 {
			ready = append(ready, issue)
		}
	}
	return ready
}

// --- Recording.

// record adds a change to the queue, on disk before the command reports it
// done, so that a change is never only in memory.
func (kept *Tracker) record(one change) error {
	one.At, one.Actor = seconds(kept.now()), kept.actor
	err := kept.store.Changing(func() error {
		var queue queued
		if _, err := kept.store.Read(queueFile, &queue); err != nil {
			return unreadable(queueFile)
		}
		if queue.Next == 0 {
			queue.Next = 1
		}
		one.Seq = queue.Next
		queue.Next++
		queue.Changes = append(queue.Changes, one)
		return kept.store.Write(queueFile, queue)
	})
	kept.loaded, kept.wantsReread, kept.changedHere = false, true, true
	return err
}

// known gives the issue with an id as it is to be read. One the copy does
// not hold is asked of the tracker once: it may have been made elsewhere a
// moment ago.
func (kept *Tracker) known(id string) (tracker.Issue, error) {
	if err := kept.load(); err != nil {
		return tracker.Issue{}, err
	}
	for _, issue := range kept.issues {
		if issue.ID == id {
			return issue, nil
		}
	}
	if !kept.isQueued() {
		return tracker.Issue{}, tracker.Refused("There is no issue with id %s.", id)
	}
	live, err := kept.inner.Show(id)
	if err != nil {
		return tracker.Issue{}, err
	}
	if err := kept.keep(live); err != nil {
		return tracker.Issue{}, err
	}
	if err := kept.load(); err != nil {
		return tracker.Issue{}, err
	}
	for _, issue := range kept.issues {
		if issue.ID == id {
			return issue, nil
		}
	}
	return live, nil
}

// guarded gives the labels of a set whose change asks the tracker first.
func guarded(labels []string) []string {
	found := []string{}
	for _, label := range labels {
		for _, prefix := range GuardedPrefixes {
			if strings.HasPrefix(label, prefix) {
				found = append(found, label)
			}
		}
	}
	sort.Strings(found)
	return found
}

// editQueued records an edit. The part of it that changes a guarded label
// does not wait: the tracker is asked first.
func (kept *Tracker) editQueued(id string, changes tracker.Changes) error {
	issue, err := kept.known(id)
	if err != nil {
		return err
	}
	one := change{
		Kind: opEdit, ID: id, Title: changes.Title, Type: changes.Type, Priority: changes.Priority,
		Category: changes.Category, ClearCategory: changes.ClearCategory,
		Assignee: changes.Assignee, ClearAssignee: changes.ClearAssignee, Metadata: changes.Metadata,
	}
	// Only what would change something: a label already there, or already
	// gone, is left alone, as the adapters do.
	for _, label := range changes.AddLabels {
		if strings.TrimSpace(label) == "" || strings.Contains(label, ",") {
			return tracker.Refused("\"%s\" cannot be used as a label.", label)
		}
		if !slices.Contains(issue.Labels, label) {
			one.AddLabels = append(one.AddLabels, label)
		}
	}
	for _, label := range changes.RemoveLabels {
		if slices.Contains(issue.Labels, label) {
			one.RemoveLabels = append(one.RemoveLabels, label)
		}
	}
	if changes.Category != nil {
		if _, err := tracker.CleanCategory(*changes.Category); err != nil {
			return err
		}
	}
	if len(guarded(one.AddLabels))+len(guarded(one.RemoveLabels)) > 0 {
		// Only the guarded labels go straight to the tracker. Every other
		// label, and whatever else the change carries, takes its place in
		// the queue, behind what already waits: sent ahead of that, an older
		// waiting value would later replace it.
		plain := func(labels []string) []string {
			return slices.DeleteFunc(slices.Clone(labels), func(label string) bool { return len(guarded([]string{label})) > 0 })
		}
		if err := kept.editAsking(issue, guarded(one.AddLabels), guarded(one.RemoveLabels)); err != nil {
			return err
		}
		one.AddLabels, one.RemoveLabels = plain(one.AddLabels), plain(one.RemoveLabels)
	}
	// Nothing would change: nothing waits to be sent.
	if one.Title == nil && one.Type == nil && one.Priority == nil && one.Category == nil && !one.ClearCategory &&
		one.Assignee == nil && !one.ClearAssignee && len(one.AddLabels)+len(one.RemoveLabels)+len(one.Metadata) == 0 {
		return nil
	}
	return kept.record(one)
}

// editAsking changes labels of which some are guarded: it reads the issue
// from the tracker, refuses when its guarded labels are not what the copy
// shows, and otherwise makes the change on the tracker at once.
//
// Side effects: asks the tracker two or three times; the copy takes the
// tracker's version of the issue either way.
func (kept *Tracker) editAsking(shown tracker.Issue, add, remove []string) error {
	live, err := kept.inner.Show(shown.ID)
	if err != nil {
		return err
	}
	if now, thought := guarded(live.Labels), guarded(shown.Labels); !slices.Equal(now, thought) {
		// The copy takes what the tracker holds, so the next look is right.
		if err := kept.keep(live); err != nil {
			return err
		}
		is := "none of them"
		if len(now) > 0 {
			is = strings.Join(now, ", ")
		}
		return tracker.Refused("Issue %s was changed on the tracker since this copy was read: of the labels %s it now has %s. Nothing was changed; look at the issue again.",
			shown.ID, strings.Join(GuardedPrefixes, " and "), is)
	}
	if err := kept.inner.Edit(shown.ID, tracker.Changes{AddLabels: add, RemoveLabels: remove}); err != nil {
		return err
	}
	kept.wantsReread = true
	after, err := kept.inner.Show(shown.ID)
	if err != nil {
		// Not reread: the change is on the tracker, and is laid on its
		// earlier version here until the next sync brings the real one.
		live.Labels = withLabels(live.Labels, add, remove)
		after = live
	}
	return kept.keep(after)
}

// createQueued makes an issue on the tracker and waits for it, because only
// the tracker gives the id; then puts it into the copy.
func (kept *Tracker) createQueued(draft tracker.Draft) (string, error) {
	if err := kept.load(); err != nil {
		return "", err
	}
	id, err := kept.inner.Create(draft)
	if err != nil {
		return "", err
	}
	kept.wantsReread = true
	touched := []string{id}
	if draft.ParentID != nil {
		touched = append(touched, *draft.ParentID)
	}
	if draft.From != nil {
		touched = append(touched, *draft.From)
	}
	fresh := []tracker.Issue{}
	for _, one := range touched {
		// The new issue, and those it was linked with as it was made, as
		// the tracker holds them now. If that cannot be asked, the next
		// sync brings them.
		if live, err := kept.inner.Show(one); err == nil {
			fresh = append(fresh, live)
		}
	}
	return id, kept.keep(fresh...)
}

// moveQueued records a move, refusing a loop of sub-issues at once.
func (kept *Tracker) moveQueued(id string, parentID *string) error {
	if _, err := kept.known(id); err != nil {
		return err
	}
	if parentID != nil {
		if _, err := kept.known(*parentID); err != nil {
			return err
		}
		byID := map[string]tracker.Issue{}
		for _, issue := range kept.issues {
			byID[issue.ID] = issue
		}
		for at, steps := *parentID, 0; steps <= len(byID); steps++ {
			if at == id {
				return tracker.Refused("An issue cannot be moved inside itself or inside one of its own sub-issues.")
			}
			up := byID[at].ParentID
			if up == nil {
				break
			}
			at = *up
		}
	}
	return kept.record(change{Kind: opMove, ID: id, Parent: parentID})
}

// --- Sending and bringing in.

// send makes one change on the tracker, as whoever was acting when it was
// made.
func (kept *Tracker) send(one change) error {
	inner := kept.inner
	if as, ok := inner.(interface {
		As(actor string) tracker.Tracker
	}); ok {
		inner = as.As(one.Actor)
	}
	switch one.Kind {
	case opEdit:
		return inner.Edit(one.ID, tracker.Changes{
			Title: one.Title, Type: one.Type, Priority: one.Priority,
			Category: one.Category, ClearCategory: one.ClearCategory,
			Assignee: one.Assignee, ClearAssignee: one.ClearAssignee,
			AddLabels: one.AddLabels, RemoveLabels: one.RemoveLabels, Metadata: one.Metadata,
		})
	case opWrite:
		return inner.Write(one.ID, one.Part, one.Text)
	case opComment:
		return inner.Comment(one.ID, one.Text)
	case opNote:
		// Added to the notes the tracker holds now, not to those the copy
		// held when the note was made: a note written elsewhere meanwhile
		// is kept. One already at the end is not added again, so that a
		// change sent twice leaves one paragraph.
		live, err := inner.Show(one.ID)
		if err != nil {
			return err
		}
		if strings.HasSuffix(strings.TrimSpace(live.Notes), strings.TrimSpace(one.Text)) {
			return nil
		}
		return inner.Write(one.ID, "notes", withNote(live.Notes, one.Text))
	case opStart:
		return inner.Start(one.ID)
	case opStop:
		return inner.Stop(one.ID)
	case opClose:
		return inner.Close(one.ID, one.Reason)
	case opReopen:
		return inner.Reopen(one.ID)
	case opMove:
		return inner.Move(one.ID, one.Parent)
	case opLink:
		return inner.Link(one.ID, one.Other, one.LinkKind)
	case opUnlink:
		return inner.Unlink(one.ID, one.Other, tracker.UnlinkOptions{OnlyFrom: one.OnlyFrom, Kind: one.LinkKind})
	}
	return tracker.Refused("This change is of a kind this version of bend does not know (%s).", one.Kind)
}

// Sync sends the waiting changes to the tracker, in the order they were
// made, and brings in what changed there. For a tracker whose changes are
// written straight through it rereads the copy.
//
// full rereads everything, which also drops issues that are gone; it
// happens by itself once a day and the first time.
// Returns what was done. An error means the tracker could not be asked for
// what changed; changes that could not be sent are not an error, they
// wait.
// Side effects: asks the tracker; the copy's files; a line in its log.
func (kept *Tracker) Sync(full bool) (SyncResult, error) {
	if !kept.isQueued() {
		if err := kept.Reread(); err != nil {
			return SyncResult{}, err
		}
		return SyncResult{BroughtIn: len(kept.issues), Full: true, SentIssues: []string{}, BroughtInIssues: []string{}}, nil
	}
	result, err := kept.syncOnce(full)
	// A change recorded while the sync ran found the lock held, so nothing
	// else will send it: this sync goes round again for it. A few times at
	// most; what comes after that waits for the next sync.
	for round := 0; round < 3 && err == nil && !result.Busy && result.Waiting > 0 && result.Problem == ""; round++ {
		var more SyncResult
		more, err = kept.syncOnce(false)
		result.Sent += more.Sent
		result.Refused += more.Refused
		result.Waiting, result.Problem = more.Waiting, more.Problem
		result.BroughtIn += more.BroughtIn
		result.SentIssues = withIDs(result.SentIssues, more.SentIssues...)
		result.BroughtInIssues = withIDs(result.BroughtInIssues, more.BroughtInIssues...)
	}
	kept.loaded, kept.wantsReread = false, false
	return result, err
}

// withIDs adds ids to a list, each once, in the order met.
func withIDs(list []string, ids ...string) []string {
	for _, id := range ids {
		if !slices.Contains(list, id) {
			list = append(list, id)
		}
	}
	return list
}

// WaitAndSync is Sync for a caller that wants its result: where another
// process is syncing, it waits for that one to finish and then syncs.
func (kept *Tracker) WaitAndSync(full bool) (SyncResult, error) {
	for attempt := 0; ; attempt++ {
		result, err := kept.Sync(full)
		switch {
		case err != nil || !result.Busy:
			return result, err
		case attempt > 120:
			return result, tracker.Refused("Another sync of this repository's issues has been running for over a minute. Try again in a moment; if it never ends, look at the log in %s.", kept.store.Dir)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// putAside moves the files of a copy this version cannot read out of the
// way, and says so. Waiting changes in them are not sent: the code that
// knew them is gone. They are kept, under another name, and counted in the
// warning.
func (kept *Tracker) putAside() {
	var old struct{ Changes []any }
	kept.store.Read("queue.json", &old)
	moved := []string{}
	for _, name := range []string{issuesFile, stateFile, queueFile, refusedFile, "queue.json"} {
		if aside := kept.store.SetAside(name); aside != "" {
			moved = append(moved, aside)
		}
	}
	if len(moved) == 0 {
		return
	}
	words := "The local copy of the issues in " + kept.store.Dir + " was made by another version of bend and is made anew."
	if len(old.Changes) > 0 {
		words += " " + strconv.Itoa(len(old.Changes)) + " changes were waiting in it and were NOT sent; they are kept in queue.json.unreadable there."
	}
	kept.warn(words)
}

// syncOnce is one round of Sync: send what waits, then bring in.
func (kept *Tracker) syncOnce(full bool) (SyncResult, error) {
	result := SyncResult{SentIssues: []string{}, BroughtInIssues: []string{}}
	done, free, err := kept.store.Syncing()
	if err != nil {
		return result, tracker.Refused("The local copy of the issues cannot be written (%s).", kept.store.Dir)
	}
	if !free {
		result.Busy = true
		return result, nil
	}
	defer done()
	var held state
	if there, err := kept.store.Read(stateFile, &held); err != nil || (there && held.Format != format) {
		kept.putAside()
		held, full = state{}, true
	}
	// damaged is set when the file of issues turns out unreadable while
	// sending.
	damaged := false
	// --- Send, oldest first. A "not now" stops the sending, to keep the
	// order; a "never" is put aside and the sending goes on.
	for {
		waiting, err := kept.readQueue()
		if err != nil {
			kept.putAside()
			held, full = state{}, true
			break
		}
		if len(waiting) == 0 {
			break
		}
		one := waiting[0]
		sendErr := kept.send(one)
		if sendErr != nil && tracker.MayWorkLater(sendErr) {
			result.Problem = sendErr.Error()
			break
		}
		if err := kept.store.Changing(func() error {
			var now queued
			if _, err := kept.store.Read(queueFile, &now); err != nil {
				return unreadable(queueFile)
			}
			now.Changes = slices.DeleteFunc(now.Changes, func(had change) bool { return had.Seq == one.Seq })
			if sendErr == nil {
				// The tracker has it now, so what the copy holds gets it in
				// the same moment it leaves the queue: there is no while in
				// which the change shows in neither. The issue's "last
				// changed" is left as the tracker gave it, so that what the
				// tracker gives next replaces this.
				if one.Kind == opComment {
					// The comments kept for the issue lack the new one.
					kept.store.Remove(commentsName(one.ID))
				}
				var issues []tracker.Issue
				if _, err := kept.store.Read(issuesFile, &issues); err != nil {
					// The file of issues is damaged. The change is on the
					// tracker all the same and must leave the queue, or it
					// would be sent again at every sync; the file is put
					// aside and everything reread below.
					kept.store.SetAside(issuesFile)
					damaged = true
				} else {
					for index := range issues {
						issues[index].Links = ownLinks(issues[index])
					}
					lay(issues, one, false)
					if err := kept.store.Write(issuesFile, issues); err != nil {
						return err
					}
				}
			} else {
				var refused []refusedEntry
				kept.store.Read(refusedFile, &refused)
				refused = append(refused, refusedEntry{At: seconds(kept.now()), Reason: sendErr.Error(), Change: one})
				if err := kept.store.Write(refusedFile, refused); err != nil {
					return err
				}
			}
			return kept.store.Write(queueFile, now)
		}); err != nil {
			return result, err
		}
		if sendErr != nil {
			result.Refused++
		} else {
			result.Sent++
			result.SentIssues = withIDs(result.SentIssues, one.ID)
		}
	}
	// --- Bring in. The moment is taken before asking.
	started := kept.now()
	if damaged {
		held, full = state{}, true
	}
	if at := moment(held.FullAt); at.IsZero() || started.Sub(at) > fullEvery {
		full = true
	}
	filter := tracker.ListFilter{Status: tracker.Ptr("all")}
	if !full {
		if at := moment(held.Cursor); !at.IsZero() {
			filter.ChangedSince = tracker.Ptr(seconds(at.Add(-overlap)))
		} else {
			// Nothing was ever given: there is no moment to ask from.
			full = true
		}
	}
	issues, pullErr := kept.inner.List(filter)
	if pullErr == nil {
		pullErr = kept.store.Changing(func() error {
			// As the file is now: another process may have put an issue in
			// it (one just made, one whose step was just moved) while the
			// answer travelled.
			var had []tracker.Issue
			if _, err := kept.store.Read(issuesFile, &had); err != nil {
				had = nil
			}
			given := map[string]tracker.Issue{}
			for _, issue := range issues {
				given[issue.ID] = issue
				if issue.UpdatedAt != nil && moment(*issue.UpdatedAt).After(moment(held.Cursor)) {
					held.Cursor = *issue.UpdatedAt
				}
			}
			next := []tracker.Issue{}
			seen := map[string]bool{}
			newer := func(a, b tracker.Issue) bool {
				return a.UpdatedAt != nil && b.UpdatedAt != nil && moment(*a.UpdatedAt).After(moment(*b.UpdatedAt))
			}
			for _, old := range had {
				fresh, brought := given[old.ID]
				switch {
				case brought && !newer(old, fresh):
					// Never an older version over a newer one.
					next = append(next, fresh)
					// Named as brought in only when it differs: asking
					// "changed since" a little before the last sync gives
					// the same issues again, and a full reread gives all.
					if old.UpdatedAt == nil || fresh.UpdatedAt == nil || *old.UpdatedAt != *fresh.UpdatedAt {
						result.BroughtInIssues = withIDs(result.BroughtInIssues, fresh.ID)
					}
				case brought:
					next = append(next, old)
				case full && !(old.CreatedAt != nil && moment(*old.CreatedAt).After(started.Add(-overlap))):
					// A full reread drops what the tracker no longer gives,
					// except an issue made since the reread began, which
					// the answer could not hold yet.
					continue
				default:
					next = append(next, old)
				}
				seen[old.ID] = true
			}
			for _, issue := range issues {
				if !seen[issue.ID] {
					next = append(next, issue)
					result.BroughtInIssues = withIDs(result.BroughtInIssues, issue.ID)
				}
			}
			// In the tracker's own order of ids: a number by its value.
			sort.SliceStable(next, func(a, b int) bool {
				left, leftErr := strconv.Atoi(next[a].ID)
				right, rightErr := strconv.Atoi(next[b].ID)
				if leftErr == nil && rightErr == nil {
					return left < right
				}
				return false
			})
			if _, err := kept.store.WriteIfChanged(issuesFile, next); err != nil {
				return err
			}
			// What another process noted meanwhile is kept.
			var now state
			kept.store.Read(stateFile, &now)
			held.Changes, held.Format = now.Changes, format
			held.RereadAt = stamp(started)
			if full {
				held.FullAt = stamp(started)
			}
			return kept.store.Write(stateFile, held)
		})
		result.BroughtIn, result.Full = len(issues), full
	}
	if waiting, err := kept.readQueue(); err == nil {
		result.Waiting = len(waiting)
	}
	if pullErr != nil && result.Problem == "" {
		result.Problem = pullErr.Error()
	}
	kept.store.Append(syncLogFile, fmt.Sprintf("%s sent %d, refused %d, waiting %d, brought in %d (full: %t) %s",
		seconds(kept.now()), result.Sent, result.Refused, result.Waiting, result.BroughtIn, result.Full, result.Problem))
	return result, pullErr
}

// --- What waits, and what was refused.

// Unsent says how many changes to an issue made here are not yet on the
// tracker.
func (kept *Tracker) Unsent(id string) int {
	count := 0
	id = kept.canon(id)
	for _, one := range kept.waiting {
		// A link kept on both issues is a change to the other one as well.
		if one.ID == id || (one.Other == id && one.LinkKind != blockedBy) {
			count++
		}
	}
	return count
}

// RefusedChanges gives the changes the tracker refused for good, oldest
// first.
func (kept *Tracker) RefusedChanges() []RefusedChange {
	found := []RefusedChange{}
	// A list written by another version is not this one's to read: its
	// entries would show with no issue and no words. The next sync puts it
	// aside.
	var held state
	if there, err := kept.store.Read(stateFile, &held); err != nil || (there && held.Format != format) {
		return found
	}
	var refused []refusedEntry
	kept.store.Read(refusedFile, &refused)
	for _, entry := range refused {
		what, text := describe(entry.Change)
		found = append(found, RefusedChange{
			Seq: entry.Change.Seq, At: entry.At, Issue: entry.Change.ID,
			What: what, Text: text, Reason: entry.Reason,
		})
	}
	return found
}

// Dismiss takes a refused change off the list; again puts it back into the
// queue to be sent once more. seq 0 means all of them.
//
// Returns how many were taken off. Fails when seq names none.
func (kept *Tracker) Dismiss(seq int, again bool) (int, error) {
	taken := 0
	err := kept.store.Changing(func() error {
		var refused []refusedEntry
		kept.store.Read(refusedFile, &refused)
		var queue queued
		if _, err := kept.store.Read(queueFile, &queue); err != nil {
			return unreadable(queueFile)
		}
		if queue.Next == 0 {
			queue.Next = 1
		}
		left := []refusedEntry{}
		for _, entry := range refused {
			if seq != 0 && entry.Change.Seq != seq {
				left = append(left, entry)
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
			// The queue first: stopped between the two, the change is in
			// both and may be sent twice, which is better than in neither.
			if err := kept.store.Write(queueFile, queue); err != nil {
				return err
			}
		}
		return kept.store.Write(refusedFile, left)
	})
	if err == nil && taken == 0 && seq != 0 {
		err = tracker.Refused("There is no refused change with the number %d.", seq)
	}
	if again && taken > 0 {
		kept.loaded, kept.wantsReread = false, true
	}
	return taken, err
}
