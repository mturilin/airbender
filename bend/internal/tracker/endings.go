// endings.go — the common closing contract, independent of a tracker.
//
// What: normalizes terminal outcomes, validates parent/duplicate constraints,
// and carries retry-stable closing details (bead-bb-o6j).
// Why: cancelled work is closed but still blocks its dependents; conflating
// those two questions loses both work and the reason it cannot proceed.
// Design notes: adapters keep their native statuses, but callers see closed
// plus an ending. The optional interface preserves older adapter contracts.
// Gotchas: closing metadata is active only while the native issue is closed;
// reopening must never resurrect a previous closing note or timestamp.
package tracker

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Endings are the supported terminal outcomes, in the UI's order.
var Endings = []string{"done", "verified", "cancelled", "duplicate"}

// ClosingKey names the adapter-owned metadata without replacing other data.
const ClosingKey = "airbender.closing"

// CloseOptions describes one close. At and RequestID make retries stable;
// Commit and PushResult document the Git work, never execute it.
type CloseOptions struct {
	Ending      string `json:"ending"`
	Reason      string `json:"reason,omitempty"`
	At          string `json:"at,omitempty"`
	Commit      string `json:"commit,omitempty"`
	DuplicateOf string `json:"duplicateOf,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	PushResult  string `json:"pushResult,omitempty"`
}

// Prepared validates the options and supplies a single closing timestamp.
// It is pure apart from reading the clock when At is missing.
func (options CloseOptions) Prepared() (CloseOptions, error) {
	if options.Ending == "" {
		options.Ending = "done"
	}
	if !slices.Contains(Endings, options.Ending) {
		return options, Usage("Unknown ending %q. Use done, verified, cancelled or duplicate.", options.Ending)
	}
	if options.DuplicateOf != "" && options.Ending != "duplicate" {
		return options, Usage("A duplicate target requires the duplicate ending.")
	}
	if options.At == "" {
		options.At = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if _, err := time.Parse(time.RFC3339Nano, options.At); err != nil {
		return options, Usage("The closing time is not an ISO timestamp.")
	}
	return options, nil
}

// IsClosed reports whether a native or canonical status is terminal.
func IsClosed(status string) bool {
	return status == "closed" || status == "verified" || status == "cancelled" || status == "duplicate"
}

// EndingOf gives the explicit ending, or the compatible interpretation of
// a native status. Open statuses have no ending.
func EndingOf(status, ending string) string {
	if !IsClosed(status) {
		return ""
	}
	if slices.Contains(Endings, ending) {
		return ending
	}
	if status == "closed" {
		return "done"
	}
	return status
}

// Blocks distinguishes unresolved/cancelled dependencies from resolved ones.
func Blocks(status, ending string) bool {
	return !IsClosed(status) || EndingOf(status, ending) == "cancelled"
}

// ClosingFrom reads only the namespaced metadata, accepting the JSON string
// form written by older command-line metadata setters as well as an object.
func ClosingFrom(metadata json.RawMessage) CloseOptions {
	var data map[string]json.RawMessage
	var closing CloseOptions
	if json.Unmarshal(metadata, &data) != nil {
		return closing
	}
	raw := data[ClosingKey]
	var text string
	if json.Unmarshal(raw, &text) == nil {
		raw = []byte(text)
	}
	_ = json.Unmarshal(raw, &closing)
	return closing
}

// NormalizeClosing gives a canonical closed state and active closing data.
// The value is copied; unrelated metadata is preserved unchanged.
func NormalizeClosing(issue Issue) Issue {
	if !IsClosed(issue.Status) {
		issue.Ending, issue.ClosedAt, issue.CloseReason = "", nil, ""
		return issue
	}
	closing := ClosingFrom(issue.Metadata)
	issue.Ending = EndingOf(issue.Status, issue.Ending)
	if closing.Ending != "" && (issue.Status == "closed" || closing.Ending == issue.Status) {
		issue.Ending = EndingOf(issue.Status, closing.Ending)
		issue.CloseReason = closing.Reason
		if closing.At != "" {
			issue.ClosedAt = Ptr(closing.At)
		}
	}
	issue.Status = "closed"
	return issue
}

// ValidateClose refuses missing issues, self/unknown duplicate targets and
// any open descendant. It changes nothing and tolerates parent-data cycles.
func ValidateClose(issues []Issue, id string, options CloseOptions) error {
	known := map[string]Issue{}
	for _, issue := range issues {
		known[issue.ID] = issue
	}
	if _, ok := known[id]; !ok {
		return Refused("No issue with id %s.", id)
	}
	if options.DuplicateOf != "" {
		if options.DuplicateOf == id {
			return Usage("An issue cannot duplicate itself.")
		}
		if _, ok := known[options.DuplicateOf]; !ok {
			return Refused("No issue with id %s.", options.DuplicateOf)
		}
	}
	for _, issue := range issues {
		if IsClosed(issue.Status) {
			continue
		}
		seen := map[string]bool{issue.ID: true}
		for parent := issue.ParentID; parent != nil && !seen[*parent]; {
			if *parent == id {
				return Refused("%s has open sub-issue %s. Close its sub-issues first.", id, issue.ID)
			}
			seen[*parent] = true
			ancestor, ok := known[*parent]
			if !ok {
				break
			}
			parent = ancestor.ParentID
		}
	}
	return nil
}

// ClosingNote is deterministic for a prepared close, so retries can deduplicate.
func ClosingNote(options CloseOptions) string {
	commit := options.Commit
	if commit == "" {
		commit = "not committed"
	}
	text := fmt.Sprintf("Closed as %s; %s.", options.Ending, commit)
	if options.Reason != "" {
		text += " " + options.Reason
	}
	if options.PushResult != "" {
		text += " Push: " + options.PushResult
	}
	marker := options.RequestID
	if marker == "" {
		marker = options.At
	}
	if marker != "" {
		text += "\n\n<!-- airbender-close:" + marker + " -->"
	}
	return strings.TrimSpace(text)
}

// SameClose compares the requested operation, excluding its assigned time.
func SameClose(left, right CloseOptions) bool {
	left.At, right.At = "", ""
	return left == right
}

// CloseWith dispatches the richer operation without forcing external test
// adapters to implement it. Only a plain Done close has a legacy fallback.
func CloseWith(target Tracker, id string, options CloseOptions) error {
	prepared, err := options.Prepared()
	if err != nil {
		return err
	}
	if closer, ok := target.(interface {
		CloseWith(string, CloseOptions) error
	}); ok {
		return closer.CloseWith(id, prepared)
	}
	if prepared.Ending != "done" || prepared.Commit != "" || prepared.DuplicateOf != "" {
		return Unsupported("This tracker cannot record that ending.")
	}
	return target.Close(id, prepared.Reason)
}
