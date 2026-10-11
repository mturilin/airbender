// github_test.go — the whole command, against real GitHub issues.
//
// What: runs every `bend` command, as the built program, in a folder set to
// use a scratch repository on GitHub, and checks what they print, what they
// change and the exit status. Then deletes every issue it made.
//
// Why: the adapter's tests (internal/github/github_test.go) run against a
// stand-in that imitates GitHub. Only this test finds out when GitHub
// behaves differently from the stand-in, or changes.
//
// How to run it: it is skipped unless the environment names the scratch
// repository, so a plain `go test ./...` stays offline:
//
//	BEND_GITHUB_SCRATCH=mturilin/bend-scratch go test ./e2e -run GitHub
//
// It needs a login that owns that repository (GH_TOKEN, GITHUB_TOKEN, or
// `gh auth login`).
//
// Design notes:
//   - Each test has a folder of its own and cleans up the issues it made
//     itself (t.Cleanup), so one test can be run alone and a failed test
//     still cleans up.
//   - The folder is not a beads folder and not a git repository: a
//     `.bend.json` in it names the tracker and the repository, which is all
//     bend needs. So neither `bd` nor `git` is run.
//   - bend signs in by itself, the same way this file finds the token. The
//     token found here is used only for the clean-up, which bend has no
//     command for (it never deletes an issue).
//
// Gotchas:
//   - It creates and DELETES real issues. As a guard it refuses any
//     repository whose name does not contain "scratch", and it deletes only
//     the issues it created itself, by number.
//   - Deleting an issue needs the owner's rights; with less, the issues are
//     left closed and the test says so.
//   - The token is never printed: no message of this file holds it, and what
//     GitHub answers to the clean-up is not printed either.
//   - Each command is one to four requests over the network; the whole run
//     takes a minute or two and stays far below GitHub's limits (about 80
//     content-creating requests against 80 a minute, spread over that time).
//   - GitHub's search runs behind, so the search check waits and retries.
//   - Labels this test adds to an issue (bend-e2e-label, type:epic, ...) are
//     created in the repository by GitHub and stay there after the issues
//     are deleted.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// scratchVariable is the environment variable that names the scratch
// repository, as "owner/name".
const scratchVariable = "BEND_GITHUB_SCRATCH"

// scratchName is what the repository's name must look like: "owner/name"
// with "scratch" somewhere in the name. This is the guard against deleting
// issues in a repository that matters.
var scratchName = regexp.MustCompile(`(?i)^[\w.-]+/[\w.-]*scratch[\w.-]*$`)

// issueNumber is what a new issue's id looks like on GitHub.
var issueNumber = regexp.MustCompile(`^\d+$`)

// githubTimeout is how long one request of the clean-up, or `gh auth token`,
// may take.
const githubTimeout = 20 * time.Second

// scratch is a throwaway folder set to use the scratch repository on
// GitHub, with the issues the test made in it.
type scratch struct {
	// repository gives the helpers that run bend in the folder.
	*repository
	// name is the scratch repository, "owner/name".
	name string
	// token signs the clean-up's requests in. Never printed.
	token string
	// made is the numbers of the issues this test created, for the clean-up.
	made []string
}

// githubToken gives the token to sign in to GitHub with: GH_TOKEN or
// GITHUB_TOKEN when set, else what `gh auth token` prints.
//
// Returns "" when there is none: `gh` is not installed or holds no login.
// Side effects: may run `gh auth token`. What gh prints about a problem is
// dropped, so nothing of it reaches a message.
func githubToken() string {
	for _, name := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if given := strings.TrimSpace(os.Getenv(name)); given != "" {
			return given
		}
	}
	limit, cancel := context.WithTimeout(context.Background(), githubTimeout)
	defer cancel()
	output, err := exec.CommandContext(limit, "gh", "auth", "token").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

// newScratch makes a throwaway folder set to use the scratch repository.
//
// The test is skipped when the environment does not name a repository or
// there is no login for GitHub; it fails when the repository named has no
// "scratch" in its name.
// Returns the folder, with a clean-up registered that deletes the issues
// made through create.
// Side effects: makes a temporary folder holding `.bend.json`; may run
// `gh auth token`. Nothing is sent to GitHub here.
func newScratch(t *testing.T) *scratch {
	t.Helper()
	name := strings.TrimSpace(os.Getenv(scratchVariable))
	if name == "" {
		t.Skip(scratchVariable + " is not set")
	}
	if !scratchName.MatchString(name) {
		t.Fatalf(
			`%s is %s. This test deletes issues, so it only runs against a repository with "scratch" in its name.`,
			scratchVariable, name)
	}
	token := githubToken()
	if token == "" {
		t.Skip("not signed in to GitHub")
	}
	// The real path, so that it is the same text bend prints for it.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	setting, err := json.Marshal(map[string]string{"tracker": "github", "repository": name})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".bend.json"), setting, 0o644); err != nil {
		t.Fatal(err)
	}
	made := &scratch{repository: &repository{t: t, root: root}, name: name, token: token}
	// Registered after t.TempDir, so it runs before the folder is removed:
	// closing what could not be deleted still needs the folder.
	t.Cleanup(made.cleanUp)
	return made
}

// graphqlAnswer is the part of GitHub's answer the clean-up reads.
type graphqlAnswer struct {
	Data struct {
		Repository struct {
			Issue *struct {
				ID string `json:"id"`
			} `json:"issue"`
		} `json:"repository"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// graphql sends one GraphQL request to GitHub with the test's own login.
//
// Returns GitHub's answer; ok is false when the request could not be sent,
// was turned down (not signed in, not allowed), or was not answered with
// JSON. An answer that lists errors is still ok: the caller reads them.
// Side effects: one request to api.github.com.
func (made *scratch) graphql(query string, variables map[string]any) (answer graphqlAnswer, ok bool) {
	body, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return answer, false
	}
	limit, cancel := context.WithTimeout(context.Background(), githubTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(limit, http.MethodPost, "https://api.github.com/graphql", bytes.NewReader(body))
	if err != nil {
		return answer, false
	}
	request.Header.Set("Authorization", "Bearer "+made.token)
	request.Header.Set("User-Agent", "bend-test")
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return answer, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return answer, false
	}
	if json.NewDecoder(response.Body).Decode(&answer) != nil {
		return answer, false
	}
	return answer, true
}

// cleanUp deletes every issue this test created, by number.
//
// An issue that cannot be deleted (deleting needs the owner's rights) is
// closed with bend instead, and the test's log says which ones are left.
// Side effects: two requests to GitHub for each issue made; for each one
// left, one bend command more.
func (made *scratch) cleanUp() {
	owner, name, _ := strings.Cut(made.name, "/")
	left := []string{}
	for _, number := range made.made {
		asNumber, err := strconv.Atoi(number)
		if err != nil {
			continue
		}
		found, ok := made.graphql(
			"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}",
			map[string]any{"owner": owner, "name": name, "number": asNumber},
		)
		if !ok {
			left = append(left, number)
			continue
		}
		if found.Data.Repository.Issue == nil {
			// Already gone.
			continue
		}
		gone, ok := made.graphql(
			"mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}",
			map[string]any{"id": found.Data.Repository.Issue.ID},
		)
		if !ok || len(gone.Errors) > 0 {
			left = append(left, number)
		}
	}
	if len(left) == 0 {
		return
	}
	stillOpen := []string{}
	for _, number := range left {
		if made.bend("close", number).status != 0 {
			stillOpen = append(stillOpen, number)
		}
	}
	made.t.Logf(
		"bend's GitHub test could not delete its issues %s in %s; they are left closed. Delete them by hand.",
		strings.Join(left, ", "), made.name)
	if len(stillOpen) > 0 {
		made.t.Logf("Of those, %s could not be closed either.", strings.Join(stillOpen, ", "))
	}
}

// create creates an issue and remembers it for the clean-up.
//
// argv is what follows `bend create`.
// Returns the new issue's number. Fails the test when bend fails or prints
// something that is not a number.
func (made *scratch) create(argv ...string) string {
	made.t.Helper()
	id := made.ok(append([]string{"create"}, argv...)...)
	if !issueNumber.MatchString(id) {
		made.t.Fatalf("create printed %q, not an issue number", id)
	}
	made.made = append(made.made, id)
	return id
}

// notes gives the notes of an issue, which the shared issue type leaves out.
func (made *scratch) notes(id string) string {
	made.t.Helper()
	var found struct {
		Notes string `json:"notes"`
	}
	made.parse(made.ok("show", id, "--json"), &found)
	return found.Notes
}

// issues runs a command that prints a list of issues as JSON and gives the
// issues, where list gives only their ids.
func (made *scratch) issues(argv ...string) []issue {
	made.t.Helper()
	var found []issue
	made.parse(made.ok(append(argv, "--json")...), &found)
	return found
}

// withoutLogin runs one bend command in the folder with no way to sign in
// to GitHub: no token in the environment, and a PATH on which there is no
// `gh` (nor anything else). A command that succeeds like this asked GitHub
// nothing.
func (made *scratch) withoutLogin(argv ...string) result {
	made.t.Helper()
	command := exec.Command(program, argv...)
	command.Dir = made.root
	for _, pair := range os.Environ() {
		name, _, _ := strings.Cut(pair, "=")
		if name != "GH_TOKEN" && name != "GITHUB_TOKEN" && name != "PATH" {
			command.Env = append(command.Env, pair)
		}
	}
	// An empty folder of its own, not the scratch folder.
	command.Env = append(command.Env, "PATH="+made.t.TempDir())
	var out, errOut bytes.Buffer
	command.Stdout = &out
	command.Stderr = &errOut
	status := 0
	if err := command.Run(); err != nil {
		exit, isExit := err.(*exec.ExitError)
		if !isExit {
			made.t.Fatalf("bend could not be started: %v", err)
		}
		status = exit.ExitCode()
	}
	return result{
		status: status,
		out:    strings.TrimSuffix(out.String(), "\n"),
		err:    strings.TrimSuffix(errOut.String(), "\n"),
	}
}

// linksOf gives links as "kind direction id", sorted and joined, for
// comparing whatever order they come in.
func linksOf(links []link) string {
	found := []string{}
	for _, one := range links {
		found = append(found, one.Kind+" "+one.Direction+" "+one.ID)
	}
	sort.Strings(found)
	return strings.Join(found, ", ")
}

// priorityOf gives a priority for comparing: -1 when there is none.
func priorityOf(priority *int) int {
	if priority == nil {
		return -1
	}
	return *priority
}

// problem is what bend prints, with --json, when a command fails.
type problem struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status"`
	Kind   string `json:"kind"`
	Error  string `json:"error"`
}

// TestGitHubStatusSaysTheTrackerAndWhatIsKeptAnotherWay checks `bend
// status`: the full one, which asks GitHub who is signed in, and the quick
// one, which asks nothing.
func TestGitHubStatusSaysTheTrackerAndWhatIsKeptAnotherWay(t *testing.T) {
	repo := newScratch(t)
	status := repo.ok("status")
	if !strings.Contains(status, repo.name+" on GitHub, signed in as ") {
		t.Fatalf("the status does not say where and as whom:\n%s", status)
	}
	for _, wanted := range []string{
		`Tracker\s+github`,
		`type, priority, category\s+kept as the labels`,
		`requirements, done, plan, notes\s+kept as marked sections`,
		`links: discovered-from, related\s+kept as a marked Links section`,
	} {
		if !regexp.MustCompile(wanted).MatchString(status) {
			t.Fatalf("the status lacks %q:\n%s", wanted, status)
		}
	}

	// The quick status: what is known without asking the tracker.
	type about struct {
		Tracker    string   `json:"tracker"`
		Repository *string  `json:"repository"`
		LinkKinds  []string `json:"linkKinds"`
		Root       string   `json:"root"`
	}
	var quick about
	repo.parse(repo.ok("status", "--quick", "--json"), &quick)
	same(t, quick.Tracker, "github", "the quick status's tracker")
	same(t, text(quick.Repository), repo.name, "the quick status's repository")
	same(t, strings.Join(quick.LinkKinds, " "), "blocked-by discovered-from related", "the quick status's kinds of link")
	same(t, quick.Root, repo.root, "the quick status's folder")
	// The full status names the same kinds of link.
	var full struct {
		Tracker   string   `json:"tracker"`
		LinkKinds []string `json:"linkKinds"`
	}
	repo.parse(repo.ok("status", "--json"), &full)
	same(t, full.Tracker, "github", "the status's tracker")
	same(t, strings.Join(full.LinkKinds, " "), strings.Join(quick.LinkKinds, " "), "the status's kinds of link")
	// Whether there is a login makes no difference to the quick status: it
	// gives the same answer with none, where the full one cannot answer.
	unsigned := repo.withoutLogin("status", "--quick", "--json")
	same(t, unsigned.status, 0, "the quick status without a login: "+unsigned.err+unsigned.out)
	var again about
	repo.parse(unsigned.out, &again)
	same(t, again.Tracker+" "+text(again.Repository)+" "+strings.Join(again.LinkKinds, " ")+" "+again.Root,
		quick.Tracker+" "+text(quick.Repository)+" "+strings.Join(quick.LinkKinds, " ")+" "+quick.Root,
		"the quick status without a login")
	printed := repo.ok("status", "--quick")
	for _, wanted := range []string{`Tracker\s+github`, `Repository\s+` + regexp.QuoteMeta(repo.name), `Link kinds\s+blocked-by, discovered-from, related`} {
		if !regexp.MustCompile(wanted).MatchString(printed) {
			t.Fatalf("the quick status lacks %q:\n%s", wanted, printed)
		}
	}
	var refused problem
	repo.parse(repo.withoutLogin("status", "--json").out, &refused)
	if refused.OK || refused.Status != 1 || refused.Kind != "not-signed-in" {
		t.Fatalf("the full status without a login gave %+v", refused)
	}
}

// TestGitHubCreateWriteEditAndShow checks that what is written to an issue
// is what is shown: its fields, each of its written parts, and its labels.
func TestGitHubCreateWriteEditAndShow(t *testing.T) {
	repo := newScratch(t)
	id := repo.create(
		"Checkout flow", "--type", "epic", "--priority", "p1",
		"--description", "-starts with a dash", "--done", "Orders go through",
		"--category", "  UX  Polish ",
	)
	repo.ok("write", id, "requirements", "1. Guest checkout")
	repo.ok("write", id, "description", "Rewritten.")
	repo.ok("write", id, "plan", "--text-file", "-")
	repo.ok("write", id, "notes", "A note")
	repo.ok("edit", id, "--title", "Checkout", "--priority", "0")
	found := repo.show(id)
	same(t, found.Title, "Checkout", "title")
	same(t, found.Status, "open", "status")
	same(t, text(found.Type), "epic", "type")
	same(t, priorityOf(found.Priority), 0, "priority")
	same(t, text(found.Category), "ux polish", "category")
	same(t, found.Description, "Rewritten.", "description")
	same(t, found.Requirements, "1. Guest checkout", "requirements")
	same(t, found.Done, "Orders go through", "done")
	same(t, found.Plan, "text from standard input", "plan")
	same(t, repo.notes(id), "A note", "notes")
	// The labels that hold the type, priority and category are not shown as
	// labels.
	same(t, strings.Join(found.Labels, " "), "", "labels")
	repo.ok("write", id, "notes", "")
	same(t, repo.notes(id), "", "cleared notes")

	// A plain label, added and removed.
	const label = "bend-e2e-label"
	repo.ok("edit", id, "--add-label", label)
	same(t, strings.Join(repo.show(id).Labels, " "), label, "labels after adding one")
	repo.ok("edit", id, "--remove-label", label)
	found = repo.show(id)
	same(t, strings.Join(found.Labels, " "), "", "labels after removing it")
	// Changing the plain labels leaves the fields kept as labels alone.
	same(t, text(found.Type)+" "+strconv.Itoa(priorityOf(found.Priority))+" "+text(found.Category),
		"epic 0 ux polish", "type, priority and category after changing labels")
	// Both in one command: the label is taken off, then put on.
	repo.ok("edit", id, "--add-label", label, "--remove-label", label)
	same(t, strings.Join(repo.show(id).Labels, " "), label, "labels after removing and adding in one command")

	// GitHub has no place for free-form data kept with an issue.
	unsupported := repo.bend("edit", id, "--set-data", "branch=x")
	same(t, unsupported.status, 3, "keeping free-form data on GitHub")
	var refused problem
	repo.parse(repo.bend("edit", id, "--set-data", "branch=x", "--json").out, &refused)
	if refused.OK || refused.Status != 3 || refused.Kind != "unsupported" {
		t.Fatalf("keeping free-form data gave %+v", refused)
	}
	same(t, repo.show(id).Title, "Checkout", "the title after a refused change")
}

// TestGitHubSubIssuesLinksMovingAndBlocking checks sub-issues, links of
// every kind, moving, and what blocks what.
func TestGitHubSubIssuesLinksMovingAndBlocking(t *testing.T) {
	repo := newScratch(t)
	epic := repo.create("Epic", "--category", "api")
	child := repo.create("Child", "--parent", epic, "--from", epic)
	blocker := repo.create("Blocker")
	shown := repo.show(child)
	same(t, text(shown.ParentID), epic, "parent")
	same(t, text(shown.Category), "api", "a sub-issue takes its parent's category")
	same(t, linksOf(shown.Links), "discovered-from out "+epic, "the child's links")
	parent := repo.show(epic)
	same(t, ids(parent.SubIssues), child, "sub-issues")
	same(t, linksOf(parent.Links), "discovered-from in "+child, "the epic's links")

	repo.ok("link", epic, blocker, "--kind", "blocked-by")
	repo.ok("link", child, blocker, "--kind", "related")
	// What the epic waits for, its sub-issue waits for too.
	same(t, ids(repo.show(child).BlockedBy), blocker, "what blocks the child")
	same(t, linksOf(repo.show(blocker).Links), "blocked-by in "+epic+", related out "+child, "the blocker's links")
	ready := repo.list("ready")
	if !slices.Contains(ready, blocker) {
		t.Fatal("an issue nothing blocks is not listed as ready")
	}
	if slices.Contains(ready, epic) || slices.Contains(ready, child) {
		t.Fatal("a blocked issue is listed as ready")
	}
	same(t, repo.status("link", epic, blocker, "--kind", "blocked-by"), 1, "the same link a second time")
	same(t, repo.status("link", child, child, "--kind", "related"), 1, "a link to itself")

	repo.ok("unlink", child, blocker)
	repo.ok("unlink", epic, blocker)
	same(t, linksOf(repo.show(blocker).Links), "", "the blocker's links after unlinking")
	same(t, ids(repo.show(child).BlockedBy), "", "what blocks the child after unlinking")
	same(t, repo.status("unlink", epic, blocker), 1, "unlinking what is not linked")

	same(t, repo.status("move", epic, "--under", child), 1, "moving an issue inside its own sub-issue")
	repo.ok("move", child, "--top")
	same(t, text(repo.show(child).ParentID), "<none>", "parent after moving to the top")
	repo.ok("move", child, "--under", blocker)
	same(t, text(repo.show(child).ParentID), blocker, "parent after moving under another issue")
	same(t, strings.Join(repo.list("list", "--parent", blocker), " "), child, "list --parent")
}

// TestGitHubUnlinkOneKindLeavesTheOther checks that of two links of
// different kinds between the same two issues, `unlink --kind` removes the
// one named and leaves the other.
func TestGitHubUnlinkOneKindLeavesTheOther(t *testing.T) {
	repo := newScratch(t)
	waiting := repo.create("Waits and relates")
	other := repo.create("The other one")
	repo.ok("link", waiting, other, "--kind", "related")
	repo.ok("link", waiting, other, "--kind", "blocked-by")
	same(t, linksOf(repo.show(waiting).Links), "blocked-by out "+other+", related out "+other, "both links")
	// A related link reads the same from both ends and is always "out".
	same(t, linksOf(repo.show(other).Links), "blocked-by in "+waiting+", related out "+waiting, "both links, from the other side")

	repo.ok("unlink", waiting, other, "--kind", "related")
	shown := repo.show(waiting)
	same(t, linksOf(shown.Links), "blocked-by out "+other, "links after removing the related one")
	same(t, ids(shown.BlockedBy), other, "what blocks it after removing the related link")
	same(t, linksOf(repo.show(other).Links), "blocked-by in "+waiting, "the other side after removing the related link")

	// And the other way round: put the related link back, take the
	// blocked-by one away.
	repo.ok("link", waiting, other, "--kind", "related")
	repo.ok("unlink", waiting, other, "--kind", "blocked-by")
	shown = repo.show(waiting)
	same(t, linksOf(shown.Links), "related out "+other, "links after removing the blocked-by one")
	same(t, ids(shown.BlockedBy), "", "what blocks it after removing the blocked-by link")

	// Without a kind, whatever links the two is removed.
	repo.ok("unlink", waiting, other)
	same(t, linksOf(repo.show(waiting).Links), "", "links after unlinking")
	same(t, linksOf(repo.show(other).Links), "", "the other side after unlinking")
}

// TestGitHubCommentsDecisionsStartingHandingOverClosingAndReopening checks
// the comments an issue collects on its way, who they are from, and its
// status at each step.
func TestGitHubCommentsDecisionsStartingHandingOverClosingAndReopening(t *testing.T) {
	repo := newScratch(t)
	id := repo.create("To hand over")
	// Text that starts with a dash goes after "--", as bend asks.
	repo.ok("comment", id, "--", "-a comment that starts with a dash")
	repo.ok("decide", id, "Use the queue", "--as", "agent-7")
	repo.ok("start", id)
	found := repo.show(id)
	same(t, found.Status, "in_progress", "status after starting")
	if found.Assignee == nil {
		t.Fatal("a started issue has no assignee")
	}
	repo.ok(
		"handover", id, "--done", "Built it", "--checked", "Ran the tests",
		"--not-checked", "Nothing", "--as", "agent-7",
	)
	var comments []struct {
		Author string `json:"author"`
		Text   string `json:"text"`
	}
	repo.parse(repo.ok("comments", id, "--json"), &comments)
	same(t, len(comments), 3, "the number of comments")
	same(t, comments[0].Text, "-a comment that starts with a dash", "the first comment")
	same(t, comments[1].Author, "agent-7", "who decided")
	same(t, comments[1].Text, "Decision: Use the queue", "the decision")
	same(t, comments[2].Author, "agent-7", "who handed over")
	if !strings.HasPrefix(comments[2].Text, "Hand-over") {
		t.Fatalf("the hand-over reads %q", comments[2].Text)
	}

	repo.ok("close", id, "--reason", "Shipped")
	found = repo.show(id)
	same(t, found.Status, "closed", "status after closing")
	same(t, found.CloseReason, "completed", "close reason")
	// The reason is a comment too.
	same(t, found.CommentCount, 4, "comment count")
	status := "<not listed>"
	for _, one := range repo.issues("list", "--status", "all") {
		if one.ID == id {
			status = one.Status
		}
	}
	same(t, status, "closed", "the issue in the list of all")
	if slices.Contains(repo.list("list"), id) {
		t.Fatal("a closed issue is listed by default")
	}
	repo.ok("reopen", id)
	same(t, repo.show(id).Status, "open", "status after reopening")
}

// TestGitHubSearchFindsAnIssueByItsWords checks `bend search`, with a word
// that no other issue has.
func TestGitHubSearchFindsAnIssueByItsWords(t *testing.T) {
	repo := newScratch(t)
	word := fmt.Sprintf("zebra%d", time.Now().UnixMilli())
	id := repo.create("Searchable " + word)
	// GitHub's search runs behind; give it up to half a minute.
	for attempt := 0; attempt < 10; attempt++ {
		if slices.Contains(repo.list("search", word), id) {
			return
		}
		time.Sleep(3 * time.Second)
	}
	t.Fatalf("search did not find issue %s within 30 seconds", id)
}

// TestGitHubProblemsHaveTheRightExitStatusAndAPlainReason checks what bend
// says and how it exits when it cannot do what was asked, and that standing
// facts work in a folder whose tracker is GitHub.
func TestGitHubProblemsHaveTheRightExitStatusAndAPlainReason(t *testing.T) {
	repo := newScratch(t)
	missing := repo.bend("show", "999999")
	same(t, missing.status, 1, "showing an issue that is not there")
	same(t, missing.err, "bend: There is no issue with id 999999.", "the reason")
	// With --json the reason is on standard output, with its kind.
	asJSON := repo.bend("show", "999999", "--json")
	same(t, asJSON.status, 1, "showing an issue that is not there, with --json")
	var refused problem
	repo.parse(asJSON.out, &refused)
	if refused.OK || refused.Status != 1 || refused.Kind != "refused" ||
		refused.Error != "There is no issue with id 999999." {
		t.Fatalf("got %+v", refused)
	}
	notANumber := repo.bend("show", "abc")
	same(t, notANumber.status, 1, "showing an id that is not a number")
	if !strings.Contains(notANumber.err, "not a GitHub issue number") {
		t.Fatalf("got %q", notANumber.err)
	}
	orphan := repo.bend("create", "x", "--parent", "999999")
	if orphan.status == 0 && issueNumber.MatchString(orphan.out) {
		// Not expected; but an issue was made, so it is cleaned up.
		repo.made = append(repo.made, orphan.out)
	}
	same(t, orphan.status, 1, "creating under a parent that is not there")
	same(t, repo.status("list", "--nope"), 2, "an unknown option")
	// Standing facts live in the folder's FACTS.md, whatever the tracker.
	repo.ok("remember", "Deploys go out on Mondays", "--key", "deploys")
	same(t, repo.ok("recall", "monday"), "deploys: Deploys go out on Mondays", "recall")
}
