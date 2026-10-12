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
//   - A git work tree need not hold a `.beads` folder of its own: beads finds
//     its database through git, in the repository's main folder. So when the
//     walk upward finds nothing, the main folder is looked at too. Without
//     this, the Airbender tab lost its issues in such a work tree, where
//     running bd directly had shown them.
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

// mainFolderOf gives the main folder of the git repository a folder is a
// work tree of; "" when the folder is not in a git repository, when git is
// not installed, and when it cannot be told.
//
// Side effects: one read-only git command.
func mainFolderOf(dir string) string {
	common, ok := git(dir, "rev-parse", "--git-common-dir")
	if !ok || common == "" {
		return ""
	}
	// git answers relative to dir when the folder is the main one.
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	return filepath.Dir(filepath.Clean(common))
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

// exists says whether a path is there.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Tracker finds the tracker for a folder.
//
// dir is where to start looking; its parents are tried in turn.
// Fails with the kind not-set-up when no accepted tracker is found; Refused
// when the folder does not exist, or its setting file cannot be understood
// or names GitHub without a repository that can be found.
// Side effects: reads the file system; up to two read-only git commands
// when the walk upward finds nothing. Nothing is sent to GitHub here.
func Tracker(dir string, options Options) (Found, error) {
	start, err := filepath.Abs(dir)
	if err != nil || !exists(start) {
		return Found{}, tracker.Refused("The folder %s does not exist.", start)
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
	beadsIn := func(root, runIn string) Found {
		// Beads writes to the main folder's `.beads`, from whichever work
		// tree it is run; that is where its sign of change is.
		home := root
		if main := mainFolderOf(root); main != "" && exists(filepath.Join(main, ".beads")) {
			home = main
		}
		adapter := beads.New(runIn, options.Actor, bdCommand).At(home)
		// Asked directly for every command only when the caller wants it.
		if os.Getenv(LiveVariable) != "" {
			return Found{Root: root, Tracker: adapter}
		}
		// From a copy on this machine (bead-bb-c9l.14): a read then starts
		// no bd. Reread from where the command ran, so that bd is started
		// there as the caller would start it.
		held := kept.Open(adapter, localcopy.FolderFor(root, "beads"), kept.Options{Warn: options.Warn})
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
		held := kept.Open(adapter, localcopy.FolderFor(root, repository), kept.Options{Warn: options.Warn, Actor: options.Actor})
		kept.Opened(held, start)
		return Found{Root: root, Tracker: held}
	}
	// A setting file may name the repository without naming the tracker:
	// "the remote is not where the issues are". The nearest one is kept for
	// the case where the remote is what decides, below.
	namedRepository := ""
	for folder := start; ; folder = filepath.Dir(folder) {
		setting, err := ReadSetting(folder)
		if err != nil {
			return Found{}, err
		}
		if setting != nil && namedRepository == "" {
			namedRepository = setting.Repository
		}
		if setting != nil && setting.Tracker != "" && slices.Contains(accept, setting.Tracker) {
			if setting.Tracker == "beads" {
				return beadsIn(folder, folder), nil
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
		if slices.Contains(accept, "beads") && exists(filepath.Join(folder, ".beads")) {
			return beadsIn(folder, folder), nil
		}
		if filepath.Dir(folder) == folder {
			break
		}
	}
	main := mainFolderOf(start)
	if slices.Contains(accept, "beads") && main != "" && exists(filepath.Join(main, ".beads")) {
		// Run where the caller is, as it would run bd itself: beads finds
		// the main folder's database from a work tree.
		return beadsIn(main, start), nil
	}
	if slices.Contains(accept, "github") {
		if repository := GithubRepositoryOf(start); repository != "" {
			if namedRepository != "" {
				repository = namedRepository
			}
			// The folder the facts file sits in: the repository's main
			// folder, which is where a work tree's checked-in files come
			// from too.
			root := main
			if root == "" {
				root = start
			}
			return githubIn(root, repository), nil
		}
	}
	return Found{}, tracker.Failed(tracker.KindNotSetUp,
		"No supported issue tracker was found in %s or the folders above it. Supported: beads (a .beads folder) and GitHub issues (a remote called origin on github.com, or a `.bend.json` setting file).",
		start)
}
