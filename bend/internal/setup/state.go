// Package setup gets a repository ready for agents to work its issues, and
// says what is in place.
//
// What: works out, for a folder, the state of every setup step (state.go),
// and carries the steps out (steps.go): choosing the tracker, installing
// the tracker's program, preparing the issues, writing the instructions for
// agents, carrying saved facts over, and publishing the issues to the
// repository's remote.
//
// Why: the owner wants a repository to work in a plain terminal without the
// Airbender plugin (bead-bb-c9l.7), so setting it up cannot live in the
// plugin. The plugin's setup card draws this state and runs these steps
// (bead-bb-c9l.9), so a terminal and the tab never disagree.
//
// Design notes:
//   - Reading and changing are apart, the owner's rule: Read changes nothing;
//     each step in steps.go changes something.
//   - Every step is idempotent: a step whose work is done says so, writes
//     nothing and runs nothing.
//   - A state is "done", "missing" (can be done now), "blocked" (cannot yet;
//     Why says what comes first) or "not-needed" (does not apply here).
//   - What a step would run outside bend is given as text (Runs), so that
//     nothing ever runs unseen: a caller shows it before asking for a yes.
//   - Files are read and written at the repository's top folder (git's, or
//     the folder itself outside git). Beads' hooks are looked for in the
//     repository's main folder, not a work tree: Claude Code's hooks are in
//     a file git does not track, so a work tree never has them
//     (bead-bb-ak0).
//
// Gotchas:
//   - Read may take a second or two: it asks beads up to three things, and
//     where the issues are synced nowhere it asks the git remote too. A
//     caller that reads often should keep the answer for a while.
//   - Beads' own check for an agent's setup (`bd setup <agent> --check`)
//     answers for its whole integration: once its block is out of CLAUDE.md
//     it says "not installed" while the session-start hook is still there.
//     So the hooks are read from the files they are in.
package setup

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/beads"
	"github.com/mturilin/airbender/bend/internal/detect"
	"github.com/mturilin/airbender/bend/internal/facts"
	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/instructions"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// The states a step can be in.
const (
	Done      = "done"
	Missing   = "missing"
	Blocked   = "blocked"
	NotNeeded = "not-needed"
)

// The steps, by name, in the order they make sense.
const (
	StepTracker      = "tracker"
	StepProgram      = "program"
	StepIssues       = "issues"
	StepInstructions = "instructions"
	StepFacts        = "facts"
	StepPublish      = "publish"
)

// StepNames is every step in order.
var StepNames = []string{StepTracker, StepProgram, StepIssues, StepInstructions, StepFacts, StepPublish}

// Step is one setup step as it stands for a folder.
type Step struct {
	Name string `json:"name"`
	// Title names the step for a person, e.g. "Set up beads in this folder".
	Title string `json:"title"`
	// State is one of Done, Missing, Blocked, NotNeeded.
	State string `json:"state"`
	// Why says, in plain words, why the step is needed, or what it waits
	// for, or why it does not apply.
	Why string `json:"why"`
	// Command is the bend command that does the step; "" unless Missing.
	Command string `json:"command"`
	// Runs is the exact command the step would run outside bend; "" for a
	// step that only writes files, or whose command depends on a choice.
	Runs string `json:"runs"`
	// Explain says what the step will do, point by point. Text in backticks
	// is a command or a file name.
	Explain []string `json:"explain"`
}

// Method is one way of installing the beads program.
type Method struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Command is what it runs, through a shell.
	Command string `json:"command"`
	// needs is the program that must be there for it to be offered.
	needs string
}

// installMethods are the ways of installing beads, as in beads' own README;
// the mise one is how beads is installed on the owner's machine. Only those
// whose program is present are offered.
var installMethods = []Method{
	{"script", "Beads' install script", "curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash", "curl"},
	{"mise", "mise", "mise use -g github:gastownhall/beads", "mise"},
	{"brew", "Homebrew", "brew install beads", "brew"},
	{"npm", "npm", "npm install -g @beads/bd", "npm"},
}

// InstructionsState is what the instructions step would find.
type InstructionsState struct {
	// Rules is which of Airbender's rules AGENTS.md holds: current, old,
	// edited or none.
	Rules string `json:"rules"`
	// BeadsBlocks are the files that hold a block beads generated.
	BeadsBlocks []string `json:"beadsBlocks"`
	// BeadsHooks are the coding agents beads' hooks are installed for in
	// this repository, by name.
	BeadsHooks []string `json:"beadsHooks"`
	// MachineWide are the agents beads' hooks are installed for under the
	// owner's home folder: not the repository's, so only named.
	MachineWide []string `json:"machineWide"`
	// Leftovers are beads' sections without markers, named for the owner.
	Leftovers []string `json:"leftovers"`
}

// State is what is in place for a folder.
type State struct {
	// Root is the folder the instruction files are in.
	Root string `json:"root"`
	// Tracker is the tracker chosen, "beads" or "github"; nil when none is.
	Tracker *string `json:"tracker"`
	// Repository is "owner/name" for GitHub issues; nil otherwise.
	Repository *string `json:"repository"`
	// Ready says that no step is missing or blocked.
	Ready bool   `json:"ready"`
	Steps []Step `json:"steps"`
	// InstallMethods are the ways of installing beads this machine has the
	// tools for.
	InstallMethods []Method `json:"installMethods"`
	// IssuesHow says what the issues step would do with beads: "fetch"
	// where the remote already holds the issues, "init" where it does not;
	// "" when it does not apply.
	IssuesHow    string            `json:"issuesHow"`
	Instructions InstructionsState `json:"instructions"`
	// SavedFacts are the facts saved in beads that the facts file does not
	// hold and the owner has not looked at yet.
	SavedFacts []facts.Fact `json:"savedFacts"`

	// What the steps need and a caller does not: the beads program found,
	// the repository's main folder, and the agents with beads' hooks.
	bd    string
	home  string
	hooks []agent
}

// Step gives the step with a name; nil for an unknown name.
func (state *State) Step(name string) *Step {
	for index := range state.Steps {
		if state.Steps[index].Name == name {
			return &state.Steps[index]
		}
	}
	return nil
}

// FactsReviewed is the line at the top of a facts file that says the facts
// saved in beads were looked at, so they are not offered again. In the
// file, and not in a program's own storage, so that it holds on every
// computer the repository is used on. An HTML comment: agents and people
// reading the file as text see through it.
const FactsReviewed = "<!-- airbender: the facts saved in beads were reviewed -->"

// quiet runs a program and gives its standard output, trimmed; ok is false
// when it is missing, fails or takes too long. Nothing of it is shown.
func quiet(dir string, limit time.Duration, name string, args ...string) (output string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	// Never a question: a read must not put up git's or ssh's prompt for a
	// name or a password. Standard input is nothing, by default.
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if os.Getenv("GIT_SSH_COMMAND") == "" {
		command.Env = append(command.Env, "GIT_SSH_COMMAND=ssh -oBatchMode=yes")
	}
	out, err := command.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// textOf gives a file's text; "" when there is no such file or it cannot be
// read.
func textOf(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

// exists says whether a path is there.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// agent is a coding agent beads has a setup of its own for, with where its
// hooks are and the command beads puts there.
type agent struct {
	id    string
	label string
	files []string
	sign  *regexp.Regexp
}

// agents are the coding agents beads' hooks are looked for, and removed,
// by. The same places under the owner's home folder are where beads
// installs them for the whole computer (`bd setup <agent> --global`).
var agents = []agent{
	{"claude", "Claude Code", []string{".claude/settings.json", ".claude/settings.local.json"}, regexp.MustCompile(`\bbd prime\b`)},
	{"codex", "Codex", []string{".codex/hooks.json"}, regexp.MustCompile(`\bbd codex-hook\b`)},
}

// beadsHooksIn gives the coding agents beads' own hooks are installed for
// under a folder.
//
// Side effects: reads up to three small files.
func beadsHooksIn(home string) []agent {
	found := []agent{}
	for _, one := range agents {
		for _, file := range one.files {
			if one.sign.MatchString(textOf(filepath.Join(home, file))) {
				found = append(found, one)
				break
			}
		}
	}
	return found
}

// labels gives the names of some agents.
func labels(found []agent) []string {
	names := []string{}
	for _, one := range found {
		names = append(names, one.label)
	}
	return names
}

// SavedFactsFrom gives the facts saved in beads, from what `bd memories
// --json` printed: one object, key to text, with the schema's version
// beside them. None when the output is not that object. Pure.
func SavedFactsFrom(stdout string) []facts.Fact {
	found := []facts.Fact{}
	decoder := json.NewDecoder(strings.NewReader(stdout))
	if opening, err := decoder.Token(); err != nil || opening != json.Delim('{') {
		return found
	}
	// Read key by key, so that the facts keep the order beads gave them in.
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return []facts.Fact{}
		}
		var value any
		if decoder.Decode(&value) != nil {
			return []facts.Fact{}
		}
		if text, isText := value.(string); isText && key != "schema_version" {
			found = append(found, facts.Fact{Key: key.(string), Text: text})
		}
	}
	return found
}

// rootOf gives the folder a repository's instruction files are in: git's
// top folder for dir, or dir itself outside a git repository.
func rootOf(dir string) string {
	if top, ok := quiet(dir, 5*time.Second, "git", "rev-parse", "--show-toplevel"); ok && top != "" {
		return top
	}
	return dir
}

// mainFolderOf gives the repository's main folder: the one a work tree
// belongs to, or root itself.
func mainFolderOf(root string) string {
	// The main work tree is always listed first.
	listed, ok := quiet(root, 5*time.Second, "git", "worktree", "list", "--porcelain")
	if first := strings.Split(listed, "\n")[0]; ok && strings.HasPrefix(first, "worktree ") {
		return strings.TrimPrefix(first, "worktree ")
	}
	return root
}

// remoteState says where a beads repository's issues stand with a remote:
// "none", beads has no remote for them; "empty", it has one that nothing
// was ever sent to; "holds", the remote holds them; "unknown", it could not
// be told now.
func remoteState(root, bd string) string {
	listed, ok := quiet(root, 30*time.Second, bd, "dolt", "remote", "list", "--json")
	if !ok {
		return "unknown"
	}
	var remotes []struct {
		URL *string `json:"url"`
	}
	if json.Unmarshal([]byte(listed), &remotes) != nil {
		return "unknown"
	}
	if len(remotes) == 0 {
		return "none"
	}
	// Beads keeps the issues on a git remote under refs/dolt/data. A remote
	// that is not a git repository cannot be asked this way: taken as
	// holding.
	if remotes[0].URL == nil || !strings.HasPrefix(*remotes[0].URL, "git+") {
		return "holds"
	}
	answer, ok := quiet(root, 30*time.Second, "git", "ls-remote", strings.TrimPrefix(*remotes[0].URL, "git+"), "refs/dolt/data")
	switch {
	case !ok:
		return "unknown"
	case answer == "":
		return "empty"
	}
	return "holds"
}

// Options adjust how the state is read.
type Options struct {
	// BdCommand is the beads program, for a caller that has found it; else
	// it is looked for (beads.Find).
	BdCommand string
	// GitHubClient makes the connection to a GitHub repository; the real
	// one when nil. Replaced in tests.
	GitHubClient func(repository string) github.Client
}

// Read works out what is in place for a folder. It changes nothing.
//
// Fails with Refused when the folder does not exist or its setting file
// cannot be understood.
// Side effects: reads files; runs git and, for beads, bd (read-only); for
// GitHub issues asks GitHub one thing.
func Read(dir string, options Options) (*State, error) {
	start, err := filepath.Abs(dir)
	if err != nil || !exists(start) {
		return nil, tracker.Refused("The folder %s does not exist.", start)
	}
	root := rootOf(start)
	state := &State{
		Root:           root,
		InstallMethods: []Method{},
		Instructions:   InstructionsState{Rules: "none", BeadsBlocks: []string{}, BeadsHooks: []string{}, MachineWide: []string{}, Leftovers: []string{}},
		SavedFacts:     []facts.Fact{},
		home:           mainFolderOf(root),
		bd:             strings.TrimSpace(options.BdCommand),
	}
	if state.bd == "" {
		state.bd = beads.Find()
	}
	for _, method := range installMethods {
		if beads.ProgramExists(method.needs) {
			state.InstallMethods = append(state.InstallMethods, method)
		}
	}

	// --- Which tracker.
	chosen, repository, err := chosenTracker(root, state.home)
	if err != nil {
		return nil, err
	}
	step := Step{Name: StepTracker, Title: "Choose where the issues are kept", Explain: []string{}}
	if chosen == "" {
		step.State = Missing
		step.Why = "Nothing says yet where this repository's issues are kept: in beads, a database inside the repository, or in GitHub issues."
		step.Command = "bend setup tracker"
		step.Explain = []string{"Records the choice in `" + detect.SettingFile + "` at the repository's top folder, a small file to check in, so it is the same for everyone who clones it."}
	} else {
		step.State = Done
		step.Why = "This repository uses " + trackerWords(chosen) + "."
		state.Tracker = &chosen
		if repository != "" {
			state.Repository = &repository
		}
	}
	state.Steps = append(state.Steps, step)

	state.Steps = append(state.Steps, state.programStep(chosen))
	issues := state.issuesStep(chosen, repository, options)
	state.Steps = append(state.Steps, issues)
	issuesReady := issues.State == Done
	state.Steps = append(state.Steps, state.instructionsStep(chosen, issuesReady))
	state.Steps = append(state.Steps, state.factsStep(chosen, issuesReady))
	state.Steps = append(state.Steps, state.publishStep(chosen, issuesReady))

	state.Ready = true
	for _, one := range state.Steps {
		if one.State == Missing || one.State == Blocked {
			state.Ready = false
		}
	}
	return state, nil
}

// trackerWords names a tracker for a person.
func trackerWords(name string) string {
	if name == "github" {
		return "GitHub issues"
	}
	return name
}

// chosenTracker says which tracker a repository has chosen: what its
// setting file names, else beads where a beads folder is there (every
// repository set up before there was a setting file). "" when neither: a
// remote on GitHub alone is a guess, not a choice.
//
// repository is the GitHub repository, when the tracker is GitHub issues
// and it can be told.
func chosenTracker(root, home string) (name, repository string, err error) {
	setting, err := detect.ReadSetting(root)
	if err != nil {
		return "", "", err
	}
	if setting != nil && setting.Tracker != "" {
		if setting.Tracker == "github" {
			repository = setting.Repository
			if repository == "" {
				repository = detect.GithubRepositoryOf(root)
			}
		}
		return setting.Tracker, repository, nil
	}
	if exists(filepath.Join(root, ".beads")) || exists(filepath.Join(home, ".beads")) {
		return "beads", "", nil
	}
	return "", "", nil
}

// programStep is the step that installs the beads program.
func (state *State) programStep(chosen string) Step {
	step := Step{Name: StepProgram, Title: "Install beads", Explain: []string{}}
	switch {
	case chosen == "":
		step.State, step.Why = Blocked, "Choose the tracker first."
	case chosen != "beads":
		step.State, step.Why = NotNeeded, "GitHub issues need no program of their own."
	case state.bd != "":
		step.State, step.Why = Done, "The beads program is on this computer ("+state.bd+")."
	case len(state.InstallMethods) == 0:
		step.State = Blocked
		step.Why = "The beads program is not on this computer, and none of the tools that install it was found (curl, mise, Homebrew, npm). Install beads by hand: github.com/gastownhall/beads."
	default:
		step.State = Missing
		step.Why = "The beads program is not on this computer. Issues are read and changed with it."
		step.Command = "bend setup program"
		for _, method := range state.InstallMethods {
			step.Explain = append(step.Explain, method.Label+": `"+method.Command+"`")
		}
	}
	return step
}

// issuesStep is the step that prepares the issues.
func (state *State) issuesStep(chosen, repository string, options Options) Step {
	step := Step{Name: StepIssues, Title: "Set up beads in this folder", Explain: []string{}}
	if chosen == "github" {
		return state.githubIssuesStep(repository, options)
	}
	switch {
	case chosen == "":
		step.State, step.Why = Blocked, "Choose the tracker first."
		return step
	case state.bd == "":
		step.State, step.Why = Blocked, "Install beads first."
		return step
	}
	// "Set up" means what listing issues means by it: bd finds a database
	// from this folder upward.
	if _, ok := quiet(state.Root, 30*time.Second, state.bd, "--readonly", "list", "--json", "--limit", "1"); ok {
		step.State, step.Why = Done, "This folder has an issue database."
		return step
	}
	step.State = Missing
	step.Command = "bend setup issues"
	// Beads keeps a repository's issues on its git remote under
	// refs/dolt/data: if they are there, this is a fresh clone, and they
	// are to be fetched, not started anew beside them.
	if held, ok := quiet(state.Root, 30*time.Second, "git", "ls-remote", "origin", "refs/dolt/data"); ok && held != "" {
		state.IssuesHow = "fetch"
		step.Title = "Get this repository's issues"
		step.Why = "This folder has no issues yet, but the repository's remote holds them. Getting them brings this folder up to date with the other computers."
		step.Runs = state.bd + " bootstrap --yes"
		step.Explain = []string{
			"It downloads the issues that the repository's git remote holds into a database in this folder.",
			"Nothing is published, and no existing issue is deleted.",
		}
		return step
	}
	state.IssuesHow = "init"
	step.Why = "This folder has no issue database yet. Setting it up lets you track issues here."
	step.Runs = state.bd + " init --skip-agents"
	step.Explain = []string{
		"It adds a `.beads` folder with the issue database.",
		"It starts a git repository if the folder is not one yet.",
		"It writes no instructions for agents: those are a step of their own.",
	}
	return step
}

// githubIssuesStep is the issues step for a repository on GitHub issues:
// there is nothing to create, only a login and the repository to check.
func (state *State) githubIssuesStep(repository string, options Options) Step {
	step := Step{Name: StepIssues, Title: "Sign in to GitHub", Explain: []string{}}
	if repository == "" {
		step.State = Blocked
		step.Why = "Which GitHub repository cannot be told: the remote called origin is not on github.com. Name it: bend setup tracker --use github --repository owner/name."
		return step
	}
	makeClient := options.GitHubClient
	if makeClient == nil {
		makeClient = func(name string) github.Client { return github.NewClient(name, github.ClientOptions{}) }
	}
	has, err := makeClient(repository).HasIssues()
	switch {
	case err == nil && has:
		step.State, step.Why = Done, "Signed in, and "+repository+" has issues switched on."
	case err == nil:
		step.State = Blocked
		step.Why = repository + " has issues switched off. Switch them on in the repository's settings on GitHub."
	case tracker.KindOf(err) == tracker.KindNotSignedIn:
		step.State = Missing
		step.Why = "There is no GitHub login on this computer. Issues on GitHub are read and changed as you."
		step.Command = "bend setup issues"
		step.Runs = "gh auth login"
		step.Explain = []string{
			"It runs GitHub's own program, which asks how you want to sign in and opens a browser.",
			"Instead you can set a token yourself in the environment, as `GH_TOKEN`.",
		}
	default:
		step.State, step.Why = Blocked, err.Error()
	}
	return step
}

// instructionsStep is the step that writes Airbender's instructions and
// takes out what beads wrote.
func (state *State) instructionsStep(chosen string, issuesReady bool) Step {
	step := Step{Name: StepInstructions, Title: "Add Airbender's instructions for agents", Explain: []string{}}
	agentsText := textOf(filepath.Join(state.Root, instructions.AgentsFile))
	claudePath := filepath.Join(state.Root, instructions.ClaudeFile)
	claudeText, claudeThere := textOf(claudePath), exists(claudePath)
	state.hooks = beadsHooksIn(state.home)
	found := &state.Instructions
	found.Rules = instructions.RulesIn(agentsText)
	if instructions.HasBeadsBlocks(agentsText) {
		found.BeadsBlocks = append(found.BeadsBlocks, instructions.AgentsFile)
	}
	if claudeThere && instructions.HasBeadsBlocks(claudeText) {
		found.BeadsBlocks = append(found.BeadsBlocks, instructions.ClaudeFile)
	}
	found.BeadsHooks = labels(state.hooks)
	// Not the repository's, so not removed and not part of "done"; only
	// named. Not asked when the repository's main folder is the home folder
	// itself, where the two are the same files.
	if userHome, err := os.UserHomeDir(); err == nil && userHome != state.home {
		found.MachineWide = labels(beadsHooksIn(userHome))
	}
	found.Leftovers = instructions.BeadsLeftovers(instructions.WithoutBeadsBlocks(agentsText))
	replaces := len(found.BeadsBlocks) > 0 || len(found.BeadsHooks) > 0
	if replaces {
		step.Title = "Replace beads' instructions with Airbender's"
	}
	// Done when the rules are there (ours, or the owner's own version of
	// them), nothing of beads' that can be removed is left, and a
	// CLAUDE.md, where there is one, needs no change.
	_, claudeChange := instructions.ClaudeFileFor(claudeText, claudeThere)
	switch {
	case (found.Rules == "current" || found.Rules == "edited") && !replaces && !claudeChange:
		step.State, step.Why = Done, "Airbender's instructions are in place."
	case !issuesReady:
		step.State, step.Why = Blocked, "Prepare the issues first."
		if chosen == "" {
			step.Why = "Choose the tracker first."
		}
	default:
		step.State = Missing
		step.Command = "bend setup instructions"
		step.Why = "The rules agents work by here: they take an issue one step at a time, leave closing to you, and commit when you accept it."
		if replaces {
			step.Why = "Beads wrote instructions of its own into this folder. They tell agents to close issues themselves, which is the opposite of how the workflow goes. This takes them out and leaves Airbender's."
		}
		switch found.Rules {
		case "none":
			step.Explain = append(step.Explain, "Adds Airbender's rules at the end of `AGENTS.md` (the file is created if there is none).")
		case "old":
			step.Explain = append(step.Explain, "Replaces the earlier version of Airbender's rules in `AGENTS.md` where it stands.")
		case "edited":
			step.Explain = append(step.Explain, "Leaves the rules block in `AGENTS.md` as it is: it was changed by hand and is yours.")
		}
		for _, file := range found.BeadsBlocks {
			step.Explain = append(step.Explain, "Takes beads' generated block out of `"+file+"`; nothing else in the file changes.")
		}
		for _, one := range state.hooks {
			step.Explain = append(step.Explain, "Removes beads' hook for "+one.label+" with beads' own command: `bd setup "+one.id+" --remove`.")
		}
		if claudeChange {
			step.Explain = append(step.Explain, "Makes `CLAUDE.md` point at `AGENTS.md` and `"+instructions.FactsFile+"`.")
		}
		step.Explain = append(step.Explain, "Makes sure `"+instructions.FactsFile+"` is there, for standing facts.")
		for _, name := range found.Leftovers {
			step.Explain = append(step.Explain, "Leaves beads' section without markers (\""+name+"\") in `AGENTS.md`: it cannot be told safely from your own text. Remove it by hand if you wish.")
		}
	}
	return step
}

// factsStep is the step that carries facts saved in beads over to the
// facts file.
func (state *State) factsStep(chosen string, issuesReady bool) Step {
	step := Step{Name: StepFacts, Title: "Carry saved facts over", Explain: []string{}}
	switch {
	case chosen != "beads" && chosen != "":
		step.State, step.Why = NotNeeded, "Only beads keeps facts of its own."
		return step
	case !issuesReady:
		// Nothing can be saved in a database that is not there.
		step.State, step.Why = NotNeeded, "There is no issue database to hold saved facts."
		return step
	case strings.Contains(textOf(filepath.Join(state.Root, instructions.FactsFile)), FactsReviewed):
		step.State, step.Why = Done, "The facts saved in beads were looked at."
		return step
	}
	listed, ok := quiet(state.Root, 30*time.Second, state.bd, "--readonly", "memories", "--json")
	held := map[string]bool{}
	if kept, err := facts.Recall(state.Root, nil); err == nil {
		for _, fact := range kept {
			held[fact.Key] = true
		}
	}
	if ok {
		for _, fact := range SavedFactsFrom(listed) {
			if !held[fact.Key] {
				state.SavedFacts = append(state.SavedFacts, fact)
			}
		}
	}
	if len(state.SavedFacts) == 0 {
		step.State, step.Why = NotNeeded, "Beads holds no saved facts that the facts file lacks."
		return step
	}
	step.State = Missing
	step.Command = "bend setup facts"
	step.Why = "Beads holds facts saved with `bd remember`, which agents no longer see at the start of a session. Choose which go into `" + instructions.FactsFile + "`, the file agents read standing facts from now."
	for _, fact := range state.SavedFacts {
		step.Explain = append(step.Explain, fact.Key+": "+fact.Text)
	}
	return step
}

// publishStep is the step that publishes the issue database to the
// repository's remote for the first time.
func (state *State) publishStep(chosen string, issuesReady bool) Step {
	step := Step{Name: StepPublish, Title: "Sync issues to the repository's remote", Explain: []string{}}
	switch {
	case chosen != "beads" && chosen != "":
		step.State, step.Why = NotNeeded, "Issues on GitHub are already kept there."
		return step
	case !issuesReady:
		step.State, step.Why = Blocked, "Prepare the issues first."
		if chosen == "" {
			step.Why = "Choose the tracker first."
		}
		return step
	}
	// Offered where the issues are synced nowhere: no remote, or one
	// nothing was ever sent to. Not when it cannot be told, and not where
	// the repository has no remote to publish to.
	where := remoteState(state.Root, state.bd)
	if _, hasOrigin := quiet(state.Root, 5*time.Second, "git", "remote", "get-url", "origin"); where == "none" && !hasOrigin {
		step.State = NotNeeded
		step.Why = "The repository has no remote called origin, so there is nowhere to publish the issues: they are on this computer only. Add a remote (git remote add origin <address>) and this step is offered."
		return step
	}
	switch where {
	case "holds":
		step.State, step.Why = Done, "The repository's remote holds the issues."
	case "unknown":
		step.State, step.Why = NotNeeded, "Whether the issues are on a remote could not be told now."
	default:
		step.State = Missing
		step.Command = "bend setup publish"
		step.Why = "This folder's issues are on this computer only: they are not in git and are synced nowhere. Syncing keeps a copy on the repository's remote and lets other computers get them."
		// Push first: a sync pulls first, and fails on a remote that has
		// nothing on it yet.
		step.Runs = state.bd + " dolt push --yes && " + state.bd + " sync"
		step.Explain = []string{
			"It publishes this folder's whole issue history (every issue, with its text, comments and history) to the repository's git remote, where anyone who can read the repository can read it. It is kept apart from your branches.",
			"Beads records the remote in `.beads/config.yaml` and makes a small git commit for that by itself. Pushing that commit is yours.",
			"From then on the issues can be kept in sync: the Airbender tab does it every few minutes, and a little after they change.",
		}
	}
	return step
}
