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
	"slices"
	"strconv"
	"strings"
)

// Rules is Airbender's working rules, as written into an AGENTS.md: a block
// between marker comments, so that it can be found again and a later
// version can replace it without touching the rest of the file.
//
//go:embed rules.md
var Rules string

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
	// Version 2, in its two wordings: the one that named beads' own
	// commands, and the one made from it for other trackers
	// (bead-bb-c9l.6). Both are replaced by the one wording that names
	// bend for every tracker (bead-bb-c9l.10).
	"f3d93fe8206c7d41aa1897ae447556394acc3cb55dae0db3477f62f6994285bc",
	"6b9afa03138a5c40b192fa122019b7f09f224501aa838d86bc9230f9f844c828",
	// Version 3: the one wording that names bend, which said to read
	// FACTS.md at the start. Version 4 names it as a link, the place to
	// store facts and memories, not loaded for the agent (bead-bb-c9l.12).
	"412b7449d6f699b31fdb1a9ec348ac72f5f51cbf6393de21969ca2cf4999faee",
}

// versionLine is the line of a rules block that says which version of the
// rules it holds, or was last compared with.
var versionLine = regexp.MustCompile(`<!-- airbender:rules:version (\d+) -->`)

// versionOf gives the version a rules block names; 0 when it names none (a
// block from before versions were written, or one whose line was removed).
func versionOf(block string) int {
	found := versionLine.FindStringSubmatch(block)
	if found == nil {
		return 0
	}
	number, _ := strconv.Atoi(found[1])
	return number
}

// CurrentVersion is the version of the rules this bend writes.
var CurrentVersion = versionOf(Rules)

// VersionIn gives the version the rules block of an AGENTS.md names; 0 when
// there is no block or it names none.
func VersionIn(agentsFile string) int {
	block, _ := rulesBlock(agentsFile)
	return versionOf(block)
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
// alone; "behind", a block the owner changed that names an earlier version
// than this one, or none: theirs too, but the rules have changed since, and
// the owner is asked whether to take the current ones or keep theirs
// (bead-bb-c9l.10: "instructions of a vendor will be updating over time. So
// we need the ability to reduce the drift"); "none", no block.
func RulesIn(agentsFile string) string {
	block, ok := rulesBlock(agentsFile)
	if !ok {
		return "none"
	}
	print := fingerprint(block)
	if print == fingerprint(Rules) {
		return "current"
	}
	for _, known := range shippedBefore {
		if print == known {
			return "old"
		}
	}
	// Only an earlier version is behind. A later one was written by a newer
	// bend than this (a colleague's, another machine's): it is not this
	// bend's to judge, and is left as the owner's.
	if versionOf(block) < CurrentVersion {
		return "behind"
	}
	return "edited"
}

// RulesEnd says whether the rules block of an AGENTS.md has its end marker.
// Without it nothing says where the block stops and the owner's own text
// begins, so the block cannot be replaced safely.
func RulesEnd(agentsFile string) bool {
	start := strings.Index(agentsFile, RulesStart)
	return start != -1 && strings.Contains(agentsFile[start:], rulesEnd)
}

// ReplaceRules gives an AGENTS.md with its rules block replaced by the
// current rules, whatever the block holds, and the block that was there, so
// that a caller can keep it somewhere before it is gone.
//
// For a block the owner changed, when they chose the current rules over
// their own. With no block the rules are added at the end and was is "".
func ReplaceRules(existing string) (next, was string) {
	block, ok := rulesBlock(existing)
	if !ok {
		return AgentsFileWith(existing), ""
	}
	start := strings.Index(existing, RulesStart)
	after := strings.TrimPrefix(existing[start+len(block):], "\n")
	return existing[:start] + Rules + after, block
}

// KeepRules gives an AGENTS.md whose rules block, changed by its owner, is
// marked as compared with the current version: its version line names the
// current version (added under the start marker where there is none).
// Nothing else in the block changes. The owner is then not asked again
// until the rules change once more.
func KeepRules(existing string) string {
	block, ok := rulesBlock(existing)
	if !ok {
		return existing
	}
	current := "<!-- airbender:rules:version " + strconv.Itoa(CurrentVersion) + " -->"
	marked := block
	if at := versionLine.FindStringIndex(block); at != nil {
		// The first such line is the block's own; one further down is the
		// owner's text (a quoted example, say) and is left alone.
		marked = block[:at[0]] + current + block[at[1]:]
	} else {
		marked = strings.Replace(block, RulesStart, RulesStart+"\n"+current, 1)
	}
	start := strings.Index(existing, RulesStart)
	return existing[:start] + marked + existing[start+len(block):]
}

// AgentsFileWith gives an AGENTS.md with Airbender's current rules in it.
//
// An older block of ours is replaced where it stands; with no block the
// rules are added at the end, after whatever is there. A block the owner
// edited is left as it is. Nothing else in the file is touched.
//
// existing is the file's text; "" when there is no file. Returns existing
// itself when the current rules are there, or the owner's own are.
func AgentsFileWith(existing string) string {
	rules := Rules
	switch RulesIn(existing) {
	case "current", "edited", "behind":
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
	// agentsImport and factsImport are the lines that make Claude Code load
	// AGENTS.md and the facts file from a CLAUDE.md. Setup wrote them until
	// bead-bb-c9l.12; it now only takes them out (see WithoutImports).
	agentsImport = "@" + AgentsFile
	factsImport  = "@" + FactsFile
)

// claudePointer is the CLAUDE.md that setup wrote in place of one beads had
// generated: a file that only points at AGENTS.md and the facts file. Kept
// to be recognised, so that none of it is taken for the owner's own text.
const claudePointer = `# Project Instructions for AI Agents

The instructions for this project are in [AGENTS.md](AGENTS.md). Read that
file in full before doing anything, and follow it. Standing facts about the
project are in [` + FactsFile + `](` + FactsFile + `).

` + agentsImport + `
` + factsImport + `

This file is only a pointer, so that tools which look for ` + "`CLAUDE.md`" + ` find
the same rules as tools which look for ` + "`AGENTS.md`" + `. Do not add instructions
here; put them in ` + "`AGENTS.md`" + `.
`

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

// importLines gives, for each line of a text, whether it is one of the two
// import lines as setup wrote them: the whole line, starting at its first
// column, outside any fenced block of code. A line that only looks like
// one, in an example the owner wrote (indented, or inside a fence), is
// theirs and is not counted.
func importLines(lines []string) []bool {
	found := make([]bool, len(lines))
	fenced := false
	for index, line := range lines {
		bare := strings.TrimRight(line, " \t\r")
		if strings.HasPrefix(strings.TrimSpace(bare), "```") || strings.HasPrefix(strings.TrimSpace(bare), "~~~") {
			fenced = !fenced
			continue
		}
		found[index] = !fenced && (bare == agentsImport || bare == factsImport)
	}
	return found
}

// HasImports says whether a text has a line that imports AGENTS.md or the
// facts file (see importLines for what counts).
func HasImports(text string) bool {
	return slices.Contains(importLines(strings.Split(text, "\n")), true)
}

// WithoutImports gives a text without the lines that import AGENTS.md and
// the facts file.
//
// Why: setup used to add them to a CLAUDE.md so that Claude Code loaded
// the rules and the facts. The owner (bead-bb-c9l.12): "@FACTS.md should
// not exist in any of the repositories", and the rules are in AGENTS.md
// itself or reached by a link. Through a CLAUDE.md that is a link to
// AGENTS.md the lines were written into AGENTS.md, a file importing
// itself; this takes them out there too.
//
// Only the lines themselves go, and the one blank line setup put under
// them where that would otherwise leave two blank lines together or one at
// the very top. Nothing else in the text is touched; a text that has none
// is given back as it came.
func WithoutImports(text string) string {
	lines := strings.Split(text, "\n")
	found := importLines(lines)
	if !slices.Contains(found, true) {
		return text
	}
	blank := func(line string) bool { return strings.TrimSpace(line) == "" }
	kept := []string{}
	for index := 0; index < len(lines); index++ {
		if !found[index] {
			kept = append(kept, lines[index])
			continue
		}
		// The blank line under the last of a run of import lines, when
		// what stands above the run is the top of the file or a blank
		// line too.
		last := index+1 >= len(lines) || !found[index+1]
		above := len(kept) == 0 || blank(kept[len(kept)-1])
		if last && above && index+1 < len(lines)-1 && blank(lines[index+1]) {
			index++
		}
	}
	return strings.Join(kept, "\n")
}

// generatedLines are the lines of the CLAUDE.md beads generates, outside
// its marked block: its heading, its opening sentence and three sections
// with a placeholder each. They are beads' words, not the owner's.
var generatedLines = []string{
	"# Project Instructions for AI Agents",
	"This file provides instructions and context for AI coding agents working on this project.",
	"## Build & Test",
	"_Add your build and test commands here_",
	"```bash",
	"# Example:",
	"# npm install",
	"# npm test",
	"```",
	"## Architecture Overview",
	"_Add a brief overview of your project architecture_",
	"## Conventions & Patterns",
	"_Add your project-specific conventions here_",
}

// spaces finds every run of white space, for comparing texts by their words.
var spaces = regexp.MustCompile(`\s+`)

// OwnText gives what is the owner's own in a CLAUDE.md: the text less
// beads' generated block, Airbender's rules block, the import lines, the
// pointer text setup itself once wrote, and the lines of the file beads
// generates. "" when nothing is left.
//
// It is what must not be lost when the file is made a link to AGENTS.md.
// Whatever cannot be told for certain to be somebody else's counts as the
// owner's: a section they added to a generated file is theirs, although
// beads' placeholders still stand beside it.
func OwnText(claudeFile string) string {
	text := WithoutImports(WithoutBeadsBlocks(claudeFile))
	if block, ok := rulesBlock(text); ok {
		text = strings.Replace(text, block, "", 1)
	}
	// The pointer file, compared by its words: an editor may have reflowed
	// it. In both forms setup wrote: with the sentence about the facts
	// file, and, before there was one, without it.
	words := func(of string) string { return strings.TrimSpace(spaces.ReplaceAllString(of, " ")) }
	pointer := words(WithoutImports(claudePointer))
	earlier := strings.Replace(pointer, " Standing facts about the project are in ["+FactsFile+"]("+FactsFile+").", "", 1)
	if got := words(text); got == pointer || got == earlier {
		return ""
	}
	// The lines beads generates, each taken out once; what is left is the
	// owner's, with runs of blank lines made one.
	left := slices.Clone(generatedLines)
	kept := []string{}
	for _, line := range strings.Split(text, "\n") {
		bare := strings.TrimSpace(line)
		if at := slices.Index(left, bare); at != -1 && bare != "" {
			left = slices.Delete(left, at, at+1)
			continue
		}
		if bare == "" && (len(kept) == 0 || strings.TrimSpace(kept[len(kept)-1]) == "") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// CarriedInto gives an AGENTS.md with a CLAUDE.md's own text added at its
// end, for when that file becomes a link: a link shows only AGENTS.md, and
// what the owner wrote in CLAUDE.md must not vanish from every agent's
// view. Text already in AGENTS.md word for word is not added again.
func CarriedInto(agentsFile, own string) string {
	own = strings.TrimSpace(own)
	if own == "" || strings.Contains(agentsFile, own) {
		return agentsFile
	}
	if strings.TrimSpace(agentsFile) == "" {
		return own + "\n"
	}
	return strings.TrimRight(agentsFile, "\n") + "\n\n" + own + "\n"
}
