// place.go — where setup may change a repository, and committing its files.
//
// What: works out whether a folder is the repository's main folder on its
// main branch, the only place setup changes the repository; and the step
// that commits the files setup writes (.bend.json, AGENTS.md, CLAUDE.md,
// FACTS.md) right away.
//
// Why: setup wrote Airbender's rules into minisaba's main folder and nobody
// committed them, so a worktree made from main lacked them and the tab
// offered to add them again, onto that issue's branch. Files committed on a
// branch reach main only if the branch is merged, and a stale branch never
// is. The owner's rule (bead-bb-25p): set Airbender up only from the main
// folder, on the main branch; anywhere else setup only says so; and there,
// offer to commit its files at once.
//
// Design notes:
//   - The main branch is the remote's default (origin/HEAD), else a local
//     main or master, as the plugin's server/folder.ts decides it. Where it
//     cannot be told, only the worktree check applies.
//   - A step that is done stays done anywhere; only a step that would change
//     the repository is held back. Installing beads, which is for the whole
//     computer, and signing in to GitHub are not.
//   - The commit names its files (`git commit -- <paths>`), so whatever
//     else is staged stays staged and out of it.
//
// Gotchas:
//   - The whole of each file is committed, a change the owner made to it by
//     hand included; the step says so before it runs.
package setup

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/detect"
	"github.com/mturilin/airbender/bend/internal/instructions"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// StepCommit is the step that commits the files setup writes.
const StepCommit = "commit"

// committedFiles are the files setup writes at the repository's top folder,
// to be committed; beads' settings file among them, which setup changes when
// it switches beads' journal on (bead-bb-cnv).
var committedFiles = []string{detect.SettingFile, instructions.AgentsFile, instructions.ClaudeFile, instructions.FactsFile, beadsConfig}

// beadsConfig is beads' settings file, tracked in the repository.
const beadsConfig = ".beads/config.yaml"

// removedPlaces are where beads' agent setup leaves files that setup
// deletes; a deletion of one that was committed is setup's to commit.
var removedPlaces = []string{".codex/hooks.json", ".codex/config.toml", ".agents/skills/beads", ".claude/settings.json"}

// changesRepository says which steps change the repository, and so are held
// back away from the main folder on the main branch. The issues step only
// with beads: with GitHub issues it is signing in.
func changesRepository(name, chosen string) bool {
	switch name {
	case StepTracker, StepInstructions, StepFacts, StepCommit, StepPublish:
		return true
	case StepIssues:
		return chosen != "github"
	}
	return false
}

// inGit says whether dir is inside a git repository.
func inGit(dir string) bool {
	_, ok := quiet(dir, 5*time.Second, "git", "rev-parse", "--git-dir")
	return ok
}

// branchOf gives the branch checked out in dir; "" when none is (or not in
// git).
func branchOf(dir string) string {
	name, ok := quiet(dir, 5*time.Second, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
	if !ok {
		return ""
	}
	return strings.TrimSpace(name)
}

// mainBranchOf gives the repository's main branch: the remote's default
// where git knows it, else a local main or master; "" when neither.
func mainBranchOf(dir string) string {
	if remote, ok := quiet(dir, 5*time.Second, "git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); ok {
		if name := strings.TrimPrefix(strings.TrimSpace(remote), "origin/"); name != "" {
			return name
		}
	}
	local, _ := quiet(dir, 5*time.Second, "git", "branch", "--list", "--format=%(refname:short)", "main", "master")
	return strings.TrimSpace(strings.Split(local, "\n")[0])
}

// uncommitted gives which of these files, at the top folder root, are new
// and not ignored, or differ from the last commit, staged or not; in the
// order given.
//
// Three plain lists of names, not `git status --porcelain`: its status
// columns begin with a space, which the trimming in quiet takes off the
// first line (it cut "AGENTS.md" to "GENTS.md").
func uncommitted(root string, files []string) []string {
	found := map[string]bool{}
	for _, args := range [][]string{
		{"ls-files", "--others", "--exclude-standard", "--"},
		{"ls-files", "--modified", "--"},
		{"diff", "--cached", "--name-only", "--"},
	} {
		listed, _ := quiet(root, 10*time.Second, "git", append(args, files...)...)
		for _, name := range strings.Split(listed, "\n") {
			if name = strings.TrimSpace(name); name != "" {
				found[name] = true
			}
		}
	}
	ordered := []string{}
	for _, name := range files {
		if found[name] {
			ordered = append(ordered, name)
		}
	}
	return ordered
}

// setupPending gives which of setup's files hold setup's work that is not
// committed: `.bend.json` changed in any way (only setup writes it);
// `FACTS.md` only when new; `AGENTS.md` and `CLAUDE.md` when new, when the
// link CLAUDE.md is changed, or when Airbender's rules block differs from
// the last commit. An agent's own edits elsewhere in those files, made
// while working an issue, do not count: those are that issue's to commit.
func setupPending(root string) []string {
	changed := map[string]bool{}
	for _, name := range uncommitted(root, committedFiles) {
		changed[name] = true
	}
	untracked := map[string]bool{}
	listed, _ := quiet(root, 10*time.Second, "git", append([]string{"ls-files", "--others", "--exclude-standard", "--"}, committedFiles...)...)
	for _, name := range strings.Split(listed, "\n") {
		untracked[strings.TrimSpace(name)] = true
	}
	pending := []string{}
	for _, name := range committedFiles {
		if !changed[name] {
			continue
		}
		switch name {
		case detect.SettingFile, beadsConfig:
			pending = append(pending, name)
		case instructions.FactsFile:
			if untracked[name] {
				pending = append(pending, name)
			}
		default:
			path := filepath.Join(root, name)
			if info, err := os.Lstat(path); untracked[name] || (err == nil && info.Mode()&os.ModeSymlink != 0) {
				pending = append(pending, name)
				continue
			}
			before, _ := quiet(root, 10*time.Second, "git", "show", "HEAD:"+name)
			if instructions.RulesBlock(textOf(path)) != instructions.RulesBlock(before) {
				pending = append(pending, name)
			}
		}
	}
	// Beads' leftovers that were committed and are now deleted.
	deleted, _ := quiet(root, 10*time.Second, "git", append([]string{"ls-files", "--deleted", "--"}, removedPlaces...)...)
	for _, name := range strings.Split(deleted, "\n") {
		if name = strings.TrimSpace(name); name != "" && !slices.Contains(pending, name) {
			pending = append(pending, name)
		}
	}
	return pending
}

// notHere says, in words, why setup may not change the repository from
// this folder; "" where it may, and outside git.
func (state *State) notHere() string {
	if !inGit(state.Root) {
		return ""
	}
	main := mainBranchOf(state.Root)
	if filepath.Clean(state.Root) != filepath.Clean(state.home) {
		// A worktree whose main folder has the rules but has not committed
		// them: the one thing to do is there (the minisaba case).
		agents := filepath.Join(state.home, instructions.AgentsFile)
		if instructions.RulesIn(textOf(agents)) != "none" && slices.Contains(setupPending(state.home), instructions.AgentsFile) {
			return "Airbender's instructions are in the main folder, " + state.home + ", but not committed, so this worktree lacks them. Commit them there: its setup offers it."
		}
		// Main has the rules and this branch was made before them: nothing to
		// set up, only the branch to bring up to date.
		if main != "" && instructions.RulesIn(textOf(filepath.Join(state.Root, instructions.AgentsFile))) == "none" {
			if onMain, ok := quiet(state.Root, 10*time.Second, "git", "show", main+":"+instructions.AgentsFile); ok && instructions.RulesIn(onMain) != "none" {
				return "Airbender is set up on " + main + ", but this branch was made before that. Bring it up to date with " + main + " to get Airbender's instructions."
			}
		}
		where := "Set up Airbender from the main folder, " + state.home
		if main != "" {
			where += ", on " + main
		}
		return where + "."
	}
	if main == "" {
		return ""
	}
	switch branch := branchOf(state.Root); branch {
	case main:
		return ""
	case "":
		return "Set up Airbender on " + main + ": this folder has no branch checked out."
	default:
		return "Set up Airbender on " + main + ": this folder is on " + branch + "."
	}
}

// commitStep is the step that commits the files setup wrote.
func (state *State) commitStep() Step {
	step := Step{Name: StepCommit, Title: "Commit Airbender's files", Explain: []string{}}
	switch {
	case !inGit(state.Root):
		step.State, step.Why = NotNeeded, "This folder is not a git repository."
		return step
	case state.Elsewhere:
		step.State, step.Why = NotNeeded, "Airbender's files are kept out of git in this clone."
		return step
	}
	pending := setupPending(state.Root)
	if len(pending) == 0 {
		written := false
		for _, name := range committedFiles {
			if _, err := os.Lstat(filepath.Join(state.Root, name)); err == nil {
				written = true
			}
		}
		if !written {
			step.State, step.Why = NotNeeded, "Setup has written nothing to commit yet."
			return step
		}
		step.State, step.Why = Done, "Airbender's files are committed."
		return step
	}
	files := strings.Join(pending, ", ")
	step.State = Missing
	step.Why = "Setup wrote " + files + ", which are not committed yet. Committed now, every worktree and branch made from here has them."
	step.Command = "bend setup commit"
	step.Runs = "git add -- " + strings.Join(pending, " ") + " && git commit -m \"" + commitMessage(pending) + "\" -- " + strings.Join(pending, " ")
	on := branchOf(state.Root)
	if on == "" {
		on = "the current commit"
	}
	step.Explain = []string{
		"It commits " + files + " on " + on + ", and nothing else: other changes, staged or not, stay as they are.",
		"The whole of each file goes in, a change you made to it yourself included.",
		"Nothing is pushed.",
	}
	return step
}

// commitMessage is the message of setup's commit.
func commitMessage(files []string) string {
	return "Set up Airbender: " + strings.Join(files, ", ")
}

// Commit commits the files setup wrote, and only them.
//
// Side effects: runs `git add` and `git commit` for those files, attached
// to the terminal, so the repository's hooks run and show.
func Commit(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepCommit, options)
	if done != nil || err != nil {
		return done, err
	}
	if err := confirm(terminal, answers, step); err != nil {
		return nil, err
	}
	pending := setupPending(state.Root)
	if err := ran(terminal.Run(state.Root, "git", append([]string{"add", "--"}, pending...)...), "git add"); err != nil {
		return nil, err
	}
	if err := ran(terminal.Run(state.Root, "git", append([]string{"commit", "-m", commitMessage(pending), "--"}, pending...)...), "git commit"); err != nil {
		return nil, err
	}
	after, err := Read(dir, options)
	if err != nil {
		return nil, err
	}
	if after.Step(StepCommit).State != Done {
		return nil, tracker.Refused("The commit did not take all of Airbender's files: %s", after.Step(StepCommit).Why)
	}
	return &Outcome{Step: StepCommit, Changed: true, Message: "Committed " + strings.Join(pending, ", ") + "."}, nil
}
