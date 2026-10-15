// Package kept answers for a tracker from a copy of its issues kept on
// this machine.
//
// What: a tracker.Tracker that holds any adapter underneath. A read is
// answered from the copy, without starting the tracker's program or asking
// the network; a change is handed to the adapter, and the copy follows.
//
// Why: starting beads' program costs most of half a second for every read,
// and a sync holds its database so that reads wait behind it; a hosted
// tracker costs a request each time. One copy above the adapters, in bend's
// common issue shape, is written once for every tracker, and gives the
// agent in a terminal, the Airbender tab and the sync one and the same
// view (bead-bb-c9l.14; the owner: "we can move this cache inside of bend
// command").
//
// Design notes:
//   - The copy holds the full list exactly as the adapter gave it, links
//     from both ends and "what blocks what" included. Nothing is worked out
//     again here, so an answer from the copy is the adapter's own answer.
//   - An adapter says how its changes are written (tracker.About.Writes).
//     Straight through, the only way built so far, is for a tracker on this
//     machine: the change is made at once and its answer reported, then the
//     copy is marked as behind and reread by a process started after the
//     command. Queued, for a tracker reached over the network, is
//     bead-bb-c9l.15; until then such a tracker is not put under this
//     package (GitHub keeps the copy inside its adapter).
//   - How the copy knows it is behind, without asking the tracker: the
//     adapter's sign, where it has one (tracker.Signed; beads' is the file
//     it rewrites on every change), differs from the sign kept with the
//     copy. So a change made with the tracker's own program in a terminal
//     shows in the next read. What a sign does not cover, the copy's age
//     does: older than a few minutes it is reread behind the command, older
//     than a day before answering.
//   - "Ready" is the tracker's own judgement and is not worked out here: it
//     is asked once after each reread and kept with the copy. Search is the
//     tracker's own too, and always asks it.
//   - Comments are kept per issue from the first time they are asked for,
//     and asked for again when the issue has changed.
//
// Gotchas:
//   - Several bend processes share the files. Each file is read whole and
//     written whole under a short lock (localcopy); a reread may run in two
//     processes at once, and the later one simply writes last.
//   - The sign is read before the list it is kept with: a change made
//     between the two then leaves the copy looking behind, never fresh.
//   - A read can succeed with the tracker's program gone, while the copy is
//     fresh. A change cannot.

package kept

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/localcopy"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

const (
	// freshFor is how old the copy may be before a read asks for a reread
	// behind the command.
	freshFor = 3 * time.Minute
	// trustedFor is how old the copy may be and still answer a read without
	// being reread first.
	trustedFor = 24 * time.Hour
)

// The files of the copy.
const (
	issuesFile = "issues.json"
	stateFile  = "state.json"
	readyFile  = "ready.json"
	// IssuesFile is the file that changes whenever the copy does, for a
	// caller that watches for that.
	IssuesFile = issuesFile
)

// state is what the copy knows about itself.
type state struct {
	// RereadAt is when the copy was last reread from the tracker; "" for
	// never.
	RereadAt string
	// Sign is the tracker's sign as it was just before that reread; "" when
	// the tracker has none, or when the copy is known to be behind (a
	// change was just made through it).
	Sign string
	// Changes counts the changes made through the copy. A reread that finds
	// it moved since it began was overtaken by a change, and must not call
	// what it read fresh.
	Changes int
	// For a queued tracker: Format numbers the way the copy's files are
	// written; FullAt is when everything was last reread; Cursor is the
	// latest "last changed" the tracker has given for any issue, from which
	// "what changed since" is asked, by the tracker's own clock.
	Format int    `json:",omitempty"`
	FullAt string `json:",omitempty"`
	Cursor string `json:",omitempty"`
}

// keptReady is the ids the tracker called ready, with the reread they
// belong to.
type keptReady struct {
	For string
	IDs []string
}

// keptComments is an issue's comments as kept, with what the issue looked
// like then: a later change, or another count, means they may be out of
// date.
type keptComments struct {
	For      string
	Comments []tracker.Comment
}

// Tracker answers for an adapter from the copy. Make one with Open.
type Tracker struct {
	inner tracker.Tracker
	store localcopy.Store
	now   func() time.Time
	warn  func(text string)

	// actor is who is acting, kept with a change that waits so that it is
	// sent as theirs.
	actor string

	loaded bool
	// issues are the issues as they are to be read. For a queued tracker,
	// held is what the tracker gave and waiting the changes not yet sent.
	issues  []tracker.Issue
	held    []tracker.Issue
	waiting []change
	state   state
	// wantsReread says that a reread should follow this command.
	wantsReread bool
	// changedHere says a change was made through the copy in this command:
	// it is what the sync that follows is logged as set off by.
	changedHere bool
}

// Options adjust a copy; the zero value is the usual one.
type Options struct {
	// Now tells the time; time.Now when nil.
	Now func() time.Time
	// Warn is told what is worth knowing and is not a failure; nothing is
	// said when nil.
	Warn func(text string)
	// Actor is who is acting, "" for nobody named.
	Actor string
}

// Open gives the tracker that answers for inner from the copy in dir.
//
// Side effects: none until a method is called. The first read loads the
// copy, and rereads it through inner where there is none, where inner's
// sign says it is behind, or where it is more than a day old.
func Open(inner tracker.Tracker, dir string, options Options) *Tracker {
	made := &Tracker{inner: inner, store: localcopy.Store{Dir: dir}, now: options.Now, warn: options.Warn, actor: options.Actor}
	if made.now == nil {
		made.now = time.Now
	}
	if made.warn == nil {
		made.warn = func(string) {}
	}
	return made
}

// stamp gives a moment as the copy writes it.
func stamp(at time.Time) string { return at.UTC().Format(time.RFC3339Nano) }

// sign gives the adapter's sign as it is now; "" when it has none.
func (kept *Tracker) sign() string {
	if signed, ok := kept.inner.(tracker.Signed); ok {
		return signed.Sign()
	}
	return ""
}

// unreadable is the failure for a file of the copy that cannot be read.
// The copy is never the only place anything is: rereading cures it.
func unreadable(name string) error {
	return tracker.Refused("The local copy of the issues cannot be read (%s). Run `bend refresh` to make it anew.", name)
}

// Reread reads every issue from the tracker and replaces the copy with
// them.
//
// Side effects: one read of the tracker (for beads, one run of bd); the
// copy's files.
func (kept *Tracker) Reread() error {
	if kept.isQueued() {
		// For a queued tracker a reread is a sync: what waits is sent, and
		// what changed is brought in.
		_, err := kept.WaitAndSync(false)
		return err
	}
	// Before the list: a change made between the two leaves the copy
	// looking behind, which costs a reread; the other order would leave an
	// old list looking fresh.
	sign := kept.sign()
	at := kept.now()
	var began state
	kept.store.Read(stateFile, &began)
	issues, err := kept.inner.List(tracker.ListFilter{Status: tracker.Ptr("all")})
	if err != nil {
		return err
	}
	next := state{RereadAt: stamp(at), Sign: sign, Changes: began.Changes}
	if err := kept.store.Changing(func() error {
		// A change made through the copy while the list was being read: the
		// list may be from before it. It is kept, as the best there is, and
		// stays marked as behind, so the next read rereads.
		var now state
		kept.store.Read(stateFile, &now)
		if now.Changes != began.Changes {
			next.Sign, next.Changes = "behind", now.Changes
		}
		// Left as it is when nothing changed: whoever watches the file is
		// then told only of real changes.
		if _, err := kept.store.WriteIfChanged(issuesFile, issues); err != nil {
			return err
		}
		// What was ready belongs to the list that is now replaced; it is
		// asked for again, and not told apart by the time alone.
		if err := kept.store.Remove(readyFile); err != nil {
			return err
		}
		return kept.store.Write(stateFile, next)
	}); err != nil {
		return tracker.Refused("The local copy of the issues cannot be written (%s).", kept.store.Dir)
	}
	kept.issues, kept.state, kept.loaded, kept.wantsReread = issues, next, true, false
	return nil
}

// load makes the copy ready for a read: reads its files and, where it is
// behind, rereads it first.
//
// Side effects: may read the tracker, which a first read, a read after a
// change made elsewhere, and a read of a copy more than a day old wait
// for.
func (kept *Tracker) load() error {
	if kept.loaded {
		return nil
	}
	if kept.isQueued() {
		return kept.loadQueued()
	}
	var held state
	var issues []tracker.Issue
	there := false
	// Both files in one moment: read one after the other, a reread between
	// the two could pair a new state with an old list.
	kept.store.Changing(func() error {
		if _, err := kept.store.Read(stateFile, &held); err != nil {
			held = state{}
		}
		found, err := kept.store.Read(issuesFile, &issues)
		there = found && err == nil
		return nil
	})
	at, known := time.Parse(time.RFC3339Nano, held.RereadAt)
	age := kept.now().Sub(at)
	switch {
	case !there || known != nil:
		// No copy, or one that cannot be read: there is nothing to answer
		// from.
		return kept.Reread()
	case held.Sign != kept.sign():
		// Behind, by the tracker's own sign.
		return kept.Reread()
	case age > trustedFor:
		// Too old to be trusted. If it cannot be reread it is still the
		// best there is, and said to be old.
		if err := kept.Reread(); err == nil {
			return nil
		} else {
			kept.warn("The local copy of the issues is more than a day old and could not be reread: " + err.Error())
		}
	case age > freshFor || age < 0:
		// Answered from as it is; reread behind the command. A copy reread
		// "in the future" means this machine's clock was set back.
		kept.wantsReread = true
	}
	for index := range issues {
		issues[index] = issues[index].Tidy()
	}
	kept.issues, kept.state, kept.loaded = issues, held, true
	return nil
}

// loadQueued is load for a queued tracker: there is no sign to go by, only
// the copy's age, and the waiting changes are laid on what it holds.
func (kept *Tracker) loadQueued() error {
	read := func() (held state, issues []tracker.Issue, waiting []change, usable bool) {
		kept.store.Changing(func() error {
			there, err := kept.store.Read(stateFile, &held)
			found, issuesErr := kept.store.Read(issuesFile, &issues)
			var queueErr error
			waiting, queueErr = kept.readQueue()
			usable = there && err == nil && held.Format == format && found && issuesErr == nil && queueErr == nil
			return nil
		})
		return
	}
	held, issues, waiting, usable := read()
	at, known := time.Parse(time.RFC3339Nano, held.RereadAt)
	age := kept.now().Sub(at)
	switch {
	case !usable || known != nil:
		// No copy, or one this version cannot read: there is nothing to
		// answer from.
		if _, err := kept.WaitAndSync(true); err != nil {
			return err
		}
		held, issues, waiting, _ = read()
	case age > trustedFor:
		if _, err := kept.WaitAndSync(false); err != nil {
			kept.warn("The local copy of the issues is more than a day old and could not be refreshed: " + err.Error())
		}
		held, issues, waiting, _ = read()
	case age > freshFor || age < 0:
		kept.wantsReread = true
	}
	for index := range issues {
		issues[index] = issues[index].Tidy()
	}
	wants := kept.wantsReread
	kept.held, kept.waiting, kept.state = issues, waiting, held
	kept.issues = kept.seen(issues, waiting)
	kept.loaded, kept.wantsReread = true, wants
	return nil
}

// behind marks the copy as behind after a change made through it, so that
// the next read rereads it whatever the tracker's sign says, and asks for a
// reread after this command.
func (kept *Tracker) behind() {
	kept.loaded, kept.wantsReread = false, true
	kept.store.Changing(func() error {
		var held state
		if _, err := kept.store.Read(stateFile, &held); err != nil {
			return nil
		}
		held.Sign = "behind"
		held.Changes++
		return kept.store.Write(stateFile, held)
	})
}

// About says what is known about the tracker without asking it.
func (kept *Tracker) About() tracker.About { return kept.inner.About() }

// Capabilities says what the tracker holds and how; asked of the tracker.
func (kept *Tracker) Capabilities() (tracker.Capabilities, error) { return kept.inner.Capabilities() }

// List gives the issues the filter lets through, from the copy.
func (kept *Tracker) List(filter tracker.ListFilter) ([]tracker.Issue, error) {
	// A wrong request is refused before anything is read.
	if _, err := tracker.Narrow(nil, filter); err != nil {
		return nil, err
	}
	if err := kept.load(); err != nil {
		return nil, err
	}
	return tracker.Narrow(kept.issues, filter)
}

// find gives the issue with an id from the copy, or the refusal for one
// that is not there.
func (kept *Tracker) find(id string) (tracker.Issue, error) {
	if err := kept.load(); err != nil {
		return tracker.Issue{}, err
	}
	for _, issue := range kept.issues {
		if issue.ID == id {
			return issue, nil
		}
	}
	return tracker.Issue{}, tracker.Refused("There is no issue with id %s.", id)
}

// canon gives an id in the one form the tracker itself gives it in, where
// the tracker takes several ("#12" and "12" on GitHub). The copy finds
// issues by their id as the tracker gave it, so every id that comes in from
// a command passes through here first; without it "#12" is asked of the
// tracker, found, and then recorded under a name no read looks for.
func (kept *Tracker) canon(id string) string {
	if with, ok := kept.inner.(interface{ CanonicalID(id string) string }); ok {
		return with.CanonicalID(id)
	}
	return id
}

// Show gives one issue in full, from the copy.
func (kept *Tracker) Show(id string) (tracker.Issue, error) { return kept.known(kept.canon(id)) }

// byIDs gives the issues with these ids, in that order; one that is not in
// the copy is left out.
func (kept *Tracker) byIDs(ids []string) []tracker.Issue {
	found := []tracker.Issue{}
	for _, id := range ids {
		for _, issue := range kept.issues {
			if issue.ID == id {
				found = append(found, issue)
				break
			}
		}
	}
	return found
}

// Ready gives the issues that can be worked on now. Which those are is the
// tracker's own judgement: asked once after each reread, and kept.
func (kept *Tracker) Ready() ([]tracker.Issue, error) {
	if err := kept.load(); err != nil {
		return nil, err
	}
	if kept.isQueued() {
		return kept.readyFromCopy(), nil
	}
	var held keptReady
	if there, err := kept.store.Read(readyFile, &held); err == nil && there && held.For == kept.state.RereadAt {
		return kept.byIDs(held.IDs), nil
	}
	ready, err := kept.inner.Ready()
	if err != nil {
		return nil, err
	}
	held = keptReady{For: kept.state.RereadAt, IDs: []string{}}
	for _, issue := range ready {
		held.IDs = append(held.IDs, issue.ID)
	}
	// Not kept when it cannot be written: asked again next time.
	kept.store.Changing(func() error { return kept.store.Write(readyFile, held) })
	return kept.byIDs(held.IDs), nil
}

// Search finds issues by the tracker's own search, which is not worked out
// here: what it matches and in what order is the tracker's to say. It asks
// the tracker.
func (kept *Tracker) Search(text string) ([]tracker.Issue, error) {
	if !kept.isQueued() {
		return kept.inner.Search(text)
	}
	if err := kept.load(); err != nil {
		return nil, err
	}
	return kept.searchCopy(text), nil
}

// commentsName is the file an issue's comments are kept in. An id is made
// safe for a file name: it may hold a dot, never a slash.
func commentsName(id string) string {
	return "comments/" + strings.NewReplacer("/", "_", "\\", "_", "..", "_").Replace(id) + ".json"
}

// Comments gives an issue's comments, oldest first: the ones kept, asked
// of the tracker again when the issue has changed since.
//
// Side effects: one read of the tracker the first time an issue's comments
// are asked for, and after the issue changed.
func (kept *Tracker) Comments(id string) ([]tracker.Comment, error) {
	id = kept.canon(id)
	issue, err := kept.known(id)
	if err != nil {
		return nil, err
	}
	// The comments made here that still wait to be sent come after the
	// ones the tracker holds.
	pending := []tracker.Comment{}
	if kept.isQueued() {
		for _, one := range kept.waiting {
			if one.Kind == opComment && one.ID == id {
				pending = append(pending, tracker.Comment{ID: "waiting-" + strconv.Itoa(one.Seq), Author: one.Actor, CreatedAt: one.At, Text: one.Text})
			}
		}
		// The issue as the tracker gave it, without what waits: that is
		// what the kept comments belong to.
		for _, had := range kept.held {
			if had.ID == id {
				issue = had
			}
		}
	}
	// The issue as it stood when the comments were kept: its last change
	// and how many comments it had. Either differing means "ask again".
	key := strconv.Itoa(issue.CommentCount) + " "
	if issue.UpdatedAt != nil {
		key += *issue.UpdatedAt
	}
	var held keptComments
	if there, err := kept.store.Read(commentsName(id), &held); err == nil && there && held.For == key {
		return append(slices.Clone(held.Comments), pending...), nil
	} else if there && err == nil && kept.isQueued() {
		// Kept, but the issue changed since. If the tracker cannot be asked
		// now, the kept ones are the best there is, and said to be old.
		fresh, askErr := kept.inner.Comments(id)
		if askErr != nil {
			kept.warn("The comments could not be refreshed and may be out of date: " + askErr.Error())
			return append(slices.Clone(held.Comments), pending...), nil
		}
		kept.store.Changing(func() error {
			return kept.store.Write(commentsName(id), keptComments{For: key, Comments: fresh})
		})
		return append(fresh, pending...), nil
	}
	comments, err := kept.inner.Comments(id)
	if err != nil {
		return nil, err
	}
	kept.store.Changing(func() error {
		return kept.store.Write(commentsName(id), keptComments{For: key, Comments: comments})
	})
	return append(comments, pending...), nil
}

// changed is called after every change handed to the tracker: whether it
// worked or not, the copy may now be behind (a change that failed half-way
// has changed something).
func (kept *Tracker) changed(err error) error {
	kept.behind()
	return err
}

// Create makes a new issue and returns its id. For a queued tracker too it
// goes to the tracker at once: only the tracker gives the id.
func (kept *Tracker) Create(draft tracker.Draft) (string, error) {
	if kept.isQueued() {
		return kept.createQueued(draft)
	}
	id, err := kept.inner.Create(draft)
	return id, kept.changed(err)
}

// Edit changes an issue's fields, labels and kept data.
func (kept *Tracker) Edit(id string, changes tracker.Changes) error {
	if kept.isQueued() {
		return kept.editQueued(kept.canon(id), changes)
	}
	return kept.changed(kept.inner.Edit(id, changes))
}

// Write replaces one written part of an issue.
func (kept *Tracker) Write(id, part, text string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Write(id, part, text))
	}
	id = kept.canon(id)
	if !slices.Contains(tracker.Parts, part) {
		return tracker.Usage("\"%s\" is not a written part of an issue. There are: %s.", part, strings.Join(tracker.Parts, ", "))
	}
	if _, err := kept.known(id); err != nil {
		return err
	}
	return kept.record(change{Kind: opWrite, ID: id, Part: part, Text: text})
}

// Comment adds a comment to an issue.
func (kept *Tracker) Comment(id, text string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Comment(id, text))
	}
	id = kept.canon(id)
	if _, err := kept.known(id); err != nil {
		return err
	}
	return kept.record(change{Kind: opComment, ID: id, Text: text})
}

// Start marks an issue as being worked on.
func (kept *Tracker) Start(id string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Start(id))
	}
	id = kept.canon(id)
	issue, err := kept.known(id)
	if err != nil {
		return err
	}
	if issue.Status == closedStatus {
		return tracker.Refused("%s is closed. Reopen it before starting work on it.", id)
	}
	return kept.record(change{Kind: opStart, ID: id})
}

// Stop puts an issue that is being worked on back to open.
func (kept *Tracker) Stop(id string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Stop(id))
	}
	id = kept.canon(id)
	issue, err := kept.known(id)
	if err != nil {
		return err
	}
	if issue.Status == closedStatus {
		return tracker.Refused("%s is closed. Reopen it to work on it again.", id)
	}
	// Nothing would change: nothing waits to be sent.
	if issue.Status != "in_progress" {
		return nil
	}
	return kept.record(change{Kind: opStop, ID: id})
}

// Close closes an issue; reason may be "".
func (kept *Tracker) Close(id, reason string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Close(id, reason))
	}
	id = kept.canon(id)
	if _, err := kept.known(id); err != nil {
		return err
	}
	return kept.record(change{Kind: opClose, ID: id, Reason: reason})
}

// Reopen reopens a closed issue.
func (kept *Tracker) Reopen(id string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Reopen(id))
	}
	id = kept.canon(id)
	if _, err := kept.known(id); err != nil {
		return err
	}
	return kept.record(change{Kind: opReopen, ID: id})
}

// Defer puts an issue in Someday (bead-bb-26g).
func (kept *Tracker) Defer(id string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Defer(id))
	}
	id = kept.canon(id)
	issue, err := kept.known(id)
	if err != nil {
		return err
	}
	switch issue.Status {
	case closedStatus:
		return tracker.Refused("%s is closed. Reopen it before setting it aside.", id)
	case tracker.DeferredStatus:
		return nil
	}
	return kept.record(change{Kind: opDefer, ID: id})
}

// Undefer brings an issue back from Someday.
func (kept *Tracker) Undefer(id string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Undefer(id))
	}
	id = kept.canon(id)
	issue, err := kept.known(id)
	if err != nil {
		return err
	}
	// Nothing would change: nothing waits to be sent.
	if issue.Status != tracker.DeferredStatus {
		return nil
	}
	return kept.record(change{Kind: opUndefer, ID: id})
}

// Move puts an issue under a parent, or with nil back at the top level.
func (kept *Tracker) Move(id string, parentID *string) error {
	if kept.isQueued() {
		if parentID != nil {
			parentID = tracker.Ptr(kept.canon(*parentID))
		}
		return kept.moveQueued(kept.canon(id), parentID)
	}
	return kept.changed(kept.inner.Move(id, parentID))
}

// both makes sure two issues are there, for a link or an unlink that waits.
func (kept *Tracker) both(id, otherID string) error {
	if _, err := kept.known(id); err != nil {
		return err
	}
	_, err := kept.known(otherID)
	return err
}

// Link records "id <kind> otherID".
func (kept *Tracker) Link(id, otherID, kind string) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Link(id, otherID, kind))
	}
	id, otherID = kept.canon(id), kept.canon(otherID)
	if !slices.Contains(kept.inner.About().LinkKinds, kind) {
		return tracker.Unsupported("This repository's tracker has no \"%s\" link. It has: %s.", kind, strings.Join(kept.inner.About().LinkKinds, ", "))
	}
	if err := kept.both(id, otherID); err != nil {
		return err
	}
	if id == otherID {
		return tracker.Refused("An issue cannot be linked to itself.")
	}
	return kept.record(change{Kind: opLink, ID: id, Other: otherID, LinkKind: kind})
}

// Unlink removes the link between two issues.
func (kept *Tracker) Unlink(id, otherID string, options tracker.UnlinkOptions) error {
	if !kept.isQueued() {
		return kept.changed(kept.inner.Unlink(id, otherID, options))
	}
	id, otherID = kept.canon(id), kept.canon(otherID)
	if err := kept.both(id, otherID); err != nil {
		return err
	}
	return kept.record(change{Kind: opUnlink, ID: id, Other: otherID, LinkKind: options.Kind, OnlyFrom: options.OnlyFrom})
}

// Status says how the copy stands.
type Status struct {
	// Folder is where the copy is kept.
	Folder string `json:"folder"`
	// LastSync is when the copy was last reread from the tracker; nil for
	// never.
	LastSync *string `json:"lastSync"`
	// Waiting and Refused are always 0 for a tracker whose changes are
	// written straight through: nothing waits to be sent.
	Waiting int `json:"waiting"`
	Refused int `json:"refused"`
	// Straight says that the tracker's changes are written straight
	// through, so there is nothing to say about waiting ones.
	Straight bool `json:"-"`
}

// SignFile gives the file whose change means the tracker's data changed,
// for a caller that watches for it; "" when the tracker has none.
func (kept *Tracker) SignFile() string {
	if with, ok := kept.inner.(interface{ SignFile() string }); ok {
		return with.SignFile()
	}
	return ""
}

// Status says how the copy stands, from its files; the tracker is not
// asked and nothing is reread.
func (kept *Tracker) Status() Status {
	var held state
	kept.store.Read(stateFile, &held)
	status := Status{Folder: kept.store.Dir, Straight: !kept.isQueued()}
	if !status.Straight {
		if waiting, err := kept.readQueue(); err == nil {
			status.Waiting = len(waiting)
		}
		status.Refused = len(kept.RefusedChanges())
	}
	if at, err := time.Parse(time.RFC3339Nano, held.RereadAt); err == nil {
		// To the second: the finer time is only for telling rereads apart.
		status.LastSync = tracker.Ptr(at.UTC().Format(time.RFC3339))
	}
	return status
}
