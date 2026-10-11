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
	"fmt"
	"io"
	"os"

	"github.com/mturilin/airbender/bend/internal/cli"
)

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
	}))
}
