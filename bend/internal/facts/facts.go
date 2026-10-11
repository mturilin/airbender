// Package facts keeps standing facts about a repository in a file.
//
// What: saves and shows short facts every future session should know (how
// to build, a convention, a lasting preference of the owner), in the file
// FACTS.md at the repository's root.
//
// Why: the owner chose a file over a tracker's own memory ("use file"): a
// file works with every tracker, survives a fresh clone, and can be
// reviewed like any other project text. And a file of its own over a
// section of AGENTS.md (bead-bb-c9l.8): the instructions are the owner's
// and change rarely, facts are added by agents as they work, and in one
// file every new fact was a change to the owner's rules, where a careless
// edit could damage them.
//
// Design notes:
//   - One line per fact, `- **key** — text`, under a heading and a few words
//     that say what the file is for. An agent may add a line by hand, without
//     this program; the instructions tell it to.
//   - One entry per key. Saving under a key that exists replaces that line
//     where it stands, so a corrected fact does not pile up beside the old
//     one.
//   - Only fact lines are ever changed. Whatever else the owner wrote in the
//     file is left exactly as it is.
//   - Facts used to be kept in a marked section of AGENTS.md. They are still
//     read from there, and moved to FACTS.md the next time a fact is saved
//     (MoveOld), so nothing is lost and nothing is written by a read.
//   - The text functions are pure and tested; the ones at the end read and
//     write files.
//
// Gotchas:
//   - Saving a fact changes a tracked file, so it shows up as an uncommitted
//     change that has to go into some commit.
//   - A fact is one line: line breaks in the text are turned into spaces.
//   - Nothing loads FACTS.md by itself. The instructions tell agents to read
//     it, and a CLAUDE.md that points at AGENTS.md pulls it in as well
//     (server/prompts.ts in the Airbender plugin).
package facts

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// File is the file the facts of a repository are kept in, at its root.
const File = "FACTS.md"

// header is how a new facts file begins.
const header = `# Facts

Standing facts about this project, for every session: how to build and run
it, its conventions, lasting preferences of its owner. One line per fact,
under a short key, like the ones below. Keep it short: this file is read at
the start of every session.
`

const (
	// oldStart and oldEnd mark the section of AGENTS.md facts were kept in
	// before they had a file.
	oldStart = "<!-- bend:facts:start -->"
	oldEnd   = "<!-- bend:facts:end -->"
	// oldFile is the file that section was in.
	oldFile = "AGENTS.md"
)

// Fact is one remembered fact.
type Fact struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

var (
	// factLine matches a fact's line; a dash, a colon or a long dash divides
	// the key from the text.
	factLine = regexp.MustCompile(`^- \*\*(.+?)\*\*\s*(?:—|–|-|:)\s*(.*)$`)
	// notKeyLetters is everything a key made from a fact's words leaves out.
	notKeyLetters = regexp.MustCompile(`[^a-z0-9]+`)
)

// lineOf is the line a fact is written as.
func lineOf(fact Fact) string { return "- **" + fact.Key + "** — " + fact.Text }

// parseLine reads one line as a fact; ok is false when the line is not one.
func parseLine(line string) (fact Fact, ok bool) {
	match := factLine.FindStringSubmatch(strings.TrimSpace(line))
	if match == nil {
		return Fact{}, false
	}
	return Fact{Key: match[1], Text: match[2]}, true
}

// KeyFor makes a key from a fact's first words, for a fact saved without
// one.
func KeyFor(text string) string {
	words := []string{}
	for _, word := range strings.Split(notKeyLetters.ReplaceAllString(strings.ToLower(text), "-"), "-") {
		if word != "" && len(words) < 6 {
			words = append(words, word)
		}
	}
	return strings.Join(words, "-")
}

// Read gives the facts held in a text: every line that is a fact's line, in
// order.
func Read(file string) []Fact {
	found := []Fact{}
	for _, line := range strings.Split(file, "\n") {
		if fact, ok := parseLine(line); ok {
			found = append(found, fact)
		}
	}
	return found
}

// WithFact gives a facts file's text with one fact saved in it.
//
// A line with the same key is replaced where it stands; otherwise the fact
// is added after the last line. An empty text becomes a new file with its
// heading. Every other line is untouched.
//
// Returns the new text, and whether a fact was replaced.
func WithFact(file string, fact Fact) (text string, replaced bool) {
	if strings.TrimSpace(file) == "" {
		file = header
	}
	lines := strings.Split(strings.TrimRight(file, "\n"), "\n")
	at := -1
	for index, line := range lines {
		if known, ok := parseLine(line); ok && known.Key == fact.Key {
			at = index
			break
		}
	}
	if at != -1 {
		lines[at] = lineOf(fact)
	} else {
		// A blank line between the words above and the first fact; none
		// between facts.
		last := strings.TrimSpace(lines[len(lines)-1])
		if _, isFact := parseLine(last); last != "" && !isFact {
			lines = append(lines, "")
		}
		lines = append(lines, lineOf(fact))
	}
	return strings.Join(lines, "\n") + "\n", at != -1
}

// SplitOld gives the facts in the old section of an AGENTS.md, and that
// text without the section. Pure.
//
// Returns facts (none when there is no section) and rest, which is file
// itself when there is none.
func SplitOld(file string) (found []Fact, rest string) {
	start := strings.Index(file, oldStart)
	end := -1
	if start != -1 {
		if at := strings.Index(file[start:], oldEnd); at != -1 {
			end = start + at
		}
	}
	if start == -1 || end == -1 {
		return []Fact{}, file
	}
	parts := []string{}
	for _, part := range []string{
		strings.TrimRight(file[:start], "\n"),
		strings.Trim(file[end+len(oldEnd):], "\n"),
	} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	return Read(file[start:end]), strings.Join(parts, "\n\n") + "\n"
}

// textOf gives a file's text, or "" when there is no such file.
func textOf(path string) (string, error) {
	content, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", tracker.Refused("The file %s could not be read.", path)
	}
	return string(content), nil
}

// write replaces a file's content, as a refusal in plain words when it
// cannot be written.
func write(path, text string) error {
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return tracker.Refused("The file %s could not be written.", path)
	}
	return nil
}

// EnsureFile makes sure the repository at root has a facts file, so that
// whatever points at it (the instructions, a CLAUDE.md) finds one.
//
// Returns whether the file was created now.
// Side effects: writes FACTS.md, with its heading and no facts, when there
// is none; nothing otherwise.
func EnsureFile(root string) (created bool, err error) {
	path := filepath.Join(root, File)
	if _, statErr := os.Stat(path); statErr == nil {
		return false, nil
	}
	return true, write(path, header)
}

// Add saves several facts for the repository at root, each under its key.
//
// Returns how many were new and how many replaced one.
// Side effects: writes FACTS.md in root (created when missing).
func Add(root string, facts []Fact) (added, replaced int, err error) {
	path := filepath.Join(root, File)
	text, err := textOf(path)
	if err != nil {
		return 0, 0, err
	}
	for _, fact := range facts {
		var was bool
		text, was = WithFact(text, Fact{
			Key:  strings.TrimSpace(strings.ReplaceAll(fact.Key, "*", "")),
			Text: strings.Join(strings.Fields(fact.Text), " "),
		})
		if was {
			replaced++
		}
	}
	if len(facts) > 0 {
		if err := write(path, text); err != nil {
			return 0, 0, err
		}
	}
	return len(facts) - replaced, replaced, nil
}

// MoveOld moves facts from the old section of AGENTS.md into FACTS.md.
//
// A fact whose key FACTS.md already holds is not moved over it: the file is
// the newer place. The section is removed from AGENTS.md either way, and
// nothing else in that file changes.
//
// Returns how many facts were moved; 0 when there was no section.
// Side effects: may write FACTS.md and AGENTS.md in root.
func MoveOld(root string) (int, error) {
	oldPath := filepath.Join(root, oldFile)
	old, err := textOf(oldPath)
	if err != nil {
		return 0, err
	}
	found, rest := SplitOld(old)
	if rest == old {
		return 0, nil
	}
	current, err := textOf(filepath.Join(root, File))
	if err != nil {
		return 0, err
	}
	held := map[string]bool{}
	for _, fact := range Read(current) {
		held[fact.Key] = true
	}
	moving := []Fact{}
	for _, fact := range found {
		if !held[fact.Key] {
			moving = append(moving, fact)
		}
	}
	if _, _, err := Add(root, moving); err != nil {
		return 0, err
	}
	return len(moving), write(oldPath, rest)
}

// Remember saves a fact for the repository at root.
//
// key is the fact's name; made from its first words when "". Saving under
// an existing key replaces that fact.
//
// Returns the key it was saved under, and whether it replaced one. Fails
// with a usage error when the text is empty.
// Side effects: writes FACTS.md in root (created when missing); facts still
// in the old section of AGENTS.md are moved over first, which rewrites that
// file once.
func Remember(root, text, key string) (savedKey string, replaced bool, err error) {
	fact := strings.Join(strings.Fields(text), " ")
	if fact == "" {
		return "", false, tracker.Usage("A fact needs some text.")
	}
	name := strings.TrimSpace(key)
	if name == "" {
		name = KeyFor(fact)
	}
	name = strings.ReplaceAll(name, "*", "")
	if name == "" {
		return "", false, tracker.Usage("A fact needs a key.")
	}
	if _, err := MoveOld(root); err != nil {
		return "", false, err
	}
	_, count, err := Add(root, []Fact{{Key: name, Text: fact}})
	return name, count == 1, err
}

// Recall gives the facts saved for the repository at root: those in
// FACTS.md, then any still in the old section of AGENTS.md whose key the
// file lacks.
//
// words, when given, narrow to facts whose key or text contains every one
// of them (any case).
// Side effects: reads files only.
func Recall(root string, words []string) ([]Fact, error) {
	file, err := textOf(filepath.Join(root, File))
	if err != nil {
		return nil, err
	}
	old, err := textOf(filepath.Join(root, oldFile))
	if err != nil {
		return nil, err
	}
	all := Read(file)
	held := map[string]bool{}
	for _, fact := range all {
		held[fact.Key] = true
	}
	oldFacts, _ := SplitOld(old)
	for _, fact := range oldFacts {
		if !held[fact.Key] {
			all = append(all, fact)
		}
	}
	found := []Fact{}
	for _, fact := range all {
		text := strings.ToLower(fact.Key + " " + fact.Text)
		wanted := true
		for _, word := range words {
			wanted = wanted && strings.Contains(text, strings.ToLower(word))
		}
		if wanted {
			found = append(found, fact)
		}
	}
	return found, nil
}
