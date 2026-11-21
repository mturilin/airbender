// Package detect finds which tracker a folder's repository uses.
//
// What: looks at a folder and gives the adapter for the tracker found there,
// and the repository's root folder.
//
// Why: the caller (an agent running `bend`) should not have to say which
// tracker a repository uses, or even know.
//
// Design notes:
//   - The order, decided by the owner (bead-bb-c9l.1): what the repository
//     says itself in its setting file (config.go) wins; without one, a
//     `.beads` folder means beads; without that, a remote called origin on
//     github.com means GitHub issues. So a repository that has both beads
//     and a GitHub remote, as nearly every beads repository does, stays on
//     beads unless it says otherwise.
//   - A caller can name the trackers it accepts. A tracker that is not
//     accepted is passed over as if it were not there.
//   - A folder with no supported tracker is a refusal with a plain message,
//     not a guess.
//   - Git bounds are resolved before inspecting tracker metadata. A nested
//     repository never inherits an enclosing repository's tracker. Linked
//     worktrees consult the canonical repository's setting and store before
//     falling back to worktree metadata.
//
// Gotchas:
//   - Nothing is sent to GitHub here, and bd is not run: finding the tracker
//     is quick, and a missing program or login shows on the first real
//     request.

package detect

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/mturilin/airbender/bend/internal/beads"
	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/kept"
	"github.com/mturilin/airbender/bend/internal/localcopy"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// Found is a tracker found for a folder.
type Found struct {
	Tracker tracker.Tracker
	// Root is the folder the tracker was found in: the repository's root.
	Root string
}

// Options adjust how a tracker is looked for; the zero value is the usual
// way.
type Options struct {
	// Actor is who is acting, passed to the adapter for the tracker's
	// history; "" for the tracker's own default.
	Actor string
	// BdCommand is the beads program to run, for a caller that has found it
	// itself; else the environment's BEND_BD, else `bd` on the PATH.
	BdCommand string
	// Accept is the trackers the caller can work with; all of them when
	// empty. One that is not accepted is passed over.
	Accept []string
	// Warn is told what is worth knowing and is not a failure (a copy that
	// could not be refreshed); nothing is said when nil.
	Warn func(text string)
	// GitHubClient makes the connection to a GitHub repository; the real
	// one when nil. Replaced in tests.
	GitHubClient func(repository string) github.Client
}

// LiveVariable names the environment variable that, when set, makes bend
// ask the tracker itself for every command instead of working from the
// copy on this machine: for comparing the two, and for testing an adapter.
const LiveVariable = "BEND_LIVE"

// gitTimeout is how long one of the read-only git commands may take.
const gitTimeout = 5 * time.Second

// git runs a read-only git command in a folder and gives its trimmed
// output; ok is false when git is missing, fails, or the folder is not a
// repository.
func git(dir string, args ...string) (output string, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = dir
	out, err := command.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// repositoryFolders resolves the enclosing worktree and its canonical main
// folder before any tracker metadata is considered. No .git marker means a
// non-Git folder; an invalid marker is a refusal, never an ancestor fallback.
func repositoryFolders(start string) (root, main string, err error) {
	for folder := start; ; folder = filepath.Dir(folder) {
		_, statErr := os.Lstat(filepath.Join(folder, ".git"))
		if statErr == nil {
			root = folder
			break
		}
		if !os.IsNotExist(statErr) {
			return "", "", tracker.Refused("The Git repository in %s could not be inspected: %v.", folder, statErr)
		}
		if filepath.Dir(folder) == folder {
			return "", "", nil
		}
	}
	top, ok := git(start, "rev-parse", "--show-toplevel")
	if !ok {
		return "", "", tracker.Refused("The Git repository in %s could not be resolved. Check its .git metadata and that git is installed.", root)
	}
	top, err = filepath.EvalSymlinks(top)
	if err != nil || top != root {
		return "", "", tracker.Refused("The Git repository in %s has an inconsistent worktree root.", root)
	}
	common, commonOK := git(start, "rev-parse", "--git-common-dir")
	gitDir, dirOK := git(start, "rev-parse", "--git-dir")
	resolve := func(path string) (string, error) {
		if !filepath.IsAbs(path) {
			path = filepath.Join(start, path)
		}
		return filepath.EvalSymlinks(path)
	}
	if !commonOK || !dirOK || common == "" || gitDir == "" {
		return "", "", tracker.Refused("The Git repository in %s has no resolvable common directory.", root)
	}
	common, err = resolve(common)
	if err != nil {
		return "", "", tracker.Refused("The Git common directory for %s could not be resolved: %v.", root, err)
	}
	gitDir, err = resolve(gitDir)
	if err != nil {
		return "", "", tracker.Refused("The Git directory for %s could not be resolved: %v.", root, err)
	}
	if gitDir == common {
		// Also supports a main worktree using --separate-git-dir.
		return root, root, nil
	}
	// A separated common directory needs core.worktree: Git's worktree list
	// reports the metadata directory itself for that layout.
	main, configured := git(start, "config", "--local", "--path", "--get", "core.worktree")
	if configured && main != "" {
		if !filepath.IsAbs(main) {
			main = filepath.Join(common, main)
		}
	} else {
		worktrees, listed := git(start, "worktree", "list", "--porcelain", "-z")
		first, _, _ := strings.Cut(worktrees, "\x00")
		if !listed || !strings.HasPrefix(first, "worktree ") {
			return "", "", tracker.Refused("The canonical main folder for Git worktree %s could not be identified.", root)
		}
		main = strings.TrimPrefix(first, "worktree ")
	}
	main, err = filepath.EvalSymlinks(main)
	if err != nil {
		return "", "", tracker.Refused("The canonical main folder for Git worktree %s could not be resolved: %v.", root, err)
	}
	mainTop, topOK := git(main, "rev-parse", "--show-toplevel")
	mainCommon, mainOK := git(main, "rev-parse", "--git-common-dir")
	if !filepath.IsAbs(mainCommon) {
		mainCommon = filepath.Join(main, mainCommon)
	}
	mainTop, topErr := filepath.EvalSymlinks(mainTop)
	mainCommon, commonErr := filepath.EvalSymlinks(mainCommon)
	if !topOK || !mainOK || topErr != nil || commonErr != nil || mainTop != main || mainCommon != common {
		return "", "", tracker.Refused("The canonical main folder for Git worktree %s could not be validated.", root)
	}
	return root, main, nil
}

// GithubRepositoryOf gives the repository on github.com that a folder's
// remote called origin points at, as "owner/name"; "" when the folder is
// not a git repository, has no such remote, or the remote is somewhere
// else.
//
// Side effects: one read-only git command.
func GithubRepositoryOf(dir string) string {
	url, ok := git(dir, "remote", "get-url", "origin")
	if !ok {
		return ""
	}
	return ParseGithubRemote(url)
}

// githubRemote matches a git remote's address on github.com in any of the
// forms git accepts: https, ssh, and the short git@ form.
var githubRemote = regexp.MustCompile(
	`^(?:https?://(?:[^@/]+@)?github\.com/|(?:ssh://)?git@github\.com[:/])([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`)

// ParseGithubRemote gives "owner/name" from a git remote's address; "" for
// an address that is not on github.com. Pure.
func ParseGithubRemote(url string) string {
	match := githubRemote.FindStringSubmatch(strings.TrimSpace(url))
	if match == nil {
		return ""
	}
	return match[1] + "/" + match[2]
}

// Tracker finds the tracker for a folder.
//
// Git metadata bounds the search to the owning repository. Outside Git,
// parents are tried in turn, preserving standalone Beads folders.
// Fails with not-set-up when no accepted tracker is found, or Refused for
// invalid folders, repository metadata, or tracker settings.
// Side effects: reads files and runs read-only git commands. No network.
func Tracker(dir string, options Options) (Found, error) {
	start, err := filepath.Abs(dir)
	if err != nil {
		return Found{}, tracker.Refused("The folder %s could not be resolved.", dir)
	}
	start, err = filepath.EvalSymlinks(start)
	if err != nil {
		return Found{}, tracker.Refused("The folder %s could not be resolved: %v.", dir, err)
	}
	info, err := os.Stat(start)
	if err != nil || !info.IsDir() {
		return Found{}, tracker.Refused("The folder %s is not a readable directory.", start)
	}
	root, main, err := repositoryFolders(start)
	if err != nil {
		return Found{}, err
	}
	accept := options.Accept
	if len(accept) == 0 {
		accept = TrackerNames
	}
	// Lets a machine where bd is not on the PATH still be used.
	bdCommand := strings.TrimSpace(options.BdCommand)
	if bdCommand == "" {
		// What the environment names is taken as it is, found or not, so
		// that a wrong name is reported as "not found" with that name.
		bdCommand = strings.TrimSpace(os.Getenv("BEND_BD"))
	}
	if bdCommand == "" {
		// Also in the usual folders: an install may have put bd where no
		// PATH reaches yet.
		bdCommand = beads.Find()
	}
	beadsIn := func(root string) Found {
		// Both reads and writes start at the validated store owner. Never
		// ask bd to rediscover ownership from an unrelated ancestor.
		adapter := beads.New(root, options.Actor, bdCommand).At(root)
		// Asked directly for every command only when the caller wants it.
		if os.Getenv(LiveVariable) != "" {
			return Found{Root: root, Tracker: adapter}
		}
		// A local copy and its change marker share the same owning root.
		held := kept.Open(adapter, localcopy.FolderFor(root, "beads"), kept.Options{Warn: options.Warn, NoSend: os.Getenv("BEND_NO_SEND") != ""})
		kept.Opened(held, start)
		return Found{Root: root, Tracker: held}
	}
	githubIn := func(root, repository string) Found {
		if options.GitHubClient != nil {
			return Found{Root: root, Tracker: github.New(options.GitHubClient(repository), options.Actor)}
		}
		adapter := github.New(github.NewClient(repository, github.ClientOptions{}), options.Actor)
		// Asked directly for every command only when the caller wants it.
		if os.Getenv(LiveVariable) != "" {
			return Found{Root: root, Tracker: adapter}
		}
		// From the copy on this machine, synced with GitHub
		// (bead-bb-c9l.15): changes wait there and are sent afterwards.
		// Synced from where the command ran, so that the same setting file
		// and the same repository are found again.
		held := kept.Open(adapter, localcopy.FolderFor(root, repository), kept.Options{Warn: options.Warn, Actor: options.Actor, NoSend: os.Getenv("BEND_NO_SEND") != ""})
		kept.Opened(held, start)
		return Found{Root: root, Tracker: held}
	}
	// Resolve every applicable setting before inferred Beads markers. In a
	// linked worktree this includes the canonical setting even if it was
	// never checked in or the worktree has its own .beads metadata.
	folders := []string{}
	for folder := start; ; folder = filepath.Dir(folder) {
		folders = append(folders, folder)
		if folder == root || filepath.Dir(folder) == folder {
			break
		}
	}
	if main != "" && main != root {
		folders = append(folders, main)
	}
	namedRepository := ""
	beadsFolder := func(folder string) (bool, error) {
		path := filepath.Join(folder, ".beads")
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil || !info.IsDir() {
			return false, tracker.Refused("The Beads store %s is not a readable directory.", path)
		}
		return true, nil
	}
	for _, folder := range folders {
		setting, err := ReadSetting(folder)
		if err != nil {
			return Found{}, err
		}
		if setting != nil && namedRepository == "" {
			namedRepository = setting.Repository
		}
		if setting != nil && setting.Tracker != "" && slices.Contains(accept, setting.Tracker) {
			if setting.Tracker == "beads" {
				owner := folder
				if main != "" {
					hasMainStore, err := beadsFolder(main)
					if err != nil {
						return Found{}, err
					}
					if hasMainStore {
						owner = main
					}
				}
				return beadsIn(owner), nil
			}
			repository := setting.Repository
			if repository == "" {
				repository = GithubRepositoryOf(folder)
			}
			if repository == "" {
				return Found{}, tracker.Refused(
					`%s is set to use GitHub issues, but which repository cannot be told: its remote called origin is not on github.com. Name it in the setting file as "repository": "owner/name".`,
					folder)
			}
			return githubIn(folder, repository), nil
		}
		if root == "" && slices.Contains(accept, "beads") {
			// Standalone non-Git stores retain nearest-marker precedence.
			hasStore, err := beadsFolder(folder)
			if err != nil {
				return Found{}, err
			}
			if hasStore {
				return beadsIn(folder), nil
			}
		}
	}
	if slices.Contains(accept, "beads") && root != "" {
		// The canonical database wins over a worktree's metadata.
		stores := folders
		if main != root {
			stores = append([]string{main}, folders[:len(folders)-1]...)
		}
		for _, folder := range stores {
			hasStore, err := beadsFolder(folder)
			if err != nil {
				return Found{}, err
			}
			if hasStore {
				return beadsIn(folder), nil
			}
		}
	}
	if slices.Contains(accept, "github") && root != "" {
		if repository := GithubRepositoryOf(start); repository != "" {
			if namedRepository != "" {
				repository = namedRepository
			}
			return githubIn(main, repository), nil
		}
	}
	return Found{}, tracker.Failed(tracker.KindNotSetUp,
		"No supported issue tracker was found for %s within its repository or standalone parent folders. Supported: beads (a .beads folder) and GitHub issues (a remote called origin on github.com, or a `.bend.json` setting file).",
		start)
}
