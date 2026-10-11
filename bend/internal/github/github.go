// Package github is the adapter for GitHub issues.
//
// What: implements the tracker.Tracker interface on top of a Client
// (api.go): turns a GitHub issue into the common Issue shape and each
// operation into the calls GitHub needs.
//
// Why: the owner wants an agent to run the same `bend` commands whether a
// repository's issues are in beads or on GitHub (bead-bb-c9l.1). GitHub is
// the first hosted tracker, and the first test of whether the common shape
// holds for one that is not beads. Everything that decides where a thing is
// kept on GitHub lives in this one file.
//
// Design notes:
//   - Where things are kept. GitHub's own: title, description, comments,
//     assignee, open and closed, sub-issues, and "blocked by". As labels:
//     type (`type:<name>`), priority (`priority:<0-4>`), category
//     (`category:<name>`, the same convention as with beads) and "in
//     progress" (`in-progress`, on an open issue). GitHub makes a label the
//     first time it is applied. As marked sections at the end of the
//     description (see tracker/parts.go): requirements, done, plan, notes.
//   - "Discovered from" and "related" do not exist on GitHub. They are kept
//     as lines of a marked "Links" section, written on BOTH issues, so that
//     showing either one needs no search: GitHub's search is limited to
//     about thirty a minute and runs behind by up to minutes.
//   - A hosted tracker is slow and counted (5,000 requests an hour), so
//     nothing here reads the whole list unless a list was asked for. An
//     operation on one issue fetches that issue, and the others it names.
//     This is the opposite of the beads adapter, where one local read of
//     everything is the cheapest thing there is.
//   - What an issue waits for: its own unfinished blockers and those of the
//     open issues it sits inside, as with beads. The parents come with the
//     issue in the same request (four levels; see api.go).
//   - GitHub does everything as the signed-in account and cannot act as
//     another name. Start assigns the issue to that account. A comment
//     written as someone else (the actor, bend's --as) opens with that name,
//     so a hand-over or a decision still says which agent wrote it, and is
//     read back with that name as its author.
//   - Closing with a reason adds the reason as a comment that begins
//     "Closed:", because GitHub's own reason is one of a few fixed words.
//   - Two issues can be linked in two ways at once here: "blocked by", which
//     is GitHub's own, and a link kept in the text. Unlink removes everything
//     between the two unless it is told which kind.
//
// Gotchas:
//   - Sections and links live in the description, which is read, changed and
//     written back. Two writers within the same moment can overwrite each
//     other. Accepted for now; a layer that keeps a copy has to deal with it
//     anyway.
//   - A person may edit the description on github.com. A removed marker
//     turns that section's text into description; nothing is lost.
//   - An issue id is GitHub's number, as text ("12"); "#12" is accepted.
//     Issues of another repository cannot be named.
//   - A message built from what the caller typed is always passed to
//     tracker.Refused and its like as an argument of "%s", never as the
//     format itself: a "%" in an id must not be read as a verb.
package github

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// The label prefixes that hold a field GitHub has none for.
const (
	typePrefix     = "type:"
	priorityPrefix = "priority:"
	categoryPrefix = "category:"
)

// inProgress is the label on an open issue that is being worked on.
const inProgress = "in-progress"

// sections are the marked sections of a description, name and visible
// heading, in the order they are written.
var sections = [][2]string{
	{"requirements", "Requirements"},
	{"done", "Done when"},
	{"plan", "Plan"},
	{"notes", "Notes"},
	{"links", "Links"},
}

// bodyParts is a description taken apart into what `bend` calls its parts.
type bodyParts struct {
	Description  string
	Requirements string
	Done         string
	Plan         string
	Notes        string
	// Links are the links GitHub has no place for; see the package comment.
	Links []tracker.TextLink
}

// splitBody takes a GitHub description apart. Pure; the opposite of
// joinBody. Links is never nil.
func splitBody(body string) bodyParts {
	names := make([]string, 0, len(sections))
	for _, section := range sections {
		names = append(names, section[0])
	}
	rest, found := tracker.SplitSections(body, names)
	return bodyParts{
		Description:  rest,
		Requirements: found["requirements"],
		Done:         found["done"],
		Plan:         found["plan"],
		Notes:        found["notes"],
		Links:        tracker.ParseTextLinks(found["links"]),
	}
}

// joinBody puts the parts back into one GitHub description. Pure.
func joinBody(parts bodyParts) string {
	text := map[string]string{
		"requirements": parts.Requirements,
		"done":         parts.Done,
		"plan":         parts.Plan,
		"notes":        parts.Notes,
		"links":        tracker.FormatTextLinks(parts.Links),
	}
	joined := make([]tracker.Section, 0, len(sections))
	for _, section := range sections {
		joined = append(joined, tracker.Section{
			Name: section[0], Heading: section[1], Text: text[section[0]],
		})
	}
	return tracker.JoinSections(parts.Description, joined)
}

// asOpen is how a comment written as someone else opens; see the package
// comment. The name and the visible line each stay on one line, which is
// spelled out here because a "." would also take a carriage return.
var asOpen = regexp.MustCompile(
	`^<!-- bend:as ([^\n\r\x{2028}\x{2029}]+?) -->\n\*\*[^\n\r\x{2028}\x{2029}]*?:\*\*\n\n`,
)

// unsafeInName is what a name may not hold: the end of an HTML comment, or
// a line break.
var unsafeInName = regexp.MustCompile(`-->|[\r\n]`)

// signComment gives the text of a comment written as name, who is not the
// signed-in account.
func signComment(name, text string) string {
	// The name sits inside an HTML comment and on a line of its own.
	safe := strings.TrimSpace(unsafeInName.ReplaceAllString(name, " "))
	return "<!-- bend:as " + safe + " -->\n**" + safe + ":**\n\n" + text
}

// readComment gives a comment's author and text, with a signed opening
// taken off again.
func readComment(author, body string) (string, string) {
	signed := asOpen.FindStringSubmatch(body)
	if signed == nil {
		return author, body
	}
	return signed[1], body[len(signed[0]):]
}

// labelValue gives the one label with a prefix, without the prefix; "" when
// there is none.
func labelValue(labels []string, prefix string) string {
	for _, label := range labels {
		if strings.HasPrefix(label, prefix) {
			return strings.TrimSpace(label[len(prefix):])
		}
	}
	return ""
}

// holdsField says whether a label holds one of the fields above, so is not
// a plain label.
func holdsField(label string) bool {
	return label == inProgress ||
		strings.HasPrefix(label, typePrefix) ||
		strings.HasPrefix(label, priorityPrefix) ||
		strings.HasPrefix(label, categoryPrefix)
}

// has says whether a list of labels holds one.
func has(labels []string, wanted string) bool {
	for _, label := range labels {
		if label == wanted {
			return true
		}
	}
	return false
}

// leadingNumber is the whole number a text opens with, after any spaces: an
// optional sign and digits.
var leadingNumber = regexp.MustCompile(`^\s*([+-]?\d+)`)

// priorityOf reads the priority a label holds: the whole number its value
// opens with ("1", and also "1 (high)"); nil when it opens with none.
func priorityOf(labels []string) *int {
	match := leadingNumber.FindStringSubmatch(labelValue(labels, priorityPrefix))
	if match == nil {
		return nil
	}
	priority, err := strconv.Atoi(match[1])
	if err != nil {
		return nil
	}
	return &priority
}

// toIssueRef turns GitHub's pointer to an issue into the common one.
func toIssueRef(ref Ref) tracker.IssueRef {
	return tracker.IssueRef{ID: strconv.Itoa(ref.Number), Title: ref.Title, Status: ref.State}
}

// orNil gives a pointer to a text, or nil for "".
func orNil(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// toIssue turns a GitHub issue into the common shape. Pure.
//
// known are pointers to the issues its text links name, by number. A link
// to an issue that is not among them (deleted since) is left out: it has no
// title to show.
//
// Returns the issue already tidied (see tracker.Issue.Tidy).
func toIssue(issue Issue, known map[int]Ref) tracker.Issue {
	parts := splitBody(issue.Body)
	open := issue.State == "open"
	links := []tracker.Link{}
	link := func(ref Ref, kind, direction string) tracker.Link {
		pointer := toIssueRef(ref)
		return tracker.Link{
			ID: pointer.ID, Title: pointer.Title, Status: pointer.Status,
			Kind: kind, Direction: direction,
		}
	}
	for _, ref := range issue.BlockedBy {
		links = append(links, link(ref, "blocked-by", "out"))
	}
	for _, ref := range issue.Blocking {
		links = append(links, link(ref, "blocked-by", "in"))
	}
	for _, text := range parts.Links {
		number, err := strconv.Atoi(text.ID)
		if err != nil {
			continue
		}
		if ref, ok := known[number]; ok {
			links = append(links, link(ref, text.Kind, text.Direction))
		}
	}
	// What it waits for: its own unfinished blockers, then those of the open
	// issues it sits inside. A closed issue waits for nothing.
	blockedBy := []tracker.IssueRef{}
	if open {
		add := func(refs []Ref) {
			for _, ref := range refs {
				pointer := toIssueRef(ref)
				had := false
				for _, already := range blockedBy {
					had = had || already.ID == pointer.ID
				}
				if ref.State == "open" && !had {
					blockedBy = append(blockedBy, pointer)
				}
			}
		}
		add(issue.BlockedBy)
		for up := issue.Parent; up != nil; up = up.Parent {
			if up.State == "open" {
				add(up.BlockedBy)
			}
		}
	}
	status := "closed"
	if open {
		status = "open"
		if has(issue.Labels, inProgress) {
			status = "in_progress"
		}
	}
	closeReason := ""
	if !open && issue.StateReason != nil {
		closeReason = *issue.StateReason
	}
	var parentID *string
	if issue.Parent != nil {
		parentID = tracker.Ptr(strconv.Itoa(issue.Parent.Number))
	}
	labels := []string{}
	for _, label := range issue.Labels {
		if !holdsField(label) {
			labels = append(labels, label)
		}
	}
	subIssues := make([]tracker.IssueRef, 0, len(issue.SubIssues))
	for _, ref := range issue.SubIssues {
		subIssues = append(subIssues, toIssueRef(ref))
	}
	return tracker.Issue{
		ID:           strconv.Itoa(issue.Number),
		Title:        issue.Title,
		Status:       status,
		Type:         orNil(labelValue(issue.Labels, typePrefix)),
		Priority:     priorityOf(issue.Labels),
		Category:     orNil(strings.ToLower(labelValue(issue.Labels, categoryPrefix))),
		Assignee:     issue.Assignee,
		ParentID:     parentID,
		Description:  parts.Description,
		Requirements: parts.Requirements,
		Done:         parts.Done,
		Plan:         parts.Plan,
		Notes:        parts.Notes,
		CloseReason:  closeReason,
		Labels:       labels,
		Links:        links,
		SubIssues:    subIssues,
		BlockedBy:    blockedBy,
		CommentCount: issue.CommentCount,
		CreatedAt:    tracker.Ptr(issue.CreatedAt),
		UpdatedAt:    tracker.Ptr(issue.UpdatedAt),
		// GitHub has no place for free-form data with an issue (Tidy makes
		// it {}), and an issue here is not the counterpart of one
		// elsewhere: it is the issue.
		Metadata:    nil,
		ExternalRef: nil,
	}.Tidy()
}

// withLabel gives a set of labels with the one under prefix replaced; a nil
// value removes it. The set given is not changed.
func withLabel(labels []string, prefix string, value *string) []string {
	rest := []string{}
	for _, label := range labels {
		if !strings.HasPrefix(label, prefix) {
			rest = append(rest, label)
		}
	}
	if value != nil {
		rest = append(rest, prefix+*value)
	}
	return rest
}

// priorityLabel gives the label value that holds a priority; refused outside
// 0 to 4.
func priorityLabel(priority int) (string, error) {
	if priority < 0 || priority > 4 {
		return "", tracker.Refused("A priority is a whole number from 0 (most urgent) to 4.")
	}
	return strconv.Itoa(priority), nil
}

// issueNumber is what an id must be once a leading "#" is taken off: one to
// nine digits.
var issueNumber = regexp.MustCompile(`^\d{1,9}$`)

// numberOf gives an id as GitHub's number; "#12" and "12" are both accepted.
// Anything else is refused, before GitHub is asked anything.
func numberOf(id string) (int, error) {
	digits := strings.TrimPrefix(strings.TrimSpace(id), "#")
	number, err := strconv.Atoi(digits)
	if !issueNumber.MatchString(digits) || err != nil || number == 0 {
		return 0, tracker.Refused(
			"%s is not a GitHub issue number. Issues here are named by their number, like 12.",
			`"`+id+`"`,
		)
	}
	return number, nil
}

// sameLink says whether two text links are the same line.
func sameLink(left, right tracker.TextLink) bool {
	return left.Kind == right.Kind && left.Direction == right.Direction && left.ID == right.ID
}

// withLink gives a change that adds one text link to the parts; one already
// there is kept once.
func withLink(link tracker.TextLink) func(bodyParts) bodyParts {
	return func(parts bodyParts) bodyParts {
		links := append(append([]tracker.TextLink{}, parts.Links...), link)
		parts.Links = tracker.ParseTextLinks(tracker.FormatTextLinks(links))
		return parts
	}
}

// withoutLinks gives a change that takes out the text links that are among
// gone.
func withoutLinks(gone []tracker.TextLink) func(bodyParts) bodyParts {
	return func(parts bodyParts) bodyParts {
		kept := []tracker.TextLink{}
		for _, link := range parts.Links {
			dropped := false
			for _, one := range gone {
				dropped = dropped || sameLink(one, link)
			}
			if !dropped {
				kept = append(kept, link)
			}
		}
		parts.Links = kept
		return parts
	}
}

// mirror gives the line the other issue carries for a text link: a
// "discovered from" reads "led to" from the other side, a "related" reads
// the same. ownID is the id of the issue the link was written on.
func mirror(link tracker.TextLink, ownID string) tracker.TextLink {
	direction := "out"
	if link.Kind != "related" && link.Direction == "out" {
		direction = "in"
	}
	return tracker.TextLink{Kind: link.Kind, Direction: direction, ID: ownID}
}

// adapter is the GitHub tracker for one repository.
type adapter struct {
	// client is the connection to that repository (api.go).
	client Client
	// actor is who is acting, when it is not the signed-in account itself;
	// "" for nobody else.
	actor string
}

// New builds the GitHub adapter for one repository.
//
// client is the connection to that repository (api.go). actor is who is
// acting, when it is not the signed-in account itself, "" for none; see the
// package comment for what GitHub can and cannot do with it.
// Side effects: none until a method is called. Reads cost requests against
// GitHub's hourly limit; the changing methods write to the repository's
// issues.
func New(client Client, actor string) tracker.Tracker {
	return &adapter{client: client, actor: actor}
}

// need gives the issue with this id, or a refusal naming it.
func (github *adapter) need(id string) (*Issue, error) {
	number, err := numberOf(id)
	if err != nil {
		return nil, err
	}
	issue, err := github.client.Issue(number)
	if err != nil {
		return nil, err
	}
	if issue == nil {
		return nil, tracker.Refused("There is no issue with id %s.", id)
	}
	return issue, nil
}

// inCommonShape gives issues in the common shape, with the pointers their
// text links need. Never nil.
//
// The issues given serve as pointers to each other for free.
// Side effects: one more request when a link names an issue that is not
// among them; none otherwise.
func (github *adapter) inCommonShape(issues []Issue) ([]tracker.Issue, error) {
	known := map[int]Ref{}
	for _, issue := range issues {
		known[issue.Number] = issue.Ref
	}
	missing := []int{}
	asked := map[int]bool{}
	for _, issue := range issues {
		for _, link := range splitBody(issue.Body).Links {
			number, err := strconv.Atoi(link.ID)
			if err != nil {
				continue
			}
			if _, ok := known[number]; !ok && !asked[number] {
				asked[number] = true
				missing = append(missing, number)
			}
		}
	}
	refs, err := github.client.Refs(missing)
	if err != nil {
		return nil, err
	}
	for _, ref := range refs {
		known[ref.Number] = ref
	}
	shaped := make([]tracker.Issue, 0, len(issues))
	for _, issue := range issues {
		shaped = append(shaped, toIssue(issue, known))
	}
	return shaped, nil
}

// signed gives text as it is to be posted: signed when written as someone
// else.
//
// Side effects: asks who is signed in, when there is an actor.
func (github *adapter) signed(text string) (string, error) {
	if strings.TrimSpace(github.actor) == "" {
		return text, nil
	}
	viewer, err := github.client.Viewer()
	if err != nil {
		return "", err
	}
	if github.actor == viewer {
		return text, nil
	}
	return signComment(github.actor, text), nil
}

// rewrite writes an issue's description back with its parts changed; nothing
// is sent when the change leaves the description as it was.
func (github *adapter) rewrite(issue *Issue, change func(bodyParts) bodyParts) error {
	body := joinBody(change(splitBody(issue.Body)))
	if body == issue.Body {
		return nil
	}
	return github.client.Update(issue.Number, Changes{Body: &body})
}

// LocalCopy gives the copy on this machine that the adapter works from,
// for a caller that shows or looks after it (the sync, what waits, what
// was refused); nil when the adapter talks to GitHub directly.
func (github *adapter) LocalCopy() *Copy {
	held, _ := github.client.(*Copy)
	return held
}

// About says what is known without asking GitHub anything: the tracker's
// name, the repository, and the kinds of link accepted.
func (github *adapter) About() tracker.About {
	return tracker.About{
		Tracker:    "github",
		Repository: tracker.Ptr(github.client.Repository()),
		LinkKinds:  append([]string{}, tracker.LinkKinds...),
	}
}

// Capabilities reports what GitHub holds as a field of its own, what is kept
// another way and where, and what it cannot do.
//
// Side effects: two requests (whether issues are switched on, and who is
// signed in).
func (github *adapter) Capabilities() (tracker.Capabilities, error) {
	warnings := []string{
		"Issues are read from a copy on this computer and changes are sent to GitHub afterwards: what others changed shows after the next sync (`bend sync`), within a few minutes as a rule.",
		"Making an issue, and moving one through its workflow, ask GitHub first and need the network.",
		"Everything is done as the signed-in GitHub account. A comment written as someone else opens with that name.",
	}
	hasIssues, err := github.client.HasIssues()
	if err != nil {
		return tracker.Capabilities{}, err
	}
	if !hasIssues {
		warnings = append([]string{"Issues are switched off for this repository on GitHub."}, warnings...)
	}
	viewer, err := github.client.Viewer()
	if err != nil {
		return tracker.Capabilities{}, err
	}
	return tracker.Capabilities{
		Tracker:   "github",
		Where:     github.client.Repository() + " on GitHub, signed in as " + viewer,
		LinkKinds: append([]string{}, tracker.LinkKinds...),
		Supports: []tracker.Support{
			{Name: "sub-issues", Level: "yes", Note: ""},
			{Name: "comments", Level: "yes", Note: ""},
			{Name: "assignee", Level: "yes", Note: "a GitHub account"},
			{Name: "link: blocked-by", Level: "yes", Note: ""},
			{Name: "description", Level: "yes", Note: ""},
			{
				Name:  "type, priority, category",
				Level: "another way",
				Note:  "kept as the labels type:<name>, priority:<0-4>, category:<name>",
			},
			{
				Name:  "in progress",
				Level: "another way",
				Note:  "kept as the label in-progress on an open issue",
			},
			{
				Name:  "requirements, done, plan, notes",
				Level: "another way",
				Note:  "kept as marked sections at the end of the description",
			},
			{
				Name:  "links: discovered-from, related",
				Level: "another way",
				Note:  "kept as a marked Links section in the description of both issues",
			},
			{
				Name:  "close reason",
				Level: "another way",
				Note:  "added as a comment that begins Closed:",
			},
			{
				Name:  "decisions and hand-overs",
				Level: "another way",
				Note:  "kept as comments with a fixed opening",
			},
			{
				Name:  "ready for the owner to validate",
				Level: "another way",
				Note:  "a hand-over comment on an issue left in progress",
			},
			{
				Name:  "acting as another name",
				Level: "no",
				Note:  "GitHub acts as the signed-in account only",
			},
		},
		Warnings: warnings,
	}, nil
}

// List gives the issues a filter picks: open ones unless it says otherwise.
//
// One request for a state (more only past a hundred issues); everything else
// is narrowed here.
func (github *adapter) List(filter tracker.ListFilter) ([]tracker.Issue, error) {
	var category *string
	if filter.Category != nil {
		cleaned, err := tracker.CleanCategory(*filter.Category)
		if err != nil {
			return nil, err
		}
		category = &cleaned
	}
	// GitHub knows open and closed; "in progress" is an open issue with a
	// label, so it is fetched as open and narrowed below.
	state := "open"
	if filter.Status != nil && (*filter.Status == "all" || *filter.Status == "closed") {
		state = *filter.Status
	}
	fetched, err := github.client.Issues(ListOptions{State: state, Since: filter.ChangedSince})
	if err != nil {
		return nil, err
	}
	found, err := github.inCommonShape(fetched)
	if err != nil {
		return nil, err
	}
	// same says whether an optional field of an issue is this value.
	same := func(field *string, wanted string) bool { return field != nil && *field == wanted }
	picked := []tracker.Issue{}
	for _, issue := range found {
		if filter.Status != nil && *filter.Status != "all" && issue.Status != *filter.Status {
			continue
		}
		if filter.Type != nil && !same(issue.Type, *filter.Type) {
			continue
		}
		if filter.Priority != nil && (issue.Priority == nil || *issue.Priority != *filter.Priority) {
			continue
		}
		if category != nil && !same(issue.Category, *category) {
			continue
		}
		if filter.Assignee != nil && !same(issue.Assignee, *filter.Assignee) {
			continue
		}
		if filter.ParentID != nil {
			// Read here, not before the request, as the TypeScript did: a
			// parent id that is no number is refused only once an issue
			// gets as far as being compared with it.
			parent, err := numberOf(*filter.ParentID)
			if err != nil {
				return nil, err
			}
			if !same(issue.ParentID, strconv.Itoa(parent)) {
				continue
			}
		}
		picked = append(picked, issue)
	}
	return picked, nil
}

// Ready gives the issues that can be worked on now.
//
// GitHub has no notion of "ready". Here it is: open, not yet being worked
// on, and waiting for nothing.
func (github *adapter) Ready() ([]tracker.Issue, error) {
	fetched, err := github.client.Issues(ListOptions{State: "open"})
	if err != nil {
		return nil, err
	}
	open, err := github.inCommonShape(fetched)
	if err != nil {
		return nil, err
	}
	ready := []tracker.Issue{}
	for _, issue := range open {
		if issue.Status == "open" && len(issue.BlockedBy) == 0 {
			ready = append(ready, issue)
		}
	}
	return ready, nil
}

// Show gives one issue: a request for it, and one more for the titles its
// text links name, when it has any.
func (github *adapter) Show(id string) (tracker.Issue, error) {
	issue, err := github.need(id)
	if err != nil {
		return tracker.Issue{}, err
	}
	shaped, err := github.inCommonShape([]Issue{*issue})
	if err != nil {
		return tracker.Issue{}, err
	}
	return shaped[0], nil
}

// Comments gives an issue's comments, oldest first, each with the name it
// was written as.
func (github *adapter) Comments(id string) ([]tracker.Comment, error) {
	issue, err := github.need(id)
	if err != nil {
		return nil, err
	}
	found, err := github.client.Comments(issue.Number)
	if err != nil {
		return nil, err
	}
	comments := make([]tracker.Comment, 0, len(found))
	for _, comment := range found {
		author, text := readComment(comment.Author, comment.Body)
		comments = append(comments, tracker.Comment{
			ID: comment.ID, Author: author, CreatedAt: comment.CreatedAt, Text: text,
		})
	}
	sort.SliceStable(comments, func(left, right int) bool {
		return comments[left].CreatedAt < comments[right].CreatedAt
	})
	return comments, nil
}

// Search gives the issues matching free text, best match first.
func (github *adapter) Search(text string) ([]tracker.Issue, error) {
	found, err := github.client.Search(text)
	if err != nil {
		return nil, err
	}
	return github.inCommonShape(found)
}

// Create makes an issue and returns its id.
//
// Side effects: the new issue; then, as the draft asks, it is put under its
// parent, a "led to" line is written on the issue it was discovered from,
// and its blockers are recorded.
func (github *adapter) Create(draft tracker.Draft) (string, error) {
	// Everything the new issue names is fetched first, so that nothing is
	// created when one of them does not exist.
	var parent, from *Issue
	var err error
	if draft.ParentID != nil {
		if parent, err = github.need(*draft.ParentID); err != nil {
			return "", err
		}
	}
	if draft.From != nil {
		if from, err = github.need(*draft.From); err != nil {
			return "", err
		}
	}
	blockers := []*Issue{}
	for _, id := range draft.BlockedBy {
		blocker, err := github.need(id)
		if err != nil {
			return "", err
		}
		blockers = append(blockers, blocker)
	}

	labels := []string{}
	if draft.Type != nil {
		labels = append(labels, typePrefix+strings.TrimSpace(*draft.Type))
	}
	if draft.Priority != nil {
		priority, err := priorityLabel(*draft.Priority)
		if err != nil {
			return "", err
		}
		labels = append(labels, priorityPrefix+priority)
	}
	// A sub-issue takes its parent's category unless it has its own, and
	// none of its parent's other labels, as with beads.
	category := ""
	if draft.Category != nil {
		if category, err = tracker.CleanCategory(*draft.Category); err != nil {
			return "", err
		}
	} else if parent != nil {
		category = strings.ToLower(labelValue(parent.Labels, categoryPrefix))
	}
	if category != "" {
		labels = append(labels, categoryPrefix+category)
	}

	parts := bodyParts{Links: []tracker.TextLink{}}
	if draft.Description != nil {
		parts.Description = *draft.Description
	}
	if draft.Done != nil {
		parts.Done = *draft.Done
	}
	if from != nil {
		parts.Links = append(parts.Links, tracker.TextLink{
			Kind: "discovered-from", Direction: "out", ID: strconv.Itoa(from.Number),
		})
	}
	made, err := github.client.Create(NewIssue{Title: draft.Title, Body: joinBody(parts), Labels: labels})
	if err != nil {
		return "", err
	}
	if parent != nil {
		if err := github.client.SetParent(parent.Number, made.ID); err != nil {
			return "", err
		}
	}
	if from != nil {
		err := github.rewrite(from, withLink(tracker.TextLink{
			Kind: "discovered-from", Direction: "in", ID: strconv.Itoa(made.Number),
		}))
		if err != nil {
			return "", err
		}
	}
	for _, blocker := range blockers {
		if err := github.client.AddBlockedBy(made.Number, blocker.ID); err != nil {
			return "", err
		}
	}
	return strconv.Itoa(made.Number), nil
}

// Edit changes an issue's title, assignee and the fields kept as labels, and
// adds and removes plain labels; all in one request, and none when nothing
// would change.
//
// Fails with Unsupported for free-form data, which GitHub has no place for.
func (github *adapter) Edit(id string, changes tracker.Changes) error {
	if len(changes.Metadata) > 0 {
		return tracker.Unsupported("GitHub issues have no place for free-form data kept with an issue.")
	}
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	update := Changes{}
	changed := false
	if changes.Title != nil {
		update.Title = changes.Title
		changed = true
	}
	// Clearing wins where a caller gives both a new assignee and "clear".
	if changes.ClearAssignee {
		update.Assignees = &[]string{}
		changed = true
	} else if changes.Assignee != nil {
		update.Assignees = &[]string{*changes.Assignee}
		changed = true
	}
	labels := issue.Labels
	if changes.Type != nil {
		labels = withLabel(labels, typePrefix, tracker.Ptr(strings.TrimSpace(*changes.Type)))
	}
	if changes.Priority != nil {
		priority, err := priorityLabel(*changes.Priority)
		if err != nil {
			return err
		}
		labels = withLabel(labels, priorityPrefix, &priority)
	}
	// Clearing wins here too.
	if changes.ClearCategory {
		labels = withLabel(labels, categoryPrefix, nil)
	} else if changes.Category != nil {
		category, err := tracker.CleanCategory(*changes.Category)
		if err != nil {
			return err
		}
		labels = withLabel(labels, categoryPrefix, &category)
	}
	for _, label := range changes.RemoveLabels {
		kept := []string{}
		for _, had := range labels {
			if had != label {
				kept = append(kept, had)
			}
		}
		labels = kept
	}
	for _, label := range changes.AddLabels {
		if strings.TrimSpace(label) == "" || strings.Contains(label, ",") {
			return tracker.Refused("%s cannot be used as a label.", `"`+label+`"`)
		}
		if !has(labels, label) {
			labels = append(append([]string{}, labels...), label)
		}
	}
	differs := len(labels) != len(issue.Labels)
	for _, label := range labels {
		differs = differs || !has(issue.Labels, label)
	}
	if differs {
		update.Labels = &labels
		changed = true
	}
	if !changed {
		return nil // Nothing to change.
	}
	return github.client.Update(issue.Number, update)
}

// Write replaces one written part of an issue; an empty text clears it, and
// takes its section out of the description.
//
// Fails with a usage error for a part that is not one of tracker.Parts,
// before GitHub is asked anything.
func (github *adapter) Write(id, part, text string) error {
	text = strings.TrimSpace(text)
	var change func(bodyParts) bodyParts
	switch part {
	case "description":
		change = func(parts bodyParts) bodyParts { parts.Description = text; return parts }
	case "requirements":
		change = func(parts bodyParts) bodyParts { parts.Requirements = text; return parts }
	case "done":
		change = func(parts bodyParts) bodyParts { parts.Done = text; return parts }
	case "plan":
		change = func(parts bodyParts) bodyParts { parts.Plan = text; return parts }
	case "notes":
		change = func(parts bodyParts) bodyParts { parts.Notes = text; return parts }
	default:
		return tracker.Usage(
			"%s is not a written part of an issue. There are: %s.",
			`"`+part+`"`, strings.Join(tracker.Parts, ", "),
		)
	}
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	return github.rewrite(issue, change)
}

// Comment adds a comment to an issue, signed when written as someone else.
func (github *adapter) Comment(id, text string) error {
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	body, err := github.signed(text)
	if err != nil {
		return err
	}
	return github.client.AddComment(issue.Number, body)
}

// Start marks an issue as being worked on: the label in-progress, and
// assigned to the signed-in account (GitHub cannot assign to another name).
// Refused for a closed issue.
func (github *adapter) Start(id string) error {
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	if issue.State == "closed" {
		return tracker.Refused("%s is closed. Reopen it before starting work on it.", id)
	}
	update := Changes{}
	if !has(issue.Labels, inProgress) {
		labels := append(append([]string{}, issue.Labels...), inProgress)
		update.Labels = &labels
	}
	viewer, err := github.client.Viewer()
	if err != nil {
		return err
	}
	update.Assignees = &[]string{viewer}
	return github.client.Update(issue.Number, update)
}

// Close closes an issue. A reason, when not empty, is added first as a
// comment that begins "Closed:".
func (github *adapter) Close(id, reason string) error {
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	if reason = strings.TrimSpace(reason); reason != "" {
		body, err := github.signed("Closed: " + reason)
		if err != nil {
			return err
		}
		if err := github.client.AddComment(issue.Number, body); err != nil {
			return err
		}
	}
	update := Changes{State: "closed", StateReason: "completed"}
	// A closed issue is not being worked on; without this it would come
	// back as "in progress" when reopened.
	if has(issue.Labels, inProgress) {
		labels := []string{}
		for _, label := range issue.Labels {
			if label != inProgress {
				labels = append(labels, label)
			}
		}
		update.Labels = &labels
	}
	return github.client.Update(issue.Number, update)
}

// Reopen opens a closed issue again; one already open is left alone.
func (github *adapter) Reopen(id string) error {
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	if issue.State == "open" {
		return nil
	}
	return github.client.Update(issue.Number, Changes{State: "open", StateReason: "reopened"})
}

// Move puts an issue under a parent, or with nil back at the top level.
// Refused when the parent is the issue itself or sits inside it.
func (github *adapter) Move(id string, parentID *string) error {
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	if parentID == nil {
		if issue.Parent != nil {
			return github.client.RemoveParent(issue.Parent.Number, issue.ID)
		}
		return nil
	}
	parent, err := github.need(*parentID)
	if err != nil {
		return err
	}
	// Checked here for the levels that came with the parent; GitHub refuses
	// a deeper loop itself.
	inside := parent.Number == issue.Number
	for up := parent.Parent; up != nil && !inside; up = up.Parent {
		inside = up.Number == issue.Number
	}
	if inside {
		return tracker.Refused("An issue cannot be moved inside itself or inside one of its own sub-issues.")
	}
	return github.client.SetParent(parent.Number, issue.ID)
}

// Link records "id <kind> otherID". "blocked-by" is GitHub's own; the other
// kinds are written as a line on both issues.
//
// Fails with Unsupported for a kind that is not one of tracker.LinkKinds,
// and is refused for an issue with itself and for a link already there.
func (github *adapter) Link(id, otherID, kind string) error {
	if !has(tracker.LinkKinds, kind) {
		return tracker.Unsupported(
			"GitHub issues have no %s link here. There are: %s.",
			`"`+kind+`"`, strings.Join(tracker.LinkKinds, ", "),
		)
	}
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	other, err := github.need(otherID)
	if err != nil {
		return err
	}
	if issue.Number == other.Number {
		return tracker.Refused("An issue cannot be linked to itself.")
	}
	already := func(found string) error {
		return tracker.Refused("%s and %s are already linked (%s).", id, otherID, found)
	}
	if kind == "blocked-by" {
		for _, ref := range issue.BlockedBy {
			if ref.Number == other.Number {
				return already("blocked-by")
			}
		}
		return github.client.AddBlockedBy(issue.Number, other.ID)
	}
	link := tracker.TextLink{Kind: kind, Direction: "out", ID: strconv.Itoa(other.Number)}
	for _, had := range splitBody(issue.Body).Links {
		if had.Kind == link.Kind && had.ID == link.ID {
			return already(kind)
		}
	}
	if err := github.rewrite(issue, withLink(link)); err != nil {
		return err
	}
	return github.rewrite(other, withLink(mirror(link, strconv.Itoa(issue.Number))))
}

// Unlink removes whatever link there is between two issues, in either
// direction, unless options narrow it; refused when nothing was there to
// remove.
func (github *adapter) Unlink(id, otherID string, options tracker.UnlinkOptions) error {
	// GitHub can hold a "blocked by" and a link kept in the text between
	// the same two issues, so a caller that removes one of them says which;
	// without that, everything between the two goes.
	wanted := func(kind string) bool { return options.Kind == "" || options.Kind == kind }
	issue, err := github.need(id)
	if err != nil {
		return err
	}
	other, err := github.need(otherID)
	if err != nil {
		return err
	}
	// waitsFor says whether one issue is recorded as blocked by the other.
	waitsFor := func(one, blocker *Issue) bool {
		for _, ref := range one.BlockedBy {
			if ref.Number == blocker.Number {
				return true
			}
		}
		return false
	}
	removed := false
	if wanted("blocked-by") && waitsFor(issue, other) {
		if err := github.client.RemoveBlockedBy(issue.Number, other.ID); err != nil {
			return err
		}
		removed = true
	}
	if wanted("blocked-by") && !options.OnlyFrom && waitsFor(other, issue) {
		if err := github.client.RemoveBlockedBy(other.Number, issue.ID); err != nil {
			return err
		}
		removed = true
	}
	// Text links: the lines on this issue that name the other, and their
	// counterparts there. With OnlyFrom, a "led to" line (a link that is
	// about the other issue) is left, and so is its counterpart.
	mine := []tracker.TextLink{}
	theirs := []tracker.TextLink{}
	for _, link := range splitBody(issue.Body).Links {
		if link.ID == strconv.Itoa(other.Number) && wanted(link.Kind) &&
			!(options.OnlyFrom && link.Direction == "in") {
			mine = append(mine, link)
			theirs = append(theirs, mirror(link, strconv.Itoa(issue.Number)))
		}
	}
	if len(mine) > 0 {
		if err := github.rewrite(issue, withoutLinks(mine)); err != nil {
			return err
		}
		if err := github.rewrite(other, withoutLinks(theirs)); err != nil {
			return err
		}
		removed = true
	}
	if !removed {
		return tracker.Refused("There is no link between %s and %s.", id, otherID)
	}
	return nil
}
