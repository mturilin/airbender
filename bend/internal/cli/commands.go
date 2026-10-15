// commands.go — what bend can do, as a table.
//
// What: one entry per command: how it is called, what it does, the options
// it accepts, and the help text built from those.
//
// Why: the help a person or an agent reads and the options the program
// accepts come from the same entry, so they cannot drift apart.
//
// Design notes:
//   - The commands are worded for the owner's way of working (write a part,
//     decide, hand over), not for any tracker's commands.
//   - There is no `current` command: which issue a session is working on is
//     about the session, not the tracker (the owner's decision).
//   - `close` is offered to agents. That agents do not close on their own is
//     a rule for agents, not a missing command (the owner's decision).

package cli

import (
	"strings"
	"unicode/utf8"
)

// Command is one command's description.
type Command struct {
	Name string
	// Usage is the words after the name, e.g. "<id> <part> [text]".
	Usage string
	// Summary is one line for the list of commands.
	Summary string
	// Details is a fuller explanation for the command's own help; may be "".
	Details string
	// Options are the options with their one-line explanations, e.g.
	// {"--type <type>", "…"}.
	Options [][2]string
	Spec    OptionSpec
	// Group is the heading the command is listed under in the main help.
	Group string
}

const (
	groupFind      = "Find and read"
	groupChange    = "Create and change"
	groupStructure = "Structure"
	groupFinish    = "Finishing"
	groupAbout     = "About this repository"
)

// withBodyOption is offered by every command that prints issues.
var withBodyOption = [2]string{"--with-body", "With --json: add each issue's body (description and requirements as one text)"}

// Commands is every command, in the order the main help lists them.
var Commands = []Command{
	{
		Name:    "list",
		Usage:   "[options]",
		Summary: "List issues (open ones, not in Someday, unless --status says otherwise)",
		Options: [][2]string{
			{"--status <status>", "open | in_progress | deferred | closed | … | all"},
			{"--type <type>", "Only this type"},
			{"--priority <0-4>", "Only this priority"},
			{"--category <name>", "Only this category"},
			{"--assignee <name>", "Only issues assigned to this person"},
			{"--parent <id>", "Only the direct sub-issues of <id>"},
			{"--changed-since <time>", "Only issues changed at or after this moment (ISO date and time)"},
			withBodyOption,
			{"--fresh", "Reread the local copy from the tracker first"},
		},
		Spec: OptionSpec{
			Values: []string{"status", "type", "priority", "category", "assignee", "parent", "changed-since"},
			Flags:  []string{"with-body", "fresh"},
		},
		Group: groupFind,
	},
	{
		Name:    "ready",
		Usage:   "[options]",
		Summary: "List issues that can be worked on now",
		Details: "Open issues that wait for nothing, by the tracker's own judgement.",
		Options: [][2]string{withBodyOption},
		Spec:    OptionSpec{Flags: []string{"with-body"}},
		Group:   groupFind,
	},
	{
		Name:    "show",
		Usage:   "<id> [options]",
		Summary: "Show one issue in full, with its links and sub-issues",
		Options: [][2]string{withBodyOption},
		Spec:    OptionSpec{Flags: []string{"with-body"}},
		Group:   groupFind,
	},
	{
		Name:    "comments",
		Usage:   "<id>",
		Summary: "Show an issue's comments, oldest first",
		Group:   groupFind,
	},
	{
		Name:    "search",
		Usage:   "<text> [options]",
		Summary: "Find issues by words in the title or id",
		Options: [][2]string{withBodyOption},
		Spec:    OptionSpec{Flags: []string{"with-body"}},
		Group:   groupFind,
	},
	{
		Name:    "create",
		Usage:   "<title> [options]",
		Summary: "Create an issue",
		Details: "Prints the new issue's id.",
		Options: [][2]string{
			{"--description <text>", "What is wanted and why"},
			{"--done <text>", `What "done" means`},
			{"--type <type>", "task | feature | bug | epic | chore | decision"},
			{"--priority <0-4>", "0 is most urgent"},
			{"--category <name>", "One category; the parent's if left out"},
			{"--parent <id>", "Create it as a sub-issue of <id>"},
			{"--from <id>", "It was discovered while working on <id>"},
			{"--blocked-by <id>", "It waits for <id> (repeatable)"},
		},
		Spec: OptionSpec{
			Values: []string{"description", "done", "type", "priority", "category", "parent", "from"},
			Lists:  []string{"blocked-by"},
		},
		Group: groupChange,
	},
	{
		Name:    "edit",
		Usage:   "<id> [options]",
		Summary: "Change title, type, priority, category, assignee, labels or kept data",
		Details: "Kept data is free-form data a program keeps with an issue, by name;\nnot every tracker has a place for it.",
		Options: [][2]string{
			{"--title <text>", "New title"},
			{"--type <type>", "New type"},
			{"--priority <0-4>", "New priority"},
			{"--category <name>", "New category"},
			{"--no-category", "Remove the category"},
			{"--assignee <name>", "New assignee"},
			{"--no-assignee", "Remove the assignee"},
			{"--add-label <label>", "Add a label (repeatable)"},
			{"--remove-label <label>", "Remove a label (repeatable)"},
			{"--set-data <name>=<value>", "Keep a piece of data with the issue (repeatable)"},
			{"--unset-data <name>", "Remove a piece of kept data (repeatable)"},
		},
		Spec: OptionSpec{
			Values: []string{"title", "type", "priority", "category", "assignee"},
			Lists:  []string{"add-label", "remove-label", "set-data", "unset-data"},
			Flags:  []string{"no-category", "no-assignee"},
		},
		Group: groupChange,
	},
	{
		Name:    "write",
		Usage:   "<id> <part> [text]",
		Summary: "Replace one written part of an issue",
		Details: "Parts: description | requirements | done | plan | notes | body.\nThe text replaces what was there; an empty text clears the part.\nFor long text use --text-file.\nThe body is the description and the requirements as one text, the\nrequirements in a marked section; a program that shows the two together\nwrites them together.",
		Group:   groupChange,
	},
	{
		Name:    "comment",
		Usage:   "<id> [text]",
		Summary: "Add a comment",
		Group:   groupChange,
	},
	{
		Name:    "note",
		Usage:   "<id> [text]",
		Summary: "Add to an issue's notes, keeping what is there",
		Details: "The text is added as a new paragraph at the end of the notes.\nTo replace the notes as a whole: bend write <id> notes.\nFor long text use --text-file.",
		Group:   groupChange,
	},
	{
		Name:    "decide",
		Usage:   "<id> [text]",
		Summary: "Record a decision and its reason",
		Details: "Say what was decided and why, and whose decision it was, e.g.\n  bend decide APP-1 \"Keep the old endpoint, because mobile still calls it (the owner's decision)\"",
		Group:   groupChange,
	},
	{
		Name:    "start",
		Usage:   "<id>",
		Summary: "Mark an issue as being worked on",
		Details: "With --as, the issue is also assigned to that name.",
		Group:   groupChange,
	},
	{
		Name:    "stop",
		Usage:   "<id>",
		Summary: "Put an issue that is in progress back to open",
		Details: "For work that was set aside: nobody is working on the issue now.\nWho it is assigned to is not changed.",
		Group:   groupChange,
	},
	{
		Name:    "close",
		Usage:   "<id> [options]",
		Summary: "Close an issue",
		Options: [][2]string{{"--reason <text>", "Why it is closed"}},
		Spec:    OptionSpec{Values: []string{"reason"}},
		Group:   groupChange,
	},
	{
		Name:    "reopen",
		Usage:   "<id>",
		Summary: "Reopen a closed issue",
		Group:   groupChange,
	},
	{
		Name:    "defer",
		Usage:   "<id>",
		Summary: "Put an issue in Someday, set aside for later",
		Details: "A deferred issue is neither ready nor closed: `bend ready` and the default\n`bend list` leave it out, and nothing starts it by itself. `bend undefer`\nbrings it back. On beads it is beads' own deferred status; on GitHub\nissues, the label someday.",
		Group:   groupChange,
	},
	{
		Name:    "undefer",
		Usage:   "<id>",
		Summary: "Bring an issue back from Someday",
		Group:   groupChange,
	},
	{
		Name:    "move",
		Usage:   "<id> (--under <parent> | --top)",
		Summary: "Put an issue under a parent, or back at the top level",
		Options: [][2]string{
			{"--under <id>", "Make it a sub-issue of <id>"},
			{"--top", "Take it out of its parent"},
		},
		Spec:  OptionSpec{Values: []string{"under"}, Flags: []string{"top"}},
		Group: groupStructure,
	},
	{
		Name:    "link",
		Usage:   "<id> <other-id> --kind <kind>",
		Summary: "Link two issues",
		Details: "Kinds: blocked-by | discovered-from | related, and any kind of the\ntracker's own that `bend status` lists.\nRead it as a sentence: `bend link A B --kind blocked-by` records that A is blocked by B.",
		Options: [][2]string{{"--kind <kind>", "blocked-by | discovered-from | related | one of the tracker's own"}},
		Spec:    OptionSpec{Values: []string{"kind"}},
		Group:   groupStructure,
	},
	{
		Name:    "unlink",
		Usage:   "<id> <other-id> [options]",
		Summary: "Remove the link between two issues",
		Details: "Whichever way round the link was recorded, unless --from-first says otherwise.",
		Options: [][2]string{
			{"--kind <kind>", "Only a link of this kind"},
			{"--from-first", "Only the link recorded on <id>, not one recorded on <other-id>"},
		},
		Spec:  OptionSpec{Values: []string{"kind"}, Flags: []string{"from-first"}},
		Group: groupStructure,
	},
	{
		Name:    "handover",
		Usage:   "<id> --done <text> --checked <text> --not-checked <text>",
		Summary: "Hand an issue over to the owner to validate",
		Details: "All three are required. If everything was checked, say so: --not-checked \"nothing\".\nThe issue is left in progress; the owner validates and closes it.",
		Options: [][2]string{
			{"--done <text>", "What was done"},
			{"--checked <text>", "How it was checked"},
			{"--not-checked <text>", "What was not checked"},
		},
		Spec:  OptionSpec{Values: []string{"done", "checked", "not-checked"}},
		Group: groupFinish,
	},
	{
		Name:    "status",
		Usage:   "[options]",
		Summary: "Which tracker is used here and what it supports",
		Options: [][2]string{
			{"--quick", "Only what is known without asking the tracker: its name, the repository, its kinds of link"},
		},
		Spec:  OptionSpec{Flags: []string{"quick"}},
		Group: groupAbout,
	},
	{
		Name:    "remember",
		Usage:   "<text> [--key <key>]",
		Summary: "Save a standing fact for future sessions",
		Details: "Facts are kept in the repository's FACTS.md, one line per key.\nSaving under a key that exists replaces that fact.",
		Options: [][2]string{{"--key <key>", "The fact's name; made from its first words if left out"}},
		Spec:    OptionSpec{Values: []string{"key"}},
		Group:   groupAbout,
	},
	{
		Name:    "recall",
		Usage:   "[words]",
		Summary: "Show saved facts, all or those containing the words",
		Group:   groupAbout,
	},
	{
		Name:    "facts",
		Usage:   "(--list | --ensure | --add-file <file> | --move-old)",
		Summary: "Look after the facts file, for a program that sets a repository up",
		Details: "It works on the folder it is run in, which needs no tracker.\n--list shows the facts in that folder's own file.\n--ensure makes FACTS.md when there is none.\n--add-file saves several facts at once, read as a JSON list of {\"key\": …, \"text\": …}.\n--move-old moves facts still kept in the old section of AGENTS.md into FACTS.md.",
		Options: [][2]string{
			{"--list", "Show the facts kept in this folder"},
			{"--ensure", "Make the facts file when it is missing"},
			{"--add-file <file>", `Save the facts in a JSON file ("-" for stdin)`},
			{"--move-old", "Move facts out of the old section of AGENTS.md"},
		},
		Spec:  OptionSpec{Values: []string{"add-file"}, Flags: []string{"list", "ensure", "move-old"}},
		Group: groupAbout,
	},
	{
		Name:    "refresh",
		Summary: "Reread the local copy of the issues from the tracker",
		Details: "bend answers reads from a copy of the issues on this computer, and rereads\nit by itself: when the tracker says something changed, after a change made\nthrough bend, and when the copy is more than a few minutes old. This does\nit now. Deleting the copy is harmless: it is made anew.",
		Group:   groupAbout,
	},
	{
		Name:    "sync",
		Usage:   "[options]",
		Summary: "Sync the issues with their remote now, or say how the syncing stands",
		Details: "Sends what was changed here and brings in what changed elsewhere, and says\nhow it ended (synced, failed, busy, conflict, stuck), what was sent and what\ncame in. Every sync, whoever started it, leaves an entry in a log kept with\nthe repository.\n\nbend also syncs by itself: a helper process, which any bend command starts,\nsyncs every three minutes and ends when bend has not been used for half an\nhour (`bend helper`). On a hosted tracker (GitHub issues) a change is also\nsent a moment after the command that made it.\n\nOn a hosted tracker, changes that cannot be sent now (no network, a limit)\nkeep waiting and are sent by the next sync, in the order they were made;\n`bend refused` lists the ones the tracker refused for good.\n\nExit status 1 when the sync did not work; the report is printed all the same.",
		Options: [][2]string{
			{"--status", "Sync nothing: say what the issues are synced with, what waits, how the last sync ended, and what is wrong"},
			{"--log", "Sync nothing: list the syncs made, newest first"},
			{"--failed", "With --log: only the syncs that did not work"},
			{"--all", "Reread every issue, which also drops the ones deleted on a hosted tracker (done by itself once a day)"},
			{"--no-wait", "Do nothing if another sync is running, instead of waiting for it"},
			{"--cause <what>", "What set it off, for the log: asked (the default) | timer | change | read"},
		},
		Spec:  OptionSpec{Values: []string{"cause"}, Flags: []string{"all", "no-wait", "status", "log", "failed"}},
		Group: groupAbout,
	},
	{
		Name:    "helper",
		Usage:   "[stop | start | disable | enable]",
		Summary: "The process that syncs the issues on a clock: how it stands, and stopping it",
		Details: "bend keeps a repository's issues in step with their remote by itself. Any\nbend command starts a small helper process for the repository when none is\nrunning; it syncs every three minutes, and ends by itself when bend has not\nbeen used for half an hour, when the bend program is replaced, or after\nthree syncs in a row failed.\n\nAlone, this says whether it is running, since when, and when it last synced.\n  stop     end the one that is running; the next bend command starts it again\n  start    start it now\n  disable  end it and keep it from being started in this repository\n  enable   allow it again, and start it",
		Group:   groupAbout,
	},
	{
		Name:    "refused",
		Usage:   "[options]",
		Summary: "List the changes a hosted tracker refused for good, and dismiss or resend them",
		Details: "A change GitHub will never accept (the issue is gone or locked, the text is\ntoo long) is taken out of the waiting changes and kept here, with GitHub's\nreason and the text it carried, so that nothing written is lost. The issue\nshows GitHub's version again.",
		Options: [][2]string{
			{"--dismiss <number|all>", "Take a refused change off the list"},
			{"--again <number|all>", "Put a refused change back among the waiting ones, to be sent once more"},
		},
		Spec:  OptionSpec{Values: []string{"dismiss", "again"}},
		Group: groupAbout,
	},
	{
		Name:    "setup",
		Usage:   "[step | all] [options]",
		Summary: "See what a repository needs to be ready, and set it up step by step",
		Details: "Alone, it only reads: every step, whether it is done, and the command for\neach one that is missing. With a step's name it does that step; `all` does\nevery missing one in order.\n\nSteps: tracker | program | issues | instructions | facts | publish.\n  tracker       choose beads or GitHub issues, recorded in .bend.json\n  program       install the tracker's own program (beads)\n  issues        beads: get the repository's issues, or start a database;\n                GitHub: sign in\n  instructions  write the rules for agents into AGENTS.md, and take out\n                what beads wrote\n  facts         carry facts saved in beads over to FACTS.md\n  publish       publish the issue database to the repository's remote\n\nA step asks what it needs to know, and shows what it will do before it\ndoes it. Give the answers as options to run it without questions. Where\nnobody is at the keyboard a step never waits: it changes nothing and says\nwhich option was missing. A step that is already done changes nothing.\n\nAirbender is for repositories of your own. Where origin is a fork, or a\nGitHub repository you cannot push to, choosing the tracker warns: its files\nwould end up in your pull requests. Keep the issues in GitHub issues in a\nrepository of yours (--use github --repository owner/name), or set up\nanyway (--anyway).",
		Options: [][2]string{
			{"-y, --yes", "Go ahead without asking for a yes"},
			{"    --no-input", "Never ask, also at a terminal"},
			{"    --use <tracker>", "tracker: beads | github"},
			{"    --repository <owner/name>", "tracker: the GitHub repository, when the remote does not say"},
			{"    --anyway", "tracker: set up a repository that looks like someone else's as your own"},
			{"    --method <id>", "program: the way to install, as `bend setup` lists them"},
			{"    --keep <key>", "facts: a saved fact to carry over (repeatable)"},
			{"    --keep-all", "facts: carry all of them over"},
			{"    --keep-none", "facts: carry none over"},
			{"    --rules <replace|keep>", "instructions: what to do with rules changed by hand that are behind the current version"},
			{"    --claude <link|rules>", "instructions: what a CLAUDE.md of its own is to be: a link to AGENTS.md, or a file with the same rules"},
		},
		Spec: OptionSpec{
			Values: []string{"use", "repository", "method", "rules", "claude"},
			Lists:  []string{"keep"},
			Flags:  []string{"yes", "no-input", "keep-all", "keep-none", "anyway"},
			Short:  map[string]string{"y": "yes"},
		},
		Group: groupAbout,
	},
	{
		Name:    "version",
		Summary: "Which bend this is",
		Details: "A number that goes up whenever bend's commands, options or JSON change,\nfor a program that runs bend to check it has one new enough.",
		Group:   groupAbout,
	},
}

// commonOptions are the options every command accepts, with their
// explanations.
var commonOptions = [][2]string{
	{"-C, --dir <path>", "Run as if started in <path>"},
	{"    --json", "Print machine-readable JSON"},
	{"    --text-file <f>", `Read the text argument from a file ("-" for stdin)`},
	{"    --as <name>", "Who is acting, for the tracker's history"},
	{"-h, --help", "Help for bend or for one command"},
}

// commonSpec is the option names behind commonOptions, merged into every
// command.
var commonSpec = OptionSpec{
	Values: []string{"dir", "text-file", "as"},
	Flags:  []string{"json", "help"},
	Short:  map[string]string{"C": "dir", "h": "help"},
}

// findCommand gives the command with a name, or nil.
func findCommand(name string) *Command {
	for index := range Commands {
		if Commands[index].Name == name {
			return &Commands[index]
		}
	}
	return nil
}

// padEnd gives text followed by spaces up to width characters.
func padEnd(text string, width int) string {
	if short := width - utf8.RuneCountInString(text); short > 0 {
		return text + strings.Repeat(" ", short)
	}
	return text
}

// columns gives lines of {left, right} pairs with the right-hand side
// aligned.
func columns(pairs [][2]string) string {
	width := 0
	for _, pair := range pairs {
		width = max(width, utf8.RuneCountInString(pair[0]))
	}
	lines := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		lines = append(lines, "  "+padEnd(pair[0], width)+"  "+pair[1])
	}
	return strings.Join(lines, "\n")
}

// MainHelp is the text of `bend --help`.
func MainHelp() string {
	lines := []string{
		"bend — read and change a repository's issues, whatever tracker holds them.",
		"",
		"The tracker is detected from the folder you are in. Commands, fields and",
		"output are the same for every tracker. Where a tracker has no home for",
		"something, bend keeps it in a fitting place or says so; it never drops it",
		"silently. Run `bend status` to see what applies here.",
		"",
		"Usage:",
		"  bend <command> [arguments] [options]",
	}
	groups := []string{}
	byGroup := map[string][][2]string{}
	for _, command := range Commands {
		if _, known := byGroup[command.Group]; !known {
			groups = append(groups, command.Group)
		}
		byGroup[command.Group] = append(byGroup[command.Group],
			[2]string{strings.TrimSpace(command.Name + " " + command.Usage), command.Summary})
	}
	for _, group := range groups {
		lines = append(lines, "", group+":", columns(byGroup[group]))
	}
	lines = append(lines,
		"",
		"Options for every command:",
		columns(commonOptions),
		"",
		"Exit status: 0 done · 1 refused, with the reason in plain words",
		"             2 usage error · 3 not supported by this repository's tracker",
		"",
		"Examples:",
		"  bend ready",
		"  bend show APP-142",
		`  bend create "Login fails on Safari" --type bug --priority 1`,
		"  bend write APP-142 plan --text-file plan.md",
		`  bend decide APP-142 "Keep the old endpoint, because mobile still calls it"`,
		"  bend link APP-150 APP-142 --kind blocked-by",
		"",
		"Run `bend <command> --help` for one command.",
	)
	return strings.Join(lines, "\n")
}

// CommandHelp is the text of `bend <command> --help`.
func CommandHelp(command *Command) string {
	lines := []string{
		command.Summary + ".",
		"",
		"Usage:",
		strings.TrimRight("  bend "+command.Name+" "+command.Usage, " "),
	}
	if command.Details != "" {
		lines = append(lines, "", command.Details)
	}
	if len(command.Options) > 0 {
		lines = append(lines, "", "Options:", columns(command.Options))
	}
	lines = append(lines, "", "Options for every command:", columns(commonOptions))
	return strings.Join(lines, "\n")
}
