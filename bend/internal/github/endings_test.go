// endings_test.go — closing/reopening and cancelled dependencies through
// a real adapter with an in-memory GitHub, never a live repository.
package github

import (
	"github.com/mturilin/airbender/bend/internal/tracker"
	"testing"
)

// TestAllEndingsAreNativeAndRetryable checks state, metadata and note deduplication.
func TestAllEndingsAreNativeAndRetryable(t *testing.T) {
	for _, ending := range tracker.Endings {
		t.Run(ending, func(t *testing.T) {
			client, adapter := fresh("")
			id := create(t, adapter, tracker.Draft{Title: "Work"})
			must(t, adapter.Edit(id, tracker.Changes{AddLabels: []string{"owner-label"}}))
			options := tracker.CloseOptions{Ending: ending, Reason: "reason", Commit: "abc", RequestID: "request"}
			must(t, tracker.CloseWith(adapter, id, options))
			must(t, tracker.CloseWith(adapter, id, options))
			issue := show(t, adapter, id)
			if issue.Status != "closed" || issue.Ending != ending || issue.ClosedAt == nil || issue.CloseReason != "reason" {
				t.Fatalf("%+v", issue)
			}
			if !has(issue.Labels, "owner-label") {
				t.Fatal("owner label lost")
			}
			comments, err := adapter.Comments(id)
			must(t, err)
			if len(comments) != 1 {
				t.Fatalf("%d close notes", len(comments))
			}
			if ending == "cancelled" {
				native, err := client.Issue(1)
				must(t, err)
				if native.StateReason == nil || *native.StateReason != "not planned" {
					t.Fatal("wrong native reason")
				}
			}
			must(t, adapter.Reopen(id))
			issue = show(t, adapter, id)
			if issue.Ending != "" || issue.ClosedAt != nil || issue.CloseReason != "" {
				t.Fatal("reopen kept closing fields")
			}
			must(t, tracker.CloseWith(adapter, id, tracker.CloseOptions{Ending: ending}))
			must(t, adapter.Reopen(id))
			must(t, tracker.CloseWith(adapter, id, tracker.CloseOptions{Ending: ending}))
			comments, err = adapter.Comments(id)
			must(t, err)
			if len(comments) != 3 {
				t.Fatal("a new close after reopening did not get its own note")
			}
		})
	}
}

// TestCancelledBlockerRemainsInTheDerivedGraph prevents native CLOSED from
// silently releasing dependent work, including after the queued-copy overlay.
func TestCancelledBlockerRemainsInTheDerivedGraph(t *testing.T) {
	_, adapter := fresh("")
	blocker := create(t, adapter, tracker.Draft{Title: "Blocked work"})
	waiting := create(t, adapter, tracker.Draft{Title: "Dependent"})
	must(t, adapter.Link(waiting, blocker, "blocked-by"))
	must(t, tracker.CloseWith(adapter, blocker, tracker.CloseOptions{Ending: "cancelled"}))
	if len(show(t, adapter, waiting).BlockedBy) != 1 {
		t.Fatal("cancelled work stopped blocking")
	}
}

type rejectingDuplicate struct {
	Client
	unavailable bool
}

// Update rejects only Duplicate so the fallback can be tested without a network.
func (client *rejectingDuplicate) Update(number int, changes Changes) error {
	if changes.StateReason == "duplicate" {
		if client.unavailable {
			err := tracker.Refused("GitHub could not be reached")
			err.Later = true
			return err
		}
		return tracker.Refused("state_reason duplicate is invalid")
	}
	return client.Client.Update(number, changes)
}

// TestDuplicateFallbackDoesNotHideNetworkFailures checks the narrow fallback.
func TestDuplicateFallbackDoesNotHideNetworkFailures(t *testing.T) {
	for _, offline := range []bool{false, true} {
		fake := NewFake(FakeOptions{})
		adapter := New(&rejectingDuplicate{Client: fake, unavailable: offline}, "")
		id := create(t, adapter, tracker.Draft{Title: "Duplicate"})
		err := tracker.CloseWith(adapter, id, tracker.CloseOptions{Ending: "duplicate"})
		if offline {
			if err == nil || show(t, adapter, id).Status == "closed" {
				t.Fatal("network error was hidden")
			}
		} else {
			must(t, err)
			if show(t, adapter, id).Ending != "duplicate" {
				t.Fatal("fallback lost ending")
			}
		}
	}
}

// TestDuplicateTargetIsRelatedOnce covers both ends and close retries.
func TestDuplicateTargetIsRelatedOnce(t *testing.T) {
	_, adapter := fresh("")
	target := create(t, adapter, tracker.Draft{Title: "Original"})
	id := create(t, adapter, tracker.Draft{Title: "Duplicate"})
	options := tracker.CloseOptions{Ending: "duplicate", DuplicateOf: target, RequestID: "dup-1"}
	must(t, tracker.CloseWith(adapter, id, options))
	must(t, tracker.CloseWith(adapter, id, options))
	for _, issue := range []tracker.Issue{show(t, adapter, id), show(t, adapter, target)} {
		if len(issue.Links) != 1 || issue.Links[0].Kind != "related" {
			t.Fatalf("related link was lost or duplicated: %+v", issue.Links)
		}
	}
}
