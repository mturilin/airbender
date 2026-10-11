// parts.go — small pure helpers shared by the adapters and the command.
//
// What: keeping a written part inside another text as a marked section
// (used where a tracker has no field for it), links kept as lines of text,
// tidying a category name, and the fixed openings of decision and hand-over
// comments.
//
// Why: several trackers lack a field for something the owner's way of
// working needs, such as requirements. A marked section in the description
// keeps the text with the issue, readable by a person in the tracker's own
// screens, and recoverable exactly by this layer.
//
// Design notes:
//   - A section is delimited by HTML comments, which trackers that draw
//     Markdown do not show, around a visible heading, so the text reads
//     naturally to a person either way.
//   - Everything here is pure text work, tested in parts_test.go.

package tracker

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// openMark is the opening line of a section holding a part called name.
func openMark(name string) string { return "<!-- bend:" + name + " -->" }

// closeMark is the closing line of a section holding a part called name.
func closeMark(name string) string { return "<!-- /bend:" + name + " -->" }

var (
	// threeNewlines finds a gap of blank lines left where a section was cut.
	threeNewlines = regexp.MustCompile(`\n{3,}`)
	// sectionHeading is the visible heading JoinSection writes first inside
	// a section.
	sectionHeading = regexp.MustCompile(`^\s*##[^\n]*\n?`)
)

// SplitSection splits a text into what is outside the section called name
// and what is inside it.
//
// Returns rest, the text with the section removed and tidied, and section,
// the section's content without its heading; "" when absent.
func SplitSection(text, name string) (rest, section string) {
	start := strings.Index(text, openMark(name))
	end := -1
	if start != -1 {
		if at := strings.Index(text[start:], closeMark(name)); at != -1 {
			end = start + at
		}
	}
	if start == -1 || end == -1 {
		return strings.TrimSpace(text), ""
	}
	inside := text[start+len(openMark(name)) : end]
	outside := text[:start] + text[end+len(closeMark(name)):]
	return strings.TrimSpace(threeNewlines.ReplaceAllString(outside, "\n\n")),
		strings.TrimSpace(sectionHeading.ReplaceAllString(inside, ""))
}

// JoinSection puts a section called name at the end of a text, under a
// visible heading; an empty section leaves the text without one.
//
// Pre-condition: rest holds no section of that name (see SplitSection).
func JoinSection(rest, name, heading, section string) string {
	body := strings.TrimSpace(section)
	rest = strings.TrimSpace(rest)
	if body == "" {
		return rest
	}
	block := openMark(name) + "\n## " + heading + "\n\n" + body + "\n" + closeMark(name)
	if rest == "" {
		return block
	}
	return rest + "\n\n" + block
}

// requirementsSection is the name of the section that holds requirements
// inside a description.
const requirementsSection = "requirements"

// SplitRequirements splits a description as a tracker without a field for
// requirements holds it into the description proper and the requirements
// kept inside it.
func SplitRequirements(text string) (description, requirements string) {
	return SplitSection(text, requirementsSection)
}

// WithRequirements gives the one text a tracker without a field for
// requirements holds: the description with the requirements as a marked
// section at its end. The opposite of SplitRequirements.
func WithRequirements(description, requirements string) string {
	return JoinSection(description, requirementsSection, "Requirements", requirements)
}

// Section is one marked section to put into a text: see JoinSections.
type Section struct {
	// Name is the name in the markers, e.g. "plan".
	Name string
	// Heading is the visible heading above the content, e.g. "Plan".
	Heading string
	// Text is the content; a section with none is left out of the text.
	Text string
}

// SplitSections takes several marked sections out of a text at once.
//
// Returns rest, the text outside all of them, and each section's content by
// name; "" for one that is not there.
func SplitSections(text string, names []string) (rest string, sections map[string]string) {
	sections = map[string]string{}
	rest = text
	for _, name := range names {
		rest, sections[name] = SplitSection(rest, name)
	}
	return strings.TrimSpace(rest), sections
}

// JoinSections puts several marked sections at the end of a text, in the
// order given. The opposite of SplitSections.
//
// Pre-condition: rest holds none of these sections.
func JoinSections(rest string, sections []Section) string {
	text := strings.TrimSpace(rest)
	for _, section := range sections {
		text = JoinSection(text, section.Name, section.Heading, section.Text)
	}
	return text
}

// TextLink is a link kept as a line of text, for a tracker that has no such
// link of its own. It is written on both issues, so that showing either one
// needs no search: "out" on the issue the link is about, "in" on the other.
type TextLink struct {
	// Kind is "discovered-from" or "related".
	Kind string
	// Direction is "out" or "in"; "related" reads the same from both ends
	// and is always "out".
	Direction string
	// ID is the other issue's id.
	ID string
}

// linkWords is how each text link reads, and is recognised again.
var linkWords = []struct{ words, kind, direction string }{
	{"discovered from", "discovered-from", "out"},
	{"led to", "discovered-from", "in"},
	{"related to", "related", "out"},
}

// FormatTextLinks gives the lines of a "Links" section: one per link, as a
// list a person can read ("- discovered from #12").
//
// Pre-condition: every link's kind and direction is one of linkWords.
func FormatTextLinks(links []TextLink) string {
	lines := make([]string, 0, len(links))
	for _, link := range links {
		for _, known := range linkWords {
			if known.kind == link.Kind && known.direction == link.Direction {
				lines = append(lines, "- "+known.words+" #"+link.ID)
				break
			}
		}
	}
	return strings.Join(lines, "\n")
}

// textLinkLine is one line of a "Links" section: a list mark, the words,
// and the other issue's number.
var textLinkLine = regexp.MustCompile(`^\s*[-*]\s*(.+?)\s+#(\d+)\s*$`)

// ParseTextLinks reads the lines of a "Links" section back. A line that is
// not one of ours (a person wrote something there) is ignored, and a link
// written twice is given once.
func ParseTextLinks(section string) []TextLink {
	found := []TextLink{}
	for _, line := range strings.Split(section, "\n") {
		match := textLinkLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		for _, known := range linkWords {
			if known.words != strings.ToLower(match[1]) {
				continue
			}
			link := TextLink{Kind: known.kind, Direction: known.direction, ID: match[2]}
			seen := false
			for _, other := range found {
				seen = seen || other == link
			}
			if !seen {
				found = append(found, link)
			}
			break
		}
	}
	return found
}

// categoryMaxLength is the longest category name accepted.
const categoryMaxLength = 40

// CleanCategory tidies a typed category name: trimmed, single spaces, lower
// case.
//
// Fails with Refused when the name is empty, too long, or contains a comma
// (several trackers keep categories as labels and split labels on commas).
func CleanCategory(typed string) (string, error) {
	name := strings.ToLower(strings.Join(strings.Fields(typed), " "))
	if name == "" {
		return "", Refused("A category needs a name.")
	}
	if utf8.RuneCountInString(name) > categoryMaxLength {
		return "", Refused("A category name can be at most %d characters.", categoryMaxLength)
	}
	if strings.Contains(name, ",") {
		return "", Refused("A category name cannot contain a comma.")
	}
	return name, nil
}

// DecisionPrefix is how a comment that records a decision begins.
const DecisionPrefix = "Decision: "

// HandoverHeading is how a hand-over comment begins.
const HandoverHeading = "Hand-over"

// HandoverText gives the text of a hand-over comment.
//
// A hand-over must say three things, and "what was not checked" may not be
// left out: the owner's rule is that an agent states plainly what it did
// not test. Writing "nothing" is allowed; silence is not.
//
// Fails with a usage error when any of the three is empty.
func HandoverText(done, checked, notChecked string) (string, error) {
	missing := []string{}
	for _, part := range [][2]string{
		{"--done", done}, {"--checked", checked}, {"--not-checked", notChecked},
	} {
		if strings.TrimSpace(part[1]) == "" {
			missing = append(missing, part[0])
		}
	}
	if len(missing) > 0 {
		return "", Usage(
			"A hand-over must say what was done, how it was checked and what was not checked. Missing: %s.",
			strings.Join(missing, ", "),
		)
	}
	return strings.Join([]string{
		HandoverHeading + ": ready for the owner to validate.",
		"",
		"What was done: " + strings.TrimSpace(done),
		"",
		"How it was checked: " + strings.TrimSpace(checked),
		"",
		"Not checked: " + strings.TrimSpace(notChecked),
	}, "\n"), nil
}
