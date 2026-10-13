// sync.go — what "syncing a tracker's issues with a remote" means, whatever
// the tracker.
//
// What: how a sync can end, what one reports, and the optional part of a
// tracker that has a sync of its own (Syncer).
//
// Why: bend keeps a repository's issues in step with their remote by
// itself, for every tracker (bead-bb-c9l.16). The layer above the adapters
// (the local copy, the helper that keeps time, the commands, the log) must
// do that without knowing which tracker it is: the owner asked that nothing
// of beads leaks through this layer. So everything a tracker's own sync has
// to say is said here, in this layer's words, and nothing else crosses.
//
// Design notes:
//   - Two kinds of tracker sync, and the layer above asks only which one it
//     has: one whose changes wait in bend's queue (About().Writes is
//     WritesQueued; bend's own sync sends them), and one that changes its
//     data at once and has a sync of its own to exchange it with a remote
//     (a Syncer). A tracker that is neither is not synced.
//   - "Not known" is a value, for what was sent and for what was changed
//     here: a tracker that cannot tell says so, and nothing above guesses.
//   - A Syncer is handed a folder to keep what it must remember between
//     runs. What it writes there is its own business; the layer above
//     never reads it.

package tracker

// SyncEnd is how a sync ended.
type SyncEnd string

const (
	// SyncSynced: both ways done, or nothing to do.
	SyncSynced SyncEnd = "synced"
	// SyncFailed: it did not work this time (network, sign-in, storage);
	// worth trying again.
	SyncFailed SyncEnd = "failed"
	// SyncBusy: it gave way to something else changing the issues; nothing
	// was sent; worth trying again.
	SyncBusy SyncEnd = "busy"
	// SyncConflict: the two sides changed in a way that cannot be merged; a
	// person has to settle it.
	SyncConflict SyncEnd = "conflict"
	// SyncStuck: something on this side blocks every sync until a person
	// clears it.
	SyncStuck SyncEnd = "stuck"
)

// Halts says whether syncing by itself stops after this end, until a sync
// that was asked for ends well.
func (end SyncEnd) Halts() bool { return end == SyncConflict || end == SyncStuck }

// The kinds of change made to an issue, as a sync reports them.
const (
	ChangeCreated = "created"
	ChangeUpdated = "updated"
	ChangeClosed  = "closed"
	ChangeDeleted = "deleted"
	ChangeComment = "comment"
	ChangeLink    = "link"
)

// SyncChange is an issue changed on this side, and how.
type SyncChange struct {
	ID string `json:"id"`
	// Kinds holds each kind once, in the order first seen.
	Kinds []string `json:"kinds"`
}

// SyncRun is what one run of a tracker's own sync reports.
type SyncRun struct {
	End SyncEnd
	// Message is the tracker's own words about a run that did not end
	// synced; else "".
	Message string
	// Sent is what this side had to send; SentKnown is false when the
	// tracker cannot tell, and Sent then means nothing.
	Sent      []SyncChange
	SentKnown bool
	// ChangedHere is the ids of the issues changed on this side before or
	// during the run: a difference in them afterwards is this side's doing,
	// not something brought in. Meaningful only when SentKnown.
	ChangedHere []string
}

// Syncer is implemented by a tracker whose data is on this machine and is
// exchanged with a remote by a sync of the tracker's own.
//
// keep, in every method, is a folder the tracker may keep files of its own
// in between runs (it may not be there yet).
type Syncer interface {
	// SyncsWith says what the issues are synced with, in words for the
	// owner ("the repository's git remote"); "" when syncing is not
	// switched on (there is no remote, or nothing was ever sent to it).
	// known is false when it could not be told now (the remote was not
	// reached); the words are then "".
	// Side effects: may run the tracker's program and reach the remote; an
	// answer may be remembered in keep for a while.
	SyncsWith(keep string) (words string, known bool)
	// Pending gives the changes made on this side that have not been sent;
	// known is false when the tracker cannot tell.
	Pending(keep string) (changes []SyncChange, known bool)
	// SyncOnce runs one sync, both ways, and reports it. A failure is an
	// end, not an error. It may take minutes.
	SyncOnce(keep string) SyncRun
}

// Remote is implemented by a tracker reached over the network that can say
// what its issues are synced with, in words for the owner ("GitHub issues
// of owner/name").
type Remote interface {
	SyncedWith() string
}
