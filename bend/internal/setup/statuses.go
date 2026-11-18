// statuses.go — install the three terminal Beads statuses without losing
// the owner's existing status configuration (bead-bb-o6j).
//
// Read-only inspection computes the merged value; only the confirmed issues
// step writes it. A name in a conflicting category is refused, not replaced.
package setup

import (
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// mergeEndings preserves configured entries and appends the missing endings.
// It returns the merged setting, whether a write is needed, or a conflict.
func mergeEndings(existing string) (string, bool, error) {
	entries := []string{}
	known := map[string]string{}
	for _, entry := range strings.Split(strings.TrimSpace(existing), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, category, _ := strings.Cut(entry, ":")
		known[name] = category
		entries = append(entries, entry)
	}
	changed := false
	for _, name := range []string{"cancelled", "duplicate", "verified"} {
		if category, there := known[name]; there {
			if category != "done" {
				return "", false, tracker.Refused("Beads status %s is already configured outside the done category. Resolve that conflict before setup can continue.", name)
			}
			continue
		}
		entries = append(entries, name+":done")
		changed = true
	}
	return strings.Join(entries, ","), changed, nil
}

// endingStatuses reads the project setting; an unset key is the empty list.
func endingStatuses(state *State) (string, bool, error) {
	existing, ok := quiet(state.Root, 10*time.Second, state.bd, "config", "get", "status.custom")
	if !ok {
		return "", false, tracker.Refused("Beads' custom-status setting could not be read.")
	}
	// Beads prints a successful sentinel, not an empty value, for an unset key.
	if existing == "status.custom (not set)" {
		existing = ""
	}
	return mergeEndings(existing)
}

// configureEndings writes only the merged status setting, after the caller's
// confirmation. A second invocation runs no write command.
func configureEndings(state *State, terminal Terminal) error {
	merged, needed, err := endingStatuses(state)
	if err != nil {
		return err
	}
	if !needed {
		return nil
	}
	return ran(terminal.Run(state.Root, state.bd, "config", "set", "status.custom", merged), "Configuring issue endings")
}
