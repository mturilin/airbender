// setup_test.go — `bend setup`, against real repositories.
//
// What: runs `bend setup` and its steps in throwaway folders: a new
// repository, one set up the way beads does it by default, a fresh clone
// whose remote holds the issues, and one set to GitHub issues with no
// login.
//
// Why: the steps drive git, bd and the instruction files together; only a
// run through all of them shows that a repository ends up ready, that a
// second run changes nothing, and that nothing waits for an answer when
// nobody is at the keyboard (the tests' standard input is never a
// terminal).
//
// Gotchas:
//   - Needs bd and git; skipped where they are missing.
//   - The fresh-clone test publishes to a bare git repository in a
//     temporary folder, never to a real remote.

package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupState is the part of `bend setup --json` the tests look at.
type setupState struct {
	Root      string  `json:"root"`
	Tracker   *string `json:"tracker"`
	Ready     bool    `json:"ready"`
	IssuesHow string  `json:"issuesHow"`
	Steps     []struct {
		Name    string `json:"name"`
		Title   string `json:"title"`
		State   string `json:"state"`
		Why     string `json:"why"`
		Command string `json:"command"`
		Runs    string `json:"runs"`
	} `json:"steps"`
	Instructions struct {
		Rules       string   `json:"rules"`
		BeadsBlocks []string `json:"beadsBlocks"`
		BeadsHooks  []string `json:"beadsHooks"`
		Leftovers   []string `json:"leftovers"`
	} `json:"instructions"`
	SavedFacts []struct {
		Key string `json:"key"`
	} `json:"savedFacts"`
}

// states gives each step's state as "name=state", joined, for comparing.
func (state setupState) states() string {
	parts := []string{}
	for _, step := range state.Steps {
		parts = append(parts, step.Name+"="+step.State)
	}
	return strings.Join(parts, " ")
}

// setup gives what `bend setup --json` says about the repository.
func (repo *repository) setup() setupState {
	repo.t.Helper()
	var state setupState
	repo.parse(repo.ok("setup", "--json"), &state)
	return state
}

// bare makes a throwaway folder with git in it and nothing else; the test
// is skipped where git or bd is not available.
func bare(t *testing.T) *repository {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("bd"); err != nil {
		t.Skip("bd is not available")
	}
	repo := &repository{t: t, root: root}
	repo.run("git", "init", "-q")
	return repo
}

// run runs a program in the repository, kept apart from the user's own git
// settings; the test is skipped when it cannot be run.
func (repo *repository) run(name string, args ...string) string {
	repo.t.Helper()
	command := exec.Command(name, args...)
	command.Dir = repo.root
	command.Env = append(os.Environ(), "BD_ACTOR=tester",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := command.CombinedOutput()
	if err != nil {
		repo.t.Skipf("%s %s could not be run: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out)
}

// file gives the text of a file in the repository; "" when it is not there.
func (repo *repository) file(name string) string {
	content, _ := os.ReadFile(filepath.Join(repo.root, name))
	return string(content)
}

func TestSetupOfANewRepository(t *testing.T) {
	newOnly(t)
	repo := bare(t)
	first := repo.setup()
	same(t, first.states(), "tracker=missing program=blocked issues=blocked instructions=blocked facts=not-needed publish=blocked", "a new repository")
	same(t, first.Root, repo.root, "root")
	same(t, first.Ready, false, "ready")
	same(t, first.Steps[0].Command, "bend setup tracker", "the command for the missing step")
	if !strings.Contains(repo.ok("setup"), "To do every missing step in order: bend setup all") {
		t.Fatal("the text form does not say how to do everything")
	}
	// Reading changed nothing.
	if entries, _ := os.ReadDir(repo.root); len(entries) != 1 {
		t.Fatalf("reading the state left files behind: %v", entries)
	}

	// Nobody is at the keyboard: a step without its answer changes nothing,
	// names the option, and ends at once as a wrong request.
	asked := repo.fails("setup", "tracker")
	same(t, asked.Kind, "usage", "tracker without an answer")
	if !strings.Contains(asked.Error, "--use beads or --use github") {
		t.Fatalf("got %q", asked.Error)
	}
	same(t, repo.file(".bend.json"), "", "the setting after a refused step")
	same(t, repo.fails("setup", "all").Kind, "usage", "all without answers")
	same(t, repo.fails("setup", "issues", "-y").Kind, "refused", "a step that waits for an earlier one")
	same(t, repo.status("setup", "nonsense"), 2, "an unknown step")

	repo.ok("setup", "tracker", "--use", "beads")
	same(t, repo.file(".bend.json"), "{\"tracker\": \"beads\"}\n", "the setting")
	// all stops at the first step that lacks its yes, having changed nothing.
	same(t, repo.fails("setup", "all").Kind, "usage", "all without a yes")
	same(t, repo.setup().states(), "tracker=done program=done issues=missing instructions=blocked facts=not-needed publish=blocked", "after choosing beads")

	repo.ok("setup", "all", "-y")
	done := repo.setup()
	same(t, done.states(), "tracker=done program=done issues=done instructions=done facts=not-needed publish=not-needed", "after all")
	same(t, done.Ready, true, "ready")
	same(t, done.Instructions.Rules, "current", "the rules")
	if !strings.HasPrefix(repo.file("AGENTS.md"), "<!-- airbender:rules:start -->") || !strings.HasPrefix(repo.file("FACTS.md"), "# Facts\n") {
		t.Fatal("the instructions or the facts file are not there")
	}
	same(t, repo.file("CLAUDE.md"), "", "no CLAUDE.md is made where there was none")
	// The repository works: an issue can be made and read.
	id := repo.ok("create", "First")
	same(t, repo.show(id).Title, "First", "an issue in the new repository")

	// Idempotent: every step, and all, find their work done and change
	// nothing.
	before := repo.file("AGENTS.md") + repo.file("FACTS.md") + repo.file(".bend.json")
	same(t, repo.ok("setup", "all", "-y"), "Nothing was missing.", "all again")
	for _, step := range []string{"tracker", "program", "issues", "instructions"} {
		var outcome struct {
			Changed bool   `json:"changed"`
			Message string `json:"message"`
		}
		repo.parse(repo.ok("setup", step, "-y", "--json"), &outcome)
		if outcome.Changed || !strings.HasPrefix(outcome.Message, "Already done") {
			t.Fatalf("%s again: %+v", step, outcome)
		}
	}
	same(t, repo.file("AGENTS.md")+repo.file("FACTS.md")+repo.file(".bend.json"), before, "the files after running everything again")
}

func TestSetupSwitchesARepositorySetUpTheOldWay(t *testing.T) {
	newOnly(t)
	repo := bare(t)
	repo.run("bd", "init", "--prefix", "t", "--non-interactive")
	repo.run("bd", "setup", "claude")
	repo.run("bd", "setup", "codex")
	repo.run("bd", "remember", "Run npm test before handing over", "--key", "build")
	repo.run("bd", "remember", "Agents do not close issues", "--key", "no-close")
	// The owner's own text, around what beads wrote.
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte(repo.file("AGENTS.md")+"\n## Mine\n\nMy own rules.\n"), 0o644)

	found := repo.setup()
	same(t, found.states(), "tracker=done program=done issues=done instructions=missing facts=missing publish=not-needed", "set up the old way")
	same(t, found.Steps[3].Title, "Replace beads' instructions with Airbender's", "the step's name")
	same(t, strings.Join(found.Instructions.BeadsBlocks, " "), "AGENTS.md CLAUDE.md", "beads' blocks")
	same(t, strings.Join(found.Instructions.BeadsHooks, ", "), "Claude Code, Codex", "beads' hooks")
	same(t, found.Instructions.Rules, "none", "the rules")
	same(t, len(found.SavedFacts), 2, "saved facts on offer")

	same(t, repo.fails("setup", "instructions").Kind, "usage", "the instructions without a yes")
	repo.ok("setup", "instructions", "-y")
	agents := repo.file("AGENTS.md")
	if strings.Contains(agents, "BEGIN BEADS") || !strings.Contains(agents, "<!-- airbender:rules:start -->") ||
		!strings.Contains(agents, "## Mine\n\nMy own rules.\n") {
		t.Fatalf("AGENTS.md is not as it should be:\n%s", agents)
	}
	if !strings.Contains(repo.file("CLAUDE.md"), "@AGENTS.md\n@FACTS.md") {
		t.Fatalf("CLAUDE.md does not point at both:\n%s", repo.file("CLAUDE.md"))
	}
	if strings.Contains(repo.file(".claude/settings.json"), "bd prime") || strings.Contains(repo.file(".codex/hooks.json"), "bd codex-hook") {
		t.Fatal("beads' hooks are still there")
	}
	after := repo.setup()
	same(t, after.Steps[3].State, "done", "the instructions step")
	same(t, len(after.Instructions.BeadsHooks)+len(after.Instructions.BeadsBlocks), 0, "what is left of beads'")

	// The facts: which to carry over must be said.
	same(t, repo.fails("setup", "facts").Kind, "usage", "the facts without a choice")
	same(t, repo.fails("setup", "facts", "--keep", "nonsense").Kind, "usage", "a fact that is not on offer")
	repo.ok("setup", "facts", "--keep", "build")
	facts := repo.file("FACTS.md")
	if !strings.Contains(facts, "- **build** — Run npm test before handing over") || strings.Contains(facts, "no-close") {
		t.Fatalf("the facts file is not as chosen:\n%s", facts)
	}
	last := repo.setup()
	same(t, last.Steps[4].State, "done", "the facts step")
	same(t, last.Ready, true, "ready")
	// Still in beads: carrying over copies, it does not move.
	if !strings.Contains(repo.run("bd", "memories"), "no-close") {
		t.Fatal("the fact left behind is gone from beads")
	}
}

func TestSetupGetsTheIssuesOnAFreshClone(t *testing.T) {
	newOnly(t)
	origin := bare(t)
	origin.run("git", "init", "-q", "--bare", "remote.git")
	remote := filepath.Join(origin.root, "remote.git")

	first := bare(t)
	first.run("git", "commit", "-q", "--allow-empty", "-m", "start")
	first.run("git", "remote", "add", "origin", remote)
	first.run("git", "push", "-q", "origin", "HEAD")
	first.ok("setup", "tracker", "--use", "beads")
	first.ok("setup", "issues", "-y")
	id := first.ok("create", "Made on the first computer")
	// The issues are on this computer only, and there is a remote: offered.
	publish := first.setup().Steps[5]
	same(t, publish.State, "missing", "publish before publishing")
	if !strings.Contains(publish.Runs, "dolt push --yes") {
		t.Fatalf("the command is not shown: %q", publish.Runs)
	}
	same(t, first.fails("setup", "publish").Kind, "usage", "publishing without a yes")
	first.ok("setup", "publish", "-y")
	same(t, first.setup().Steps[5].State, "done", "publish after publishing")

	second := bare(t)
	second.run("git", "remote", "add", "origin", remote)
	second.ok("setup", "tracker", "--use", "beads")
	found := second.setup()
	same(t, found.IssuesHow, "fetch", "what the issues step would do")
	same(t, found.Steps[2].Title, "Get this repository's issues", "the step's name")
	second.ok("setup", "issues", "-y")
	same(t, second.show(id).Title, "Made on the first computer", "the issue, on the second computer")
}

func TestSetupForGitHubIssuesWithoutALogin(t *testing.T) {
	newOnly(t)
	repo := bare(t)
	// No token, and a PATH with git alone on it, so no `gh` to ask either:
	// nothing is sent anywhere.
	only := t.TempDir()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not available")
	}
	os.Symlink(git, filepath.Join(only, "git"))
	repo.env = []string{"GH_TOKEN=", "GITHUB_TOKEN=", "PATH=" + only}

	same(t, repo.fails("setup", "tracker", "--use", "github").Kind, "usage", "GitHub without a repository that can be told")
	// A name that could not be read back is refused before anything is written.
	same(t, repo.fails("setup", "tracker", "--use", "github", "--repository", "not valid").Kind, "usage", "a repository that is not owner/name")
	same(t, repo.file(".bend.json"), "", "the setting after a refused step")
	repo.ok("setup", "tracker", "--use", "github", "--repository", "someone/thing")
	same(t, repo.file(".bend.json"), "{\"tracker\": \"github\", \"repository\": \"someone/thing\"}\n", "the setting")
	found := repo.setup()
	same(t, found.states(), "tracker=done program=not-needed issues=missing instructions=blocked facts=not-needed publish=not-needed", "GitHub issues, not signed in")
	same(t, found.Steps[2].Runs, "gh auth login", "what signing in runs")
	// Signing in is a conversation; without a keyboard it is refused with
	// how to do it, and nothing is run.
	refused := repo.fails("setup", "issues", "-y")
	same(t, refused.Kind, "not-signed-in", "signing in with nobody there")
	if !strings.Contains(refused.Error, "gh auth login") {
		t.Fatalf("got %q", refused.Error)
	}
	// all stops there too, and does not say that nothing was missing.
	same(t, repo.fails("setup", "all", "-y").Kind, "not-signed-in", "all, with a step that cannot be done")

	// A step that waits for something outside bend: all says so.
	other := bare(t)
	// An empty home folder too: programs are also looked for in the usual
	// folders under it.
	other.env = append([]string{"HOME=" + t.TempDir()}, repo.env...)
	other.ok("setup", "tracker", "--use", "beads")
	// Which of the two depends on the machine: with no tool to install
	// beads with, the step waits for one ("program: ..."); with one, the
	// way of installing has to be said (--method). Either way all fails,
	// and says why.
	waiting := other.fails("setup", "all", "-y")
	if !strings.Contains(waiting.Error, "program:") && !strings.Contains(waiting.Error, "--method") {
		t.Fatalf("got %q", waiting.Error)
	}
}
