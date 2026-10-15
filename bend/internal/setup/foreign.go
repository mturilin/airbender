// foreign.go — telling someone else's repository from one's own.
//
// What: before anything is set up, asks GitHub whether the folder's origin
// is a fork or a repository the signed-in account cannot push to, and
// keeps, per clone, that the owner chose to keep the issues in a
// repository of their own instead.
//
// Why: Airbender adds its files to the repository (.beads, AGENTS.md,
// .bend.json) and they get committed, so in a contribution to someone
// else's project they would land in pull requests. The owner decided not
// to support that: setup warns, and offers GitHub issues in a repository of
// the owner's, or setting up anyway (bead-bb-dof).
//
// Design notes:
//   - Asked only while the tracker is not chosen: a repository already set
//     up never costs a request.
//   - Where it cannot tell (no origin, not on GitHub, no login, no answer
//     in time) it says nothing: a wrong warning is worse than none.
//   - The choice to keep the issues elsewhere is a git setting of the clone
//     (bend.foreign), not a file: a file would itself be one more thing to
//     keep out of their repository.
//
// Gotchas:
//   - .git/info/exclude works only on files git does not track; .bend.json
//     is always new here, so it works for it.
package setup

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/detect"
	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// Foreign says why a folder looks like someone else's project.
type Foreign struct {
	// Repository is origin's "owner/name".
	Repository string `json:"repository"`
	// Fork says origin is a fork of another repository.
	Fork bool `json:"fork"`
	// CanPush is false when the signed-in account may not push to origin;
	// nil when GitHub did not say.
	CanPush *bool `json:"canPush"`
}

// Words says in a sentence why the folder looks like someone else's.
func (foreign Foreign) Words() string {
	if foreign.Fork {
		return foreign.Repository + " is a fork of another repository."
	}
	return "Your GitHub account cannot push to " + foreign.Repository + "."
}

// Warning is what setup says before setting up such a folder.
const Warning = "This looks like someone else's project. Airbender adds its files to the repository (.beads, AGENTS.md, .bend.json) and they get committed, so in a contribution they would end up in your pull requests. Use Airbender in a repository of your own, or keep the issues in GitHub issues in a repository of yours."

// foreignTimeout is how long GitHub may take to answer before the check is
// given up on, saying nothing.
const foreignTimeout = 5 * time.Second

// foreignKey is the clone's git setting that says the owner keeps this
// project's issues in a repository of their own.
const foreignKey = "bend.foreign"

// foreignOf asks GitHub how origin stands; nil when it is the owner's own,
// or when that cannot be told.
//
// Side effects: one request to GitHub, at most foreignTimeout long.
func foreignOf(root string, options Options) *Foreign {
	repository := detect.GithubRepositoryOf(root)
	if repository == "" {
		return nil
	}
	makeClient := options.GitHubClient
	if makeClient == nil {
		makeClient = func(name string) github.Client { return github.NewClient(name, github.ClientOptions{}) }
	}
	answer := make(chan *Foreign, 1)
	go func() {
		standing, err := makeClient(repository).Standing()
		if err != nil {
			answer <- nil
			return
		}
		cannotPush := standing.CanPush != nil && !*standing.CanPush
		if !standing.Fork && !cannotPush {
			answer <- nil
			return
		}
		answer <- &Foreign{Repository: repository, Fork: standing.Fork, CanPush: standing.CanPush}
	}()
	select {
	case found := <-answer:
		return found
	case <-time.After(foreignTimeout):
		return nil
	}
}

// keptElsewhere says the owner chose, for this clone, to keep the issues in
// a repository of their own.
func keptElsewhere(root string) bool {
	value, ok := quiet(root, 10*time.Second, "git", "config", "--local", "--get", foreignKey)
	return ok && strings.TrimSpace(value) == "true"
}

// keepElsewhere records that choice and keeps the setting file out of git
// in this clone.
//
// Side effects: sets bend.foreign in the clone's git config; adds a line to
// .git/info/exclude.
func keepElsewhere(root string) error {
	if _, ok := quiet(root, 10*time.Second, "git", "config", "--local", foreignKey, "true"); !ok {
		return tracker.Refused("The git setting %s could not be written.", foreignKey)
	}
	return excludeLocally(root, "/"+detect.SettingFile)
}

// excludeLocally adds a pattern to the clone's own ignore list,
// .git/info/exclude, once.
//
// Side effects: creates or appends to that file.
func excludeLocally(root, pattern string) error {
	where, ok := quiet(root, 10*time.Second, "git", "rev-parse", "--git-path", "info/exclude")
	if !ok {
		return tracker.Refused("This folder is not a git repository, so nothing can be kept out of it.")
	}
	path := strings.TrimSpace(where)
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	existing, _ := os.ReadFile(path)
	for _, line := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(line) == pattern {
			return nil
		}
	}
	text := string(existing)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "# Airbender keeps the issues of this clone elsewhere (bend setup)\n" + pattern + "\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return tracker.Refused("%s could not be written: %s", path, err)
	}
	return writeFile(path, text)
}
