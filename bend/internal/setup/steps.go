// steps.go — carrying the setup steps out.
//
// What: one function per step (see state.go for what the steps are), and
// All, which runs the missing ones in order.
//
// Why: see the package comment.
//
// Design notes:
//   - Every step begins the same way: read the state; if the step is done,
//     say so and change nothing; if it is blocked or not needed, refuse with
//     the reason; else collect its answers and act.
//   - Answers come from the options first. One that is missing is asked for
//     when someone is at the keyboard; when nobody is, the step changes
//     nothing and fails at once as a wrong request, naming the option that
//     gives the answer. It never waits (the owner's rule).
//   - A yes-or-no question is answered by Yes (-y); a choice has an option of
//     its own. Before a yes is asked for, what will happen is shown,
//     including the exact outside command.
//   - Outside commands (an installer, bd, gh) run attached to the terminal,
//     so their output and their own questions are seen.

package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/mturilin/airbender/bend/internal/beads"
	"github.com/mturilin/airbender/bend/internal/detect"
	"github.com/mturilin/airbender/bend/internal/facts"
	"github.com/mturilin/airbender/bend/internal/instructions"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// Terminal is how a step talks to whoever runs it.
type Terminal struct {
	// Interactive says that someone is at the keyboard and may be asked.
	Interactive bool
	// Ask prints a question and reads one line of answer. Only called when
	// Interactive.
	Ask func(question string) string
	// Say prints a line for the person to read. It is not the answer of the
	// command: it goes where a program reading the answer does not look.
	Say func(text string)
	// Run runs an outside command in a folder, attached to the terminal,
	// and gives its exit status; -1 when it could not be started. The
	// caller that builds a Terminal sees to it that the command can read
	// the keyboard only when Interactive: otherwise a question of its own
	// would wait for an answer nobody gives.
	Run func(dir, name string, args ...string) int
}

// Answers are the answers a caller gives in advance, as options.
type Answers struct {
	// Yes answers every "go ahead?" with yes (-y).
	Yes bool
	// Use is the tracker to choose: "beads" or "github" (--use).
	Use string
	// Repository is the GitHub repository, "owner/name" (--repository).
	Repository string
	// Method is the id of the way to install beads (--method).
	Method string
	// Keep are the keys of the saved facts to carry over (--keep); KeepAll
	// and KeepNone choose all of them or none.
	Keep     []string
	KeepAll  bool
	KeepNone bool
}

// Outcome is what a step did.
type Outcome struct {
	Step string `json:"step"`
	// Changed is false when the step found its work already done.
	Changed bool `json:"changed"`
	// Message says what was done, or that nothing needed doing.
	Message string `json:"message"`
}

// missingAnswer is the failure of a step that needs an answer nobody is
// there to give.
func missingAnswer(what, option string) error {
	return tracker.Usage("%s Nobody is at the keyboard to ask, so say it with %s.", what, option)
}

// begin reads the state and settles the cases every step shares.
//
// Returns the state and the step when there is work to do; an outcome when
// the step is already done; an error when it cannot be done now.
func begin(dir, name string, options Options) (*State, *Step, *Outcome, error) {
	state, err := Read(dir, options)
	if err != nil {
		return nil, nil, nil, err
	}
	step := state.Step(name)
	switch step.State {
	case Done:
		return state, step, &Outcome{Step: name, Message: "Already done: " + step.Why}, nil
	case NotNeeded:
		return state, step, &Outcome{Step: name, Message: "Not needed: " + step.Why}, nil
	case Blocked:
		return nil, nil, nil, tracker.Refused("%s", step.Why)
	}
	return state, step, nil, nil
}

// confirm shows what a step will do and gets a yes for it.
//
// Fails as a wrong request when nobody is at the keyboard and Yes was not
// given; as a refusal when the person says no.
func confirm(terminal Terminal, answers Answers, step *Step) error {
	if answers.Yes {
		return nil
	}
	if !terminal.Interactive {
		return missingAnswer("\""+step.Title+"\" changes things and needs a yes.", "-y")
	}
	terminal.Say(step.Title + ". " + step.Why)
	for _, point := range step.Explain {
		terminal.Say("  - " + point)
	}
	if step.Runs != "" {
		terminal.Say("It runs: " + step.Runs)
	}
	answer := strings.ToLower(strings.TrimSpace(terminal.Ask("Go ahead? [y/N] ")))
	if answer != "y" && answer != "yes" {
		return tracker.Refused("Not done: you did not say yes.")
	}
	return nil
}

// ran turns the exit status of an outside command into an error, or nil.
func ran(status int, what string) error {
	switch {
	case status == 0:
		return nil
	case status < 0:
		return tracker.Refused("%s could not be started.", what)
	}
	return tracker.Refused("%s did not finish (exit status %d). What it printed is above.", what, status)
}

// Tracker records which tracker the repository uses.
//
// Side effects: writes .bend.json at the repository's top folder.
func Tracker(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, err := Read(dir, options)
	if err != nil {
		return nil, err
	}
	use := strings.TrimSpace(answers.Use)
	current := ""
	if state.Tracker != nil {
		current = *state.Tracker
	}
	if use == "" {
		if current != "" {
			return &Outcome{Step: StepTracker, Message: "Already done: this repository uses " + trackerWords(current) + "."}, nil
		}
		if !terminal.Interactive {
			return nil, missingAnswer("Which tracker?", "--use beads or --use github")
		}
		terminal.Say("Where are this repository's issues kept?")
		terminal.Say("  1. beads: a database inside the repository, worked with the bd program")
		terminal.Say("  2. github: GitHub issues, on the repository's page on github.com")
		switch strings.ToLower(strings.TrimSpace(terminal.Ask("Which? [1/2] "))) {
		case "1", "beads":
			use = "beads"
		case "2", "github":
			use = "github"
		default:
			return nil, tracker.Refused("Not done: that is neither of the two.")
		}
	}
	if !slices.Contains(detect.TrackerNames, use) {
		return nil, tracker.Usage("Unknown tracker \"%s\". Use one of: %s.", use, strings.Join(detect.TrackerNames, ", "))
	}
	repository := strings.TrimSpace(answers.Repository)
	if repository != "" && use != "github" {
		return nil, tracker.Usage("--repository goes with --use github.")
	}
	// What the file says now, to keep what this step does not decide and to
	// tell "already so" from a change.
	path := filepath.Join(state.Root, detect.SettingFile)
	setting, err := detect.ReadSetting(state.Root)
	if err != nil {
		return nil, err
	}
	if setting == nil {
		setting = &detect.Setting{}
	}
	if repository == "" {
		repository = setting.Repository
	}
	if use == "github" && repository == "" && detect.GithubRepositoryOf(state.Root) == "" {
		if !terminal.Interactive {
			return nil, missingAnswer("Which GitHub repository? The remote called origin is not on github.com.", "--repository owner/name")
		}
		repository = strings.TrimSpace(terminal.Ask("Which GitHub repository (owner/name)? "))
	}
	// Checked before anything is written: a setting that cannot be read
	// back would stop every later step, this one included.
	if repository != "" && !detect.ValidRepository(repository) {
		return nil, tracker.Usage("\"%s\" is not a repository. Write it as owner/name.", repository)
	}
	if use == "github" && repository == "" && detect.GithubRepositoryOf(state.Root) == "" {
		return nil, tracker.Refused("Not done: no repository was named.")
	}
	if setting.Tracker == use && setting.Repository == repository {
		return &Outcome{Step: StepTracker, Message: "Already done: this repository uses " + trackerWords(use) + "."}, nil
	}
	if err := detect.WriteSetting(state.Root, detect.Setting{Tracker: use, Repository: repository}); err != nil {
		return nil, err
	}
	return &Outcome{Step: StepTracker, Changed: true,
		Message: "This repository now uses " + trackerWords(use) + " (recorded in " + path + "; check that file in)."}, nil
}

// Program installs the beads program.
//
// Side effects: runs the chosen installer through a shell, attached to the
// terminal; what it installs is the installer's doing.
func Program(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepProgram, options)
	if done != nil || err != nil {
		return done, err
	}
	var method *Method
	ids := []string{}
	for index := range state.InstallMethods {
		ids = append(ids, state.InstallMethods[index].ID)
		if state.InstallMethods[index].ID == answers.Method {
			method = &state.InstallMethods[index]
		}
	}
	switch {
	case method != nil:
	case answers.Method != "":
		return nil, tracker.Usage("\"%s\" is not a way of installing beads that this computer has the tools for. There are: %s.", answers.Method, strings.Join(ids, ", "))
	case !terminal.Interactive:
		return nil, missingAnswer("Which way of installing beads?", "--method "+strings.Join(ids, " | "))
	default:
		terminal.Say(step.Why + " Choose how to install it:")
		for index, one := range state.InstallMethods {
			terminal.Say("  " + strconv.Itoa(index+1) + ". " + one.Label + ": " + one.Command)
		}
		typed := strings.TrimSpace(terminal.Ask("Which? [1-" + strconv.Itoa(len(ids)) + "] "))
		number, err := strconv.Atoi(typed)
		if at := slices.Index(ids, typed); at != -1 {
			number, err = at+1, nil
		}
		if err != nil || number < 1 || number > len(ids) {
			return nil, tracker.Refused("Not done: that is none of them.")
		}
		method = &state.InstallMethods[number-1]
	}
	chosen := *step
	chosen.Explain = nil
	chosen.Runs = method.Command
	if err := confirm(terminal, answers, &chosen); err != nil {
		return nil, err
	}
	if err := ran(terminal.Run(state.Root, "sh", "-c", method.Command), "The installer"); err != nil {
		return nil, err
	}
	if beads.Find() == "" {
		return nil, tracker.Refused("The installer finished, but the beads program (bd) is still not found on the PATH or in the usual folders. Open a new terminal, or say where it is with BEND_BD.")
	}
	return &Outcome{Step: StepProgram, Changed: true, Message: "Beads is installed (" + beads.Find() + ")."}, nil
}

// Issues prepares the issues: with beads it gets them where the remote
// holds them and starts a database where it does not; with GitHub issues it
// signs in.
//
// Side effects: runs bd or gh attached to the terminal.
func Issues(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepIssues, options)
	if done != nil || err != nil {
		return done, err
	}
	if state.Tracker != nil && *state.Tracker == "github" {
		// Signing in is a conversation with GitHub's own program; without a
		// keyboard there is nobody to have it.
		if !terminal.Interactive {
			return nil, tracker.Failed(tracker.KindNotSignedIn,
				"There is no GitHub login on this computer. Sign in at a terminal with `gh auth login`, or set GH_TOKEN.")
		}
		if err := confirm(terminal, answers, step); err != nil {
			return nil, err
		}
		if err := ran(terminal.Run(state.Root, "gh", "auth", "login"), "gh auth login"); err != nil {
			return nil, err
		}
		return &Outcome{Step: StepIssues, Changed: true, Message: "Signed in to GitHub."}, nil
	}
	if err := confirm(terminal, answers, step); err != nil {
		return nil, err
	}
	if state.IssuesHow == "fetch" {
		if err := ran(terminal.Run(state.Root, state.bd, "bootstrap", "--yes"), "Getting the issues"); err != nil {
			return nil, err
		}
		return &Outcome{Step: StepIssues, Changed: true, Message: "The repository's issues are in this folder now."}, nil
	}
	args := []string{"init", "--skip-agents"}
	if !terminal.Interactive {
		// bd init asks questions of its own; without a keyboard it must not.
		args = append(args, "--non-interactive")
	}
	if err := ran(terminal.Run(state.Root, state.bd, args...), "Setting up beads"); err != nil {
		return nil, err
	}
	return &Outcome{Step: StepIssues, Changed: true, Message: "This folder has an issue database now."}, nil
}

// writeFile replaces a file's content, as a refusal in plain words when it
// cannot be written.
func writeFile(path, text string) error {
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return tracker.Refused("%s could not be written: %s", path, err)
	}
	return nil
}

// Instructions writes Airbender's rules into AGENTS.md, makes an existing
// CLAUDE.md point at it and at the facts file, makes sure the facts file is
// there, and takes out what beads wrote: its marked blocks, and its hooks
// with beads' own command.
//
// Side effects: writes AGENTS.md, CLAUDE.md and FACTS.md at the
// repository's top folder; runs `bd setup <agent> --remove` in its main
// folder for each agent that has beads' hooks.
func Instructions(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepInstructions, options)
	if done != nil || err != nil {
		return done, err
	}
	if err := confirm(terminal, answers, step); err != nil {
		return nil, err
	}
	// Facts an earlier version kept in a section of AGENTS.md go to the
	// facts file first, so that the file is rewritten once more below with
	// that section already out.
	if _, err := facts.MoveOld(state.Root); err != nil {
		return nil, err
	}
	agentsPath := filepath.Join(state.Root, instructions.AgentsFile)
	existing := textOf(agentsPath)
	// Beads' marked blocks out, then Airbender's rules in: added at the
	// end, or an earlier version of ours replaced where it stands. A rules
	// block the owner edited is left as it is.
	if next := instructions.AgentsFileWith(instructions.WithoutBeadsBlocks(existing), trackerOf(state)); next != existing {
		if err := writeFile(agentsPath, next); err != nil {
			return nil, err
		}
	}
	// The rules, and a CLAUDE.md, point at the facts file.
	if _, err := facts.EnsureFile(state.Root); err != nil {
		return nil, err
	}
	claudePath := filepath.Join(state.Root, instructions.ClaudeFile)
	if next, change := instructions.ClaudeFileFor(textOf(claudePath), exists(claudePath)); change {
		if err := writeFile(claudePath, next); err != nil {
			return nil, err
		}
	}
	// Beads' hooks, with beads' own way of removing them. After the files,
	// so that a failure here leaves the instructions right.
	for _, one := range state.hooks {
		status := -1
		if state.bd != "" {
			status = terminal.Run(state.home, state.bd, "setup", one.id, "--remove")
		}
		// Believed only when the hook is really gone from its file.
		for _, left := range beadsHooksIn(state.home) {
			if left.id != one.id {
				continue
			}
			reason := "beads' own removal left it in place."
			if state.bd == "" {
				reason = "the beads program, which removes it, was not found."
			} else if status != 0 {
				reason = "beads' own removal failed; what it printed is above."
			}
			return nil, tracker.Refused("The instructions are written, but beads' hook for %s is still there: %s", one.label, reason)
		}
	}
	message := "Airbender's instructions are in place."
	if len(state.Instructions.Leftovers) > 0 {
		message += " Beads' sections without markers were left in AGENTS.md for you to remove by hand: " +
			strings.Join(state.Instructions.Leftovers, ", ") + "."
	}
	if len(state.Instructions.MachineWide) > 0 {
		message += " Beads' hooks installed for this whole computer were not touched: " +
			strings.Join(state.Instructions.MachineWide, ", ") + "."
	}
	return &Outcome{Step: StepInstructions, Changed: true, Message: message}, nil
}

// Facts carries facts saved in beads over to the facts file, and records
// that they were looked at, so that they are not offered again.
//
// Side effects: writes FACTS.md at the repository's top folder.
func Facts(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepFacts, options)
	if done != nil || err != nil {
		return done, err
	}
	offered := map[string]bool{}
	for _, fact := range state.SavedFacts {
		offered[fact.Key] = true
	}
	keep := map[string]bool{}
	choose := func(keys []string) error {
		for _, key := range keys {
			if key = strings.TrimSpace(key); key == "" {
				continue
			}
			if !offered[key] {
				return tracker.Usage("\"%s\" is not one of the saved facts on offer.", key)
			}
			keep[key] = true
		}
		return nil
	}
	switch {
	case answers.KeepAll && (answers.KeepNone || len(answers.Keep) > 0), answers.KeepNone && len(answers.Keep) > 0:
		return nil, tracker.Usage("Give one of --keep-all, --keep-none, or --keep <key>.")
	case answers.KeepAll:
		keep = offered
	case answers.KeepNone:
	case len(answers.Keep) > 0:
		if err := choose(answers.Keep); err != nil {
			return nil, err
		}
	case !terminal.Interactive:
		return nil, missingAnswer("Which saved facts to carry over?", "--keep <key> (repeatable), --keep-all or --keep-none")
	default:
		terminal.Say(step.Why)
		for _, fact := range state.SavedFacts {
			terminal.Say("  " + fact.Key + ": " + fact.Text)
		}
		typed := strings.TrimSpace(terminal.Ask("Which to keep? [all / none / keys separated by commas] "))
		switch strings.ToLower(typed) {
		case "all":
			keep = offered
		case "none":
		case "":
			return nil, tracker.Refused("Not done: nothing was chosen.")
		default:
			if err := choose(strings.Split(typed, ",")); err != nil {
				return nil, err
			}
		}
	}
	chosen := []facts.Fact{}
	for _, fact := range state.SavedFacts {
		if keep[fact.Key] {
			chosen = append(chosen, fact)
		}
	}
	if _, _, err := facts.Add(state.Root, chosen); err != nil {
		return nil, err
	}
	if _, err := facts.EnsureFile(state.Root); err != nil {
		return nil, err
	}
	// Looked at, whatever was chosen: not offered again.
	path := filepath.Join(state.Root, instructions.FactsFile)
	if text := textOf(path); !strings.Contains(text, FactsReviewed) {
		if err := writeFile(path, FactsReviewed+"\n"+text); err != nil {
			return nil, err
		}
	}
	return &Outcome{Step: StepFacts, Changed: true,
		Message: strconv.Itoa(len(chosen)) + " of " + strconv.Itoa(len(state.SavedFacts)) + " saved facts carried over to " + instructions.FactsFile + "."}, nil
}

// Publish publishes the issue database to the repository's remote for the
// first time.
//
// Side effects: runs `bd dolt push --yes` and `bd sync` attached to the
// terminal: the whole issue history leaves this machine.
func Publish(dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	state, step, done, err := begin(dir, StepPublish, options)
	if done != nil || err != nil {
		return done, err
	}
	if err := confirm(terminal, answers, step); err != nil {
		return nil, err
	}
	// Push first: a sync pulls first, and fails on a remote that has
	// nothing on it yet.
	if err := ran(terminal.Run(state.Root, state.bd, "dolt", "push", "--yes"), "Publishing the issues"); err != nil {
		return nil, err
	}
	if err := ran(terminal.Run(state.Root, state.bd, "sync"), "Syncing the issues"); err != nil {
		return nil, err
	}
	// Believed only when the remote really holds them: beads ends without
	// an error where it found nothing to publish to.
	// "Could not be told" (the remote not reached just now) is not a no.
	if where := remoteState(state.Root, state.bd); where == "none" || where == "empty" {
		return nil, tracker.Refused("Beads ran, but the issues are still not on the repository's remote. What it printed is above.")
	}
	return &Outcome{Step: StepPublish, Changed: true, Message: "The issues are on the repository's remote."}, nil
}

// run is every step by its name.
var run = map[string]func(string, Terminal, Answers, Options) (*Outcome, error){
	StepTracker:      Tracker,
	StepProgram:      Program,
	StepIssues:       Issues,
	StepInstructions: Instructions,
	StepFacts:        Facts,
	StepPublish:      Publish,
}

// Run carries out one step by name.
func Run(name, dir string, terminal Terminal, answers Answers, options Options) (*Outcome, error) {
	step, known := run[name]
	if !known {
		return nil, tracker.Usage("Unknown setup step \"%s\". There are: %s.", name, strings.Join(StepNames, ", "))
	}
	return step(dir, terminal, answers, options)
}

// All runs every step that is missing, in order, each exactly as it runs
// by itself. It stops at the first that fails.
//
// Returns what each step that was looked at did, also when it stops early.
func All(dir string, terminal Terminal, answers Answers, options Options) ([]Outcome, error) {
	outcomes := []Outcome{}
	for _, name := range StepNames {
		// Read anew before each: a step changes what the next ones find.
		state, err := Read(dir, options)
		if err != nil {
			return outcomes, err
		}
		if state.Step(name).State != Missing {
			continue
		}
		outcome, err := run[name](dir, terminal, answers, options)
		if err != nil {
			return outcomes, err
		}
		outcomes = append(outcomes, *outcome)
		if terminal.Say != nil {
			terminal.Say(outcome.Message)
		}
	}
	// Not "everything is done" while a step waits for something outside
	// this program (a tool to install with, a repository that cannot be
	// told): said, with the reason, as a failure.
	state, err := Read(dir, options)
	if err != nil {
		return outcomes, err
	}
	waiting := []string{}
	for _, step := range state.Steps {
		if step.State == Blocked {
			waiting = append(waiting, step.Name+": "+step.Why)
		}
	}
	if len(waiting) > 0 {
		// The first is the cause; the ones after it only wait for it.
		return outcomes, tracker.Refused("Not everything could be done. %s", waiting[0])
	}
	return outcomes, nil
}

// MarshalJSON keeps a method's JSON to what a caller draws.
func (method Method) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		Command string `json:"command"`
	}{method.ID, method.Label, method.Command})
}

// trackerOf gives the name of the tracker a repository uses, "" when
// none is chosen yet: what decides which wording of the rules it gets.
func trackerOf(state *State) string {
	if state.Tracker == nil {
		return ""
	}
	return *state.Tracker
}
