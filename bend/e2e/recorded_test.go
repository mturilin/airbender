// recorded_test.go — everything bend prints for a fixed series of commands,
// compared with a recording.
//
// What: runs the series below in a throwaway beads repository, writes down
// each command with its exit status and what it printed on standard output
// and on standard error, and compares the whole with testdata/recorded.txt.
//
// Why: the other tests check what matters in each answer; this one catches
// a change nobody thought to check: a word in a message, a key in the JSON,
// the order of the keys, a column's width, a line of help. When bend moved
// from TypeScript to Go, the recording made with the old program was the
// measure of the new one.
//
// Design notes:
//   - What differs from run to run is replaced before comparing: issue ids
//     by the name the series gives them (<epic>, <child>, ...), times by
//     <time>, the folders by <root> and <empty>.
//   - To record again after a change that is meant: BEND_RECORD=1 go test
//     ./e2e -run TestRecorded, then read the diff of the recording like any
//     other change.
//
// Gotchas:
//   - Every issue of the series has a priority of its own, because beads
//     lists issues of the same priority made in the same second in an order
//     that is not fixed. For the same reason no issue of the series has two
//     links recorded on it: beads gives them in either order.
package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// step is one command of the series. Names in braces in its words are
// replaced by the ids of the issues made earlier.
type step struct {
	// saveAs, when not "", keeps what the command printed (a new issue's id)
	// under this name.
	saveAs string
	argv   []string
}

// do is a step that keeps nothing.
func do(argv ...string) step { return step{argv: argv} }

// makeIssue is a step that creates an issue and keeps its id under name.
func makeIssue(name string, argv ...string) step {
	return step{saveAs: name, argv: append([]string{"create"}, argv...)}
}

// helpOf is every command whose help is recorded.
var helpOf = []string{
	"list", "ready", "show", "comments", "search", "create", "edit", "write", "comment", "decide", "start",
	"close", "reopen", "move", "link", "unlink", "handover", "status", "remember", "recall", "facts", "version",
}

// series is the commands recorded, in order.
var series = []step{
	do("version"),
	do("version", "--json"),
	do("status"),
	do("status", "--json"),
	do("status", "--quick"),
	do("status", "--quick", "--json"),
	do("list"),
	makeIssue("epic", "Checkout flow", "--type", "epic", "--priority", "p0",
		"--description", "-starts with a dash, and has <angle> & ampersand", "--done", "Orders go through",
		"--category", "  UX  Polish "),
	makeIssue("child", "Guest checkout", "--parent", "{epic}", "--priority", "1", "--type", "task"),
	makeIssue("other", "Tidy the cart", "--from", "{epic}", "--priority", "2", "--category", "api"),
	makeIssue("blocker", "Payment provider contract", "--priority", "3", "--type", "decision",
		"--blocked-by", "{other}"),
	makeIssue("extra", "See also", "--priority", "4"),
	do("create", "Too urgent", "--priority", "9"),
	do("create"),
	do("write", "{epic}", "requirements", "1. Guest checkout\n2. Saved cards"),
	do("write", "{epic}", "plan", "--text-file", "-"),
	do("write", "{epic}", "notes", "A note.\n\nWith two paragraphs."),
	do("write", "{epic}", "description", "Rewritten."),
	do("write", "{epic}", "summary", "No such part"),
	do("edit", "{epic}", "--title", "Checkout", "--type", "feature"),
	do("edit", "{epic}"),
	do("edit", "{other}", "--no-category"),
	do("edit", "{other}", "--category", "x", "--no-category"),
	do("link", "{child}", "{blocker}", "--kind", "blocked-by"),
	do("link", "{extra}", "{epic}", "--kind", "related"),
	do("link", "{child}", "{blocker}", "--kind", "related"),
	do("link", "{child}", "{child}", "--kind", "related"),
	do("link", "{child}", "{other}", "--kind", "nonsense"),
	do("link", "{child}", "{other}"),
	do("show", "{epic}"),
	do("show", "{epic}", "--json"),
	do("show", "{child}"),
	do("show", "{child}", "--json"),
	do("show", "{blocker}"),
	do("list"),
	do("list", "--json"),
	do("list", "--type", "task"),
	do("list", "--priority", "p2"),
	do("list", "--category", "UX polish"),
	do("list", "--parent", "{epic}"),
	do("list", "--parent", "{epic}", "--json", "--with-body"),
	do("edit", "{child}", "--add-label", "step:plan", "--set-data", "branch=feature/x"),
	do("edit", "{child}", "--remove-label", "step:plan", "--unset-data", "branch", "--json"),
	do("ready"),
	do("search", "cart"),
	do("search", "nothing like this"),
	do("comment", "{child}", "--", "-a comment that starts with a dash"),
	do("comment", "{child}", "--text-file", "-"),
	do("comment", "{child}"),
	do("comment", "{child}", "--", "--help"),
	do("edit", "{extra}", "--title", "-h"),
	do("edit", "{extra}", "--title=--help", "--add-label", "-h"),
	do("show", "{extra}"),
	do("list", "--changed-since", "yesterday"),
	do("decide", "{child}", "Keep it simple, because it is enough (the owner's decision)"),
	do("handover", "{child}", "--done", "x", "--checked", "y"),
	do("handover", "{child}", "--done", "Built it", "--checked", "Tests", "--not-checked", "nothing"),
	do("comments", "{child}"),
	do("comments", "{child}", "--json"),
	do("comments", "{epic}"),
	do("show", "{child}"),
	do("start", "{other}", "--as", "agent-7"),
	do("start", "{other}", "--as", "agent-7", "--json"),
	do("close", "{other}", "--reason", "validated", "--as", "agent-7"),
	do("start", "{other}"),
	do("list", "--status", "closed"),
	do("list", "--status", "all"),
	do("list", "--assignee", "agent-7", "--status", "all"),
	do("show", "{blocker}"),
	do("reopen", "{other}"),
	do("close", "{epic}"),
	do("move", "{child}", "--top"),
	do("move", "{child}", "--top", "--json"),
	do("move", "{child}", "--under", "{epic}", "--json"),
	do("move", "{epic}", "--under", "{child}"),
	do("move", "{child}"),
	do("unlink", "{blocker}", "{child}"),
	do("unlink", "{blocker}", "{child}"),
	do("unlink", "{epic}", "{extra}", "--json"),
	do("show", "t-nope"),
	do("show", "t-nope", "--json"),
	do("show"),
	do("bogus"),
	do("bogus", "--json"),
	do("list", "--wat"),
	do("list", "--status"),
	do("help", "nonsense"),
	do("remember", "Deploys go out on Mondays", "--key", "deploys"),
	do("remember", "Deploys go out on Tuesdays", "--key", "deploys", "--json"),
	do("remember", "Run the tests before handing over"),
	do("remember", "   "),
	do("recall"),
	do("recall", "tuesday"),
	do("recall", "--json"),
	do("recall", "nothing like this"),
	do("-C", "{empty}", "list"),
	do("-C", "{empty}", "list", "--json"),
	do("-C", "{empty}/missing", "list"),
}

var (
	// isoTime is a moment as the tracker writes it.
	isoTime = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)`)
	// shownTime is a moment as the comments are shown with.
	shownTime = regexp.MustCompile(`\d{4}-\d\d-\d\d \d\d:\d\d`)
	// commentID is the id beads gives a comment.
	commentID = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
)

func TestRecorded(t *testing.T) {
	repo := newRepository(t)
	empty, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]string{"empty": empty}
	// The order ids are replaced in: a sub-issue's id begins with its
	// parent's, so the later-made, longer ones go first.
	made := []string{}
	fill := func(word string) string {
		for name, value := range names {
			word = strings.ReplaceAll(word, "{"+name+"}", value)
		}
		return word
	}
	tidy := func(text string) string {
		for at := len(made) - 1; at >= 0; at-- {
			text = strings.ReplaceAll(text, names[made[at]], "<"+made[at]+">")
		}
		text = strings.ReplaceAll(text, repo.root, "<root>")
		text = strings.ReplaceAll(text, empty, "<empty>")
		text = commentID.ReplaceAllString(text, "<comment id>")
		return shownTime.ReplaceAllString(isoTime.ReplaceAllString(text, "<time>"), "<time>")
	}

	var recording strings.Builder
	record := func(argv []string, got result) {
		shown := []string{}
		for _, word := range argv {
			if word == "" || strings.ContainsAny(word, " \n<>&'\"") {
				word = fmt.Sprintf("%q", word)
			}
			shown = append(shown, word)
		}
		fmt.Fprintf(&recording, "$ bend %s\n[exit %d]\n", tidy(strings.Join(shown, " ")), got.status)
		if got.out != "" {
			fmt.Fprintf(&recording, "%s\n", tidy(got.out))
		}
		if got.err != "" {
			fmt.Fprintf(&recording, "[standard error]\n%s\n", tidy(got.err))
		}
		recording.WriteString("\n")
	}

	record([]string{}, repo.bend())
	record([]string{"--help"}, repo.bend("--help"))
	for _, name := range helpOf {
		record([]string{name, "--help"}, repo.bend(name, "--help"))
	}
	for _, one := range series {
		argv := []string{}
		for _, word := range one.argv {
			argv = append(argv, fill(word))
		}
		got := repo.bend(argv...)
		if one.saveAs != "" {
			if got.status != 0 {
				t.Fatalf("bend %s: exit %d: %s", strings.Join(argv, " "), got.status, got.err)
			}
			names[one.saveAs] = got.out
			made = append(made, one.saveAs)
		}
		record(argv, got)
	}

	file := filepath.Join("testdata", "recorded.txt")
	if target := os.Getenv("BEND_RECORD"); target != "" {
		if target != "1" {
			file = target
		}
		if err := os.WriteFile(file, []byte(recording.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("recorded %s", file)
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("there is no recording; make one with BEND_RECORD=1: %v", err)
	}
	if recording.String() == string(want) {
		return
	}
	// Say where the two part, which is easier to read than both in full.
	gotLines := strings.Split(recording.String(), "\n")
	wantLines := strings.Split(string(want), "\n")
	for at := 0; at < len(gotLines) || at < len(wantLines); at++ {
		var got, wanted string
		if at < len(gotLines) {
			got = gotLines[at]
		}
		if at < len(wantLines) {
			wanted = wantLines[at]
		}
		if got != wanted {
			actual := filepath.Join(t.TempDir(), "recorded.actual.txt")
			if dir := os.Getenv("BEND_KEEP"); dir != "" {
				actual = filepath.Join(dir, "recorded.actual.txt")
			}
			os.WriteFile(actual, []byte(recording.String()), 0o644)
			t.Fatalf("what bend prints differs from the recording at line %d:\n  recorded: %s\n  now:      %s\n(set BEND_KEEP to a folder to keep all of what it prints now)",
				at+1, wanted, got)
		}
	}
}
