// args.go — reading a command line.
//
// What: turns the words after a command's name into positional arguments
// and options, checked against what that command accepts.
//
// Why: bend has some twenty commands with a handful of options each. One
// small reader keeps their behaviour the same everywhere: `--name value`
// and `--name=value` both work, an unknown option is a usage error that
// names it, and `--` ends the options so any text can follow.
//
// Design notes:
//   - Written by hand rather than with the standard flag package or a
//     library: bend's messages are its own and part of what callers rely on,
//     options may come before or after the positional arguments, and this is
//     the whole of what is needed.
//   - Pure and tested (args_test.go).

package cli

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// OptionSpec says which options a command accepts. Names are given without
// the dashes.
type OptionSpec struct {
	// Values are options that take a value: `--type bug`.
	Values []string
	// Lists are options that take a value and may be given several times.
	Lists []string
	// Flags are options that are simply present or not: `--top`.
	Flags []string
	// Short are the one-letter forms, e.g. {"C": "dir", "h": "help"}.
	Short map[string]string
}

// Parsed is what was read from a command line.
type Parsed struct {
	Positionals []string
	Values      map[string]string
	Lists       map[string][]string
	Flags       map[string]bool
}

// value gives an option's value, or nil when it was not given.
func (parsed *Parsed) value(name string) *string {
	if value, given := parsed.Values[name]; given {
		return &value
	}
	return nil
}

// ParseArgs reads words against spec.
//
// Fails with a usage error for an option the command does not accept, an
// option missing its value, or a value given to an option that takes none.
func ParseArgs(words []string, spec OptionSpec) (*Parsed, error) {
	parsed := &Parsed{
		Positionals: []string{},
		Values:      map[string]string{},
		Lists:       map[string][]string{},
		Flags:       map[string]bool{},
	}
	for at := 0; at < len(words); at++ {
		word := words[at]
		if word == "--" {
			parsed.Positionals = append(parsed.Positionals, words[at+1:]...)
			break
		}
		// A lone "-" is a value ("read from standard input"), not an option.
		if !strings.HasPrefix(word, "-") || word == "-" {
			parsed.Positionals = append(parsed.Positionals, word)
			continue
		}
		var name string
		var inline *string
		if strings.HasPrefix(word, "--") {
			name = word[2:]
			if equals := strings.Index(word, "="); equals != -1 {
				name = word[2:equals]
				inline = tracker.Ptr(word[equals+1:])
			}
		} else {
			long, known := spec.Short[word[1:]]
			if !known {
				// The usual cause of a long "option" is text that begins
				// with a dash.
				if len(word) > 2 {
					return nil, tracker.Usage("Unknown option %s. If this is text that starts with a dash, put -- before it or use --text-file.", word)
				}
				return nil, tracker.Usage("Unknown option %s.", word)
			}
			name = long
		}
		if slices.Contains(spec.Flags, name) {
			if inline != nil {
				return nil, tracker.Usage("Option --%s does not take a value.", name)
			}
			parsed.Flags[name] = true
			continue
		}
		isList := slices.Contains(spec.Lists, name)
		if !isList && !slices.Contains(spec.Values, name) {
			return nil, tracker.Usage("Unknown option --%s.", name)
		}
		var value string
		switch {
		case inline != nil:
			value = *inline
		case at+1 < len(words):
			at++
			value = words[at]
		default:
			return nil, tracker.Usage("Option --%s needs a value.", name)
		}
		if isList {
			parsed.Lists[name] = append(parsed.Lists[name], value)
		} else {
			parsed.Values[name] = value
		}
	}
	return parsed, nil
}

// priorityForm is a priority as typed: 0 to 4, with or without a "p".
var priorityForm = regexp.MustCompile(`^(?i:p)?([0-4])$`)

// ParsePriority reads a priority typed as `2` or `p2`, as a number from 0
// to 4.
//
// Fails with a usage error for anything else.
func ParsePriority(typed string) (int, error) {
	match := priorityForm.FindStringSubmatch(strings.TrimSpace(typed))
	if match == nil {
		return 0, tracker.Usage("A priority is a number from 0 to 4, not \"%s\".", typed)
	}
	return strconv.Atoi(match[1])
}
