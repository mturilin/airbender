// Package instructions holds the words written for agents into a
// repository, and the rules for writing them.
//
// What: Airbender's rules for a repository's AGENTS.md (rules.md, built
// into the program), the decision about what its CLAUDE.md should contain,
// and taking beads' own generated instructions out of both.
//
// Why: `bend setup instructions` writes them, from a terminal or for the
// Airbender tab, so both write the same thing (bead-bb-c9l.9). Before, the
// text and these rules were in the plugin.
//
// Design notes:
//   - Airbender's rules are the only instructions about issues a repository
//     gives its agents (bead-bb-c9l.8, the decision in bead-bb-c9l.7). Beads
//     writes instructions of its own, for its own way of working: "close the
//     issue when you are done", and a "session close protocol" printed at the
//     start of every session. That is the opposite of the workflow here, so
//     beads' text is taken out.
//   - Only text between beads' own markers is removed. Beads also writes
//     text without markers; that cannot be told safely from the owner's own,
//     so it is named for the owner and left.
//   - A rules block the owner edited is theirs and is never replaced. Ours,
//     unchanged, is known by its fingerprint, of this version or an earlier
//     one.
//   - Everything here is text in, text out. The answers are the ones the
//     plugin's TypeScript gave, held in testdata/vectors.json: a repository
//     set up by an earlier version must be read the same way.
//
// Gotchas:
//   - Changing rules.md in a way agents should get means raising the version
//     line inside it and adding the old text's fingerprint to shippedBefore,
//     or repositories with the old block are taken for edited ones and never
//     updated.
package instructions

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"regexp"
	"strings"
)

// Rules is Airbender's working rules, as written into an AGENTS.md: a block
// between marker comments, so that it can be found again and a later
// version can replace it without touching the rest of the file.
//
//go:embed rules.md
var Rules string

// rulesWithBend is the same rules for a repository whose issues are not in
// beads: every command is bend's, and nothing names beads or its program.
// It is made from Rules by the replacements in withBend, so the two cannot
// drift apart in what they ask of an agent (bead-bb-c9l.6). The names of
// the two agent tools still begin "beads_": those are the tools' names.
var rulesWithBend = withBend(Rules)

// withBend gives the rules with bend's commands in place of beads'.
//
// Panics when a passage it replaces is not in the text, so that a change to
// rules.md that this would silently miss fails every test instead.
func withBend(rules string) string {
	start := strings.Index(rules, "## Working with beads through Airbender")
	end := strings.Index(rules, "- **Standing facts are in")
	if start == -1 || end == -1 {
		panic("instructions: the opening of rules.md is not as withBend expects")
	}
	rules = rules[:start] + bendOpening + rules[end:]
	for _, pair := range [][2]string{
		{"Do not use `bd remember` for that.", "`bend remember \"...\"` adds\n  one for you."},
		{"create one first (`bd create`)", "create one first (`bend create`)"},
		{"(`bd update <id> --acceptance \"...\"`)", "(`bend write <id> done \"...\"`)"},
		{"create an issue yourself you may give it a size, with the label\n  `size:s`, `size:m` or `size:l`.", "create an issue yourself you may give it a size, with the label\n  `size:s`, `size:m` or `size:l` (`bend edit <id> --add-label size:m`)."},
		{"go on the issue (`bd comment`, `bd note`, the design\n  field).", "go on the issue (`bend comment`, `bend decide`, and\n  `bend write <id> notes`)."},
		{"Never close an issue with `bd close`", "Never close an issue with `bend close`"},
	} {
		if !strings.Contains(rules, pair[0]) {
			panic("instructions: rules.md no longer holds: " + pair[0])
		}
		rules = strings.Replace(rules, pair[0], pair[1], 1)
	}
	return rules
}

// bendOpening is how the rules open where the commands are bend's.
const bendOpening = "## Working with issues through Airbender\n" +
	"\n" +
	"This repository's issues are worked from the Airbender tab in BB, and read\n" +
	"and changed with the `bend` command, whatever tracker holds them. These are\n" +
	"the instructions for working on issues here; follow them whenever you work\n" +
	"on one.\n" +
	"\n" +
	"The commands you need (`bend <command> --help` says more, and `bend status`\n" +
	"says which tracker this repository uses):\n" +
	"\n" +
	"- `bend show <id>` and `bend comments <id>`: read an issue and its history.\n" +
	"- `bend write <id> description \"...\"`, `bend write <id> done \"...\"` and\n" +
	"  `bend write <id> plan \"...\"`: write what is wanted, what \"done\" means,\n" +
	"  and the plan. `bend start <id>`: mark it started.\n" +
	"- `bend comment <id> \"...\"`: record a surprise or a hand-over;\n" +
	"  `bend decide <id> \"...\"`: record a decision and its reason.\n" +
	"- `bend create \"...\" --from <id>`: follow-up work, linked to the issue it\n" +
	"  came from.\n" +
	"- `bend link <id> <other-id> --kind blocked-by`: this issue waits for the\n" +
	"  other one.\n" +
	"- `bend list` and `bend ready`: what there is, and what can be worked on.\n" +
	"\n"

// RulesFor gives the rules for a repository by its tracker: beads' own
// commands where the issues are in beads ("beads", or "" for a tracker not
// chosen yet), bend's everywhere else.
func RulesFor(tracker string) string {
	if tracker == "" || tracker == "beads" {
		return Rules
	}
	return rulesWithBend
}

const (
	// RulesStart and rulesEnd mark the start and end of Airbender's block
	// inside an AGENTS.md.
	RulesStart = "<!-- airbender:rules:start -->"
	rulesEnd   = "<!-- airbender:rules:end -->"
	// FactsFile is the file standing facts are kept in, at a repository's
	// root.
	FactsFile = "FACTS.md"
	// AgentsFile and ClaudeFile are the two instruction files.
	AgentsFile = "AGENTS.md"
	ClaudeFile = "CLAUDE.md"
)

// shippedBefore is the rules as earlier versions wrote them, by fingerprint
// (SHA-256 of the block with every run of white space made one space).
//
// A block that matches one is ours, unchanged, and may be replaced by the
// current text. A block that matches none was edited by the owner, and
// replacing it would throw their text away; such a block is left alone and
// the owner is told.
var shippedBefore = []string{
	// Version 1: before bead-bb-c9l.8, with the sentence about taking
	// precedence over beads' own instructions.
	"bcf270710cd722894f17bde63d8aa46944be782add371ede632d38a44bb47783",
}

// rulesBlock gives the rules block of an AGENTS.md, markers included; ok is
// false when there is none.
func rulesBlock(agentsFile string) (block string, ok bool) {
	start := strings.Index(agentsFile, RulesStart)
	if start == -1 {
		return "", false
	}
	end := strings.Index(agentsFile[start:], rulesEnd)
	if end == -1 {
		return agentsFile[start:], true
	}
	return agentsFile[start : start+end+len(rulesEnd)], true
}

// fingerprint gives a text's fingerprint, as kept in shippedBefore.
func fingerprint(text string) string {
	sum := sha256.Sum256([]byte(strings.Join(strings.Fields(text), " ")))
	return hex.EncodeToString(sum[:])
}

// RulesIn says which rules an AGENTS.md holds: "current", this version's;
// "old", an earlier version's, unchanged, which may be replaced; "edited", a
// block the owner changed, of whatever version, which is theirs and is left
// alone; "none", no block.
//
// tracker is the repository's tracker (see RulesFor). The current rules for
// another tracker count as "old": they are ours, unchanged, and are replaced
// when a repository's tracker is changed.
func RulesIn(agentsFile, tracker string) string {
	block, ok := rulesBlock(agentsFile)
	if !ok {
		return "none"
	}
	print := fingerprint(block)
	if print == fingerprint(RulesFor(tracker)) {
		return "current"
	}
	if print == fingerprint(Rules) || print == fingerprint(rulesWithBend) {
		return "old"
	}
	for _, known := range shippedBefore {
		if print == known {
			return "old"
		}
	}
	return "edited"
}

// AgentsFileWith gives an AGENTS.md with Airbender's current rules in it.
//
// An older block of ours is replaced where it stands; with no block the
// rules are added at the end, after whatever is there. A block the owner
// edited is left as it is. Nothing else in the file is touched.
//
// existing is the file's text; "" when there is no file. tracker is the
// repository's tracker (see RulesFor). Returns existing itself when the
// current rules are there, or the owner's own are.
func AgentsFileWith(existing, tracker string) string {
	rules := RulesFor(tracker)
	switch RulesIn(existing, tracker) {
	case "current", "edited":
		return existing
	case "none":
		if existing == "" {
			return rules
		}
		return strings.TrimRight(existing, "\n") + "\n\n" + rules
	}
	start := strings.Index(existing, RulesStart)
	end := strings.Index(existing[start:], rulesEnd)
	// A block without its end marker (cut by hand): replaced to the end of
	// the file, which is where the block was written.
	after := ""
	if end != -1 {
		after = strings.TrimPrefix(existing[start+end+len(rulesEnd):], "\n")
	}
	return existing[:start] + rules + after
}

// beadsBlock is a block beads generated, between its own markers: the one
// `bd init` writes ("BEGIN BEADS INTEGRATION ...") and the one `bd setup
// codex` writes ("BEGIN BEADS CODEX SETUP ..."). The markers carry a
// version and a hash that change between beads versions, so only their
// fixed start is matched. Lazy, and each block ends at the first end marker
// after it, so text between two blocks is never taken.
var beadsBlock = regexp.MustCompile(`(?s)<!-- BEGIN BEADS [^>]*-->.*?<!-- END BEADS [^>]*-->\n?`)

// HasBeadsBlocks says whether a text holds a block beads generated.
func HasBeadsBlocks(text string) bool { return beadsBlock.MatchString(text) }

// WithoutBeadsBlocks gives a text without the blocks beads generated.
//
// Only what is between beads' markers goes, markers included. Where a block
// stood, the blank lines around it are closed up to one, so no gap is left;
// nothing else changes, to the letter. Returns text itself when it holds no
// such block.
func WithoutBeadsBlocks(text string) string {
	if !HasBeadsBlocks(text) {
		return text
	}
	parts := beadsBlock.Split(text, -1)
	kept := []string{}
	for index, part := range parts {
		// The blank lines that set a removed block apart, on either side.
		if index > 0 {
			part = strings.TrimLeft(part, "\n")
		}
		if index < len(parts)-1 {
			if trimmed := strings.TrimRight(part, "\n"); trimmed != part {
				part = trimmed + "\n"
			}
		}
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.TrimRight(strings.Join(kept, "\n"), "\n") + "\n"
}

// beadsUnmarked is the sections beads writes into an AGENTS.md without
// markers, by what gives each away. They tell agents the same things the
// marked blocks do ("bd close <id> # Complete work"), but nothing marks
// where they start and end, so they are named for the owner and not
// removed.
var beadsUnmarked = []struct {
	name string
	sign *regexp.Regexp
}{
	{"the opening lines about bd prime", regexp.MustCompile("This project uses \\*\\*bd\\*\\* \\(beads\\) for issue tracking\\. Run `bd prime`")},
	{"Quick Reference", regexp.MustCompile(`(?m)^## Quick Reference\n(?s:.{0,400}?)bd close <id>`)},
	{"Session Completion", regexp.MustCompile(`(?m)^## Session Completion$`)},
	{"Beads Issue Tracker", regexp.MustCompile(`(?m)^## Beads Issue Tracker$`)},
}

// BeadsLeftovers gives the names of beads' unmarked sections found in a
// text, for the owner to remove by hand if they wish.
//
// Pre-condition: beads' marked blocks are already out of text (the last two
// signs are headings that also stand inside those blocks).
func BeadsLeftovers(text string) []string {
	found := []string{}
	for _, unmarked := range beadsUnmarked {
		if unmarked.sign.MatchString(text) {
			found = append(found, unmarked.name)
		}
	}
	return found
}

const (
	// claudeImport is the line that makes Claude Code load AGENTS.md with a
	// CLAUDE.md; factsImport the same for the facts file.
	claudeImport = "@" + AgentsFile
	factsImport  = "@" + FactsFile
)

// claudePointer is a CLAUDE.md that only points at AGENTS.md and the facts
// file.
const claudePointer = `# Project Instructions for AI Agents

The instructions for this project are in [AGENTS.md](AGENTS.md). Read that
file in full before doing anything, and follow it. Standing facts about the
project are in [` + FactsFile + `](` + FactsFile + `).

` + claudeImport + `
` + factsImport + `

This file is only a pointer, so that tools which look for ` + "`CLAUDE.md`" + ` find
the same rules as tools which look for ` + "`AGENTS.md`" + `. Do not add instructions
here; put them in ` + "`AGENTS.md`" + `.
`

// claudeImportLine finds the line that imports AGENTS.md, with whatever
// spaces the owner put around it.
var claudeImportLine = regexp.MustCompile(`(?m)^([ \t]*` + regexp.QuoteMeta(claudeImport) + `[ \t]*)$`)

// hasLine says whether a text has a line that is exactly line, spaces
// around it aside.
func hasLine(text, line string) bool {
	for _, candidate := range strings.Split(text, "\n") {
		if strings.TrimSpace(candidate) == line {
			return true
		}
	}
	return false
}

// ClaudeFileFor decides what a repository's CLAUDE.md should become.
//
// A file beads generated and nobody filled in becomes a short pointer to
// AGENTS.md; one with the owner's own text keeps it, less beads' block,
// with the two import lines added where they are missing. None is created
// where there is none.
//
// existing is the file's text; exists is false when there is no file.
// Returns the new text and true, or false when nothing is to be written.
func ClaudeFileFor(existing string, exists bool) (next string, change bool) {
	if !exists || strings.TrimSpace(existing) == "" {
		return "", false
	}
	generated := strings.Contains(existing, "<!-- BEGIN BEADS INTEGRATION") &&
		strings.Contains(existing, "_Add your build and test commands here_") &&
		strings.Contains(existing, "_Add a brief overview of your project architecture_") &&
		strings.Contains(existing, "_Add your project-specific conventions here_")
	if generated {
		return claudePointer, true
	}
	next = WithoutBeadsBlocks(existing)
	if !hasLine(next, claudeImport) {
		next = claudeImport + "\n" + factsImport + "\n\n" + next
	} else if !hasLine(next, factsImport) {
		// After the line it belongs with, wherever the owner put that.
		if at := claudeImportLine.FindStringIndex(next); at != nil {
			next = next[:at[1]] + "\n" + factsImport + next[at[1]:]
		}
	}
	return next, next != existing
}
