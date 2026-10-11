// narrow.go — narrowing a list of issues by a filter.
//
// What: the one rule for what `list` lets through, over issues in the
// common shape, and reading a moment as a person writes it.
//
// Why: an adapter that has every issue in hand (beads), and the local copy
// that answers in an adapter's place, must let exactly the same issues
// through, so the rule is written once.

package tracker

import (
	"strings"
	"time"
)

// ParseMoment reads a date and time in the forms a caller is likely to
// write; ok is false for anything else. One written without an offset is
// read as this machine's local time, as a person writing it means it.
func ParseMoment(text string) (moment time.Time, ok bool) {
	text = strings.TrimSpace(text)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00", "2006-01-02 15:04:05Z07:00"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05.999999999", "2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02"} {
		if parsed, err := time.ParseInLocation(layout, text, time.Local); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// Narrow gives the issues a filter lets through, in the order given; open
// ones when the filter names no status.
//
// Fails with Refused for a category that cannot be one, and as a wrong
// request for a "changed since" that is not a date and time: refused, not
// answered with an empty list, because a caller that keeps a copy would
// read "nothing" as "nothing has changed".
func Narrow(issues []Issue, filter ListFilter) ([]Issue, error) {
	var category *string
	if filter.Category != nil {
		name, err := CleanCategory(*filter.Category)
		if err != nil {
			return nil, err
		}
		category = &name
	}
	var since time.Time
	if filter.ChangedSince != nil {
		var known bool
		if since, known = ParseMoment(*filter.ChangedSince); !known {
			return nil, Usage("\"%s\" is not a date and time. Write it like 2026-01-31T14:00:00Z.", *filter.ChangedSince)
		}
	}
	same := func(have, want *string) bool { return want == nil || (have != nil && *have == *want) }
	found := []Issue{}
	for _, issue := range issues {
		switch {
		case filter.Status == nil:
			if issue.Status == "closed" {
				continue
			}
		case *filter.Status != "all" && issue.Status != *filter.Status:
			continue
		}
		if !same(issue.Type, filter.Type) || !same(issue.Category, category) ||
			!same(issue.Assignee, filter.Assignee) || !same(issue.ParentID, filter.ParentID) {
			continue
		}
		if filter.Priority != nil && (issue.Priority == nil || *issue.Priority != *filter.Priority) {
			continue
		}
		if filter.ChangedSince != nil {
			// Compared as moments, not as text: a tracker may write its
			// times with an offset, and the caller's may be written another
			// way. An issue whose time cannot be read is not let through.
			if issue.UpdatedAt == nil {
				continue
			}
			updated, ok := ParseMoment(*issue.UpdatedAt)
			if !ok || updated.Before(since) {
				continue
			}
		}
		found = append(found, issue)
	}
	return found, nil
}
