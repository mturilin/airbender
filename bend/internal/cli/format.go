// format.go — how issues are printed for a reader.
//
// What: the plain-text forms of a list of issues, one issue in full, its
// comments, the repository's status, and saved facts.
//
// Why: the same answers are also available as JSON (--json) for programs;
// this file is the form meant to be read, by a person or by an agent, and
// is kept apart from the command logic so that either can change alone.
//
// Design notes:
//   - One line per issue in lists, the id first, so a line can be cut down
//     to its id with standard tools.
//   - A part that is empty is left out of the full view; nothing is printed
//     as a bare heading.
//   - Pure functions.

package cli

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mturilin/airbender/bend/internal/facts"
	"github.com/mturilin/airbender/bend/internal/kept"
	"github.com/mturilin/airbender/bend/internal/setup"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// priorityOf is "P2", or "" when the issue has no priority.
func priorityOf(issue tracker.Issue) string {
	if issue.Priority == nil {
		return ""
	}
	return fmt.Sprintf("P%d", *issue.Priority)
}

// shownStatus is the status shown for an issue: "blocked" wins over its
// stored status.
func shownStatus(issue tracker.Issue) string {
	if issue.Status != "closed" && len(issue.BlockedBy) > 0 {
		return "blocked"
	}
	return issue.Status
}

// orEmpty gives the text a pointer points at, or "" for nil.
func orEmpty(text *string) string {
	if text == nil {
		return ""
	}
	return *text
}

// FormatList gives one line per issue: id, status, priority, type, title,
// category.
func FormatList(issues []tracker.Issue) string {
	if len(issues) == 0 {
		return "No issues."
	}
	idWidth := 0
	for _, issue := range issues {
		idWidth = max(idWidth, utf8.RuneCountInString(issue.ID))
	}
	lines := make([]string, 0, len(issues))
	for _, issue := range issues {
		title := issue.Title
		if issue.Category != nil {
			title += "  [" + *issue.Category + "]"
		}
		lines = append(lines, strings.Join([]string{
			padEnd(issue.ID, idWidth),
			padEnd(shownStatus(issue), 11),
			padEnd(priorityOf(issue), 2),
			padEnd(orEmpty(issue.Type), 8),
			title,
		}, "  "))
	}
	return strings.Join(lines, "\n")
}

// refLine is "id title" for a pointer to another issue, marked when it is
// closed.
func refLine(id, title, status string) string {
	line := id + "  " + title
	if status == "closed" {
		line += "  (closed)"
	}
	return line
}

// FormatIssue gives one issue in full.
func FormatIssue(issue tracker.Issue) string {
	shown := []string{}
	for _, fact := range []string{
		shownStatus(issue),
		priorityOf(issue),
		orEmpty(issue.Type),
		prefixed("category ", issue.Category),
		prefixed("assigned to ", issue.Assignee),
	} {
		if fact != "" {
			shown = append(shown, fact)
		}
	}
	lines := []string{issue.ID + "  " + issue.Title, strings.Join(shown, " · ")}
	if issue.ParentID != nil {
		lines = append(lines, "Sub-issue of "+*issue.ParentID)
	}
	if len(issue.Labels) > 0 {
		lines = append(lines, "Labels: "+strings.Join(issue.Labels, ", "))
	}
	if issue.CloseReason != "" {
		lines = append(lines, "Closed because: "+issue.CloseReason)
	}
	block := func(heading string, items []string) {
		if len(items) == 0 {
			return
		}
		lines = append(lines, "", heading+":")
		for _, item := range items {
			lines = append(lines, "  "+item)
		}
	}
	waits := []string{}
	for _, ref := range issue.BlockedBy {
		waits = append(waits, refLine(ref.ID, ref.Title, ref.Status))
	}
	block("Waits for", waits)
	links := []string{}
	for _, link := range issue.Links {
		if link.Direction == "out" {
			links = append(links, link.Kind+"  "+refLine(link.ID, link.Title, link.Status))
		} else {
			links = append(links, refLine(link.ID, link.Title, link.Status)+"  — "+link.Kind+" this")
		}
	}
	block("Links", links)
	subs := []string{}
	for _, sub := range issue.SubIssues {
		subs = append(subs, padEnd(sub.Status, 11)+"  "+sub.ID+"  "+sub.Title)
	}
	block("Sub-issues", subs)
	part := func(heading, text string) {
		if text = strings.TrimSpace(text); text != "" {
			lines = append(lines, "", heading, text)
		}
	}
	part("DESCRIPTION", issue.Description)
	part("REQUIREMENTS", issue.Requirements)
	part("DONE MEANS", issue.Done)
	part("PLAN", issue.Plan)
	part("NOTES", issue.Notes)
	if issue.Unsent > 0 {
		lines = append(lines, "", plural(issue.Unsent, "change")+" made here not yet on the tracker: bend sync")
	}
	if issue.CommentCount > 0 {
		word := "comments"
		if issue.CommentCount == 1 {
			word = "comment"
		}
		lines = append(lines, "", fmt.Sprintf("%d %s: bend comments %s", issue.CommentCount, word, issue.ID))
	}
	return strings.Join(lines, "\n")
}

// prefixed gives words followed by the text, or "" when there is no text.
func prefixed(words string, text *string) string {
	if text == nil {
		return ""
	}
	return words + *text
}

// FormatComments gives an issue's comments, oldest first.
func FormatComments(comments []tracker.Comment) string {
	if len(comments) == 0 {
		return "No comments."
	}
	blocks := make([]string, 0, len(comments))
	for _, comment := range comments {
		when := comment.CreatedAt
		if len(when) > 16 {
			when = when[:16]
		}
		blocks = append(blocks,
			strings.Replace(when, "T", " ", 1)+"  "+comment.Author+"\n"+strings.TrimSpace(comment.Text))
	}
	return strings.Join(blocks, "\n\n")
}

// FormatStatus gives what `bend status` prints.
func FormatStatus(capabilities tracker.Capabilities) string {
	lines := []string{
		"Tracker   " + capabilities.Tracker,
		"Folder    " + capabilities.Where,
	}
	group := func(level, mark, heading string) {
		items := []tracker.Support{}
		width := 0
		for _, item := range capabilities.Supports {
			if item.Level == level {
				items = append(items, item)
				width = max(width, utf8.RuneCountInString(item.Name))
			}
		}
		if len(items) == 0 {
			return
		}
		lines = append(lines, "", heading)
		for _, item := range items {
			lines = append(lines, strings.TrimRight("  "+mark+" "+padEnd(item.Name, width)+"  "+item.Note, " "))
		}
	}
	group("yes", "✓", "Supported here")
	group("another way", "~", "Stored another way")
	group("no", "✗", "Not available")
	if len(capabilities.Warnings) > 0 {
		lines = append(lines, "", "Worth knowing")
		for _, warning := range capabilities.Warnings {
			lines = append(lines, "  ! "+warning)
		}
	}
	return strings.Join(lines, "\n")
}

// FormatAbout gives what `bend status --quick` prints.
func FormatAbout(about tracker.About) string {
	lines := []string{"Tracker     " + about.Tracker}
	if about.Repository != nil {
		lines = append(lines, "Repository  "+*about.Repository)
	}
	return strings.Join(append(lines, "Link kinds  "+strings.Join(about.LinkKinds, ", ")), "\n")
}

// FormatFacts gives saved facts, one per line.
func FormatFacts(found []facts.Fact) string {
	if len(found) == 0 {
		return "No saved facts."
	}
	lines := make([]string, 0, len(found))
	for _, fact := range found {
		lines = append(lines, fact.Key+": "+fact.Text)
	}
	return strings.Join(lines, "\n")
}

// FormatSetup gives what `bend setup` prints: every step with its state,
// and for a missing one what it would do and the command that does it.
func FormatSetup(state *setup.State) string {
	lines := []string{"Folder    " + state.Root}
	if state.Tracker != nil {
		kept := *state.Tracker
		if state.Repository != nil {
			kept += " (" + *state.Repository + ")"
		}
		lines = append(lines, "Tracker   "+kept)
	}
	marks := map[string]string{setup.Done: "✓", setup.Missing: "✗", setup.Blocked: "…", setup.NotNeeded: "-"}
	width := 0
	for _, step := range state.Steps {
		width = max(width, utf8.RuneCountInString(step.Name))
	}
	lines = append(lines, "")
	for _, step := range state.Steps {
		lines = append(lines, marks[step.State]+" "+padEnd(step.Name, width)+"  "+step.Title)
		indent := strings.Repeat(" ", width+4)
		if step.State != setup.Done {
			lines = append(lines, indent+step.Why)
		}
		if step.State != setup.Missing {
			continue
		}
		for _, point := range step.Explain {
			lines = append(lines, indent+"- "+point)
		}
		if step.Runs != "" {
			lines = append(lines, indent+"It runs: "+step.Runs)
		}
		lines = append(lines, indent+"To do it: "+step.Command)
	}
	lines = append(lines, "")
	if state.Ready {
		lines = append(lines, "Everything is in place.")
	} else {
		lines = append(lines, "✓ done   ✗ missing   … waits for an earlier step   - not needed here", "To do every missing step in order: bend setup all")
	}
	return strings.Join(lines, "\n")
}

// FormatCopy gives the lines `bend status` adds about the copy a hosted
// tracker is worked from; "" where there is none.
func FormatCopy(status *kept.Status) string {
	if status == nil {
		return ""
	}
	synced := "never"
	if status.LastSync != nil {
		synced = strings.Replace(strings.TrimSuffix(*status.LastSync, "Z"), "T", " ", 1) + " UTC"
	}
	lines := []string{
		"",
		"Local copy",
		"  Kept in      " + status.Folder,
	}
	if status.Straight {
		// Changes go straight to the tracker: only how fresh matters.
		lines = append(lines, "  Last reread  "+synced)
	} else {
		lines = append(lines,
			"  Last synced  "+synced,
			"  Waiting      "+plural(status.Waiting, "change")+" made here not yet on the tracker")
	}
	if status.Refused > 0 {
		lines = append(lines, "  Refused      "+plural(status.Refused, "change")+" the tracker will not take: bend refused")
	}
	return "\n" + strings.Join(lines[1:], "\n")
}

// changesWords gives changes as "id (kinds), id (kinds)".
func changesWords(changes []tracker.SyncChange) string {
	words := make([]string, 0, len(changes))
	for _, change := range changes {
		words = append(words, change.ID+" ("+strings.Join(change.Kinds, ", ")+")")
	}
	return strings.Join(words, ", ")
}

// when gives a moment (milliseconds since 1970) in local time.
func when(at int64) string {
	return time.UnixMilli(at).Local().Format("2006-01-02 15:04")
}

// FormatEntry gives what `bend sync` prints: how one sync ended, what was
// sent and what came in.
func FormatEntry(entry kept.Entry) string {
	lines := []string{}
	switch entry.End {
	case tracker.SyncBusy:
		return "Another sync is running; nothing to do."
	case tracker.SyncSynced:
		lines = append(lines, "Synced.")
	default:
		lines = append(lines, "The sync did not work ("+string(entry.End)+").")
	}
	if entry.Message != "" {
		lines = append(lines, entry.Message)
	}
	switch {
	case entry.End != tracker.SyncSynced && entry.Sent == nil:
	case entry.Sent == nil:
		lines = append(lines, "Sent: not known.")
	case len(entry.Sent) == 0:
		lines = append(lines, "Sent: nothing.")
	default:
		lines = append(lines, "Sent: "+changesWords(entry.Sent)+".")
	}
	switch {
	case entry.End != tracker.SyncSynced && entry.BroughtIn == nil:
	case entry.BroughtIn == nil:
		lines = append(lines, "Brought in: not known.")
	case len(entry.BroughtIn) == 0:
		lines = append(lines, "Brought in: nothing.")
	default:
		lines = append(lines, "Brought in: "+strings.Join(entry.BroughtIn, ", ")+".")
	}
	if entry.Waiting > 0 {
		lines = append(lines, plural(entry.Waiting, "change")+" still waiting to be sent.")
	}
	return strings.Join(lines, "\n")
}

// FormatTrouble gives what is wrong with the syncing, for a terminal.
func FormatTrouble(trouble kept.Trouble) string {
	lines := []string{"Sync trouble", "  " + trouble.Title}
	if trouble.Since > 0 {
		lines = append(lines, "  Since "+when(trouble.Since)+".")
	}
	if trouble.Message != "" {
		lines = append(lines, "  "+strings.ReplaceAll(trouble.Message, "\n", "\n  "))
	}
	return strings.Join(append(lines, "  "+trouble.Advice), "\n")
}

// FormatSyncState gives what `bend sync --status` prints.
func FormatSyncState(state kept.SyncState) string {
	if state.Remote == nil {
		return "The issues are synced with nothing: they are on this computer only.\n`bend setup` shows the step that publishes them."
	}
	lines := []string{"Synced with  " + *state.Remote}
	switch {
	case state.Running:
		lines = append(lines, "Now          a sync is running")
	case state.Halted:
		lines = append(lines, "Now          stopped until a sync that is asked for ends well")
	}
	if state.Last == nil {
		lines = append(lines, "Last sync    none from this computer yet")
	} else {
		lines = append(lines, "Last sync    "+when(state.Last.At)+", "+string(state.Last.End)+" ("+state.Last.Cause+")")
	}
	if state.SyncedAt != nil && (state.Last == nil || state.Last.End != tracker.SyncSynced) {
		lines = append(lines, "Last good    "+when(*state.SyncedAt))
	}
	switch {
	case state.Pending == nil:
		lines = append(lines, "Waiting      not known")
	case len(state.Pending) == 0:
		lines = append(lines, "Waiting      nothing to send")
	default:
		lines = append(lines, "Waiting      "+changesWords(state.Pending))
	}
	lines = append(lines, "Helper       "+helperWords(state.Helper))
	text := strings.Join(lines, "\n")
	if state.Trouble != nil {
		text += "\n\n" + FormatTrouble(*state.Trouble)
	}
	return text
}

// helperWords says how the helper stands in a few words.
func helperWords(state kept.HelperState) string {
	switch {
	case state.Disabled:
		return "disabled in this repository (bend helper enable)"
	case state.Running:
		return "running since " + when(state.Since)
	case state.HeldBackUntil > 0:
		return "not running: syncs kept failing; not started again by itself before " + when(state.HeldBackUntil)
	}
	return "not running; the next bend command starts it"
}

// FormatHelper gives what `bend helper` prints.
func FormatHelper(state kept.HelperState, runs []kept.Entry) string {
	lines := []string{"The helper is " + helperWords(state) + "."}
	for _, entry := range runs {
		if entry.Cause == kept.CauseTimer {
			lines = append(lines, "It last synced "+when(entry.At)+" ("+string(entry.End)+").")
			break
		}
	}
	return strings.Join(lines, "\n")
}

// FormatRuns gives what `bend sync --log` prints.
func FormatRuns(runs []kept.Entry) string {
	if len(runs) == 0 {
		return "No syncs to list."
	}
	lines := make([]string, 0, len(runs))
	for _, entry := range runs {
		line := when(entry.At) + "  " + string(entry.End) + "  (" + entry.Cause + ")"
		if entry.Runs > 1 {
			line += "  ×" + strconv.Itoa(entry.Runs)
		}
		if len(entry.Sent) > 0 {
			line += "  sent " + changesWords(entry.Sent)
		}
		if len(entry.BroughtIn) > 0 {
			line += "  brought in " + strings.Join(entry.BroughtIn, ", ")
		}
		if entry.Message != "" {
			line += "\n    " + strings.ReplaceAll(entry.Message, "\n", "\n    ")
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// FormatRefused gives what `bend refused` prints.
func FormatRefused(refused []kept.RefusedChange) string {
	if len(refused) == 0 {
		return "No refused changes."
	}
	blocks := make([]string, 0, len(refused))
	for _, one := range refused {
		block := fmt.Sprintf("%d  issue %s: %s\n   Refused: %s", one.Seq, one.Issue, one.What, one.Reason)
		if text := strings.TrimSpace(one.Text); text != "" {
			block += "\n   " + strings.ReplaceAll(text, "\n", "\n   ")
		}
		blocks = append(blocks, block)
	}
	return strings.Join(blocks, "\n\n") +
		"\n\nbend refused --dismiss <number|all> takes one off this list; --again <number|all> sends it once more."
}
