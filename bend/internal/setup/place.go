// place.go — where setup may change a repository, and committing its files.
//
// What: works out whether a folder is the repository's main folder on its
// main branch, the only place setup changes the repository; and the step
// that commits the files setup writes (.bend.json, AGENTS.md, CLAUDE.md,
// FACTS.md and beads' support files) right away, and keeps beads' root
// lock out of git in this clone.
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
//   - Beads' hooks are expanded to individual file names: a directory
//     path must not accidentally stage ignored files within it.
//   - The root lock lives beside .beads, outside its .gitignore's scope.
//     Its ignore rule goes in the clone's info/exclude after confirmation,
//     even when no files need committing (bead-bb-ozo).
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

// committedFiles are setup's shared files, relative to the repository's
// root. The hooks directory is expanded by uncommitted; the database and
// runtime files are never candidates (bead-bb-cnv, bead-bb-ozo).
var committedFiles = []string{
	detect.SettingFile, instructions.AgentsFile, instructions.ClaudeFile, instructions.FactsFile,
	beadsConfig, ".beads/.gitignore", ".beads/README.md", ".beads/metadata.json", ".beads/hooks",
}

// beadsConfig is beads' settings file, tracked in the repository.
const beadsConfig = ".beads/config.yaml"

// beadsLock is beads' clone-local workspace gate, beside its database folder.
const beadsLock = ".beads.gate.lock"

// beadsLockPending reports whether an existing beads folder lacks an
// effective ignore rule for its root lock, whether or not the lock exists.
// It only reads; existing global, shared or local ignore rules count.
func beadsLockPending(root string) bool {
	if !exists(filepath.Join(root, ".beads")) {
		return false
	}
	_, ignored := quiet(root, 5*time.Second, "git", "check-ignore", "--quiet", "--", beadsLock)
	return !ignored
}

// ignoreBeadsLock appends the missing rule to this clone's Git exclude
// file, preserving its contents. Call only in git, after confirmation.
// Returns a refusal on read/write failure; creates no commit or shared file.
func ignoreBeadsLock(root string) error {
	where, ok := quiet(root, 5*time.Second, "git", "rev-parse", "--git-path", "info/exclude")
	if !ok {
		return tracker.Refused("Git's local exclude file could not be found.")
	}
	if !filepath.IsAbs(where) {
		where = filepath.Join(root, where)
	}
	content, err := os.ReadFile(where)
	if err != nil && !os.IsNotExist(err) {
		return tracker.Refused("%s could not be read: %s", where, err)
	}
	text := string(content)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "# Beads' local workspace lock (bend setup)\n/" + beadsLock + "\n"
	if err := os.MkdirAll(filepath.Dir(where), 0o755); err != nil {
		return tracker.Refused("%s could not be written: %s", where, err)
	}
	return writeFile(where, text)
}

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
// order given, with directory contents sorted and expanded to file names.
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
		matches := []string{}
		for path := range found {
			if path == name || strings.HasPrefix(path, name+"/") {
				matches = append(matches, path)
			}
		}
		slices.Sort(matches)
		ordered = append(ordered, matches...)
	}
	return ordered
}

// setupPending gives which of setup's files hold setup's work that is not
// committed: `.bend.json` changed in any way (only setup writes it);
// beads' support files changed in any way;
// `FACTS.md` only when new; `AGENTS.md` and `CLAUDE.md` when new, when the
// link CLAUDE.md is changed, or when Airbender's rules block differs from
// the last commit. An agent's own edits elsewhere in those files, made
// while working an issue, do not count: those are that issue's to commit.
func setupPending(root string) []string {
	changed := uncommitted(root, committedFiles)
	untracked := map[string]bool{}
	listed, _ := quiet(root, 10*time.Second, "git", append([]string{"ls-files", "--others", "--exclude-standard", "--"}, committedFiles...)...)
	for _, name := range strings.Split(listed, "\n") {
		untracked[strings.TrimSpace(name)] = true
	}
	pending := []string{}
	for _, name := range changed {
		switch {
		case name == detect.SettingFile || strings.HasPrefix(name, ".beads/"):
			pending = append(pending, name)
		case name == instructions.FactsFile:
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
	ignoreLock := beadsLockPending(state.Root)
	if len(pending) == 0 && !ignoreLock {
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
	step.State = Missing
	step.Command = "bend setup commit"
	if ignoreLock {
		step.Explain = append(step.Explain, "Adds /"+beadsLock+" to Git's local info/exclude file so this computer's lock stays out of git.")
	}
	if len(pending) == 0 {
		step.Why = "Airbender's files are committed, but beads' local workspace lock is not ignored."
		step.Explain = append(step.Explain, "No commit is needed. Other changes, staged or not, stay as they are.")
		return step
	}
	files := strings.Join(pending, ", ")
	step.Why = "Setup wrote " + files + ", which are not committed yet. Committed now, every worktree and branch made from here has them."
	step.Runs = "git add -- " + strings.Join(pending, " ") + " && git commit -m \"" + commitMessage(pending) + "\" -- " + strings.Join(pending, " ")
	on := branchOf(state.Root)
	if on == "" {
		on = "the current commit"
	}
	step.Explain = append(step.Explain,
		"It commits "+files+" on "+on+", and nothing else: other changes, staged or not, stay as they are.",
		"The whole of each file goes in, a change you made to it yourself included.",
		"Nothing is pushed.",
	)
	return step
}

// commitMessage is the message of setup's commit.
func commitMessage(files []string) string {
	return "Set up Airbender: " + strings.Join(files, ", ")
}

// Commit commits the files setup wrote, and only them.
//
// Side effects after confirmation: ignores beads' root lock locally when
// needed; runs `git add` and `git commit` only for pending shared files,
// attached to the terminal so the repository's hooks run and show. With
// only a missing ignore rule, it leaves HEAD and the index alone.
func Commit(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepCommit, options)
	if done != nil || err != nil {
		return done, err
	}
	if err := confirm(terminal, answers, step); err != nil {
		return nil, err
	}
	pending := setupPending(state.Root)
	ignoredLock := beadsLockPending(state.Root)
	if ignoredLock {
		if err := ignoreBeadsLock(state.Root); err != nil {
			return nil, err
		}
	}
	if len(pending) != 0 {
		if err := ran(terminal.Run(state.Root, "git", append([]string{"add", "--"}, pending...)...), "git add"); err != nil {
			return nil, err
		}
		if err := ran(terminal.Run(state.Root, "git", append([]string{"commit", "-m", commitMessage(pending), "--"}, pending...)...), "git commit"); err != nil {
			return nil, err
		}
	}
	after, err := Read(dir, options)
	if err != nil {
		return nil, err
	}
	if after.Step(StepCommit).State != Done {
		return nil, tracker.Refused("The commit did not take all of Airbender's files: %s", after.Step(StepCommit).Why)
	}
	message := ""
	if len(pending) != 0 {
		message = "Committed " + strings.Join(pending, ", ") + "."
	}
	if ignoredLock {
		message = strings.TrimSpace(message + " Ignored " + beadsLock + " locally.")
	}
	return &Outcome{Step: StepCommit, Changed: true, Message: message}, nil
}
