// Package e2e drives bend as a program, against a real beads folder.
//
// What: starts the bend program in a throwaway repository and checks what
// it prints, what it changes and its exit status; and compares everything a
// fixed series of commands prints with a recording (recorded_test.go).
//
// Why: the adapter's value is in how it drives the real `bd`, so these
// tests catch a change in bd's behaviour as well as a mistake in ours. And
// because they start a program and read its output, they say nothing about
// what language it is written in: the same suite was run against the
// TypeScript bend before the Go one replaced it (bead-bb-c9l.4), and is what
// "the same commands, output and exit statuses" meant.
//
// Design notes:
//   - The program is the one named by the environment's BEND_PROGRAM; when
//     that is not set, the tests build cmd/bend themselves, so that a plain
//     `go test ./...` always tests the source in the repository.
//   - BEND_OLD=1 leaves out what the TypeScript bend never had (see
//     newOnly); it is only of use for running the suite against that one.
//
// Gotchas:
//   - Needs `bd` and `git` on the PATH. Where they are missing the tests are
//     skipped, not failed, so the pure tests still run anywhere.
//   - Each bd command takes a noticeable fraction of a second; the scenarios
//     are grouped to keep the run short.
//   - BD_ACTOR is set so that the names bd records do not depend on who runs
//     the tests.
package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// program is the bend program under test.
var program string

// TestMain finds or builds the program, runs the tests, and removes what it
// built.
func TestMain(m *testing.M) {
	program = os.Getenv("BEND_PROGRAM")
	built := ""
	if program == "" {
		var err error
		if built, err = os.MkdirTemp("", "bend-build-"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		program = filepath.Join(built, "bend")
		build := exec.Command("go", "build", "-o", program, "../cmd/bend")
		if out, err := build.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "bend could not be built: %v\n%s", err, out)
			os.Exit(1)
		}
	}
	status := m.Run()
	if built != "" {
		os.RemoveAll(built)
	}
	os.Exit(status)
}

// newOnly skips a test of something the TypeScript bend never had.
func newOnly(t *testing.T) {
	t.Helper()
	if os.Getenv("BEND_OLD") != "" {
		t.Skip("not in the TypeScript bend")
	}
}

// result is what one run of bend gave.
type result struct {
	status int
	out    string
	err    string
}

// repository is a throwaway folder with git and beads set up in it.
type repository struct {
	t    *testing.T
	root string
	// env is added to the environment of every run, as NAME=value.
	env []string
}

// newRepository makes a throwaway repository; the test is skipped where git
// or bd is not available.
func newRepository(t *testing.T) *repository {
	t.Helper()
	// The real path, so that it is the same text bend prints for it.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range [][]string{
		{"git", "init", "-q"},
		{"bd", "init", "--prefix", "t", "--non-interactive"},
	} {
		run := exec.Command(command[0], command[1:]...)
		run.Dir = root
		if out, err := run.CombinedOutput(); err != nil {
			t.Skipf("bd or git is not available: %v\n%s", err, out)
		}
	}
	return &repository{t: t, root: root}
}

// bend runs one bend command in the repository. Standard input is the text
// "text from standard input".
func (repo *repository) bend(argv ...string) result {
	repo.t.Helper()
	command := exec.Command(program, argv...)
	command.Dir = repo.root
	// No reread is started behind a command: the tests must not leave
	// processes behind, and what they see must not depend on timing.
	command.Env = append(append(os.Environ(), "BD_ACTOR=tester", "BEND_NO_BACKGROUND=1"), repo.env...)
	command.Stdin = strings.NewReader("text from standard input")
	var out, errOut bytes.Buffer
	command.Stdout = &out
	command.Stderr = &errOut
	status := 0
	if err := command.Run(); err != nil {
		exit, isExit := err.(*exec.ExitError)
		if !isExit {
			repo.t.Fatalf("bend could not be started: %v", err)
		}
		status = exit.ExitCode()
	}
	return result{
		status: status,
		out:    strings.TrimSuffix(out.String(), "\n"),
		err:    strings.TrimSuffix(errOut.String(), "\n"),
	}
}

// ok runs a command that must succeed and gives what it printed.
func (repo *repository) ok(argv ...string) string {
	repo.t.Helper()
	got := repo.bend(argv...)
	if got.status != 0 {
		repo.t.Fatalf("bend %s: exit %d: %s%s", strings.Join(argv, " "), got.status, got.err, got.out)
	}
	return got.out
}

// status runs a command and gives its exit status.
func (repo *repository) status(argv ...string) int {
	repo.t.Helper()
	return repo.bend(argv...).status
}

// issue is the part of bend's JSON for an issue that the tests look at.
type issue struct {
	ID           string         `json:"id"`
	Title        string         `json:"title"`
	Status       string         `json:"status"`
	Type         *string        `json:"type"`
	Priority     *int           `json:"priority"`
	Category     *string        `json:"category"`
	Assignee     *string        `json:"assignee"`
	ParentID     *string        `json:"parentId"`
	Description  string         `json:"description"`
	Requirements string         `json:"requirements"`
	Done         string         `json:"done"`
	Plan         string         `json:"plan"`
	CloseReason  string         `json:"closeReason"`
	Labels       []string       `json:"labels"`
	Links        []link         `json:"links"`
	SubIssues    []ref          `json:"subIssues"`
	BlockedBy    []ref          `json:"blockedBy"`
	CommentCount int            `json:"commentCount"`
	UpdatedAt    *string        `json:"updatedAt"`
	Metadata     map[string]any `json:"metadata"`
}

// ref is a pointer to another issue in bend's JSON.
type ref struct {
	ID string `json:"id"`
}

// link is one link in bend's JSON.
type link struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Direction string `json:"direction"`
}

// show gives one issue as bend's JSON describes it.
func (repo *repository) show(id string) issue {
	repo.t.Helper()
	var found issue
	repo.parse(repo.ok("show", id, "--json"), &found)
	return found
}

// list runs a command that prints a list of issues as JSON and gives their
// ids.
func (repo *repository) list(argv ...string) []string {
	repo.t.Helper()
	var found []issue
	repo.parse(repo.ok(append(argv, "--json")...), &found)
	ids := []string{}
	for _, one := range found {
		ids = append(ids, one.ID)
	}
	return ids
}

// parse reads JSON that bend printed, failing the test when it is not JSON.
func (repo *repository) parse(text string, into any) {
	repo.t.Helper()
	if err := json.Unmarshal([]byte(text), into); err != nil {
		repo.t.Fatalf("not JSON: %v\n%s", err, text)
	}
}

// text gives what a pointer points at, or "<none>".
func text(pointer *string) string {
	if pointer == nil {
		return "<none>"
	}
	return *pointer
}

// same fails the test when got is not want.
func same[Value comparable](t *testing.T, got, want Value, what string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

// ids gives the ids of some pointers, joined, for comparing.
func ids(refs []ref) string {
	found := []string{}
	for _, one := range refs {
		found = append(found, one.ID)
	}
	return strings.Join(found, " ")
}

func TestCreateWriteEditAndShow(t *testing.T) {
	repo := newRepository(t)
	id := repo.ok(
		"create", "Checkout flow", "--type", "epic", "--priority", "p1",
		"--description", "-starts with a dash", "--done", "Orders go through",
		"--category", "  UX  Polish ",
	)
	if !strings.HasPrefix(id, "t-") {
		t.Fatalf("got the id %q", id)
	}
	repo.ok("write", id, "requirements", "1. Guest checkout")
	repo.ok("write", id, "description", "Rewritten.")
	repo.ok("write", id, "plan", "--text-file", "-")
	repo.ok("edit", id, "--title", "Checkout", "--priority", "0")
	found := repo.show(id)
	same(t, found.Title, "Checkout", "title")
	same(t, *found.Priority, 0, "priority")
	same(t, text(found.Type), "epic", "type")
	same(t, text(found.Category), "ux polish", "category")
	same(t, found.Description, "Rewritten.", "description")
	same(t, found.Requirements, "1. Guest checkout", "requirements")
	same(t, found.Done, "Orders go through", "done")
	same(t, found.Plan, "text from standard input", "plan")
	repo.ok("write", id, "requirements", "")
	same(t, repo.show(id).Requirements, "", "cleared requirements")
	same(t, repo.show(id).Description, "Rewritten.", "description after clearing")
	repo.ok("edit", id, "--no-category")
	same(t, text(repo.show(id).Category), "<none>", "removed category")
	if !strings.Contains(repo.ok("show", id), "Checkout") {
		t.Fatal("the title is not in the text view")
	}
}

func TestSubIssuesLinksMovingAndBlocking(t *testing.T) {
	repo := newRepository(t)
	parent := repo.ok("create", "Parent", "--category", "api")
	child := repo.ok("create", "Child", "--parent", parent)
	other := repo.ok("create", "Other", "--from", parent)
	same(t, text(repo.show(child).ParentID), parent, "parent")
	same(t, text(repo.show(child).Category), "api", "a sub-issue takes its parent's category")
	same(t, ids(repo.show(parent).SubIssues), child, "sub-issues")
	links := repo.show(other).Links
	if len(links) != 1 || links[0] != (link{ID: parent, Kind: "discovered-from", Direction: "out"}) {
		t.Fatalf("got the links %v", links)
	}

	repo.ok("link", child, other, "--kind", "blocked-by")
	same(t, ids(repo.show(child).BlockedBy), other, "blocked by")
	if !regexp.MustCompile(regexp.QuoteMeta(child) + `\s+blocked`).MatchString(repo.ok("list")) {
		t.Fatal("the list does not show the child as blocked")
	}
	for _, ready := range repo.list("ready") {
		if ready == child {
			t.Fatal("a blocked issue is listed as ready")
		}
	}

	same(t, repo.status("link", child, other, "--kind", "related"), 1, "a second link between two issues")
	same(t, repo.status("link", child, child, "--kind", "related"), 1, "a link to itself")
	same(t, repo.status("link", child, other, "--kind", "nonsense"), 2, "an unknown kind")
	same(t, repo.status("link", child, other), 2, "no kind")

	repo.ok("unlink", other, child)
	same(t, ids(repo.show(child).BlockedBy), "", "blocked by after unlinking")
	same(t, repo.status("unlink", child, other), 1, "unlinking what is not linked")

	repo.ok("move", child, "--top")
	same(t, text(repo.show(child).ParentID), "<none>", "parent after moving to the top")
	repo.ok("move", child, "--under", parent)
	same(t, repo.status("move", parent, "--under", child), 1, "moving an issue inside its own sub-issue")
	same(t, repo.status("move", child), 2, "moving nowhere")

	same(t, strings.Join(repo.list("list", "--parent", parent), " "), child, "list --parent")
	same(t, strings.Join(repo.list("search", "Other"), " "), other, "search")
}

func TestCommentsDecisionsStartingHandingOverAndClosing(t *testing.T) {
	repo := newRepository(t)
	id := repo.ok("create", "Work item")
	repo.ok("comment", id, "--", "-a comment that starts with a dash")
	repo.ok("decide", id, "Keep it simple, because it is enough")
	same(t, repo.status("handover", id, "--done", "x", "--checked", "y"), 2, "a hand-over that leaves something out")
	same(t, repo.show(id).Status, "open", "a refused hand-over changes nothing")
	repo.ok("handover", id, "--done", "Built it", "--checked", "Tests", "--not-checked", "nothing")
	same(t, repo.show(id).Status, "in_progress", "status after the hand-over")
	comments := repo.ok("comments", id)
	for _, wanted := range []string{
		"-a comment that starts with a dash",
		"Decision: Keep it simple",
		"Hand-over: ready for the owner to validate",
	} {
		if !strings.Contains(comments, wanted) {
			t.Fatalf("the comments lack %q:\n%s", wanted, comments)
		}
	}
	same(t, repo.show(id).CommentCount, 3, "comment count")

	repo.ok("close", id, "--reason", "validated")
	same(t, repo.show(id).Status, "closed", "status after closing")
	same(t, repo.show(id).CloseReason, "validated", "close reason")
	if strings.Contains(repo.ok("list"), id) {
		t.Fatal("a closed issue is listed by default")
	}
	if !strings.Contains(repo.ok("list", "--status", "closed"), id) {
		t.Fatal("a closed issue is not listed with --status closed")
	}
	same(t, repo.status("start", id), 1, "starting a closed issue")
	repo.ok("reopen", id)
	repo.ok("start", id, "--as", "agent-7")
	same(t, text(repo.show(id).Assignee), "agent-7", "assignee after starting with --as")
}

func TestSomedaySetsAnIssueAsideAndBringsItBack(t *testing.T) {
	// bead-bb-26g: beads' own deferred status, out of ready and the
	// default list, back to open with undefer.
	repo := newRepository(t)
	idea := repo.ok("create", "An idea for later")
	work := repo.ok("create", "Work in hand")
	repo.ok("start", idea)
	repo.ok("defer", idea)
	same(t, repo.show(idea).Status, "deferred", "status after defer")
	repo.ok("defer", idea)
	for _, args := range [][]string{{"list"}, {"ready"}} {
		if listed := repo.ok(args...); strings.Contains(listed, idea) || !strings.Contains(listed, work) {
			t.Fatalf("bend %v:\n%s", args, listed)
		}
	}
	for _, status := range []string{"deferred", "all"} {
		if !strings.Contains(repo.ok("list", "--status", status), idea) {
			t.Fatalf("not listed with --status %s", status)
		}
	}
	repo.ok("undefer", idea)
	same(t, repo.show(idea).Status, "open", "status after undefer")
	repo.ok("undefer", idea)
	repo.ok("close", idea)
	same(t, repo.status("defer", idea), 1, "deferring a closed issue")
}

func TestProblemsHaveTheRightExitStatus(t *testing.T) {
	repo := newRepository(t)
	missing := repo.bend("show", "t-nope")
	same(t, missing.status, 1, "showing an issue that is not there")
	if !strings.Contains(missing.err, "no issue with id t-nope") {
		t.Fatalf("got %q", missing.err)
	}
	var failure struct {
		OK     bool   `json:"ok"`
		Status int    `json:"status"`
		Error  string `json:"error"`
	}
	repo.parse(repo.bend("show", "t-nope", "--json").out, &failure)
	if failure.OK || failure.Status != 1 || failure.Error != "There is no issue with id t-nope." {
		t.Fatalf("got %+v", failure)
	}
	same(t, repo.status("bogus"), 2, "an unknown command")
	same(t, repo.status("list", "--wat"), 2, "an unknown option")
	same(t, repo.status(), 2, "no command")
	same(t, repo.status("--help"), 0, "--help")
	if !strings.Contains(repo.bend("create", "--help").out, "--blocked-by <id>") {
		t.Fatal("the help of create does not list --blocked-by")
	}
	nowhere := repo.bend("-C", t.TempDir(), "list")
	same(t, nowhere.status, 1, "a folder without a tracker")
	if !strings.Contains(nowhere.err, "No supported issue tracker") {
		t.Fatalf("got %q", nowhere.err)
	}
}

func TestStatusAndFacts(t *testing.T) {
	repo := newRepository(t)
	status := repo.ok("status")
	for _, wanted := range []string{`Tracker\s+beads`, `requirements\s+kept as a marked section`, `not synced anywhere`} {
		if !regexp.MustCompile(wanted).MatchString(status) {
			t.Fatalf("the status lacks %q:\n%s", wanted, status)
		}
	}
	repo.ok("remember", "Deploys go out on Mondays", "--key", "deploys")
	if !strings.Contains(repo.ok("remember", "Deploys go out on Tuesdays", "--key", "deploys"), "Replaced") {
		t.Fatal("saving under the same key did not replace")
	}
	same(t, repo.ok("recall", "tuesday"), "deploys: Deploys go out on Tuesdays", "recall")
	file, err := os.ReadFile(filepath.Join(repo.root, "FACTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(file), "# Facts\n") ||
		!strings.HasSuffix(string(file), "- **deploys** — Deploys go out on Tuesdays\n") {
		t.Fatalf("got the facts file %q", file)
	}
}

func TestListNarrowedToWhatChangedSince(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	repo.ok("create", "One")
	repo.ok("create", "Two")
	everything := strings.Join(repo.list("list", "--status", "all"), " ")
	// Everything in this throwaway folder was made a moment ago.
	same(t, strings.Join(repo.list("list", "--status", "all", "--changed-since", "2000-01-01T00:00:00Z"), " "),
		everything, "changed since long ago")
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	same(t, strings.Join(repo.list("list", "--status", "all", "--changed-since", later), " "), "", "changed since later")
	// Without an offset it is this machine's time; a moment that cannot be
	// read is refused, not answered with "nothing changed".
	local := time.Now().Add(-time.Hour).Format("2006-01-02T15:04:05")
	same(t, strings.Join(repo.list("list", "--status", "all", "--changed-since", local), " "), everything, "changed since an hour ago, local time")
	same(t, repo.status("list", "--changed-since", "yesterday"), 2, "a moment that cannot be read")
}
