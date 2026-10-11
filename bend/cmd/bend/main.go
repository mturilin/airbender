// Command bend reads and changes a repository's issues, whatever tracker
// holds them.
//
// What: connects the command in internal/cli to the process: its arguments,
// standard input and output, the current folder and the exit status.
//
// Why: the command takes its surroundings as an argument so it can be
// tested; this file is the one place that hands it the real ones.
//
// Gotchas:
//   - Build it from the bend folder: `go build -o bend ./cmd/bend`. It needs
//     nothing beside it to run; the trackers' own programs (bd, and gh for a
//     GitHub login) are found on the PATH when they are needed.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/mturilin/airbender/bend/internal/cli"
)

// keyboard reads the lines a person types in answer to a question.
var keyboard = bufio.NewReader(os.Stdin)

// isTerminal says whether a file is a terminal: a character device, which a
// pipe and a regular file are not. /dev/null is one too, but is named apart:
// nobody types there.
func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	null, err := os.Stat(os.DevNull)
	return err != nil || !os.SameFile(info, null)
}

func main() {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "bend: the current folder could not be told.")
		os.Exit(1)
	}
	os.Exit(cli.Run(os.Args[1:], cli.Surroundings{
		Out: func(text string) { fmt.Fprintln(os.Stdout, text) },
		Err: func(text string) { fmt.Fprintln(os.Stderr, text) },
		Stdin: func() string {
			// Read whole, as text; nothing to read is an empty text.
			content, _ := io.ReadAll(os.Stdin)
			return string(content)
		},
		Cwd: cwd,
		// Someone is at the keyboard when standard input is a terminal and
		// not a pipe or a file.
		Interactive: isTerminal(os.Stdin),
		Ask: func(question string) string {
			fmt.Fprint(os.Stderr, question)
			line, _ := keyboard.ReadString('\n')
			return line
		},
		Attach: func(dir string, keyboard bool, name string, args ...string) int {
			command := exec.Command(name, args...)
			command.Dir = dir
			// Without a keyboard its standard input stays nothing.
			if keyboard {
				command.Stdin = os.Stdin
			}
			// To standard error, both of them: standard output is bend's
			// own answer, which a program may be reading as JSON. At a
			// terminal the two look the same.
			command.Stdout = os.Stderr
			command.Stderr = os.Stderr
			if err := command.Run(); err != nil {
				var exit *exec.ExitError
				if errors.As(err, &exit) {
					return exit.ExitCode()
				}
				return -1
			}
			return 0
		},
	}))
}
