// Package beads is the adapter for beads (the `bd` command-line tool).
//
// What: implements tracker.Tracker on top of `bd`: turns beads' rows into
// the common Issue shape, and each operation into bd commands.
//
// Why: beads is the first tracker the owner uses. Everything beads-specific
// in bend lives in this one package.
//
// Design notes:
//   - Reads use one `bd --readonly list --all --json` and work the rest out
//     in memory (links from both ends, sub-issues, what blocks what), so every
//     answer is one consistent snapshot. Beads' `show` gives an issue's links
//     in one direction only.
//   - Where the parts are kept: description, done and plan are beads' own
//     description, acceptance criteria and design; notes are notes.
//     Requirements have no field in beads and are kept as a marked section
//     inside the description (tracker/parts.go); Capabilities says so.
//   - The category is the label `category:<name>`. A new sub-issue takes its
//     parent's category and none of its parent's other labels: bd would copy
//     them all, and callers keep things of their own in labels (the Airbender
//     tab keeps an issue's workflow step there), which must not be inherited.
//   - Links: "blocked-by" is beads' dependency type "blocks" (stored on the
//     issue that waits); "discovered-from" is the same name in beads;
//     "related" goes through `bd dep relate`, beads' see-also command. Beads'
//     other dependency types (ownKinds) are accepted under beads' own names.
//   - Refusals are worded for any caller: they name no command of bend or of
//     bd, because the Airbender tab shows them on a screen.
//   - Free text is never put where bd could read it as an option: it is the
//     value of a named flag, or is sent on standard input. No shell is used.
//
// Gotchas:
//   - With --json, bd may report an error on standard output as
//     `{"error": ...}`; that is read before falling back to standard error.
//   - bd prints `null` where an empty list would be expected.
//   - Beads keeps one link per ordered pair of issues, whatever its kind.
//   - `bd close` refuses an issue that still has open sub-issues; its message
//     is passed on.
//   - A missing folder and a missing program look the same to the operating
//     system; the caller (detect) checks the folder first.
package beads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

const (
	// categoryPrefix is the label prefix that holds an issue's category.
	categoryPrefix = "category:"
	// closed is beads' status for a finished issue.
	closed = "closed"
	// bdTimeout is how long one bd command may take.
	bdTimeout = 30 * time.Second
)

// Dependency is one link as beads stores it on the issue it is about.
type Dependency struct {
	DependsOnID string `json:"depends_on_id"`
	Type        string `json:"type"`
}

// Row is one row of `bd list --json`, limited to what is used; all else is
// ignored.
type Row struct {
	ID                 string   `json:"id"`
	Title              string   `json:"title"`
	Status             string   `json:"status"`
	Description        string   `json:"description"`
	Design             string   `json:"design"`
	AcceptanceCriteria string   `json:"acceptance_criteria"`
	Notes              string   `json:"notes"`
	CloseReason        string   `json:"close_reason"`
	CommentCount       int      `json:"comment_count"`
	Priority           *int     `json:"priority"`
	IssueType          *string  `json:"issue_type"`
	Assignee           *string  `json:"assignee"`
	Parent             *string  `json:"parent"`
	Labels             []string `json:"labels"`
	CreatedAt          *string  `json:"created_at"`
	UpdatedAt          *string  `json:"updated_at"`
	// Metadata is free-form data kept with the issue.
	Metadata json.RawMessage `json:"metadata"`
	// ExternalRef is the issue's counterpart in another tracker, when it has
	// one.
	ExternalRef  *string      `json:"external_ref"`
	Dependencies []Dependency `json:"dependencies"`
}

// kindOf maps beads' dependency types to the common link kinds they are
// shown as.
var kindOf = map[string]string{
	"blocks":          "blocked-by",
	"discovered-from": "discovered-from",
	"related":         "related",
	"relates-to":      "related",
}

// ownKinds are beads' dependency types beyond the common three, accepted by
// Link under beads' own names.
var ownKinds = []string{"tracks", "until", "caused-by", "validates", "supersedes"}

// shownKind is the kind a beads dependency type is shown as: the common
// name where there is one, else beads' own.
func shownKind(dependencyType string) string {
	if kind, ok := kindOf[dependencyType]; ok {
		return kind
	}
	return dependencyType
}

// twoWay says whether a kind reads the same from both ends.
func twoWay(kind string) bool { return kind == "related" }

// allKinds is every kind of link Link accepts.
func allKinds() []string { return append(slices.Clone(tracker.LinkKinds), ownKinds...) }

// ToIssues turns beads' rows into issues in the common shape.
//
// Pure: rows in, issues out. Links are listed from both ends; a two-way
// link stored on both issues is listed once per issue. BlockedBy holds the
// unfinished issues an open issue waits for, its own and those of the open
// issues it sits inside (beads' own rule: a sub-issue of a blocked issue is
// blocked). A loop in the parent data is not followed.
func ToIssues(rows []Row) []tracker.Issue {
	byID := make(map[string]*Row, len(rows))
	for index := range rows {
		byID[rows[index].ID] = &rows[index]
	}
	ref := func(row *Row) tracker.IssueRef {
		return tracker.IssueRef{ID: row.ID, Title: row.Title, Status: row.Status}
	}
	links := map[string][]tracker.Link{}
	add := func(owner string, link tracker.Link) {
		// A two-way link stored on both issues would otherwise show twice.
		for _, known := range links[owner] {
			if known.ID == link.ID && known.Kind == link.Kind &&
				(twoWay(link.Kind) || known.Direction == link.Direction) {
				return
			}
		}
		links[owner] = append(links[owner], link)
	}
	direct := map[string][]tracker.IssueRef{}
	for index := range rows {
		row := &rows[index]
		for _, dependency := range row.Dependencies {
			if dependency.Type == "parent-child" {
				continue
			}
			other, known := byID[dependency.DependsOnID]
			// A link to an issue outside this list has no title to show.
			if !known {
				continue
			}
			kind := shownKind(dependency.Type)
			add(row.ID, tracker.Link{ID: other.ID, Title: other.Title, Status: other.Status, Kind: kind, Direction: "out"})
			direction := "in"
			if twoWay(kind) {
				direction = "out"
			}
			add(other.ID, tracker.Link{ID: row.ID, Title: row.Title, Status: row.Status, Kind: kind, Direction: direction})
			if dependency.Type == "blocks" && row.Status != closed && other.Status != closed {
				direct[row.ID] = append(direct[row.ID], ref(other))
			}
		}
	}
	children := map[string][]tracker.IssueRef{}
	for index := range rows {
		row := &rows[index]
		if row.Parent == nil || byID[*row.Parent] == nil {
			continue
		}
		children[*row.Parent] = append(children[*row.Parent], ref(row))
	}
	parentOf := func(row *Row) *Row {
		if row.Parent == nil {
			return nil
		}
		return byID[*row.Parent]
	}
	issues := make([]tracker.Issue, 0, len(rows))
	for index := range rows {
		row := &rows[index]
		blockedBy := slices.Clone(direct[row.ID])
		if row.Status != closed {
			seen := map[string]bool{row.ID: true}
			for parent := parentOf(row); parent != nil && !seen[parent.ID]; parent = parentOf(parent) {
				seen[parent.ID] = true
				if parent.Status == closed {
					continue
				}
				for _, blocker := range direct[parent.ID] {
					if !slices.ContainsFunc(blockedBy, func(known tracker.IssueRef) bool { return known.ID == blocker.ID }) {
						blockedBy = append(blockedBy, blocker)
					}
				}
			}
		}
		// Lower-cased on the way in as well as on the way out
		// (CleanCategory), so a label written with capitals by hand still
		// counts as the same category.
		var category *string
		labels := []string{}
		for _, label := range row.Labels {
			if !strings.HasPrefix(label, categoryPrefix) {
				labels = append(labels, label)
				continue
			}
			name := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(label, categoryPrefix)))
			if category == nil {
				// Only the first category label counts; an empty one is none.
				category = &name
			}
		}
		if category != nil && *category == "" {
			category = nil
		}
		description, requirements := tracker.SplitRequirements(row.Description)
		updatedAt := row.UpdatedAt
		if updatedAt == nil {
			updatedAt = row.CreatedAt
		}
		// Anything that is not a plain object counts as none.
		var metadata json.RawMessage
		if trimmed := bytes.TrimSpace(row.Metadata); len(trimmed) > 0 && trimmed[0] == '{' {
			metadata = trimmed
		}
		issues = append(issues, tracker.Issue{
			ID:           row.ID,
			Title:        row.Title,
			Status:       row.Status,
			Type:         row.IssueType,
			Priority:     row.Priority,
			Category:     category,
			Assignee:     row.Assignee,
			ParentID:     row.Parent,
			Description:  description,
			Requirements: requirements,
			Done:         row.AcceptanceCriteria,
			Plan:         row.Design,
			Notes:        row.Notes,
			CloseReason:  row.CloseReason,
			Labels:       labels,
			Links:        links[row.ID],
			SubIssues:    children[row.ID],
			BlockedBy:    blockedBy,
			CommentCount: row.CommentCount,
			CreatedAt:    row.CreatedAt,
			UpdatedAt:    updatedAt,
			Metadata:     metadata,
			ExternalRef:  row.ExternalRef,
		}.Tidy())
	}
	return issues
}

// DescendantIDs gives every id inside rootID, at any depth, by the parents
// in rows. Guarded against a loop in the data: each issue is taken once.
func DescendantIDs(rootID string, rows []Row) map[string]bool {
	found := map[string]bool{}
	queue := []string{rootID}
	for len(queue) > 0 {
		parentID := queue[0]
		queue = queue[1:]
		for _, row := range rows {
			if row.Parent == nil || *row.Parent != parentID || found[row.ID] || row.ID == rootID {
				continue
			}
			found[row.ID] = true
			queue = append(queue, row.ID)
		}
	}
	return found
}

var (
	// errorPrefix is what bd puts before the reason of some errors.
	errorPrefix = regexp.MustCompile(`^Error( updating \S+)?:\s*`)
	// assignedTo is bd's refusal to close an issue assigned to someone else.
	assignedTo = regexp.MustCompile(`assignee is "(.*?)", actor is "(.*?)"`)
	// cycle is bd's refusal of a link that would make a loop.
	cycle = regexp.MustCompile(`(?i)would create a cycle`)
	// useForce is bd's advice to use an option the caller does not have.
	useForce = regexp.MustCompile(`;? ?(close children first )?or use --force to override`)
)

// removeFirstAdvice is bd's advice to use a bd command.
const removeFirstAdvice = "; remove it first with 'bd dep remove' then re-add"

// Explain turns one of bd's error messages into words that make sense to
// any caller: without bd's own prefixes, and without advice to use bd
// commands or options the caller does not have.
func Explain(message string) string {
	// bd adds usage text after some errors; the first line is the reason.
	reason := strings.TrimSpace(errorPrefix.ReplaceAllString(strings.Split(message, "\n")[0], ""))
	if assigned := assignedTo.FindStringSubmatch(reason); assigned != nil {
		return "The issue is assigned to " + assigned[1] + ", and you are acting as " + assigned[2] +
			". Close it as " + assigned[1] + ", or change its assignee first."
	}
	if cycle.MatchString(reason) {
		return "That would make a loop: one of the two already depends on the other."
	}
	// Only the first of each is replaced, as bd writes each once.
	if at := useForce.FindStringSubmatchIndex(reason); at != nil {
		instead := ""
		if at[2] != -1 {
			instead = "; close them first"
		}
		reason = reason[:at[0]] + instead + reason[at[1]:]
	}
	return strings.Replace(reason, removeFirstAdvice, "", 1)
}

// storedLink gives the link stored on from that points at to, of any kind
// but parent-child; nil when there is none.
func storedLink(from *Row, to string) *Dependency {
	for index := range from.Dependencies {
		dependency := &from.Dependencies[index]
		if dependency.DependsOnID == to && dependency.Type != "parent-child" {
			return dependency
		}
	}
	return nil
}

// Tracker is the beads adapter for one folder. Make one with New.
type Tracker struct {
	// dir is a folder inside the repository; bd finds its database from
	// there upward.
	dir string
	// actor is who is acting, for beads' history; "" leaves bd's own default
	// (the git user).
	actor string
	// command is the bd program to run.
	command string
	// home is the folder the repository's `.beads` folder is in; "" when it
	// was not said.
	home string
}

// New builds the beads adapter for one folder.
//
// dir is a folder inside the repository. actor is who is acting, or "".
// command is the bd program to run; "" means `bd` on the PATH.
// Side effects: none until a method is called. Reads run `bd --readonly`;
// the changing methods write to the beads database.
func New(dir, actor, command string) *Tracker {
	if command == "" {
		command = "bd"
	}
	return &Tracker{dir: dir, actor: actor, command: command}
}

// At says where beads keeps the repository's database: the folder whose
// `.beads` folder beads itself writes to. From a work tree that is the
// repository's main folder, not the work tree, although a work tree has a
// `.beads` folder of its own (the checked-in settings).
// Without it the tracker has no sign to give (see Sign), and a copy of its
// issues is believed only for a short while.
func (beads *Tracker) At(home string) *Tracker {
	beads.home = home
	return beads
}

// SignFile is the file whose change is beads' sign (see Sign), for a
// caller that watches for it; "" when where beads keeps its files was not
// said.
func (beads *Tracker) SignFile() string {
	if beads.home == "" {
		return ""
	}
	return filepath.Join(beads.home, ".beads", "last-touched")
}

// Sign gives beads' own mark of "something changed": the time and size of
// the small file it rewrites on every change to an issue made through it.
// Not on a delete, and not when a sync brings changes in; a copy's age
// covers those.
func (beads *Tracker) Sign() string {
	if beads.home == "" {
		return "unknown"
	}
	file, err := os.Stat(beads.SignFile())
	if err != nil {
		// Not written yet: its first writing is a change of the sign.
		return "absent"
	}
	return strconv.FormatInt(file.ModTime().UnixNano(), 10) + "." + strconv.FormatInt(file.Size(), 10)
}

// bd runs one bd command and gives its standard output.
//
// input, when not nil, is text to send on standard input, for commands that
// read free text from there.
// Fails with Refused carrying bd's own message when the command fails; with
// the kind no-program when bd is not installed; not-set-up when the folder
// has no beads database.
func (beads *Tracker) bd(args []string, input *string) (string, error) {
	if beads.actor != "" {
		args = append([]string{"--actor", beads.actor}, args...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), bdTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, beads.command, args...)
	command.Dir = beads.dir
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if input != nil {
		command.Stdin = strings.NewReader(*input)
	}
	err := command.Run()
	if err == nil {
		return stdout.String(), nil
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return "", tracker.Failed(tracker.KindNoProgram,
			"The beads program (%s) was not found. Install beads, or say where it is installed.", beads.command)
	}
	detail := strings.TrimSpace(stderr.String())
	if detail == "" {
		detail = strings.TrimSpace(stdout.String())
	}
	if detail == "" {
		detail = err.Error()
	}
	var reported struct {
		Error *string `json:"error"`
	}
	if json.Unmarshal(stdout.Bytes(), &reported) == nil && reported.Error != nil {
		detail = *reported.Error
	}
	if strings.Contains(strings.ToLower(detail), "no beads database found") {
		return "", tracker.Failed(tracker.KindNotSetUp, "This folder has no beads database yet.")
	}
	return "", tracker.Refused("%s", Explain(detail))
}

// bdJSON runs a bd command and reads its answer as JSON into answer; bd's
// `null` leaves answer as it was (an empty list).
func (beads *Tracker) bdJSON(args []string, answer any) error {
	out, err := beads.bd(args, nil)
	if err != nil {
		return err
	}
	if json.Unmarshal([]byte(out), answer) != nil {
		return tracker.Refused("bd answered in a format this program does not understand. It may be a newer or older bd than it was written for.")
	}
	return nil
}

// rows gives every issue of the repository, as beads gives them.
func (beads *Tracker) rows() ([]Row, error) {
	var all []Row
	err := beads.bdJSON([]string{"--readonly", "list", "--all", "--json", "--limit", "0"}, &all)
	return all, err
}

// need gives the row for id, or a refusal naming it.
func need(all []Row, id string) (*Row, error) {
	for index := range all {
		if all[index].ID == id {
			return &all[index], nil
		}
	}
	return nil, tracker.Refused("There is no issue with id %s.", id)
}

// needIn reads every row and gives them with the one for id.
func (beads *Tracker) needIn(id string) ([]Row, *Row, error) {
	all, err := beads.rows()
	if err != nil {
		return nil, nil, err
	}
	row, err := need(all, id)
	return all, row, err
}

// byIDs gives the issues with these ids, in the order of ids; unknown ids
// are skipped.
func (beads *Tracker) byIDs(ids []string) ([]tracker.Issue, error) {
	rows, err := beads.rows()
	if err != nil {
		return nil, err
	}
	all := map[string]tracker.Issue{}
	for _, issue := range ToIssues(rows) {
		all[issue.ID] = issue
	}
	found := []tracker.Issue{}
	for _, id := range ids {
		if issue, ok := all[id]; ok {
			found = append(found, issue)
		}
	}
	return found, nil
}

// About says what is known without running bd.
func (beads *Tracker) About() tracker.About {
	return tracker.About{Tracker: "beads", Repository: nil, LinkKinds: allKinds(), Writes: tracker.WritesStraight}
}

// Capabilities says what beads holds and how.
//
// Side effects: one bd command, to see whether the database is synced
// anywhere.
func (beads *Tracker) Capabilities() (tracker.Capabilities, error) {
	warnings := []string{}
	// Beads keeps its issues in a local database. Unless a remote is set up
	// for it, they exist on this machine only.
	remotes, _ := beads.bd([]string{"dolt", "remote", "list"}, nil)
	if strings.Contains(strings.ToLower(remotes), "no remotes configured") || strings.TrimSpace(remotes) == "" {
		warnings = append(warnings,
			"The beads database is not synced anywhere: the issues exist on this machine only (see `bd dolt remote`).")
	}
	return tracker.Capabilities{
		Tracker:   "beads",
		Where:     beads.dir,
		LinkKinds: allKinds(),
		Supports: []tracker.Support{
			{Name: "sub-issues", Level: "yes"},
			{Name: "comments", Level: "yes"},
			{Name: "type", Level: "yes"},
			{Name: "priority", Level: "yes"},
			{Name: "assignee", Level: "yes"},
			{Name: "links: blocked-by, discovered-from, related", Level: "yes"},
			{Name: "description, done, plan, notes", Level: "yes"},
			{Name: "category", Level: "another way", Note: "kept as the label category:<name>"},
			{Name: "requirements", Level: "another way", Note: "kept as a marked section inside the description"},
			{Name: "decisions and hand-overs", Level: "another way", Note: "kept as comments with a fixed opening"},
			{Name: "ready for the owner to validate", Level: "another way", Note: "a hand-over comment on an issue left in progress"},
		},
		Warnings: warnings,
	}, nil
}

// List gives the issues the filter lets through; open ones by default.
func (beads *Tracker) List(filter tracker.ListFilter) ([]tracker.Issue, error) {
	// Checked before bd is run, so that a wrong request costs nothing.
	if _, err := tracker.Narrow(nil, filter); err != nil {
		return nil, err
	}
	rows, err := beads.rows()
	if err != nil {
		return nil, err
	}
	return tracker.Narrow(ToIssues(rows), filter)
}

// idsFrom runs a bd command that answers with a list of rows and gives
// their ids.
func (beads *Tracker) idsFrom(args []string) ([]string, error) {
	var found []struct {
		ID string `json:"id"`
	}
	if err := beads.bdJSON(args, &found); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(found))
	for _, row := range found {
		ids = append(ids, row.ID)
	}
	return ids, nil
}

// Ready gives the issues that can be worked on now.
func (beads *Tracker) Ready() ([]tracker.Issue, error) {
	// "Can be worked on now" is beads' own judgement, not re-derived here.
	ids, err := beads.idsFrom([]string{"--readonly", "ready", "--json", "--limit", "0"})
	if err != nil {
		return nil, err
	}
	return beads.byIDs(ids)
}

// Show gives one issue in full.
func (beads *Tracker) Show(id string) (tracker.Issue, error) {
	all, _, err := beads.needIn(id)
	if err != nil {
		return tracker.Issue{}, err
	}
	for _, issue := range ToIssues(all) {
		if issue.ID == id {
			return issue, nil
		}
	}
	return tracker.Issue{}, tracker.Refused("There is no issue with id %s.", id)
}

// Comments gives an issue's comments, oldest first.
func (beads *Tracker) Comments(id string) ([]tracker.Comment, error) {
	if _, _, err := beads.needIn(id); err != nil {
		return nil, err
	}
	var found []struct {
		// ID is a number in some versions of bd and a text in others.
		ID        json.RawMessage `json:"id"`
		Author    string          `json:"author"`
		Text      string          `json:"text"`
		CreatedAt string          `json:"created_at"`
	}
	if err := beads.bdJSON([]string{"--readonly", "comments", id, "--json"}, &found); err != nil {
		return nil, err
	}
	comments := make([]tracker.Comment, 0, len(found))
	for _, row := range found {
		commentID := string(row.ID)
		if unquoted, err := strconv.Unquote(commentID); err == nil {
			commentID = unquoted
		}
		comments = append(comments, tracker.Comment{
			ID: commentID, Author: row.Author, CreatedAt: row.CreatedAt, Text: row.Text,
		})
	}
	sort.SliceStable(comments, func(left, right int) bool {
		return comments[left].CreatedAt < comments[right].CreatedAt
	})
	return comments, nil
}

// Search finds issues by words in the title or id, by beads' own search.
func (beads *Tracker) Search(text string) ([]tracker.Issue, error) {
	ids, err := beads.idsFrom([]string{"--readonly", "search", text, "--json", "--limit", "0"})
	if err != nil {
		return nil, err
	}
	return beads.byIDs(ids)
}

// Create makes a new issue and returns its id.
//
// Side effects: one bd command to create it, and one for each issue it
// waits for.
func (beads *Tracker) Create(draft tracker.Draft) (string, error) {
	all, err := beads.rows()
	if err != nil {
		return "", err
	}
	mentioned := []*string{draft.ParentID, draft.From}
	for index := range draft.BlockedBy {
		mentioned = append(mentioned, &draft.BlockedBy[index])
	}
	for _, id := range mentioned {
		if id == nil {
			continue
		}
		if _, err := need(all, *id); err != nil {
			return "", err
		}
	}
	args := []string{"create", "--json", "--title", draft.Title}
	if draft.Description != nil && strings.TrimSpace(*draft.Description) != "" {
		args = append(args, "--description", *draft.Description)
	}
	if draft.Done != nil && strings.TrimSpace(*draft.Done) != "" {
		args = append(args, "--acceptance", *draft.Done)
	}
	if draft.Type != nil {
		args = append(args, "--type", *draft.Type)
	}
	if draft.Priority != nil {
		args = append(args, "--priority", strconv.Itoa(*draft.Priority))
	}
	// bd would copy all of a parent's labels onto a new sub-issue; see the
	// package comment for why only the category is passed on.
	var category *string
	if draft.Category != nil {
		name, err := tracker.CleanCategory(*draft.Category)
		if err != nil {
			return "", err
		}
		category = &name
	}
	if draft.ParentID != nil {
		args = append(args, "--parent", *draft.ParentID, "--no-inherit-labels")
		if category == nil {
			for _, issue := range ToIssues(all) {
				if issue.ID == *draft.ParentID {
					category = issue.Category
				}
			}
		}
	}
	// Safe as a flag value: it always starts with "category:", never a
	// dash, and CleanCategory has ruled out commas.
	if category != nil {
		args = append(args, "--labels", categoryPrefix+*category)
	}
	if draft.From != nil {
		args = append(args, "--deps", "discovered-from:"+*draft.From)
	}
	var created struct {
		ID *string `json:"id"`
	}
	if err := beads.bdJSON(args, &created); err != nil {
		return "", err
	}
	if created.ID == nil {
		return "", tracker.Refused("bd reported success but did not say which issue it created. Look at the list to see whether it is there.")
	}
	for _, blocker := range draft.BlockedBy {
		if _, err := beads.bd([]string{"dep", "add", *created.ID, blocker, "--json"}, nil); err != nil {
			return "", err
		}
	}
	return *created.ID, nil
}

// metadataKey is what a name for kept data may be made of.
var metadataKey = regexp.MustCompile(`^[\w.-]+$`)

// Edit changes an issue's fields, labels and kept data in one bd command;
// nothing is run when nothing would change.
func (beads *Tracker) Edit(id string, changes tracker.Changes) error {
	_, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	args := []string{"update", id, "--json"}
	if changes.Title != nil {
		args = append(args, "--title", *changes.Title)
	}
	if changes.Type != nil {
		args = append(args, "--type", *changes.Type)
	}
	if changes.Priority != nil {
		args = append(args, "--priority", strconv.Itoa(*changes.Priority))
	}
	if changes.ClearAssignee {
		args = append(args, "--assignee", "")
	} else if changes.Assignee != nil {
		args = append(args, "--assignee", *changes.Assignee)
	}
	for _, label := range changes.RemoveLabels {
		if slices.Contains(row.Labels, label) {
			args = append(args, "--remove-label", label)
		}
	}
	for _, label := range changes.AddLabels {
		// A label is a flag's value here, so one that starts with a dash
		// would still be read as text; a comma would split it in two.
		if strings.TrimSpace(label) == "" || strings.Contains(label, ",") {
			return tracker.Refused("\"%s\" cannot be used as a label.", label)
		}
		if !slices.Contains(row.Labels, label) {
			args = append(args, "--add-label", label)
		}
	}
	for _, change := range changes.Metadata {
		// The key is half of a flag's value ("key=value"), so it must not
		// hold the sign that divides the two.
		if !metadataKey.MatchString(change.Key) {
			return tracker.Refused("\"%s\" cannot be used as a name for kept data.", change.Key)
		}
		if change.Value == nil {
			args = append(args, "--unset-metadata", change.Key)
		} else {
			args = append(args, "--set-metadata", change.Key+"="+*change.Value)
		}
	}
	if changes.Category != nil || changes.ClearCategory {
		wanted := ""
		if !changes.ClearCategory {
			name, err := tracker.CleanCategory(*changes.Category)
			if err != nil {
				return err
			}
			wanted = categoryPrefix + name
		}
		// Every category label is removed first, so an issue never ends up
		// with two, even if one was added by hand with bd.
		present := false
		for _, label := range row.Labels {
			if !strings.HasPrefix(label, categoryPrefix) {
				continue
			}
			if label == wanted {
				present = true
			} else {
				args = append(args, "--remove-label", label)
			}
		}
		if wanted != "" && !present {
			args = append(args, "--add-label", wanted)
		}
	}
	if len(args) == 3 {
		return nil // Nothing to change.
	}
	_, err = beads.bd(args, nil)
	return err
}

// Write replaces one written part of an issue.
func (beads *Tracker) Write(id, part, text string) error {
	_, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	description, requirements := tracker.SplitRequirements(row.Description)
	var flag, value string
	switch part {
	// The description and the requirements share beads' one field; each is
	// written without disturbing the other.
	case "description":
		flag, value = "--description", tracker.WithRequirements(text, requirements)
	case "requirements":
		flag, value = "--description", tracker.WithRequirements(description, text)
	case "done":
		flag, value = "--acceptance", strings.TrimSpace(text)
	case "plan":
		flag, value = "--design", strings.TrimSpace(text)
	case "notes":
		flag, value = "--notes", strings.TrimSpace(text)
	default:
		return tracker.Usage("Unknown part \"%s\". Use one of: %s.", part, strings.Join(tracker.Parts, ", "))
	}
	_, err = beads.bd([]string{"update", id, "--json", flag, value}, nil)
	return err
}

// Comment adds a comment to an issue.
func (beads *Tracker) Comment(id, text string) error {
	if _, _, err := beads.needIn(id); err != nil {
		return err
	}
	// On standard input, so text that starts with a dash is still text.
	_, err := beads.bd([]string{"comment", id, "--stdin"}, &text)
	return err
}

// Start marks an issue as being worked on, and assigns it to the actor when
// there is one.
func (beads *Tracker) Start(id string) error {
	_, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	if row.Status == closed {
		return tracker.Refused("%s is closed. Reopen it before starting work on it.", id)
	}
	args := []string{"update", id, "--json", "--status", "in_progress"}
	if beads.actor != "" {
		args = append(args, "--assignee", beads.actor)
	}
	_, err = beads.bd(args, nil)
	return err
}

// Stop puts an issue that is in progress back to open; one that is not in
// progress is left alone. Refused for a closed issue.
func (beads *Tracker) Stop(id string) error {
	_, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	if row.Status == closed {
		return tracker.Refused("%s is closed. Reopen it to work on it again.", id)
	}
	if row.Status != "in_progress" {
		return nil
	}
	_, err = beads.bd([]string{"update", id, "--json", "--status", "open"}, nil)
	return err
}

// Close closes an issue; reason may be "".
func (beads *Tracker) Close(id, reason string) error {
	if _, _, err := beads.needIn(id); err != nil {
		return err
	}
	args := []string{"close", id, "--json"}
	if strings.TrimSpace(reason) != "" {
		args = append(args, "--reason", reason)
	}
	_, err := beads.bd(args, nil)
	return err
}

// Reopen reopens a closed issue.
func (beads *Tracker) Reopen(id string) error {
	if _, _, err := beads.needIn(id); err != nil {
		return err
	}
	_, err := beads.bd([]string{"reopen", id, "--json"}, nil)
	return err
}

// Move puts an issue under a parent, or with nil back at the top level.
func (beads *Tracker) Move(id string, parentID *string) error {
	all, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	target := ""
	if parentID != nil {
		target = *parentID
		parent, err := need(all, target)
		if err != nil {
			return err
		}
		// Beads keeps "sub-issue of" as a link too, and allows one link per
		// pair of issues, so an existing link between the two is in the way.
		if storedLink(row, target) != nil || storedLink(parent, id) != nil {
			return tracker.Refused("%s and %s are linked. Remove that link first, then move it.", id, target)
		}
		// Checked here and not left to bd: an issue inside itself would
		// disappear from every view that walks the tree from the top.
		if target == id || DescendantIDs(id, all)[target] {
			return tracker.Refused("An issue cannot be moved inside itself or inside one of its own sub-issues.")
		}
	}
	// An empty --parent is how bd takes an issue out of its parent.
	_, err = beads.bd([]string{"update", id, "--json", "--parent", target}, nil)
	return err
}

// Link records "id <kind> otherID".
func (beads *Tracker) Link(id, otherID, kind string) error {
	if !slices.Contains(allKinds(), kind) {
		return tracker.Unsupported("Beads has no \"%s\" link. It has: %s.", kind, strings.Join(allKinds(), ", "))
	}
	all, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	other, err := need(all, otherID)
	if err != nil {
		return err
	}
	if id == otherID {
		return tracker.Refused("An issue cannot be linked to itself.")
	}
	// Beads keeps one link per pair in each direction, and a "related" link
	// takes both directions. Said here in bend's own words, because bd's
	// refusal advises bd commands.
	existing := storedLink(row, otherID)
	if existing == nil && kind == "related" {
		existing = storedLink(other, id)
	}
	if existing != nil {
		return tracker.Refused("%s and %s are already linked (%s). Remove that link first.", id, otherID, shownKind(existing.Type))
	}
	args := []string{"dep", "relate", id, otherID, "--json"}
	if kind != "related" {
		dependencyType := kind
		if kind == "blocked-by" {
			dependencyType = "blocks"
		}
		args = []string{"dep", "add", id, otherID, "--type", dependencyType, "--json"}
	}
	_, err = beads.bd(args, nil)
	return err
}

// Unlink removes the link between two issues, in either direction unless
// options narrow it.
func (beads *Tracker) Unlink(id, otherID string, options tracker.UnlinkOptions) error {
	all, row, err := beads.needIn(id)
	if err != nil {
		return err
	}
	// A link of another kind than the one asked for is as good as none.
	ofKind := func(link *Dependency) *Dependency {
		if link != nil && options.Kind != "" && shownKind(link.Type) != options.Kind {
			return nil
		}
		return link
	}
	forward := ofKind(storedLink(row, otherID))
	var backward *Dependency
	if !options.OnlyFrom {
		other, err := need(all, otherID)
		if err != nil {
			return err
		}
		backward = ofKind(storedLink(other, id))
	}
	if forward == nil && backward == nil {
		return tracker.Refused("There is no link between %s and %s.", id, otherID)
	}
	// A two-way link is undone with the command that made it, so both
	// halves go; `dep remove` would leave the other issue's half behind.
	if (forward != nil && forward.Type == "relates-to") || (backward != nil && backward.Type == "relates-to") {
		_, err := beads.bd([]string{"dep", "unrelate", id, otherID, "--json"}, nil)
		return err
	}
	if forward != nil {
		if _, err := beads.bd([]string{"dep", "remove", id, otherID, "--json"}, nil); err != nil {
			return err
		}
	}
	if backward != nil {
		if _, err := beads.bd([]string{"dep", "remove", otherID, id, "--json"}, nil); err != nil {
			return err
		}
	}
	return nil
}
