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
		ClaudeFile  string   `json:"claudeFile"`
		ClaudeRules string   `json:"claudeRules"`
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
	// The CLAUDE.md beads generated is a file of its own: what it is to be
	// has to be said too. It holds nothing of the owner's, so as a link it
	// carries nothing into AGENTS.md.
	same(t, repo.fails("setup", "instructions", "-y").Kind, "usage", "the instructions without saying what CLAUDE.md is to be")
	repo.ok("setup", "instructions", "-y", "--claude", "link")
	agents := repo.file("AGENTS.md")
	if strings.Contains(agents, "BEGIN BEADS") || !strings.Contains(agents, "<!-- airbender:rules:start -->") ||
		!strings.Contains(agents, "## Mine\n\nMy own rules.\n") || strings.Contains(agents, "_Add your build") {
		t.Fatalf("AGENTS.md is not as it should be:\n%s", agents)
	}
	if target, err := os.Readlink(filepath.Join(repo.root, "CLAUDE.md")); err != nil || target != "AGENTS.md" {
		t.Fatalf("CLAUDE.md is not a link to AGENTS.md: %q (%v)", target, err)
	}
	if strings.Contains(agents, "@AGENTS.md") || strings.Contains(agents, "@FACTS.md") {
		t.Fatalf("an import line was written:\n%s", agents)
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

func TestSetupNoticesRulesChangedByHandThatFellBehind(t *testing.T) {
	newOnly(t)
	repo := bare(t)
	repo.ok("setup", "tracker", "--use", "beads")
	repo.ok("setup", "all", "-y")
	current := repo.file("AGENTS.md")

	// The owner's own variant of the current rules: theirs, and up to date.
	own := strings.Replace(current, "Every piece of work has an issue", "Every piece of work has an issue, here too", 1)
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte(own), 0o644)
	same(t, repo.setup().Instructions.Rules, "edited", "an edited block of the current version")
	same(t, repo.setup().Steps[3].State, "done", "the step, with rules that are the owner's and current")

	// The same, from an earlier version: behind. The step is offered and
	// asks; with nobody to ask it names the option and changes nothing.
	behind := "# Mine\n\n" + strings.Replace(own, "rules:version 4 -->", "rules:version 2 -->", 1) + "\n## After\n"
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte(behind), 0o644)
	found := repo.setup()
	same(t, found.Instructions.Rules, "behind", "an edited block of an earlier version")
	same(t, found.Steps[3].State, "missing", "the step, with rules that fell behind")
	same(t, found.Steps[3].Title, "Update Airbender's instructions for agents", "the step's name")
	if !strings.Contains(found.Steps[3].Why, "yours are from version 2, the current ones are version 4") {
		t.Fatalf("the step says: %s", found.Steps[3].Why)
	}
	asked := repo.fails("setup", "instructions", "-y")
	same(t, asked.Kind, "usage", "the step without the choice")
	if !strings.Contains(asked.Error, "--rules replace or --rules keep") {
		t.Fatalf("got %q", asked.Error)
	}
	same(t, repo.fails("setup", "instructions", "-y", "--rules", "burn").Kind, "usage", "a choice that is neither")
	same(t, repo.file("AGENTS.md"), behind, "the file after refused steps")

	// Keep: nothing of theirs changes but the version it is compared with,
	// and the step is done until the rules change again.
	repo.ok("setup", "instructions", "-y", "--rules", "keep")
	same(t, repo.file("AGENTS.md"), "# Mine\n\n"+own+"\n## After\n", "the file after keeping")
	same(t, repo.setup().Steps[3].State, "done", "the step after keeping")

	// Replace: the current rules stand where theirs stood, the rest of the
	// file is untouched, and what was there is saved outside the working
	// files.
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte(behind), 0o644)
	said := repo.ok("setup", "instructions", "-y", "--rules", "replace")
	same(t, repo.file("AGENTS.md"), "# Mine\n\n"+current+"\n## After\n", "the file after replacing")
	same(t, repo.setup().Instructions.Rules, "current", "the rules after replacing")
	at := strings.Index(said, "saved in ")
	if at == -1 {
		t.Fatalf("the step does not say where the earlier rules are: %s", said)
	}
	saved := strings.TrimSuffix(strings.TrimSpace(said[at+len("saved in "):]), ".")
	kept, err := os.ReadFile(saved)
	if err != nil || !strings.Contains(string(kept), "Every piece of work has an issue, here too") {
		t.Fatalf("the earlier rules were not saved in %s: %v", saved, err)
	}
	// In the repository's own git folder, which no commit takes in.
	if !strings.HasPrefix(saved, filepath.Join(repo.root, ".git", "bend")+string(filepath.Separator)) {
		t.Fatalf("the earlier rules were not saved in the repository's git folder: %s", saved)
	}

	// An earlier version of ours, unchanged: offered as an update, in
	// words that say the repository was set up and nothing is wrong.
	earlier, err := os.ReadFile(filepath.Join("..", "internal", "instructions", "testdata", "rules-v2-bend.md"))
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), earlier, 0o644)
	update := repo.setup()
	same(t, update.Instructions.Rules, "old", "an unchanged earlier version")
	same(t, update.Steps[3].Title, "Update Airbender's instructions for agents", "the step's name for an update")
	if why := update.Steps[3].Why; !strings.Contains(why, "it has version 2, the current ones are version 4") || !strings.Contains(why, "Nothing is wrong here") {
		t.Fatalf("the step says: %s", why)
	}
	repo.ok("setup", "instructions", "-y")
	same(t, repo.file("AGENTS.md"), current, "the file after the update")

	// A block whose end marker is gone cannot be replaced: nothing says
	// where it stops, and the owner's text below it would go too. Refused,
	// with nothing changed and nothing saved; keeping it still works.
	open := strings.Replace(behind, "<!-- airbender:rules:end -->\n", "", 1)
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte(open), 0o644)
	refused := repo.fails("setup", "instructions", "-y", "--rules", "replace")
	same(t, refused.Kind, "refused", "replacing a block with no end marker")
	if !strings.Contains(refused.Error, "no end marker") {
		t.Fatalf("got %q", refused.Error)
	}
	same(t, repo.file("AGENTS.md"), open, "the file after the refusal")
	repo.ok("setup", "instructions", "-y", "--rules", "keep")
	if !strings.HasSuffix(repo.file("AGENTS.md"), "\n## After\n") {
		t.Fatalf("keeping a block with no end marker lost what follows it:\n%s", repo.file("AGENTS.md"))
	}

	// A block with no version line at all (written by hand between the
	// markers) is behind too, and keeping it gives it one.
	bare := "<!-- airbender:rules:start -->\n## My own rules\n\nDo as I say.\n<!-- airbender:rules:end -->\n"
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte(bare), 0o644)
	same(t, repo.setup().Instructions.Rules, "behind", "a block that names no version")
	repo.ok("setup", "instructions", "-y", "--rules", "keep")
	same(t, repo.file("AGENTS.md"), "<!-- airbender:rules:start -->\n<!-- airbender:rules:version 4 -->\n## My own rules\n\nDo as I say.\n<!-- airbender:rules:end -->\n", "a kept block that named no version")
	same(t, repo.setup().Steps[3].State, "done", "the step after keeping a block of the owner's own")
}

func TestSetupAndClaudeFile(t *testing.T) {
	newOnly(t)
	link := func(repo *repository) string {
		target, err := os.Readlink(filepath.Join(repo.root, "CLAUDE.md"))
		if err != nil {
			return ""
		}
		return target
	}
	ready := func() (*repository, string) {
		repo := bare(t)
		repo.ok("setup", "tracker", "--use", "beads")
		repo.ok("setup", "all", "-y")
		return repo, repo.file("AGENTS.md")
	}

	// No CLAUDE.md: none is made, and no line imports anything.
	repo, rules := ready()
	if _, err := os.Lstat(filepath.Join(repo.root, "CLAUDE.md")); err == nil {
		t.Fatal("a CLAUDE.md was created where there was none")
	}
	if strings.Contains(rules, "\n@") || strings.HasPrefix(rules, "@") {
		t.Fatalf("the rules import a file:\n%s", rules)
	}
	same(t, repo.setup().Instructions.ClaudeFile, "none", "no CLAUDE.md")

	// A link to AGENTS.md, with the two lines an earlier setup wrote
	// through it at the top of AGENTS.md: the step is offered, takes them
	// off, and leaves the link a link and the rest as it was.
	os.Symlink("AGENTS.md", filepath.Join(repo.root, "CLAUDE.md"))
	same(t, repo.setup().Instructions.ClaudeFile, "linked", "a link to AGENTS.md")
	same(t, repo.setup().Steps[3].State, "done", "the step, with a clean linked CLAUDE.md")
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte("@AGENTS.md\n@FACTS.md\n\n"+rules), 0o644)
	damaged := repo.setup()
	same(t, damaged.Steps[3].State, "missing", "the step, with import lines at the top of AGENTS.md")
	same(t, damaged.Steps[3].Title, "Update Airbender's instructions for agents", "its name")
	repo.ok("setup", "instructions", "-y")
	same(t, repo.file("AGENTS.md"), rules, "AGENTS.md after the lines are taken off")
	same(t, link(repo), "AGENTS.md", "the link after the step")
	same(t, repo.setup().Steps[3].State, "done", "the step afterwards")
	// A second run finds nothing to do.
	repo.ok("setup", "instructions", "-y")
	same(t, repo.file("AGENTS.md"), rules, "AGENTS.md after a second run")
	same(t, link(repo), "AGENTS.md", "the link after a second run")

	// The other way round, AGENTS.md a link to CLAUDE.md: one file all the
	// same. Nothing is asked, the rules go into that one file, and neither
	// name becomes a link to the other.
	turned, turnedRules := ready()
	os.Rename(filepath.Join(turned.root, "AGENTS.md"), filepath.Join(turned.root, "CLAUDE.md"))
	os.Symlink("CLAUDE.md", filepath.Join(turned.root, "AGENTS.md"))
	same(t, turned.setup().Instructions.ClaudeFile, "linked", "AGENTS.md a link to CLAUDE.md")
	same(t, turned.setup().Steps[3].State, "done", "the step, with AGENTS.md a link to CLAUDE.md")
	os.WriteFile(filepath.Join(turned.root, "CLAUDE.md"), []byte("@AGENTS.md\n@FACTS.md\n\n"+turnedRules), 0o644)
	turned.ok("setup", "instructions", "-y", "--claude", "link")
	same(t, turned.file("CLAUDE.md"), turnedRules, "the one file, with the lines taken off")
	same(t, turned.file("AGENTS.md"), turnedRules, "the same file by its other name")
	if info, err := os.Lstat(filepath.Join(turned.root, "CLAUDE.md")); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("CLAUDE.md, the real file, was made a link")
	}

	// A link to another file is not this setup's, and is left alone.
	repo, rules = ready()
	os.WriteFile(filepath.Join(repo.root, "OTHER.md"), []byte("Other.\n"), 0o644)
	os.Symlink("OTHER.md", filepath.Join(repo.root, "CLAUDE.md"))
	elsewhere := repo.setup()
	same(t, elsewhere.Instructions.ClaudeFile, "linked-elsewhere", "a link to another file")
	same(t, elsewhere.Steps[3].State, "done", "the step, with a CLAUDE.md linked elsewhere")
	// Also when the step does run, for something else: the link and the
	// file it points at are as they were.
	os.WriteFile(filepath.Join(repo.root, "AGENTS.md"), []byte("@FACTS.md\n\n"+rules), 0o644)
	repo.ok("setup", "instructions", "-y", "--claude", "link")
	same(t, link(repo), "OTHER.md", "a link to another file, after a step that ran")
	same(t, repo.file("OTHER.md"), "Other.\n", "the file it points at")
	same(t, repo.file("AGENTS.md"), rules, "AGENTS.md after that step")

	// A CLAUDE.md that cannot be read is not taken for an empty one: the
	// step refuses and it stays. (Not as root, who can read anything.)
	if os.Geteuid() != 0 {
		os.Remove(filepath.Join(repo.root, "CLAUDE.md"))
		os.WriteFile(filepath.Join(repo.root, "CLAUDE.md"), []byte("Secret.\n"), 0o000)
		refused := repo.fails("setup", "instructions", "-y", "--claude", "link")
		same(t, refused.Kind, "refused", "a CLAUDE.md that cannot be read")
		if info, err := os.Lstat(filepath.Join(repo.root, "CLAUDE.md")); err != nil || info.Mode()&os.ModeSymlink != 0 {
			t.Fatal("an unreadable CLAUDE.md was replaced by a link")
		}
		os.Chmod(filepath.Join(repo.root, "CLAUDE.md"), 0o644)
		same(t, repo.file("CLAUDE.md"), "Secret.\n", "the unreadable CLAUDE.md, afterwards")
	}
	// A folder by that name is left alone too.
	os.Remove(filepath.Join(repo.root, "CLAUDE.md"))
	os.Mkdir(filepath.Join(repo.root, "CLAUDE.md"), 0o755)
	same(t, repo.setup().Instructions.ClaudeFile, "linked-elsewhere", "a folder called CLAUDE.md")
	same(t, repo.setup().Steps[3].State, "done", "the step, with a folder called CLAUDE.md")
	os.Remove(filepath.Join(repo.root, "CLAUDE.md"))

	// An ordinary file: the owner chooses. Without an answer nothing
	// changes and the option is named.
	mine := "@AGENTS.md\n@FACTS.md\n\n# Claude only\n\nUse the long context.\n"
	os.Remove(filepath.Join(repo.root, "CLAUDE.md"))
	os.WriteFile(filepath.Join(repo.root, "CLAUDE.md"), []byte(mine), 0o644)
	open := repo.setup()
	same(t, open.Instructions.ClaudeFile, "file", "an ordinary CLAUDE.md")
	same(t, open.Steps[3].State, "missing", "the step, with a CLAUDE.md of its own")
	same(t, open.Steps[3].Title, "Decide what `CLAUDE.md` is here", "its name")
	asked := repo.fails("setup", "instructions", "-y")
	same(t, asked.Kind, "usage", "the step without the choice")
	if !strings.Contains(asked.Error, "--claude link or --claude rules") {
		t.Fatalf("got %q", asked.Error)
	}
	same(t, repo.fails("setup", "instructions", "-y", "--claude", "both").Kind, "usage", "a choice that is neither")
	same(t, repo.file("CLAUDE.md"), mine, "CLAUDE.md after refused steps")
	same(t, repo.file("AGENTS.md"), rules, "AGENTS.md after refused steps")

	// Link: a relative link to AGENTS.md; the owner's text is carried to
	// the end of AGENTS.md without the import lines; the file is saved.
	said := repo.ok("setup", "instructions", "-y", "--claude", "link")
	same(t, link(repo), "AGENTS.md", "CLAUDE.md after choosing the link")
	same(t, repo.file("AGENTS.md"), rules+"\n# Claude only\n\nUse the long context.\n", "AGENTS.md with the owner's text carried over")
	at := strings.Index(said, "saved in ")
	if at == -1 {
		t.Fatalf("the step does not say where the file was saved: %s", said)
	}
	saved := strings.TrimSuffix(strings.Fields(said[at+len("saved in "):])[0], ".")
	if kept, err := os.ReadFile(saved); err != nil || string(kept) != mine || !strings.HasPrefix(saved, filepath.Join(repo.root, ".git", "bend")+string(filepath.Separator)) {
		t.Fatalf("what CLAUDE.md held was not saved in the git folder as it was: %s (%v)", saved, err)
	}
	same(t, repo.setup().Steps[3].State, "done", "the step after choosing the link")
	// A second run, also with the answer given again, changes nothing.
	carried := repo.file("AGENTS.md")
	repo.ok("setup", "instructions", "-y", "--claude", "rules")
	same(t, repo.file("AGENTS.md"), carried, "AGENTS.md after a second run")
	same(t, link(repo), "AGENTS.md", "the link after a second run")

	// Rules: the file stays, gets the same rules block, keeps its own
	// text, and loses the import lines.
	repo, rules = ready()
	os.WriteFile(filepath.Join(repo.root, "CLAUDE.md"), []byte(mine), 0o644)
	repo.ok("setup", "instructions", "-y", "--claude", "rules")
	same(t, link(repo), "", "CLAUDE.md is still a file")
	same(t, repo.file("CLAUDE.md"), "# Claude only\n\nUse the long context.\n\n"+rules, "CLAUDE.md with the same rules")
	same(t, repo.file("AGENTS.md"), rules, "AGENTS.md, untouched")
	settled := repo.setup()
	same(t, settled.Instructions.ClaudeRules, "current", "the rules in CLAUDE.md")
	same(t, settled.Steps[3].State, "done", "the step after choosing the rules")
	// The answer given again, the other way, does not turn a settled file
	// into a link.
	repo.ok("setup", "instructions", "-y", "--claude", "link")
	same(t, link(repo), "", "a settled CLAUDE.md after the other answer")
	// An earlier version of the rules in it is brought up to date with
	// AGENTS.md's, without asking again.
	earlier, err := os.ReadFile(filepath.Join("..", "internal", "instructions", "testdata", "rules-v3.md"))
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(repo.root, "CLAUDE.md"), []byte("# Claude only\n\nUse the long context.\n\n"+string(earlier)), 0o644)
	same(t, repo.setup().Steps[3].State, "missing", "the step, with earlier rules in CLAUDE.md")
	repo.ok("setup", "instructions", "-y")
	same(t, repo.file("CLAUDE.md"), "# Claude only\n\nUse the long context.\n\n"+rules, "CLAUDE.md brought up to date")
}
