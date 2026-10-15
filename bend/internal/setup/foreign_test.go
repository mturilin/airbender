// foreign_test.go — setup in a clone of someone else's project.
//
// What: with origin on GitHub and a stand-in for GitHub saying it is a fork
// (or not), checks the warning, the refusal without --anyway, keeping the
// issues in another repository with nothing of Airbender's left for git,
// and that a repository already set up never asks GitHub (bead-bb-dof).

package setup

import (
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// cloneOf makes a git repository whose origin is github.com/them/project.
func cloneOf(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"remote", "add", "origin", "https://github.com/them/project.git"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

// gitSays runs git in dir and gives what it printed.
func gitSays(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, _ := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	return strings.TrimSpace(string(out))
}

// standing is Options whose GitHub says this of every repository; asked
// counts the clients made.
func standing(said github.Standing, asked *int) Options {
	return Options{GitHubClient: func(name string) github.Client {
		*asked++
		return github.NewFake(github.FakeOptions{Repository: name, Standing: &said})
	}}
}

func TestAForkIsWarnedAboutOnlyUntilTheTrackerIsChosen(t *testing.T) {
	dir := cloneOf(t)
	asked := 0
	options := standing(github.Standing{Fork: true}, &asked)
	state, err := Read(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if state.Foreign == nil || state.Foreign.Repository != "them/project" || !state.Foreign.Fork {
		t.Fatalf("got %+v", state.Foreign)
	}
	if why := state.Step(StepTracker).Why; !strings.Contains(why, "is a fork") || !strings.Contains(why, Warning) {
		t.Fatalf("the tracker step says %q", why)
	}
	if _, err := Tracker(dir, nobody(t), Answers{Use: "beads", Anyway: true}, options); err != nil {
		t.Fatal(err)
	}
	asked = 0
	state, _ = Read(dir, options)
	if state.Foreign != nil || asked != 0 {
		t.Fatalf("asked GitHub %d times once set up; foreign %+v", asked, state.Foreign)
	}
	// Set up anyway: the clone is the owner's own; nothing is kept out.
	if state.Elsewhere || gitSays(t, dir, "config", "--get", foreignKey) != "" {
		t.Fatal("set up anyway, yet marked as kept elsewhere")
	}
}

func TestTheOwnersOwnRepositoryIsNotWarnedAbout(t *testing.T) {
	asked := 0
	push := true
	state, err := Read(cloneOf(t), standing(github.Standing{CanPush: &push}, &asked))
	if err != nil || state.Foreign != nil || asked != 1 {
		t.Fatalf("got %+v, %v, asked %d", state.Foreign, err, asked)
	}
	// Not pushable is someone else's too.
	push = false
	state, _ = Read(cloneOf(t), standing(github.Standing{CanPush: &push}, &asked))
	if state.Foreign == nil || state.Foreign.Words() != "Your GitHub account cannot push to them/project." {
		t.Fatalf("got %+v", state.Foreign)
	}
}

func TestSomeoneElsesProjectNeedsAYesOrAnyway(t *testing.T) {
	dir := cloneOf(t)
	asked := 0
	options := standing(github.Standing{Fork: true}, &asked)
	// Nobody to ask: it stops, names both ways on, writes nothing.
	_, err := Tracker(dir, nobody(t), Answers{Use: "beads"}, options)
	if tracker.KindOf(err) != tracker.KindUsage || !strings.Contains(err.Error(), "--anyway") || !strings.Contains(err.Error(), "--repository owner/name") {
		t.Fatalf("got %v", err)
	}
	// GitHub issues on origin itself is no way out.
	if _, err := Tracker(dir, nobody(t), Answers{Use: "github"}, options); tracker.KindOf(err) != tracker.KindUsage {
		t.Fatalf("got %v", err)
	}
	if gitSays(t, dir, "status", "--porcelain") != "" {
		t.Fatal("something was written")
	}
	// At a keyboard the warning is shown and a no changes nothing.
	said := []string{}
	if _, err := Tracker(dir, keyboard(&said, "1", "n"), Answers{}, options); tracker.KindOf(err) != tracker.KindRefused {
		t.Fatalf("got %v", err)
	}
	shown := strings.Join(said, "\n")
	if strings.Count(shown, Warning) != 1 || !strings.Contains(shown, "Set up here anyway?") {
		t.Fatalf("shown:\n%s", shown)
	}
	// A yes sets it up as the owner's own.
	if outcome, err := Tracker(dir, keyboard(&said, "1", "y"), Answers{}, options); err != nil || !outcome.Changed {
		t.Fatalf("got %+v, %v", outcome, err)
	}
}

func TestIssuesKeptInARepositoryOfTheOwnersLeaveNothingForGit(t *testing.T) {
	dir := cloneOf(t)
	asked := 0
	options := standing(github.Standing{Fork: true}, &asked)
	outcome, err := Tracker(dir, nobody(t), Answers{Use: "github", Repository: "me/notes"}, options)
	if err != nil || !outcome.Changed || !strings.Contains(outcome.Message, "kept out of git here") {
		t.Fatalf("got %+v, %v", outcome, err)
	}
	if status := gitSays(t, dir, "status", "--porcelain"); status != "" {
		t.Fatalf("git sees: %s", status)
	}
	exclude := gitSays(t, dir, "rev-parse", "--git-path", "info/exclude")
	if out, _ := exec.Command("grep", "-c", "^/.bend.json$", dir+"/"+exclude).Output(); strings.TrimSpace(string(out)) != "1" {
		t.Fatalf("the exclude file holds .bend.json %s times", out)
	}
	state, err := Read(dir, options)
	if err != nil || !state.Elsewhere {
		t.Fatalf("not kept elsewhere: %+v, %v", state, err)
	}
	if step := state.Step(StepInstructions); step.State != NotNeeded || !strings.Contains(step.Why, "someone else's project") {
		t.Fatalf("instructions: %+v", step)
	}
	// Again: the exclude line is not added twice.
	if _, err := Tracker(dir, nobody(t), Answers{Use: "github", Repository: "me/notes"}, options); err != nil {
		t.Fatal(err)
	}
	if err := excludeLocally(dir, "/.bend.json"); err != nil {
		t.Fatal(err)
	}
	if out, _ := exec.Command("grep", "-c", "^/.bend.json$", dir+"/"+exclude).Output(); strings.TrimSpace(string(out)) != "1" {
		t.Fatalf("the exclude file holds .bend.json %s times", out)
	}
}

func TestBeadsIsSetUpWithoutQuestions(t *testing.T) {
	for _, wanted := range []string{"--non-interactive", "--skip-agents", "maintainer"} {
		if !slices.Contains(initArgs, wanted) {
			t.Fatalf("bd init is not given %s: %v", wanted, initArgs)
		}
	}
}
