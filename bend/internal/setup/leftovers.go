// leftovers.go — what beads' own agent setup leaves behind, to be removed.
//
// What: finds, under a repository's main folder, the files beads' setup for
// a coding agent left that hold nothing of the owner's (a hooks file with
// only beads' hooks or none, Codex's config with only beads' switch,
// beads' Codex skill), and removes them with the folders left empty.
//
// Why: the owner's rule (bead-bb-cnv): every file Airbender or beads
// touches is committed, ignored or removed, and setup leaves nothing in
// between. Beads' agent setup belongs to "removed" (Airbender's
// instructions replace it, bead-bb-c9l.8), but beads' own removal does not
// finish: `bd setup codex --remove` leaves .codex/config.toml with an empty
// [features], `bd setup claude --remove` leaves .claude/settings.json as
// {"hooks": {}}, and an older beads wrote a Codex hook (`bd prime
// --hook-json`) that the newer one does not recognise. minisaba was left
// with such a file uncommitted.
//
// Design notes:
//   - A file is removed only when its whole content is beads': every hook
//     in it is beads' (or there is none), and nothing else is in it. A file
//     that also holds the owner's settings is never rewritten here; beads'
//     own removal takes its entries out, and what it cannot is named.
//   - Read only from the main folder, where these files live (bead-bb-ak0).
//
// Gotchas:
//   - The checks know what beads 1.3.1 writes (tried 2026-10-15): .codex/
//     hooks.json, .codex/config.toml ([features] hooks = true),
//     .agents/skills/beads/, .claude/settings.json.
package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// beadsCommand is the mark of a hook beads installed, in any of its forms.
var beadsCommand = regexp.MustCompile(`\bbd (prime|codex-hook)\b`)

// leftoverPlaces are, per agent, the files and folders beads' setup for it
// may leave, relative to the main folder.
var leftoverPlaces = map[string][]string{
	"claude": {".claude/settings.json", ".claude/settings.local.json"},
	"codex":  {".codex/hooks.json", ".codex/config.toml", ".agents/skills/beads"},
}

// emptiedFolders are removed, in this order, when nothing is left in them.
var emptiedFolders = []string{".codex", ".claude", ".agents/skills", ".agents"}

// onlyBeadsHooks says whether a hooks file holds nothing but hooks, all of
// them beads' (or none at all). False for anything it cannot read.
func onlyBeadsHooks(text string) bool {
	var whole map[string]json.RawMessage
	if json.Unmarshal([]byte(text), &whole) != nil {
		return false
	}
	for key := range whole {
		if key != "hooks" {
			return false
		}
	}
	var hooks map[string][]struct {
		Hooks []struct {
			Command string `json:"command"`
		} `json:"hooks"`
	}
	if raw, there := whole["hooks"]; there && json.Unmarshal(raw, &hooks) != nil {
		return false
	}
	for _, groups := range hooks {
		for _, group := range groups {
			for _, hook := range group.Hooks {
				if !beadsCommand.MatchString(hook.Command) {
					return false
				}
			}
		}
	}
	return true
}

// onlyBeadsCodexConfig says whether a Codex config holds nothing but what
// beads put there: the [features] table, with or without hooks = true.
func onlyBeadsCodexConfig(text string) bool {
	seen := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
		case line == "[features]" || strings.ReplaceAll(line, " ", "") == "hooks=true":
			seen = true
		default:
			return false
		}
	}
	return seen
}

// beadsLeftovers gives, per agent id, the paths under home that beads'
// agent setup left and that hold nothing of the owner's.
//
// Side effects: reads a few small files.
func beadsLeftovers(home string) map[string][]string {
	found := map[string][]string{}
	for id, places := range leftoverPlaces {
		for _, place := range places {
			path := filepath.Join(home, place)
			info, err := os.Stat(path)
			if err != nil {
				continue
			}
			left := false
			switch {
			case info.IsDir():
				left = filepath.Base(place) == "beads"
			case strings.HasSuffix(place, ".toml"):
				left = onlyBeadsCodexConfig(textOf(path))
			default:
				left = onlyBeadsHooks(textOf(path))
			}
			if left {
				found[id] = append(found[id], place)
			}
		}
	}
	return found
}

// removeLeftovers deletes these paths under home, then the folders left
// empty.
//
// Side effects: deletes files and folders.
func removeLeftovers(home string, places []string) error {
	for _, place := range places {
		if err := os.RemoveAll(filepath.Join(home, place)); err != nil {
			return err
		}
	}
	for _, folder := range emptiedFolders {
		// Remove fails on a folder that still holds something: kept.
		os.Remove(filepath.Join(home, folder))
	}
	return nil
}
