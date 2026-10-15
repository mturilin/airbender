// github_test.go — tests for the GitHub adapter, without a network.
//
// What: checks where each thing is kept on GitHub (labels, sections of the
// description, links written on both issues), what blocks what, who a
// comment is from, what each operation refuses, and what a read costs in
// requests; and the plain words for each way a request can fail.
//
// Why: these are the adapter's own rules, and none of them needs GitHub to
// be checked. They run against an in-memory stand-in (fake.go). The real
// client is tested against a stand-in web server in api_test.go.

package github

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// fresh gives a fresh stand-in repository and an adapter on it, acting as
// actor ("" for nobody else).
func fresh(actor string) (*Fake, tracker.Tracker) {
	github := NewFake(FakeOptions{Login: "octo"})
	return github, New(github, actor)
}

// wantFailure fails the test unless err is a *tracker.Error of this kind
// whose message matches the pattern.
func wantFailure(t *testing.T, err error, kind tracker.Kind, pattern string) {
	t.Helper()
	var failure *tracker.Error
	if !errors.As(err, &failure) {
		t.Fatalf("want a %s failure matching %q, got %v", kind, pattern, err)
	}
	if failure.Kind != kind || !regexp.MustCompile(pattern).MatchString(failure.Message) {
		t.Fatalf("want a %s failure matching %q, got %s: %s", kind, pattern, failure.Kind, failure.Message)
	}
}

// wantRefused fails the test unless err is a plain refusal whose message
// matches the pattern.
func wantRefused(t *testing.T, err error, pattern string) {
	t.Helper()
	wantFailure(t, err, tracker.KindRefused, pattern)
}

// must fails the test when an operation that should work did not.
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected failure: %v", err)
	}
}

// same fails the test unless got and want are deeply equal.
func same(t *testing.T, got, want any, what ...string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %#v, want %#v", strings.Join(what, " "), got, want)
	}
}

// create makes an issue and gives its id, failing the test on a refusal.
func create(t *testing.T, github tracker.Tracker, draft tracker.Draft) string {
	t.Helper()
	id, err := github.Create(draft)
	must(t, err)
	return id
}

// show gives an issue, failing the test on a refusal.
func show(t *testing.T, github tracker.Tracker, id string) tracker.Issue {
	t.Helper()
	issue, err := github.Show(id)
	must(t, err)
	return issue
}

// ids gives the ids of issues, in order.
func ids(issues []tracker.Issue) []string {
	found := []string{}
	for _, issue := range issues {
		found = append(found, issue.ID)
	}
	return found
}

// refIDs gives the ids of pointers to issues, in order.
func refIDs(refs []tracker.IssueRef) []string {
	found := []string{}
	for _, ref := range refs {
		found = append(found, ref.ID)
	}
	return found
}

// kinds gives an issue's links as "kind direction id", in order.
func kinds(t *testing.T, github tracker.Tracker, id string) []string {
	t.Helper()
	found := []string{}
	for _, link := range show(t, github, id).Links {
		found = append(found, link.Kind+" "+link.Direction+" "+link.ID)
	}
	return found
}

// text gives what an optional text holds, or "<nil>".
func text(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func TestDescriptionIsTakenApartAndPutBackTheSame(t *testing.T) {
	parts := bodyParts{
		Description:  "Wanted.",
		Requirements: "1. One",
		Done:         "It works",
		Plan:         "Do it",
		Notes:        "A note",
		Links: []tracker.TextLink{
			{Kind: "discovered-from", Direction: "out", ID: "12"},
			{Kind: "discovered-from", Direction: "in", ID: "15"},
			{Kind: "related", Direction: "out", ID: "7"},
		},
		Data: map[string]string{"branch": "epic/x"},
	}
	body := joinBody(parts)
	same(t, splitBody(body), parts)
	// A person reading it on github.com sees headings and plain lines.
	for _, pattern := range []string{
		`^Wanted\.\n\n<!-- bend:requirements -->\n## Requirements\n\n1\. One\n`,
		`## Done when\n\nIt works`,
		`## Links\n\n- discovered from #12\n- led to #15\n- related to #7\n`,
	} {
		if !regexp.MustCompile(pattern).MatchString(body) {
			t.Fatalf("the description does not match %q:\n%s", pattern, body)
		}
	}
	// Nothing but a description: no markers at all.
	same(t, joinBody(bodyParts{Description: "Wanted."}), "Wanted.")
	// A line a person added to the Links section is ignored, not an error.
	same(t,
		splitBody("x\n\n<!-- bend:links -->\n## Links\n\n- see also the wiki\n- related to #3\n<!-- /bend:links -->").Links,
		[]tracker.TextLink{{Kind: "related", Direction: "out", ID: "3"}},
	)
}

func TestFieldsAreLabelsAndPartsAreSections(t *testing.T) {
	github, adapter := fresh("")
	id := create(t, adapter, tracker.Draft{
		Title:       "Checkout flow",
		Description: tracker.Ptr("-starts with a dash"),
		Done:        tracker.Ptr("Orders go through"),
		Type:        tracker.Ptr("epic"),
		Priority:    tracker.Ptr(1),
		Category:    tracker.Ptr("  UX  Polish "),
	})
	same(t, id, "1")
	labels := github.LabelsOf(1)
	sort.Strings(labels)
	same(t, labels, []string{"category:ux polish", "priority:1", "type:epic"})
	must(t, adapter.Write(id, "requirements", "1. Guest checkout"))
	must(t, adapter.Write(id, "plan", "The plan"))
	must(t, adapter.Write(id, "notes", "A note"))
	must(t, adapter.Write(id, "description", "Rewritten."))
	must(t, adapter.Edit(id, tracker.Changes{
		Title:     tracker.Ptr("Checkout"),
		Priority:  tracker.Ptr(0),
		AddLabels: []string{"urgent"},
		Assignee:  tracker.Ptr("kim"),
	}))
	issue := show(t, adapter, id)
	same(t,
		[]string{issue.Title, issue.Status, text(issue.Type), text(issue.Category), text(issue.Assignee)},
		[]string{"Checkout", "open", "epic", "ux polish", "kim"},
	)
	same(t, issue.Priority, tracker.Ptr(0))
	same(t,
		[]string{issue.Description, issue.Requirements, issue.Done, issue.Plan, issue.Notes},
		[]string{"Rewritten.", "1. Guest checkout", "Orders go through", "The plan", "A note"},
	)
	// The labels that hold a field are not shown as plain labels.
	same(t, issue.Labels, []string{"urgent"})
	// One priority label, never two.
	priorities := []string{}
	for _, label := range github.LabelsOf(1) {
		if strings.HasPrefix(label, "priority:") {
			priorities = append(priorities, label)
		}
	}
	same(t, priorities, []string{"priority:0"})
	// Clearing a part removes its section; clearing a category its label.
	must(t, adapter.Write(id, "plan", ""))
	must(t, adapter.Edit(id, tracker.Changes{
		ClearCategory: true, RemoveLabels: []string{"urgent"}, ClearAssignee: true,
	}))
	issue = show(t, adapter, id)
	same(t, issue.Plan, "")
	same(t, issue.Category, (*string)(nil))
	same(t, issue.Labels, []string{})
	same(t, issue.Assignee, (*string)(nil))
	if strings.Contains(github.BodyOf(1), "bend:plan") {
		t.Fatalf("the plan's section is still there:\n%s", github.BodyOf(1))
	}

	must(t, adapter.Start(id))
	issue = show(t, adapter, id)
	same(t, []string{issue.Status, text(issue.Assignee)}, []string{"in_progress", "octo"})
	if !has(github.LabelsOf(1), "in-progress") {
		t.Fatalf("no in-progress label: %v", github.LabelsOf(1))
	}
	wantRefused(t, adapter.Edit(id, tracker.Changes{Priority: tracker.Ptr(7)}), `whole number from 0`)
	// Nothing kept with it yet (see the test of kept data below).
	same(t, string(issue.Metadata), "{}")
	same(t, issue.ExternalRef, (*string)(nil))
	wantRefused(t, adapter.Edit(id, tracker.Changes{Category: tracker.Ptr("a,b")}), `comma`)
	// A part that is not one of the written parts is a wrong request.
	wantFailure(t, adapter.Write(id, "links", "x"), tracker.KindUsage, `not a written part`)
}

func TestSubIssuesWhatBlocksWhatAndMoving(t *testing.T) {
	_, adapter := fresh("")
	epic := create(t, adapter, tracker.Draft{
		Title: "Epic", Category: tracker.Ptr("ux"), Type: tracker.Ptr("epic"),
	})
	child := create(t, adapter, tracker.Draft{Title: "Child", ParentID: &epic})
	grandchild := create(t, adapter, tracker.Draft{Title: "Grandchild", ParentID: &child})
	blocker := create(t, adapter, tracker.Draft{Title: "Blocker"})
	// A sub-issue takes its parent's category and nothing else.
	shown := show(t, adapter, child)
	same(t,
		[]string{text(shown.ParentID), text(shown.Category), text(shown.Type)},
		[]string{epic, "ux", "<nil>"},
	)
	same(t, refIDs(show(t, adapter, epic).SubIssues), []string{child})

	must(t, adapter.Link(epic, blocker, "blocked-by"))
	same(t, kinds(t, adapter, epic), []string{"blocked-by out " + blocker})
	same(t, kinds(t, adapter, blocker), []string{"blocked-by in " + epic})
	// What the epic waits for, the issues inside it wait for too, at any
	// depth.
	for _, id := range []string{epic, child, grandchild} {
		same(t, refIDs(show(t, adapter, id).BlockedBy), []string{blocker}, id)
	}
	ready, err := adapter.Ready()
	must(t, err)
	same(t, ids(ready), []string{blocker})
	wantRefused(t, adapter.Link(epic, blocker, "blocked-by"), `already linked`)
	// A finished blocker no longer blocks, but the link is still shown.
	must(t, adapter.Close(blocker, ""))
	shown = show(t, adapter, child)
	same(t, shown.BlockedBy, []tracker.IssueRef{})
	same(t, show(t, adapter, epic).Links[0].Status, "closed")
	ready, err = adapter.Ready()
	must(t, err)
	same(t, ids(ready), []string{epic, child, grandchild})

	wantRefused(t, adapter.Move(epic, &epic), `inside itself`)
	wantRefused(t, adapter.Move(epic, &grandchild), `inside itself`)
	must(t, adapter.Move(grandchild, &epic))
	same(t, text(show(t, adapter, grandchild).ParentID), epic)
	must(t, adapter.Move(grandchild, nil))
	same(t, show(t, adapter, grandchild).ParentID, (*string)(nil))
	must(t, adapter.Move(grandchild, nil)) // Already at the top: nothing to do.
}

func TestLinksGitHubHasNoPlaceForAreWrittenOnBothIssues(t *testing.T) {
	github, adapter := fresh("")
	origin := create(t, adapter, tracker.Draft{Title: "Origin"})
	follow := create(t, adapter, tracker.Draft{Title: "Follow-up", From: &origin})
	other := create(t, adapter, tracker.Draft{Title: "Other"})
	number := func(id string) int {
		parsed, err := strconv.Atoi(id)
		must(t, err)
		return parsed
	}
	same(t, kinds(t, adapter, follow), []string{"discovered-from out " + origin})
	same(t, kinds(t, adapter, origin), []string{"discovered-from in " + follow})
	if !strings.Contains(github.BodyOf(number(follow)), "- discovered from #1") {
		t.Fatalf("no line on the follow-up:\n%s", github.BodyOf(number(follow)))
	}
	if !strings.Contains(github.BodyOf(number(origin)), "- led to #2") {
		t.Fatalf("no line on the origin:\n%s", github.BodyOf(number(origin)))
	}

	must(t, adapter.Link(follow, other, "related"))
	same(t, kinds(t, adapter, other), []string{"related out " + follow})
	same(t, kinds(t, adapter, follow), []string{
		"discovered-from out " + origin,
		"related out " + other,
	})
	wantRefused(t, adapter.Link(follow, other, "related"), `already linked`)
	wantRefused(t, adapter.Link(follow, follow, "related"), `to itself`)
	wantRefused(t, adapter.Link(follow, "99", "related"), `no issue with id 99`)
	wantFailure(t, adapter.Link(follow, other, "tracks"), tracker.KindUnsupported, `no "tracks" link here`)

	// Showing one issue never reads the list: a fixed, small number of
	// requests, whatever the repository holds.
	for extra := 0; extra < 30; extra++ {
		create(t, adapter, tracker.Draft{Title: fmt.Sprintf("Filler %d", extra)})
	}
	before := github.Requests()
	show(t, adapter, follow)
	same(t, github.Requests()-before, 2, "show: the issue, and the titles its text links name")
	before = github.Requests()
	show(t, adapter, other)
	same(t, github.Requests()-before, 2)
	before = github.Requests()
	_, err := adapter.Comments(follow)
	must(t, err)
	same(t, github.Requests()-before, 2, "comments: the issue, and its comments")

	// One kind can be removed and another between the same two left.
	must(t, adapter.Link(other, follow, "blocked-by"))
	must(t, adapter.Unlink(other, follow, tracker.UnlinkOptions{Kind: "blocked-by"}))
	same(t, kinds(t, adapter, other), []string{"related out " + follow})
	must(t, adapter.Link(other, follow, "blocked-by"))
	must(t, adapter.Unlink(other, follow, tracker.UnlinkOptions{Kind: "related"}))
	same(t, kinds(t, adapter, other), []string{"blocked-by out " + follow})
	must(t, adapter.Link(other, follow, "related"))
	must(t, adapter.Unlink(other, follow, tracker.UnlinkOptions{Kind: "blocked-by"}))
	// Removing a link removes both lines.
	must(t, adapter.Unlink(other, follow, tracker.UnlinkOptions{}))
	same(t, kinds(t, adapter, other), []string{})
	same(t, kinds(t, adapter, follow), []string{"discovered-from out " + origin})
	// "Only the link recorded on this issue": the origin's "led to" line is
	// about the follow-up, so it stays; from the follow-up's side it goes.
	wantRefused(t, adapter.Unlink(origin, follow, tracker.UnlinkOptions{OnlyFrom: true}), `no link between`)
	must(t, adapter.Unlink(follow, origin, tracker.UnlinkOptions{OnlyFrom: true}))
	same(t, kinds(t, adapter, follow), []string{})
	same(t, kinds(t, adapter, origin), []string{})
	if strings.Contains(github.BodyOf(number(origin)), "bend:links") {
		t.Fatalf("the Links section is still on the origin:\n%s", github.BodyOf(number(origin)))
	}
	wantRefused(t, adapter.Unlink(follow, origin, tracker.UnlinkOptions{}), `no link between`)
}

func TestCommentsSayWhoWroteThemClosingWithAReasonReopening(t *testing.T) {
	_, adapter := fresh("agent-7")
	id := create(t, adapter, tracker.Draft{Title: "To close"})
	must(t, adapter.Comment(id, "Decision: use the queue"))
	must(t, adapter.Start(id))
	must(t, adapter.Close(id, "Shipped in 2.1"))
	// said gives who wrote each comment and what, in order.
	said := func(github tracker.Tracker, id string) [][2]string {
		comments, err := github.Comments(id)
		must(t, err)
		found := [][2]string{}
		for _, comment := range comments {
			found = append(found, [2]string{comment.Author, comment.Text})
		}
		return found
	}
	same(t, said(adapter, id), [][2]string{
		{"agent-7", "Decision: use the queue"},
		{"agent-7", "Closed: Shipped in 2.1"},
	})
	issue := show(t, adapter, id)
	same(t, []string{issue.Status, issue.CloseReason}, []string{"closed", "completed"})
	same(t, issue.CommentCount, 2)
	wantRefused(t, adapter.Start(id), `is closed`)
	must(t, adapter.Reopen(id))
	issue = show(t, adapter, id)
	// Not "in progress" again: closing took that label off.
	same(t, []string{issue.Status, issue.CloseReason}, []string{"open", ""})

	// Written as the signed-in account itself: nothing is added.
	_, own := fresh("octo")
	mine := create(t, own, tracker.Draft{Title: "Mine"})
	must(t, own.Comment(mine, "plain"))
	same(t, said(own, mine), [][2]string{{"octo", "plain"}})
	// An issue with no comments gives an empty list, not none at all.
	comments, err := own.Comments(create(t, own, tracker.Draft{Title: "Silent"}))
	must(t, err)
	same(t, comments, []tracker.Comment{})
	// A name cannot break out of the marker it is kept in.
	signed := signComment("a --> b\nc", "text")
	author, body := readComment("octo", signed)
	same(t, []string{author, body}, []string{"a   b c", "text"})
}

func TestListsOpenByDefaultNarrowedInMemoryAndOnlyWhatChangedSince(t *testing.T) {
	github, adapter := fresh("")
	bug := create(t, adapter, tracker.Draft{
		Title: "Bug", Type: tracker.Ptr("bug"), Priority: tracker.Ptr(1), Category: tracker.Ptr("api"),
	})
	task := create(t, adapter, tracker.Draft{Title: "Task", Type: tracker.Ptr("task"), ParentID: &bug})
	done := create(t, adapter, tracker.Draft{Title: "Done"})
	must(t, adapter.Close(done, ""))
	must(t, adapter.Start(task))
	list := func(filter tracker.ListFilter) []string {
		t.Helper()
		found, err := adapter.List(filter)
		must(t, err)
		return ids(found)
	}
	same(t, list(tracker.ListFilter{}), []string{bug, task})
	same(t, list(tracker.ListFilter{Status: tracker.Ptr("all")}), []string{bug, task, done})
	same(t, list(tracker.ListFilter{Status: tracker.Ptr("closed")}), []string{done})
	same(t, list(tracker.ListFilter{Status: tracker.Ptr("in_progress")}), []string{task})
	same(t, list(tracker.ListFilter{Status: tracker.Ptr("open")}), []string{bug})
	same(t, list(tracker.ListFilter{Type: tracker.Ptr("bug")}), []string{bug})
	same(t, list(tracker.ListFilter{Priority: tracker.Ptr(1)}), []string{bug})
	same(t, list(tracker.ListFilter{Category: tracker.Ptr(" API ")}), []string{bug, task})
	same(t, list(tracker.ListFilter{Assignee: tracker.Ptr("octo")}), []string{task})
	same(t, list(tracker.ListFilter{ParentID: tracker.Ptr("#" + bug)}), []string{task})
	found, err := adapter.Search("bug")
	must(t, err)
	same(t, ids(found), []string{bug})
	// Nothing found is an empty list, not none at all.
	found, err = adapter.Search("nowhere")
	must(t, err)
	same(t, found, []tracker.Issue{})

	github.SetClock("2026-03-01T00:00:00Z")
	must(t, adapter.Edit(bug, tracker.Changes{Title: tracker.Ptr("Bug, renamed")}))
	same(t,
		list(tracker.ListFilter{Status: tracker.Ptr("all"), ChangedSince: tracker.Ptr("2026-02-01T00:00:00Z")}),
		[]string{bug},
	)
	// A list is one request, however it is narrowed.
	before := github.Requests()
	list(tracker.ListFilter{Status: tracker.Ptr("all")})
	same(t, github.Requests()-before, 1)
}

func TestAnIDIsGitHubsNumberAnythingElseIsRefusedBeforeGitHubIsAsked(t *testing.T) {
	github, adapter := fresh("")
	id := create(t, adapter, tracker.Draft{Title: "One"})
	same(t, show(t, adapter, "#"+id).ID, id)
	before := github.Requests()
	for _, bad := range []string{"abc", "", "0", "-1", "1.5", "owner/repo#1", "--force", "100%s"} {
		_, err := adapter.Show(bad)
		wantRefused(t, err, `not a GitHub issue number`)
		// The id is said back exactly as it was typed.
		if !strings.HasPrefix(err.Error(), `"`+bad+`" is not`) {
			t.Fatalf("the id %q is not named in: %s", bad, err)
		}
	}
	same(t, github.Requests(), before)
	_, err := adapter.Show("42")
	wantRefused(t, err, `no issue with id 42`)
	_, err = adapter.Create(tracker.Draft{Title: "x", ParentID: tracker.Ptr("42")})
	wantRefused(t, err, `no issue with id 42`)
	// Nothing was created by the refused create.
	all, err := adapter.List(tracker.ListFilter{Status: tracker.Ptr("all")})
	must(t, err)
	same(t, ids(all), []string{id})
}

func TestStoppingTakesInProgressOffAndLeavesTheAssignee(t *testing.T) {
	github, adapter := fresh("")
	id := create(t, adapter, tracker.Draft{Title: "Set aside"})
	must(t, adapter.Edit(id, tracker.Changes{AddLabels: []string{"ui"}}))
	must(t, adapter.Start(id))
	must(t, adapter.Stop(id))
	shown := show(t, adapter, id)
	same(t, []string{shown.Status, text(shown.Assignee)}, []string{"open", "octo"})
	same(t, github.LabelsOf(1), []string{"ui"})
	// One that is not in progress is left alone: nothing is sent.
	before := github.Requests()
	must(t, adapter.Stop(id))
	same(t, github.Requests(), before+1)
	must(t, adapter.Close(id, ""))
	wantRefused(t, adapter.Stop(id), `is closed`)
}

func TestSomedayIsALabelThatStartingAndClosingTakeOff(t *testing.T) {
	// bead-bb-26g.
	github, adapter := fresh("")
	id := create(t, adapter, tracker.Draft{Title: "Maybe later"})
	must(t, adapter.Edit(id, tracker.Changes{AddLabels: []string{"ui"}}))
	must(t, adapter.Start(id))
	must(t, adapter.Defer(id))
	same(t, show(t, adapter, id).Status, tracker.DeferredStatus)
	same(t, github.LabelsOf(1), []string{"ui", "someday"})
	same(t, show(t, adapter, id).Labels, []string{"ui"})
	// Twice changes nothing: nothing is sent.
	before := github.Requests()
	must(t, adapter.Defer(id))
	same(t, github.Requests(), before+1)
	ready, err := adapter.Ready()
	must(t, err)
	same(t, len(ready), 0)
	listed, err := adapter.List(tracker.ListFilter{})
	must(t, err)
	same(t, len(listed), 0)
	must(t, adapter.Undefer(id))
	same(t, show(t, adapter, id).Status, "open")
	same(t, github.LabelsOf(1), []string{"ui"})
	// Starting takes it out of Someday; so does closing.
	must(t, adapter.Defer(id))
	must(t, adapter.Start(id))
	same(t, github.LabelsOf(1), []string{"ui", "in-progress"})
	must(t, adapter.Defer(id))
	must(t, adapter.Close(id, ""))
	same(t, github.LabelsOf(1), []string{"ui"})
	wantRefused(t, adapter.Defer(id), `is closed`)
}

func TestKeptDataIsAHiddenLineAtTheEndOfTheDescription(t *testing.T) {
	github, adapter := fresh("")
	id := create(t, adapter, tracker.Draft{Title: "Epic", Description: tracker.Ptr("What is wanted.")})
	must(t, adapter.Write(id, "plan", "First this."))
	set := func(key string, value *string) error {
		return adapter.Edit(id, tracker.Changes{Metadata: []tracker.MetadataChange{{Key: key, Value: value}}})
	}
	// A value that would end an HTML comment, or break a line, is kept whole.
	branch := "epic/a-very-long-branch-name-that-no-label-could-hold-because-it-is-over-fifty --> \"x\""
	must(t, set("branch", &branch))
	must(t, set("other", tracker.Ptr("kept")))
	body := github.BodyOf(1)
	lines := strings.Split(body, "\n")
	last := lines[len(lines)-1]
	if !strings.HasPrefix(last, "<!-- bend:data {") || !strings.HasSuffix(last, "} -->") || strings.Count(body, "-->") != strings.Count(body, "<!--") {
		t.Fatalf("the data is not one hidden line at the end:\n%s", body)
	}
	shown := show(t, adapter, id)
	same(t, string(shown.Metadata), `{"branch":"epic/a-very-long-branch-name-that-no-label-could-hold-because-it-is-over-fifty --\u003e \"x\"","other":"kept"}`)
	// Nothing else moved: the description and the plan read as before.
	same(t, shown.Description, "What is wanted.")
	same(t, shown.Plan, "First this.")
	// Writing a part keeps the data, and keeps it last.
	must(t, adapter.Write(id, "notes", "A note."))
	lines = strings.Split(github.BodyOf(1), "\n")
	if !strings.HasPrefix(lines[len(lines)-1], "<!-- bend:data ") {
		t.Fatalf("the data is no longer last:\n%s", github.BodyOf(1))
	}
	// Setting it to what it is asks nothing of GitHub but the read.
	before := github.Requests()
	must(t, set("other", tracker.Ptr("kept")))
	same(t, github.Requests(), before+1)
	// Taken out one by one; with the last gone, so is the line.
	must(t, set("branch", nil))
	must(t, set("other", nil))
	if strings.Contains(github.BodyOf(1), "bend:data") {
		t.Fatalf("an empty line of data was left:\n%s", github.BodyOf(1))
	}
	same(t, string(show(t, adapter, id).Metadata), "{}")

	// Only the last line is data. A line of the same shape further up is
	// text: an issue that describes this line keeps its description whole
	// and gets no data from it.
	other := create(t, adapter, tracker.Draft{Title: "About the line"})
	quoted := "Use this line:\n<!-- bend:data {\"branch\":\"doc\"} -->\nto keep data."
	must(t, github.Update(2, Changes{Body: &quoted}))
	same(t, string(show(t, adapter, other).Metadata), "{}")
	same(t, show(t, adapter, other).Description, quoted)
	// Its own data goes under that, and both are read back as they are.
	must(t, adapter.Edit(other, tracker.Changes{Metadata: []tracker.MetadataChange{{Key: "branch", Value: tracker.Ptr("b")}}}))
	same(t, string(show(t, adapter, other).Metadata), `{"branch":"b"}`)
	same(t, show(t, adapter, other).Description, quoted)
	// Someone wrote under the line on github.com: it is text now, in view,
	// and the data reads as gone.
	text := github.BodyOf(2) + "\n\nAdded on github.com."
	must(t, github.Update(2, Changes{Body: &text}))
	same(t, string(show(t, adapter, other).Metadata), "{}")
	if !strings.Contains(show(t, adapter, other).Description, `bend:data {"branch":"b"}`) {
		t.Fatal("the line that is no longer last was dropped")
	}
	// A line broken by hand is no data, and is left to be seen.
	broken := "Text.\n\n<!-- bend:data {not json} -->"
	must(t, github.Update(2, Changes{Body: &broken}))
	same(t, string(show(t, adapter, other).Metadata), "{}")
	if !strings.Contains(show(t, adapter, other).Description, "bend:data") {
		t.Fatal("a broken line of data was dropped")
	}
}

func TestStatusNamesTheRepositoryTheAccountAndWhatIsKeptAnotherWay(t *testing.T) {
	github, adapter := fresh("")
	capabilities, err := adapter.Capabilities()
	must(t, err)
	same(t, capabilities.Tracker, "github")
	if !strings.Contains(capabilities.Where, "someone/scratch on GitHub, signed in as octo") {
		t.Fatalf("where: %s", capabilities.Where)
	}
	same(t, capabilities.LinkKinds, []string{"blocked-by", "discovered-from", "related"})
	level := func(name string) string {
		for _, item := range capabilities.Supports {
			if strings.Contains(item.Name, name) {
				return item.Level
			}
		}
		return ""
	}
	same(t, level("sub-issues"), "yes")
	same(t, level("type, priority, category"), "another way")
	same(t, level("requirements"), "another way")
	same(t, level("discovered-from"), "another way")
	same(t, level("acting as another name"), "no")

	// What is known without asking: the name, the repository, the kinds of
	// link; and not one request is sent for it.
	before := github.Requests()
	about := adapter.About()
	same(t, about, tracker.About{
		Tracker:    "github",
		Repository: tracker.Ptr("someone/scratch"),
		LinkKinds:  []string{"blocked-by", "discovered-from", "related"},
		Writes:     tracker.WritesQueued,
	})
	same(t, github.Requests(), before)
}

func TestEveryWayARequestCanFailIsSaidInPlainWords(t *testing.T) {
	// headers builds a response's headers from names and values.
	headers := func(values map[string]string) http.Header {
		built := http.Header{}
		for name, value := range values {
			built.Set(name, value)
		}
		return built
	}
	for _, check := range []struct {
		status  int
		headers map[string]string
		detail  string
		pattern string
	}{
		{403, map[string]string{"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791603725"}, "", `hourly limit .* lifts at \d\d:\d\d\.$`},
		{429, map[string]string{"x-ratelimit-remaining": "0"}, "", `lifts at the top of the hour\.$`},
		{403, map[string]string{"retry-after": "30"}, "You have exceeded a secondary rate limit", `slow down .* 30 seconds`},
		{403, nil, "You have exceeded a secondary rate limit", `slow down .* in a minute\.$`},
		{401, nil, "Bad credentials", `did not accept the login`},
		{403, nil, "Resource not accessible", `may not do that here\. Resource not accessible$`},
		{404, nil, "Not Found", `no such repository or issue`},
		{410, nil, "", `switched off`},
		{502, nil, "", `having trouble \(status 502\)`},
		{422, nil, "", `^GitHub refused the request \(status 422\)\.$`},
	} {
		got := explainFailure(check.status, headers(check.headers), check.detail)
		if !regexp.MustCompile(check.pattern).MatchString(got) {
			t.Fatalf("status %d: %q does not match %q", check.status, got, check.pattern)
		}
	}
	same(t, explainFailure(422, headers(nil), "Validation Failed"), "GitHub refused: Validation Failed")
}
