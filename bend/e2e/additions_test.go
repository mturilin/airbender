// additions_test.go — what bend offers a program that the first, TypeScript
// bend did not.
//
// What: labels and kept data through `edit`, the `body` part, links of
// beads' own kinds, removing one link of two, `status --quick`, the `facts`
// command, and the kind of a failure in JSON.
//
// Why: the Airbender tab reaches issues by running bend (bead-bb-c9l.4), and
// these are the things it does that an agent at a terminal had no need of.
// They are checked here against the real bd, like the rest.

package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failure is what bend prints with --json when a command fails.
type failure struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status"`
	Kind   string `json:"kind"`
	Error  string `json:"error"`
}

// fails runs a command with --json that must fail, and gives what it
// reported.
func (repo *repository) fails(argv ...string) failure {
	repo.t.Helper()
	got := repo.bend(append(argv, "--json")...)
	var reported failure
	repo.parse(got.out, &reported)
	if got.status == 0 || reported.OK || reported.Status != got.status {
		repo.t.Fatalf("bend %s: exit %d, printed %s", strings.Join(argv, " "), got.status, got.out)
	}
	return reported
}

func TestLabelsAndKeptData(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	id := repo.ok("create", "Labelled", "--category", "api")
	repo.ok("edit", id, "--add-label", "step:plan", "--add-label", "size:m")
	same(t, strings.Join(repo.show(id).Labels, " "), "size:m step:plan", "labels after adding")
	// One already there, or already gone, is left alone.
	repo.ok("edit", id, "--add-label", "step:plan", "--remove-label", "size:m", "--remove-label", "never-there")
	same(t, strings.Join(repo.show(id).Labels, " "), "step:plan", "labels after removing")
	same(t, text(repo.show(id).Category), "api", "the category is not among the labels, and stays")
	same(t, repo.fails("edit", id, "--add-label", "a,b").Kind, "refused", "a label with a comma")

	repo.ok("edit", id, "--set-data", "branch=feature/x=1", "--set-data", "other=kept")
	same(t, repo.show(id).Metadata["branch"], any("feature/x=1"), "kept data")
	repo.ok("edit", id, "--unset-data", "branch")
	if _, kept := repo.show(id).Metadata["branch"]; kept {
		t.Fatal("the kept data was not removed")
	}
	same(t, repo.show(id).Metadata["other"], any("kept"), "the other piece of kept data")
	same(t, repo.status("edit", id, "--set-data", "no-sign"), 2, "kept data without a value")
	same(t, repo.fails("edit", id, "--set-data", "bad name=1").Kind, "refused", "a name with a space")
}

func TestBodyIsDescriptionAndRequirementsTogether(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	id := repo.ok("create", "With a body", "--description", "Old.")
	body := "What is wanted.\n\n<!-- bend:requirements -->\n## Requirements\n\n1. First\n<!-- /bend:requirements -->"
	file := filepath.Join(t.TempDir(), "body.md")
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	repo.ok("write", id, "body", "--text-file", file)
	found := repo.show(id)
	same(t, found.Description, "What is wanted.", "description")
	same(t, found.Requirements, "1. First", "requirements")
	// A body without the section clears the requirements.
	repo.ok("write", id, "body", "Only a description now.")
	found = repo.show(id)
	same(t, found.Description, "Only a description now.", "description")
	same(t, found.Requirements, "", "requirements")
	// Saved unchanged, nothing is written: the issue's time does not move.
	before := text(repo.show(id).UpdatedAt)
	repo.ok("write", id, "body", "Only a description now.")
	same(t, text(repo.show(id).UpdatedAt), before, "the time of the last change")
}

func TestLinksOfTheTrackersOwnKindsAndRemovingOne(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	first := repo.ok("create", "First")
	second := repo.ok("create", "Second")
	kinds := []string{"tracks", "until", "caused-by", "validates", "supersedes", "discovered-from", "blocked-by"}
	for _, kind := range kinds {
		repo.ok("link", first, second, "--kind", kind)
		links := repo.show(first).Links
		if len(links) != 1 || links[0] != (link{ID: second, Kind: kind, Direction: "out"}) {
			t.Fatalf("%s: got the links %v", kind, links)
		}
		// Asking for another kind finds nothing to remove.
		same(t, repo.fails("unlink", first, second, "--kind", "related").Kind, "refused", "unlink of another kind")
		// The link is recorded on the first issue, not on the second.
		same(t, repo.status("unlink", second, first, "--from-first"), 1, "unlink from the wrong end")
		repo.ok("unlink", first, second, "--kind", kind, "--from-first")
		same(t, len(repo.show(first).Links), 0, "links after removing")
	}
	repo.ok("link", first, second, "--kind", "related")
	repo.ok("unlink", second, first, "--from-first")
	same(t, len(repo.show(first).Links), 0, "a related link goes from both ends")
}

func TestStatusQuickAsksNothing(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	// A bd that is not there: the quick form must not need it.
	repo.env = []string{"BEND_BD=" + filepath.Join(repo.root, "no-such-bd")}
	var about struct {
		Tracker    string   `json:"tracker"`
		Repository *string  `json:"repository"`
		LinkKinds  []string `json:"linkKinds"`
		Root       string   `json:"root"`
	}
	repo.parse(repo.ok("status", "--quick", "--json"), &about)
	same(t, about.Tracker, "beads", "tracker")
	same(t, about.Root, repo.root, "root")
	same(t, strings.Join(about.LinkKinds, " "),
		"blocked-by discovered-from related tracks until caused-by validates supersedes", "kinds of link")
	if about.Repository != nil {
		t.Fatalf("a beads folder has no repository, got %q", *about.Repository)
	}
	if !strings.Contains(repo.ok("status", "--quick"), "Tracker     beads") {
		t.Fatal("the text form does not name the tracker")
	}
}

func TestFailuresSayWhichKindTheyAre(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	same(t, repo.fails("show", "t-nope").Kind, "refused", "an issue that is not there")
	same(t, repo.fails("list", "--wat").Kind, "usage", "an unknown option")
	same(t, repo.fails("-C", t.TempDir(), "list").Kind, "not-set-up", "a folder without a tracker")
	// In a repository bend has not read yet: with a fresh copy a read needs
	// no beads program at all, and would succeed.
	unread := newRepository(t)
	unread.env = []string{"BEND_BD=" + filepath.Join(repo.root, "no-such-bd")}
	missing := unread.fails("list")
	same(t, missing.Kind, "no-program", "beads not installed")
	same(t, missing.Status, 1, "its exit status")
	// A change always needs it.
	repo.env = unread.env
	same(t, repo.fails("create", "No program").Kind, "no-program", "a change with beads not installed")
	// A .beads folder that holds no database.
	empty := t.TempDir()
	if err := os.Mkdir(filepath.Join(empty, ".beads"), 0o755); err != nil {
		t.Fatal(err)
	}
	repo.env = nil
	same(t, repo.fails("-C", empty, "list").Kind, "not-set-up", "a .beads folder without a database")
}

func TestFactsCommandNeedsNoTracker(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	dir := t.TempDir()
	agents := "# Rules\n\n<!-- bend:facts:start -->\n- **build** — Run make\n<!-- bend:facts:end -->\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(agents), 0o644); err != nil {
		t.Fatal(err)
	}
	adding := filepath.Join(t.TempDir(), "facts.json")
	os.WriteFile(adding, []byte(`[{"key": "deploys", "text": "On  Tuesdays"}, {"key": "build", "text": "Run make all"}]`), 0o644)
	var done struct {
		Moved, Added, Replaced int
		Created                bool
	}
	repo.parse(repo.ok("-C", dir, "facts", "--move-old", "--add-file", adding, "--ensure", "--json"), &done)
	if done.Moved != 1 || done.Added != 1 || done.Replaced != 1 || done.Created {
		t.Fatalf("got %+v", done)
	}
	file, _ := os.ReadFile(filepath.Join(dir, "FACTS.md"))
	if !strings.HasSuffix(string(file), "\n- **build** — Run make all\n- **deploys** — On Tuesdays\n") {
		t.Fatalf("got the facts file %q", file)
	}
	rules, _ := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	same(t, string(rules), "# Rules\n", "AGENTS.md without the old section")

	// --list reads the folder's own file, tracker or not.
	var listed []struct{ Key, Text string }
	repo.parse(repo.ok("-C", dir, "facts", "--list", "--json"), &listed)
	if len(listed) != 2 || listed[0].Key != "build" || listed[1].Text != "On Tuesdays" {
		t.Fatalf("got %+v", listed)
	}
	same(t, repo.status("-C", dir, "facts", "--list", "--ensure"), 2, "--list with something that writes")

	bare := t.TempDir()
	repo.parse(repo.ok("-C", bare, "facts", "--ensure", "--json"), &done)
	if !done.Created {
		t.Fatal("the facts file was not created")
	}
	same(t, repo.status("-C", bare, "facts"), 2, "facts without saying what to do")
	same(t, repo.status("-C", bare, "facts", "--add-file", filepath.Join(bare, "FACTS.md")), 2, "a file that is not a list of facts")
}

func TestWithBodyAndAcceptedTrackers(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	id := repo.ok("create", "Has both", "--description", "Wanted.")
	repo.ok("write", id, "requirements", "1. First")
	var listed []struct {
		ID          string `json:"id"`
		Description string `json:"description"`
		Body        string `json:"body"`
	}
	repo.parse(repo.ok("list", "--json", "--with-body"), &listed)
	want := "Wanted.\n\n<!-- bend:requirements -->\n## Requirements\n\n1. First\n<!-- /bend:requirements -->"
	if len(listed) != 1 || listed[0].Body != want || listed[0].Description != "Wanted." {
		t.Fatalf("got %+v", listed)
	}
	// What comes out goes back in unchanged.
	before := text(repo.show(id).UpdatedAt)
	repo.ok("write", id, "body", listed[0].Body)
	same(t, text(repo.show(id).UpdatedAt), before, "the time of the last change")
	if strings.Contains(repo.ok("show", id, "--json"), `"body"`) {
		t.Fatal("the body is printed without being asked for")
	}

	// A caller that accepts only GitHub finds no tracker in a beads folder.
	repo.env = []string{"BEND_ACCEPT=github"}
	same(t, repo.fails("list").Kind, "not-set-up", "beads not accepted")
	repo.env = []string{"BEND_ACCEPT=beads"}
	repo.ok("list")
	repo.env = []string{"BEND_ACCEPT=linear"}
	same(t, repo.status("list"), 2, "an unknown tracker accepted")
}
