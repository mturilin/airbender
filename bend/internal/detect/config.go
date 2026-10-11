// config.go — a repository's own word on which tracker it uses.
//
// What: reads the setting file `.bend.json` at a repository's root.
//
// Why: most repositories need no setting: a `.beads` folder means beads,
// and otherwise a GitHub remote means GitHub issues. But a repository can
// have both (every beads repository pushed to GitHub does), and the owner
// decided that such a repository says which one it uses in a small
// checked-in file (bead-bb-c9l.1), so that the choice travels with the
// code and is the same for everyone who clones it.
//
// Design notes:
//   - A file that cannot be understood is a refusal that names the file, not
//     a silent fall back to guessing: guessing the wrong tracker would send
//     an agent's issues to the wrong place.

package detect

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// SettingFile is the setting file's name, at a repository's root.
const SettingFile = ".bend.json"

// TrackerNames are the trackers a repository can name.
var TrackerNames = []string{"beads", "github"}

// Setting is what a setting file says; a field left "" is not decided by it.
type Setting struct {
	Tracker string
	// Repository is, for GitHub, "owner/name"; else the remote called origin
	// decides.
	Repository string
}

// repositoryName is how a repository is written: "owner/name".
var repositoryName = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// asWritten gives a JSON value as it stands in the file, on one line, for a
// message about it.
func asWritten(raw json.RawMessage) string {
	var compact bytes.Buffer
	if json.Compact(&compact, raw) != nil {
		return string(raw)
	}
	return compact.String()
}

// ReadSetting reads the setting file of a folder.
//
// Returns what it says, or nil when the folder has none.
// Fails with Refused when the file is there but cannot be understood: not
// JSON, an unknown tracker, or a repository not written "owner/name".
// Side effects: reads the file system only.
func ReadSetting(folder string) (*Setting, error) {
	file := filepath.Join(folder, SettingFile)
	content, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, tracker.Refused("%s could not be read.", file)
	}
	if !json.Valid(content) {
		return nil, tracker.Refused("%s is not valid JSON.", file)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(content, &fields) != nil || fields == nil {
		return nil, tracker.Refused(`%s must hold one object, like {"tracker": "github"}.`, file)
	}
	setting := &Setting{}
	if raw, given := fields["tracker"]; given {
		if json.Unmarshal(raw, &setting.Tracker) != nil || !slices.Contains(TrackerNames, setting.Tracker) {
			return nil, tracker.Refused("%s names the tracker %s. It can be: %s.",
				file, asWritten(raw), strings.Join(TrackerNames, ", "))
		}
	}
	if raw, given := fields["repository"]; given {
		if json.Unmarshal(raw, &setting.Repository) != nil || !repositoryName.MatchString(setting.Repository) {
			return nil, tracker.Refused(`%s names the repository %s. Write it as "owner/name".`, file, asWritten(raw))
		}
	}
	return setting, nil
}
