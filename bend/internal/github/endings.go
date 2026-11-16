// endings.go — native GitHub closing reasons and retryable closing details.
//
// What: closes one issue with an explicit ending and an auditable Git result.
// Why: closed/not-planned and verified work must not become indistinguishable.
// Design notes: the closing metadata and native state are sent together;
// signing/deduplication follows the existing comment API. No Git is executed.
// Gotchas: only an explicit unsupported duplicate reason permits a fallback;
// permission, transport and unrelated validation failures must remain visible.
package github

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

const verifiedLabel = "airbender:verified"
const duplicateLabel = "airbender:duplicate"

// githubEnding maps native reasons and the two internal labels. Open issues
// have no ending, even when a stale label remains after an external edit.
func githubEnding(issue Issue) string {
	if issue.State != "closed" {
		return ""
	}
	if has(issue.Labels, verifiedLabel) {
		return "verified"
	}
	if has(issue.Labels, duplicateLabel) {
		return "duplicate"
	}
	ref := issue.Ref
	if ref.StateReason == nil {
		ref.StateReason = issue.StateReason
	}
	return toIssueRef(ref).Ending
}

// CloseWith validates the live tree and duplicate target, atomically writes
// state/body/labels, and completes related links and its closing note on retry.
func (github *adapter) CloseWith(id string, options tracker.CloseOptions) error {
	options, err := options.Prepared()
	if err != nil {
		return err
	}
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	all, err := github.List(tracker.ListFilter{Status: tracker.Ptr("all")})
	if err != nil {
		return err
	}
	id = github.CanonicalID(id)
	if err := tracker.ValidateClose(all, id, options); err != nil {
		return err
	}
	parts := splitBody(issue.Body)
	metadata, _ := json.Marshal(parts.Data)
	previous := tracker.ClosingFrom(metadata)
	if issue.State == "closed" && previous.Ending != "" && options.Ending == previous.Ending && options.Reason == "" && options.Commit == "" && options.RequestID == "" && options.DuplicateOf == "" && options.PushResult == "" {
		options = previous
	}
	if issue.State == "closed" && previous.Ending != "" && !tracker.SameClose(previous, options) {
		return tracker.Refused("%s is already closed with different closing details. Reopen it first.", id)
	}
	if issue.State == "closed" && githubEnding(*issue) != options.Ending {
		return tracker.Refused("%s is already closed with another ending. Reopen it first.", id)
	}
	if issue.State == "closed" && tracker.SameClose(previous, options) && previous.At != "" {
		options.At = previous.At
	}
	encoded, _ := json.Marshal(options)
	parts.Data[tracker.ClosingKey] = string(encoded)
	body := joinBody(parts)
	labels := without(issue.Labels, inProgress, someday, verifiedLabel, duplicateLabel)
	reason := "completed"
	switch options.Ending {
	case "verified":
		labels = append(labels, verifiedLabel)
	case "cancelled":
		reason = "not_planned"
	case "duplicate":
		reason = "duplicate"
	}
	update := Changes{State: "closed", StateReason: reason, Body: &body, Labels: &labels}
	if options.DuplicateOf != "" {
		target, err := github.need(options.DuplicateOf)
		if err != nil {
			return err
		}
		update.DuplicateIssueID = &target.ID
	}
	if issue.State != "closed" || !tracker.SameClose(previous, options) {
		if err := github.client.Update(issue.Number, update); err != nil {
			message := strings.ToLower(err.Error())
			unsupported := strings.Contains(message, "state_reason") && (strings.Contains(message, "invalid") || strings.Contains(message, "not supported") || strings.Contains(message, "not a permitted"))
			if reason != "duplicate" || !unsupported || tracker.MayWorkLater(err) {
				return err
			}
			labels = append(labels, duplicateLabel)
			update.Labels = &labels
			update.StateReason, update.DuplicateIssueID = "not_planned", nil
			if err := github.client.Update(issue.Number, update); err != nil {
				return err
			}
		}
	}
	if options.DuplicateOf != "" {
		if err := github.ensureClosingRelated(id, options.DuplicateOf); err != nil {
			return err
		}
	}
	note := tracker.ClosingNote(options)
	comments, err := github.Comments(id)
	if err != nil {
		return err
	}
	for _, comment := range comments {
		if comment.Text == note {
			return nil
		}
	}
	return github.Comment(id, note)
}

// ensureClosingRelated adds each missing half of a Duplicate's related link.
// Unlike the public Link action, an already complete link is success. Fresh
// bodies retain the closing metadata just written and repair partial retries.
func (github *adapter) ensureClosingRelated(id, otherID string) error {
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	other, err := github.need(otherID)
	if err != nil {
		return err
	}
	link := tracker.TextLink{Kind: "related", Direction: "out", ID: strconv.Itoa(other.Number)}
	back := mirror(link, strconv.Itoa(issue.Number))
	for _, side := range []struct {
		issue *Issue
		link  tracker.TextLink
	}{{issue, link}, {other, back}} {
		present := false
		for _, had := range splitBody(side.issue.Body).Links {
			present = present || sameLink(had, side.link)
		}
		if !present {
			if err := github.rewrite(side.issue, withLink(side.link)); err != nil {
				return err
			}
		}
	}
	return nil
}
