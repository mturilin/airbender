// find.go — where the beads program is on this machine.
//
// What: looks for `bd`, and says whether some other program is installed.
//
// Why: a program started by a desktop app (the Airbender tab's server) may
// have a shorter PATH than a shell, and an install made a moment ago may
// have put bd in a folder that is on no PATH yet. Looking in the usual
// places as well means "it is installed" and "it can be run" agree.

package beads

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// usualFolders are where programs a person installs for themselves usually
// go, beside the folders on the PATH.
func usualFolders() []string {
	folders := []string{}
	if home, err := os.UserHomeDir(); err == nil {
		folders = append(folders,
			filepath.Join(home, ".local", "share", "mise", "shims"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "go", "bin"))
	}
	return append(folders, "/usr/local/bin", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin")
}

// runnable says whether a path is a file that may be run.
func runnable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

// whereIs gives the path of a program by name: on the PATH first, then in
// the usual folders; "" when it is in none.
func whereIs(name string) string {
	if found, err := exec.LookPath(name); err == nil {
		return found
	}
	for _, folder := range usualFolders() {
		if candidate := filepath.Join(folder, name); runnable(candidate) {
			return candidate
		}
	}
	return ""
}

// ProgramExists says whether a program is installed on this machine.
func ProgramExists(name string) bool { return whereIs(name) != "" }

// Find gives the beads program to run: the one the environment's BEND_BD
// names (a caller that has found it itself says so there), else `bd` on the
// PATH or in the usual folders. "" when there is none.
func Find() string {
	if named := strings.TrimSpace(os.Getenv("BEND_BD")); named != "" {
		if strings.ContainsRune(named, filepath.Separator) {
			if runnable(named) {
				return named
			}
			return ""
		}
		return whereIs(named)
	}
	return whereIs("bd")
}
