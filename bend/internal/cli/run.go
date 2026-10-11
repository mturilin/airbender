// Package cli is the bend command.
//
// What: reads a command line, finds the repository's tracker, carries out
// one command through it, prints the answer as text or JSON, and gives the
// exit status.
//
// Why: this is the door agents, and the Airbender tab, use to read and
// change issues without knowing which tracker holds them. It is
// deliberately thin: what an operation means is decided in the adapters,
// and this package only connects words on a command line to them.
//
// Design notes:
//   - Run takes its surroundings (where to print, how to read standard
//     input, the starting folder) as an argument, so the whole command can be
//     exercised in tests without a real process.
//   - Exit status: 0 done; 1 refused, with the reason in plain words; 2 usage
//     error; 3 not supported by this repository's tracker.
//   - With --json a failure is printed on standard output as
//     {"ok": false, "status", "kind", "error"}. The kind tells a program
//     which of the expected problems it is (the tracker's program is missing,
//     the folder has no tracker, there is no login, ...), so it can offer the
//     way out of each without reading the words.
//   - `decide` and `handover` are comments underneath, with a fixed opening
//     so they can be found later. They are their own commands so that an
//     agent's rules read as actions and so a hand-over cannot leave out what
//     was not checked.
//   - Changing commands print one line saying what was done; with --json
//     they print {"ok": true, ...}.
//   - JSON is printed with two spaces of indentation and the keys in a fixed
//     order (the order of the struct fields, and of `fields` below), because
//     programs and recorded test output compare it as text.

package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/mturilin/airbender/bend/internal/detect"
	"github.com/mturilin/airbender/bend/internal/facts"
	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/kept"
	"github.com/mturilin/airbender/bend/internal/setup"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// Surroundings is what the command needs from the process around it.
type Surroundings struct {
	// Out prints a line of the answer.
	Out func(text string)
	// Err prints a line about a problem.
	Err func(text string)
	// Stdin reads all of standard input.
	Stdin func() string
	// Cwd is the folder the command was started in.
	Cwd string
	// Interactive says that someone is at the keyboard and may be asked a
	// question. Only the setup steps ask.
	Interactive bool
	// Ask prints a question and reads one line of answer from the keyboard.
	// Only called when Interactive.
	Ask func(question string) string
	// Attach runs an outside command in a folder with the terminal handed
	// to it, so its output and its own questions are seen, and gives its
	// exit status; -1 when it could not be started. What the command prints
	// must not land in bend's own answer (see cmd/bend).
	// keyboard says whether the command may read the keyboard; when false
	// its standard input is nothing, so a question of its own ends at once
	// instead of waiting.
	Attach func(dir string, keyboard bool, name string, args ...string) int
	// Detect finds the tracker; detect.Tracker when nil. Replaced in tests.
	Detect func(dir string, options detect.Options) (detect.Found, error)
}

// field is one key of a JSON object with its value.
type field struct {
	key   string
	value any
}

// fields is a JSON object whose keys are printed in the order given.
type fields []field

// MarshalJSON writes the object with its keys in order.
func (object fields) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for index, entry := range object {
		if index > 0 {
			out.WriteByte(',')
		}
		key, err := encode(entry.key, "")
		if err != nil {
			return nil, err
		}
		value, err := encode(entry.value, "")
		if err != nil {
			return nil, err
		}
		out.WriteString(key + ":" + value)
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// encode gives a value as JSON text, with the given indentation ("" for one
// line) and without turning <, > and & into escapes: the output is read by
// programs and people, not put into a web page.
func encode(value any, indent string) (string, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", indent)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(out.String(), "\n"), nil
}

// answer is what a command gives back: text for a reader and a value to
// print as JSON with --json.
type answer struct {
	text string
	json any
}

// did is the answer of a command that changed something.
func did(text string, extra ...field) answer {
	return answer{text: text, json: append(fields{{"ok", true}}, extra...)}
}

// leadingValueOptions are the options that take a value and may come before
// the command's name.
var leadingValueOptions = []string{"-C", "--dir", "--as", "--text-file"}

// splitCommand splits a command line into the command's name and everything
// else. Options may come before the name (`bend -C path list`). name is ""
// when there is none.
func splitCommand(argv []string) (name string, rest []string) {
	for at := 0; at < len(argv); at++ {
		word := argv[at]
		if slices.Contains(leadingValueOptions, word) {
			at++
			continue
		}
		if strings.HasPrefix(word, "-") {
			continue
		}
		return word, append(slices.Clone(argv[:at]), argv[at+1:]...)
	}
	return "", slices.Clone(argv)
}

// need gives the positional at index, or a usage error naming what is
// missing.
func need(parsed *Parsed, index int, what string) (string, error) {
	if index >= len(parsed.Positionals) || strings.TrimSpace(parsed.Positionals[index]) == "" {
		return "", tracker.Usage("Missing %s.", what)
	}
	return parsed.Positionals[index], nil
}

// readInput gives the content of a file named on the command line; "-" is
// standard input.
func readInput(file string, surroundings Surroundings) (string, error) {
	if file == "-" {
		return surroundings.Stdin(), nil
	}
	content, err := os.ReadFile(file)
	if err != nil {
		return "", tracker.Refused("The file %s could not be read.", file)
	}
	return string(content), nil
}

// textOf gives the free text of a command: the words after from, or the
// content of --text-file ("-" for standard input).
//
// allowEmpty is true where an empty text means something (clearing a part);
// otherwise an empty text is a usage error.
func textOf(parsed *Parsed, from int, surroundings Surroundings, allowEmpty bool) (string, error) {
	var words []string
	if from < len(parsed.Positionals) {
		words = parsed.Positionals[from:]
	}
	file := parsed.value("text-file")
	if file != nil && len(words) > 0 {
		return "", tracker.Usage("Give the text as an argument or with --text-file, not both.")
	}
	var text string
	if file == nil {
		if len(words) == 0 {
			return "", tracker.Usage("Missing the text (as an argument, or with --text-file).")
		}
		text = strings.Join(words, " ")
	} else {
		var err error
		if text, err = readInput(*file, surroundings); err != nil {
			return "", err
		}
	}
	if !allowEmpty && strings.TrimSpace(text) == "" {
		return "", tracker.Usage("The text is empty.")
	}
	return text, nil
}

// oneOf gives typed when it is one of allowed, or a usage error listing
// them.
func oneOf(typed string, allowed []string, what string) (string, error) {
	if slices.Contains(allowed, typed) {
		return typed, nil
	}
	return "", tracker.Usage("Unknown %s \"%s\". Use one of: %s.", what, typed, strings.Join(allowed, ", "))
}

// Version counts the changes to what bend offers a program: its commands,
// options and JSON. A program that runs bend (the Airbender tab) asks for it
// first and says so plainly when the bend it found is older than it needs,
// instead of failing on an option that bend does not know. Raise it with
// every such change.
const Version = 4

// statusWithCopy is what `bend status --json` prints: what the tracker
// supports, and how the copy on this machine stands; null where the tracker
// is not worked from one.
type statusWithCopy struct {
	tracker.Capabilities
	Copy *kept.Status `json:"copy"`
}

// AcceptVariable names the environment variable by which a caller says
// which trackers it can work with, separated by commas, e.g. "beads". A
// tracker not named is passed over as if it were not there. The Airbender
// tab sets it: it reads the whole list on every reload, which a hosted
// tracker is too slow for until issues are kept in a local copy
// (bead-bb-c9l.6).
const AcceptVariable = "BEND_ACCEPT"

// acceptedTrackers reads AcceptVariable; nil when it is not set, which
// accepts every tracker.
func acceptedTrackers() ([]string, error) {
	var accept []string
	for _, name := range strings.Split(os.Getenv(AcceptVariable), ",") {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		if !slices.Contains(detect.TrackerNames, name) {
			return nil, tracker.Usage("%s names the tracker \"%s\". It can be: %s.",
				AcceptVariable, name, strings.Join(detect.TrackerNames, ", "))
		}
		accept = append(accept, name)
	}
	return accept, nil
}

// issueWithBody is an issue as printed with --with-body: every key of the
// issue, then the body.
type issueWithBody struct {
	tracker.Issue
	// Body is the description and the requirements as one text, the
	// requirements in a marked section: what `write <id> body` takes.
	Body string `json:"body"`
}

// withBodies gives issues with their bodies, for a program that shows the
// description and the requirements as one text.
func withBodies(listed []tracker.Issue) []issueWithBody {
	with := make([]issueWithBody, 0, len(listed))
	for _, issue := range listed {
		with = append(with, issueWithBody{issue, tracker.WithRequirements(issue.Description, issue.Requirements)})
	}
	return with
}

// bodyPart is the part `write` accepts beside tracker.Parts: the
// description and the requirements as one text.
const bodyPart = "body"

// priorityOption reads an option that holds a priority; nil when it was not
// given.
func priorityOption(parsed *Parsed, name string) (*int, error) {
	typed := parsed.value(name)
	if typed == nil {
		return nil, nil
	}
	priority, err := ParsePriority(*typed)
	if err != nil {
		return nil, err
	}
	return &priority, nil
}

// folderOf is the folder a command is to run in: --dir, else where it was
// started.
func folderOf(parsed *Parsed, surroundings Surroundings) string {
	if dir := parsed.value("dir"); dir != nil {
		return *dir
	}
	return surroundings.Cwd
}

// setUp carries out `bend setup`: alone it reads what is in place; with a
// step's name it carries that step out; with "all", every missing one.
//
// It needs no tracker in the folder: finding one is what it is for.
// Side effects: none without a step; a step's own otherwise (see
// internal/setup).
func setUp(parsed *Parsed, surroundings Surroundings) (answer, error) {
	dir := folderOf(parsed, surroundings)
	options := setup.Options{}
	if len(parsed.Positionals) > 1 {
		return answer{}, tracker.Usage("Name one step, or all. Run `bend setup` to see the steps.")
	}
	if len(parsed.Positionals) == 0 {
		state, err := setup.Read(dir, options)
		if err != nil {
			return answer{}, err
		}
		return answer{FormatSetup(state), state}, nil
	}
	terminal := setup.Terminal{
		Interactive: surroundings.Interactive && !parsed.Flags["no-input"] && surroundings.Ask != nil,
		Ask:         surroundings.Ask,
		Say:         surroundings.Err,
		Run:         func(string, string, ...string) int { return -1 },
	}
	if attach := surroundings.Attach; attach != nil {
		terminal.Run = func(dir, name string, args ...string) int {
			return attach(dir, terminal.Interactive, name, args...)
		}
	}
	answers := setup.Answers{
		Yes:        parsed.Flags["yes"],
		Use:        orEmpty(parsed.value("use")),
		Repository: orEmpty(parsed.value("repository")),
		Method:     orEmpty(parsed.value("method")),
		Keep:       parsed.Lists["keep"],
		KeepAll:    parsed.Flags["keep-all"],
		KeepNone:   parsed.Flags["keep-none"],
	}
	step := parsed.Positionals[0]
	if step == "all" {
		outcomes, err := setup.All(dir, terminal, answers, options)
		if err != nil {
			return answer{}, err
		}
		text := "Nothing was missing."
		if len(outcomes) > 0 {
			text = "Done: " + plural(len(outcomes), "step") + ". Run `bend setup` to see what is in place."
		}
		return answer{text, fields{{"ok", true}, {"steps", outcomes}}}, nil
	}
	outcome, err := setup.Run(step, dir, terminal, answers, options)
	if err != nil {
		return answer{}, err
	}
	return did(outcome.Message, field{"step", outcome.Step}, field{"changed", outcome.Changed}, field{"message", outcome.Message}), nil
}

// lookAfterFacts carries out the `facts` command.
//
// It works on the folder it is given and needs no tracker there: a program
// that sets a repository up puts the facts file in place before, or
// without, a tracker.
// Side effects: may write FACTS.md and AGENTS.md in that folder.
func lookAfterFacts(parsed *Parsed, surroundings Surroundings) (answer, error) {
	root, err := filepath.Abs(folderOf(parsed, surroundings))
	if err != nil {
		return answer{}, tracker.Refused("The folder %s does not exist.", folderOf(parsed, surroundings))
	}
	if _, err := os.Stat(root); err != nil {
		return answer{}, tracker.Refused("The folder %s does not exist.", root)
	}
	addFile := parsed.value("add-file")
	if parsed.Flags["list"] {
		if parsed.Flags["ensure"] || parsed.Flags["move-old"] || addFile != nil {
			return answer{}, tracker.Usage("--list only reads; give it alone.")
		}
		// This folder's own file, where `recall` reads the repository's.
		saved, err := facts.Recall(root, nil)
		if err != nil {
			return answer{}, err
		}
		return answer{FormatFacts(saved), saved}, nil
	}
	if !parsed.Flags["ensure"] && !parsed.Flags["move-old"] && addFile == nil {
		return answer{}, tracker.Usage("Say what to do: --list, --ensure, --add-file <file>, or --move-old.")
	}
	// Read and checked before anything is written.
	var adding []facts.Fact
	if addFile != nil {
		content, err := readInput(*addFile, surroundings)
		if err != nil {
			return answer{}, err
		}
		if json.Unmarshal([]byte(content), &adding) != nil {
			return answer{}, tracker.Usage(`The facts must be a JSON list like [{"key": "build", "text": "Run make"}].`)
		}
		for _, fact := range adding {
			if strings.TrimSpace(fact.Key) == "" || strings.TrimSpace(fact.Text) == "" {
				return answer{}, tracker.Usage("Every fact needs a key and a text.")
			}
		}
	}
	done := []string{}
	result := fields{}
	// Facts an earlier version kept in a section of AGENTS.md go to the
	// facts file first, so that what is added now is the newer word.
	if parsed.Flags["move-old"] {
		moved, err := facts.MoveOld(root)
		if err != nil {
			return answer{}, err
		}
		done = append(done, plural(moved, "fact")+" moved from AGENTS.md")
		result = append(result, field{"moved", moved})
	}
	if addFile != nil {
		added, replaced, err := facts.Add(root, adding)
		if err != nil {
			return answer{}, err
		}
		done = append(done, plural(added, "fact")+" added, "+plural(replaced, "fact")+" replaced")
		result = append(result, field{"added", added}, field{"replaced", replaced})
	}
	if parsed.Flags["ensure"] {
		created, err := facts.EnsureFile(root)
		if err != nil {
			return answer{}, err
		}
		if created {
			done = append(done, "FACTS.md created")
		} else {
			done = append(done, "FACTS.md is there")
		}
		result = append(result, field{"created", created})
	}
	return did(strings.Join(done, "; ")+".", result...), nil
}

// plural gives a count with its noun: "1 fact", "3 facts".
func plural(count int, noun string) string {
	if count == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(count) + " " + noun + "s"
}

// carryOut carries out one command.
//
// Returns what to print: text for a reader and a value for --json.
// Fails with an *tracker.Error; see the package comment for the kinds.
func carryOut(command *Command, parsed *Parsed, surroundings Surroundings) (answer, error) {
	switch command.Name {
	case "setup":
		return setUp(parsed, surroundings)
	case "facts":
		return lookAfterFacts(parsed, surroundings)
	case "version":
		return answer{"bend " + strconv.Itoa(Version), fields{{"version", Version}}}, nil
	}
	find := surroundings.Detect
	if find == nil {
		find = detect.Tracker
	}
	actor := ""
	if as := parsed.value("as"); as != nil {
		actor = *as
	}
	accept, err := acceptedTrackers()
	if err != nil {
		return answer{}, err
	}
	found, err := find(folderOf(parsed, surroundings), detect.Options{
		Actor: actor, Accept: accept,
		Warn: func(text string) { surroundings.Err("bend: " + text) },
	})
	if err != nil {
		return answer{}, err
	}
	issues := found.Tracker
	value := parsed.value
	// The copy on this machine the tracker is worked from; nil for a
	// tracker that needs none (beads) or is asked directly.
	var held *github.Copy
	if with, ok := issues.(interface{ LocalCopy() *github.Copy }); ok {
		held = with.LocalCopy()
	}
	// The copy a tracker on this machine is answered from; nil otherwise.
	local, _ := issues.(*kept.Tracker)
	// copyNow says how whichever copy there is stands; nil for none.
	copyNow := func() *kept.Status {
		switch {
		case local != nil:
			status := local.Status()
			return &status
		case held != nil:
			status := held.Status()
			return &kept.Status{Folder: status.Folder, LastSync: status.LastSync, Waiting: status.Waiting, Refused: status.Refused}
		}
		return nil
	}
	// unsent fills in how many changes of each issue still wait to be sent.
	unsent := func(listed []tracker.Issue) []tracker.Issue {
		if held == nil {
			return listed
		}
		for index := range listed {
			if number, err := strconv.Atoi(listed[index].ID); err == nil {
				listed[index].Unsent = held.Unsent(number)
			}
		}
		return listed
	}
	// What a command that prints issues prints with --json.
	printed := func(listed []tracker.Issue) any {
		listed = unsent(listed)
		if !parsed.Flags["with-body"] {
			return listed
		}
		return withBodies(listed)
	}

	switch command.Name {
	case "refresh":
		switch {
		case local != nil:
			if err := local.Reread(); err != nil {
				return answer{}, err
			}
		case held != nil:
			if _, err := held.WaitAndSync(false); err != nil {
				return answer{}, err
			}
		default:
			return did("There is no local copy here: the tracker is asked directly."), nil
		}
		return did("The local copy of the issues is fresh."), nil

	case "list":
		priority, err := priorityOption(parsed, "priority")
		if err != nil {
			return answer{}, err
		}
		if parsed.Flags["fresh"] && local != nil {
			if err := local.Reread(); err != nil {
				return answer{}, err
			}
		}
		listed, err := issues.List(tracker.ListFilter{
			Status:       value("status"),
			Type:         value("type"),
			Priority:     priority,
			Category:     value("category"),
			Assignee:     value("assignee"),
			ParentID:     value("parent"),
			ChangedSince: value("changed-since"),
		})
		if err != nil {
			return answer{}, err
		}
		return answer{FormatList(listed), printed(listed)}, nil

	case "ready":
		listed, err := issues.Ready()
		if err != nil {
			return answer{}, err
		}
		return answer{FormatList(listed), printed(listed)}, nil

	case "show":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		issue, err := issues.Show(id)
		if err != nil {
			return answer{}, err
		}
		issue = unsent([]tracker.Issue{issue})[0]
		if parsed.Flags["with-body"] {
			return answer{FormatIssue(issue), withBodies([]tracker.Issue{issue})[0]}, nil
		}
		return answer{FormatIssue(issue), issue}, nil

	case "comments":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		comments, err := issues.Comments(id)
		if err != nil {
			return answer{}, err
		}
		return answer{FormatComments(comments), comments}, nil

	case "search":
		text, err := textOf(parsed, 0, surroundings, false)
		if err != nil {
			return answer{}, err
		}
		listed, err := issues.Search(text)
		if err != nil {
			return answer{}, err
		}
		return answer{FormatList(listed), printed(listed)}, nil

	case "create":
		title, err := need(parsed, 0, "the title")
		if err != nil {
			return answer{}, err
		}
		priority, err := priorityOption(parsed, "priority")
		if err != nil {
			return answer{}, err
		}
		id, err := issues.Create(tracker.Draft{
			Title:       title,
			Description: value("description"),
			Done:        value("done"),
			Type:        value("type"),
			Priority:    priority,
			Category:    value("category"),
			ParentID:    value("parent"),
			From:        value("from"),
			BlockedBy:   parsed.Lists["blocked-by"],
		})
		if err != nil {
			return answer{}, err
		}
		return answer{id, fields{{"ok", true}, {"id", id}}}, nil

	case "edit":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		if value("category") != nil && parsed.Flags["no-category"] {
			return answer{}, tracker.Usage("Give --category or --no-category, not both.")
		}
		if value("assignee") != nil && parsed.Flags["no-assignee"] {
			return answer{}, tracker.Usage("Give --assignee or --no-assignee, not both.")
		}
		priority, err := priorityOption(parsed, "priority")
		if err != nil {
			return answer{}, err
		}
		changes := tracker.Changes{
			Title:         value("title"),
			Type:          value("type"),
			Priority:      priority,
			Category:      value("category"),
			ClearCategory: parsed.Flags["no-category"],
			Assignee:      value("assignee"),
			ClearAssignee: parsed.Flags["no-assignee"],
			AddLabels:     parsed.Lists["add-label"],
			RemoveLabels:  parsed.Lists["remove-label"],
		}
		for _, pair := range parsed.Lists["set-data"] {
			name, kept, divided := strings.Cut(pair, "=")
			if !divided || name == "" {
				return answer{}, tracker.Usage("Write kept data as <name>=<value>, not \"%s\".", pair)
			}
			changes.Metadata = append(changes.Metadata, tracker.MetadataChange{Key: name, Value: &kept})
		}
		for _, name := range parsed.Lists["unset-data"] {
			changes.Metadata = append(changes.Metadata, tracker.MetadataChange{Key: name})
		}
		if changes.Empty() {
			return answer{}, tracker.Usage("Nothing to change: give at least one option.")
		}
		if err := issues.Edit(id, changes); err != nil {
			return answer{}, err
		}
		return did("Changed "+id+".", field{"id", id}), nil

	case "write":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		typed, err := need(parsed, 1, "the part")
		if err != nil {
			return answer{}, err
		}
		part, err := oneOf(typed, append(slices.Clone(tracker.Parts), bodyPart), "part")
		if err != nil {
			return answer{}, err
		}
		text, err := textOf(parsed, 2, surroundings, true)
		if err != nil {
			return answer{}, err
		}
		if part == bodyPart {
			if err := writeBody(issues, id, text); err != nil {
				return answer{}, err
			}
		} else if err := issues.Write(id, part, text); err != nil {
			return answer{}, err
		}
		return did("Wrote the "+part+" of "+id+".", field{"id", id}, field{"part", part}), nil

	case "comment", "decide":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		text, err := textOf(parsed, 1, surroundings, false)
		if err != nil {
			return answer{}, err
		}
		if command.Name == "decide" {
			if err := issues.Comment(id, tracker.DecisionPrefix+strings.TrimSpace(text)); err != nil {
				return answer{}, err
			}
			return did("Recorded the decision on "+id+".", field{"id", id}), nil
		}
		if err := issues.Comment(id, text); err != nil {
			return answer{}, err
		}
		return did("Commented on "+id+".", field{"id", id}), nil

	case "start":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		if err := issues.Start(id); err != nil {
			return answer{}, err
		}
		return did(id+" is in progress.", field{"id", id}), nil

	case "close":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		if err := issues.Close(id, orEmpty(value("reason"))); err != nil {
			return answer{}, err
		}
		return did("Closed "+id+".", field{"id", id}), nil

	case "reopen":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		if err := issues.Reopen(id); err != nil {
			return answer{}, err
		}
		return did("Reopened "+id+".", field{"id", id}), nil

	case "move":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		under := value("under")
		if (under == nil) == !parsed.Flags["top"] {
			return answer{}, tracker.Usage("Say where to: --under <parent>, or --top.")
		}
		if err := issues.Move(id, under); err != nil {
			return answer{}, err
		}
		if under == nil {
			return did("Moved "+id+" to the top level.", field{"id", id}, field{"parentId", nil}), nil
		}
		return did("Moved "+id+" under "+*under+".", field{"id", id}, field{"parentId", *under}), nil

	case "link":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		other, err := need(parsed, 1, "the other issue's id")
		if err != nil {
			return answer{}, err
		}
		if value("kind") == nil {
			return answer{}, tracker.Usage("Say what kind of link: --kind %s.", strings.Join(tracker.LinkKinds, " | "))
		}
		// Checked here against what this repository's tracker has, so that
		// a mistyped kind is a wrong request, whatever the tracker.
		kind, err := oneOf(*value("kind"), issues.About().LinkKinds, "kind of link")
		if err != nil {
			return answer{}, err
		}
		if err := issues.Link(id, other, kind); err != nil {
			return answer{}, err
		}
		text := id + " is " + strings.Replace(kind, "-", " ", 1) + " " + other + "."
		switch {
		case kind == "related":
			text = id + " and " + other + " are related."
		case !slices.Contains(tracker.LinkKinds, kind):
			// A kind of the tracker's own does not read as a sentence.
			text = "Linked " + id + " to " + other + " (" + kind + ")."
		}
		return did(text, field{"id", id}, field{"otherId", other}, field{"kind", kind}), nil

	case "unlink":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		other, err := need(parsed, 1, "the other issue's id")
		if err != nil {
			return answer{}, err
		}
		options := tracker.UnlinkOptions{OnlyFrom: parsed.Flags["from-first"], Kind: orEmpty(value("kind"))}
		if err := issues.Unlink(id, other, options); err != nil {
			return answer{}, err
		}
		return did("Removed the link between "+id+" and "+other+".", field{"id", id}, field{"otherId", other}), nil

	case "handover":
		id, err := need(parsed, 0, "the issue id")
		if err != nil {
			return answer{}, err
		}
		// Checked before anything is written, so a refused hand-over leaves
		// the issue as it was.
		text, err := tracker.HandoverText(
			orEmpty(value("done")), orEmpty(value("checked")), orEmpty(value("not-checked")))
		if err != nil {
			return answer{}, err
		}
		issue, err := issues.Show(id)
		if err != nil {
			return answer{}, err
		}
		if issue.Status == "closed" {
			return answer{}, tracker.Refused("%s is closed; there is nothing to hand over.", id)
		}
		// Handed over means: in progress, waiting for the owner. An issue
		// that was never started is started here so it shows as such.
		if issue.Status != "in_progress" {
			if err := issues.Start(id); err != nil {
				return answer{}, err
			}
		}
		if err := issues.Comment(id, text); err != nil {
			return answer{}, err
		}
		return did("Handed "+id+" over. It stays in progress until the owner closes it.", field{"id", id}), nil

	case "status":
		if parsed.Flags["quick"] {
			about := issues.About()
			// Where the copy is kept, for a caller that watches it for
			// changes; null where there is none.
			var folder *string
			if status := copyNow(); status != nil {
				folder = &status.Folder
			}
			// The tracker's own file that changes with its data (beads'
			// "last touched"), for the same caller: a change made with the
			// tracker's program reaches the copy only at the next read.
			var watched *string
			if local != nil && local.SignFile() != "" {
				watched = tracker.Ptr(local.SignFile())
			}
			return answer{FormatAbout(about), fields{
				{"tracker", about.Tracker},
				{"repository", about.Repository},
				{"linkKinds", about.LinkKinds},
				{"root", found.Root},
				{"copy", folder},
				{"watch", watched},
			}}, nil
		}
		capabilities, err := issues.Capabilities()
		if err != nil {
			return answer{}, err
		}
		reported := statusWithCopy{Capabilities: capabilities, Copy: copyNow()}
		return answer{FormatStatus(capabilities) + FormatCopy(reported.Copy), reported}, nil

	case "sync":
		if held == nil {
			return did("Nothing to sync: this repository's issues are not worked from a copy of a hosted tracker."), nil
		}
		// Where another process is syncing (one started in the background
		// a moment ago, say), it is waited for, so that this sync sends
		// what that one did not see.
		sync := held.WaitAndSync
		if parsed.Flags["no-wait"] {
			sync = held.Sync
		}
		result, err := sync(parsed.Flags["all"])
		if err != nil {
			return answer{}, err
		}
		return answer{FormatSync(result), result}, nil

	case "refused":
		if value("dismiss") != nil && value("again") != nil {
			return answer{}, tracker.Usage("Give --dismiss or --again, not both.")
		}
		if held == nil {
			return answer{"No refused changes.", []github.RefusedChange{}}, nil
		}
		which, again := value("dismiss"), false
		if value("again") != nil {
			which, again = value("again"), true
		}
		if which == nil {
			refused := held.RefusedChanges()
			return answer{FormatRefused(refused), refused}, nil
		}
		seq := 0
		if *which != "all" {
			if seq, err = strconv.Atoi(*which); err != nil || seq < 1 {
				return answer{}, tracker.Usage("Say which refused change: its number, or all.")
			}
		}
		taken, err := held.Dismiss(seq, again)
		if err != nil {
			return answer{}, err
		}
		words := "Dismissed " + plural(taken, "refused change") + "."
		if again {
			words = plural(taken, "refused change") + " put back to be sent again."
		}
		return did(words, field{"count", taken}), nil

	case "remember":
		text, err := textOf(parsed, 0, surroundings, false)
		if err != nil {
			return answer{}, err
		}
		key, replaced, err := facts.Remember(found.Root, text, orEmpty(value("key")))
		if err != nil {
			return answer{}, err
		}
		word := "Saved"
		if replaced {
			word = "Replaced"
		}
		return did(word+" the fact \""+key+"\" in "+facts.File+".", field{"key", key}, field{"replaced", replaced}), nil

	case "recall":
		saved, err := facts.Recall(found.Root, parsed.Positionals)
		if err != nil {
			return answer{}, err
		}
		return answer{FormatFacts(saved), saved}, nil
	}
	return answer{}, tracker.Usage("Unknown command \"%s\".", command.Name)
}

// writeBody replaces an issue's description and requirements from one text
// that holds both, the requirements as a marked section.
//
// Only a half that differs from what the issue holds is written, so a text
// saved unchanged writes nothing.
// Side effects: one read of the issue, and up to two writes.
func writeBody(issues tracker.Tracker, id, body string) error {
	description, requirements := tracker.SplitRequirements(body)
	held, err := issues.Show(id)
	if err != nil {
		return err
	}
	if description != held.Description {
		if err := issues.Write(id, "description", description); err != nil {
			return err
		}
	}
	if requirements != held.Requirements {
		return issues.Write(id, "requirements", requirements)
	}
	return nil
}

// shortForms gives the one-letter options a command accepts: the ones
// every command has, and its own.
func shortForms(command *Command) map[string]string {
	short := map[string]string{}
	for letter, name := range commonSpec.Short {
		short[letter] = name
	}
	for letter, name := range command.Spec.Short {
		short[letter] = name
	}
	return short
}

// asksForHelp says whether a command line asks for help: --help or -h
// standing as an option.
//
// Not as text: after "--" everything is text, and the word after an option
// that takes a value is that value, so a title, a description or a label
// that happens to be "-h" does not turn the command into its help.
// command is the command named on the line, or nil when there is none or it
// is not known; then only the options every command has are known to take a
// value.
func asksForHelp(rest []string, command *Command) bool {
	takesValue := slices.Clone(commonSpec.Values)
	if command != nil {
		takesValue = append(append(takesValue, command.Spec.Values...), command.Spec.Lists...)
	}
	for at := 0; at < len(rest); at++ {
		word := rest[at]
		switch {
		case word == "--":
			return false
		case word == "--help" || word == "-h":
			return true
		case strings.HasPrefix(word, "--") && !strings.Contains(word, "="):
			if slices.Contains(takesValue, word[2:]) {
				at++
			}
		case strings.HasPrefix(word, "-") && len(word) == 2:
			if long, known := commonSpec.Short[word[1:]]; known && slices.Contains(takesValue, long) {
				at++
			}
		}
	}
	return false
}

// Run runs bend with the given arguments.
//
// argv is the words after the program's name.
// Returns the exit status (see the package comment).
// Side effects: whatever the command does to the tracker or to the facts
// file; prints through surroundings.
func Run(argv []string, surroundings Surroundings) int {
	asJSON := slices.Contains(argv, "--json")
	status, err := run(argv, surroundings, &asJSON)
	// Whatever the command did: a copy of a hosted tracker that it changed,
	// or found a few minutes old, is synced now, in a process of its own
	// that this one does not wait for.
	github.AfterCommand()
	kept.AfterCommand()
	if err == nil {
		return status
	}
	kind := tracker.KindOf(err)
	// With --json the problem goes to standard output too, in a fixed
	// shape, so a program reading the answer does not have to look in two
	// places.
	if asJSON {
		text, _ := encode(fields{
			{"ok", false},
			{"status", kind.ExitStatus()},
			{"kind", string(kind)},
			{"error", err.Error()},
		}, "  ")
		surroundings.Out(text)
	} else {
		surroundings.Err("bend: " + err.Error())
	}
	return kind.ExitStatus()
}

// run is Run without the reporting of a failure. asJSON is set as soon as
// the command line has been read, so that a failure after that is reported
// in the form the caller asked for.
func run(argv []string, surroundings Surroundings, asJSON *bool) (int, error) {
	name, rest := splitCommand(argv)
	wantsHelp := asksForHelp(rest, findCommand(name))
	if name == "" || name == "help" {
		var command *Command
		if name == "help" {
			for _, word := range rest {
				if strings.HasPrefix(word, "-") {
					continue
				}
				if command = findCommand(word); command == nil {
					return 0, tracker.Usage("Unknown command \"%s\". Run `bend --help`.", word)
				}
				break
			}
		}
		if command == nil {
			surroundings.Out(MainHelp())
		} else {
			surroundings.Out(CommandHelp(command))
		}
		// Bare `bend` is a usage error; asking for help is not.
		if name == "" && !wantsHelp {
			return 2, nil
		}
		return 0, nil
	}
	command := findCommand(name)
	if command == nil {
		return 0, tracker.Usage("Unknown command \"%s\". Run `bend --help`.", name)
	}
	if wantsHelp {
		surroundings.Out(CommandHelp(command))
		return 0, nil
	}
	parsed, err := ParseArgs(rest, OptionSpec{
		Values: append(slices.Clone(commonSpec.Values), command.Spec.Values...),
		Lists:  command.Spec.Lists,
		Flags:  append(slices.Clone(commonSpec.Flags), command.Spec.Flags...),
		Short:  shortForms(command),
	})
	if err != nil {
		return 0, err
	}
	*asJSON = parsed.Flags["json"]
	result, err := carryOut(command, parsed, surroundings)
	if err != nil {
		return 0, err
	}
	if !*asJSON {
		surroundings.Out(result.text)
		return 0, nil
	}
	text, err := encode(result.json, "  ")
	if err != nil {
		return 0, tracker.Refused("The answer could not be written as JSON: %s", err)
	}
	surroundings.Out(text)
	return 0, nil
}
