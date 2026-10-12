// derive.go — putting an issue together from the copy's facts.
//
// What: takes the issues a queued tracker's copy holds and gives them as
// they are to be read: every pointer to another issue with that issue's
// present title and state, links seen from the other end, sub-issues, and
// what each issue waits for.
//
// Why: a tracker reached over the network is not reread whole at every
// sync, only what changed. But an issue's answer carries facts about other
// issues, and when a blocker is closed the tracker reports the blocker as
// changed, not the issue that waited for it. Kept as it was answered, that
// issue would go on showing "blocked". So only each issue's own facts are
// believed (its fields, its parent, the links recorded on it), and
// everything that depends on another issue is worked out when read
// (bead-bb-c9l.15). The same holds for changes that wait to be sent: laid
// on the facts, they show in every issue they touch.
//
// Design notes:
//   - What counts as an issue's own: every link the adapter gave for it
//     except "blocked-by, seen from the other end", which is the other
//     issue's fact. Links a tracker keeps as text on both issues (GitHub's
//     "discovered from" and "related") are each issue's own, as written.
//   - A pointer's state is "closed" or "open", as the hosted adapter gives
//     it, whatever finer status the issue itself has.
//   - What an issue waits for: its own unfinished blockers, then those of
//     the open issues it sits inside, at any depth. A closed issue waits for
//     nothing. A loop in the parents is not followed.
//   - One index by id is built per read, so the work grows with the number
//     of issues and links, not with its square.
//
// Gotchas:
//   - The rule must give what the adapter itself would answer for a full
//     list; a test holds it to the GitHub adapter (derive_test.go). One
//     wanted difference: that adapter follows parents four levels up, a
//     limit of one request to GitHub.

package kept

import "github.com/mturilin/airbender/bend/internal/tracker"

// closedStatus is the status of a finished issue, for every tracker.
const closedStatus = "closed"

// blockedBy is the kind of link that makes an issue wait for another.
const blockedBy = "blocked-by"

// pointerTo gives the short pointer to an issue, as a hosted adapter gives
// it: the state is open or closed.
func pointerTo(issue *tracker.Issue) tracker.IssueRef {
	state := "open"
	if issue.Status == closedStatus {
		state = closedStatus
	}
	return tracker.IssueRef{ID: issue.ID, Title: issue.Title, Status: state}
}

// ownLinks gives the links recorded on an issue itself: all but "blocked
// by" seen from the other end.
func ownLinks(issue tracker.Issue) []tracker.Link {
	own := []tracker.Link{}
	for _, link := range issue.Links {
		if link.Kind == blockedBy && link.Direction == "in" {
			continue
		}
		own = append(own, link)
	}
	return own
}

// derive gives the issues as they are to be read, worked out from each
// one's own facts. The order is kept. Pure: the issues given are not
// changed.
func derive(issues []tracker.Issue) []tracker.Issue {
	byID := make(map[string]*tracker.Issue, len(issues))
	for index := range issues {
		byID[issues[index].ID] = &issues[index]
	}
	// What each issue waits for by its own links, and who waits for it.
	waitsFor := make(map[string][]string, len(issues))
	waitedBy := map[string][]string{}
	children := map[string][]string{}
	for index := range issues {
		issue := &issues[index]
		for _, link := range issue.Links {
			if link.Kind == blockedBy && link.Direction == "out" {
				waitsFor[issue.ID] = append(waitsFor[issue.ID], link.ID)
				waitedBy[link.ID] = append(waitedBy[link.ID], issue.ID)
			}
		}
		if issue.ParentID != nil {
			children[*issue.ParentID] = append(children[*issue.ParentID], issue.ID)
		}
	}
	// refresh gives a link with the other issue's present title and state;
	// one to an issue the copy does not hold is kept as it was given.
	refresh := func(link tracker.Link) tracker.Link {
		if other := byID[link.ID]; other != nil {
			pointer := pointerTo(other)
			link.Title, link.Status = pointer.Title, pointer.Status
		}
		return link
	}
	made := make([]tracker.Issue, 0, len(issues))
	for index := range issues {
		issue := issues[index]
		own := ownLinks(issue)
		links := []tracker.Link{}
		// In the adapter's order: what it waits for, who waits for it, then
		// the links kept as text.
		for _, link := range own {
			if link.Kind == blockedBy {
				links = append(links, refresh(link))
			}
		}
		for _, id := range waitedBy[issue.ID] {
			pointer := pointerTo(byID[id])
			links = append(links, tracker.Link{ID: pointer.ID, Title: pointer.Title, Status: pointer.Status, Kind: blockedBy, Direction: "in"})
		}
		for _, link := range own {
			if link.Kind != blockedBy {
				links = append(links, refresh(link))
			}
		}
		subIssues := []tracker.IssueRef{}
		for _, id := range children[issue.ID] {
			subIssues = append(subIssues, pointerTo(byID[id]))
		}
		waits := []tracker.IssueRef{}
		if issue.Status != closedStatus {
			add := func(ids []string) {
				for _, id := range ids {
					blocker := byID[id]
					if blocker == nil || blocker.Status == closedStatus {
						continue
					}
					had := false
					for _, already := range waits {
						had = had || already.ID == id
					}
					if !had {
						waits = append(waits, pointerTo(blocker))
					}
				}
			}
			add(waitsFor[issue.ID])
			seen := map[string]bool{issue.ID: true}
			for up := issue.ParentID; up != nil && !seen[*up]; {
				seen[*up] = true
				parent := byID[*up]
				if parent == nil {
					break
				}
				if parent.Status != closedStatus {
					add(waitsFor[parent.ID])
				}
				up = parent.ParentID
			}
		}
		issue.Links, issue.SubIssues, issue.BlockedBy = links, subIssues, waits
		made = append(made, issue.Tidy())
	}
	return made
}
