// detect_test.go — tests for finding a folder's tracker.
//
// What: checks the order of the search (setting file, .beads folder, a work
// tree's main folder, a GitHub remote), the forms of a GitHub address, and
// the refusals for a setting file that cannot be understood.
//
// Why: finding the wrong tracker would send an agent's issues to the wrong
// place.
//
// Gotchas:
//   - Some tests need git; they are skipped where it is missing.
//   - Nothing is sent to GitHub: the connection is the stand-in, and only
//     About is read, which asks nothing.

package detect

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/github"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// base makes the test's own folder, by its real path so that it compares
// equal to what the search gives.
func base(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// folder makes a folder under root with these files (name, text, name,
// text, ...); a name ending in "/" makes a folder.
func folder(t *testing.T, root, name string, files ...string) string {
	t.Helper()
	made := filepath.Join(root, name)
	if err := os.MkdirAll(made, 0o755); err != nil {
		t.Fatal(err)
	}
	for at := 0; at < len(files); at += 2 {
		path := filepath.Join(made, files[at])
		var err error
		if strings.HasSuffix(files[at], "/") {
			err = os.MkdirAll(path, 0o755)
		} else {
			err = os.WriteFile(path, []byte(files[at+1]), 0o644)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	return made
}

// runGit runs git in a folder, kept apart from the user's own git settings
// (hooks that run on every commit, a signing key); the test is skipped
// where git is not available.
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not available: %v", err)
	}
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

// standIn is the stand-in's connection, so that nothing is sent to GitHub.
func standIn(repository string) github.Client {
	return github.NewFake(github.FakeOptions{Repository: repository})
}

// found gives "beads", or for GitHub which repository, for the tracker
// found in dir; or the failure.
func found(dir string, accept ...string) (string, error) {
	result, err := Tracker(dir, Options{Accept: accept, GitHubClient: standIn})
	if err != nil {
		return "", err
	}
	about := result.Tracker.About()
	if about.Repository != nil {
		return *about.Repository, nil
	}
	return about.Tracker, nil
}

// expect fails the test unless the tracker found in dir is want.
func expect(t *testing.T, dir, want string, accept ...string) {
	t.Helper()
	got, err := found(dir, accept...)
	if err != nil || got != want {
		t.Fatalf("in %s: got %q, %v; want %q", dir, got, err, want)
	}
}

func TestBeadsFolderIsFoundInTheFolderOrAbove(t *testing.T) {
	root := folder(t, base(t), "plain", ".beads/", "", "deep/er/", "")
	for _, dir := range []string{root, filepath.Join(root, "deep", "er")} {
		result, err := Tracker(dir, Options{})
		if err != nil || result.Root != root {
			t.Fatalf("in %s: got %q, %v", dir, result.Root, err)
		}
	}
}

func TestNoTrackerAndMissingFolder(t *testing.T) {
	root := base(t)
	// A stray setting or .beads above the temporary folder would be found.
	if _, err := Tracker(folder(t, root, "bare"), Options{Accept: []string{"beads"}}); tracker.KindOf(err) != tracker.KindNotSetUp {
		t.Fatalf("got %v", err)
	}
	_, err := Tracker(filepath.Join(root, "missing"), Options{})
	if err == nil || tracker.KindOf(err) != tracker.KindRefused {
		t.Fatalf("got %v", err)
	}
}

func TestWorkTreeUsesTheMainFoldersBeads(t *testing.T) {
	root := base(t)
	main := folder(t, root, "main")
	tree := filepath.Join(root, "tree")
	runGit(t, main, "init", "-q")
	runGit(t, main, "commit", "-q", "--allow-empty", "-m", "start")
	runGit(t, main, "worktree", "add", "-q", tree, "-b", "tree")
	// Not checked in, so the work tree has none of its own.
	folder(t, main, ".beads")
	for _, dir := range []string{main, tree} {
		result, err := Tracker(dir, Options{})
		if err != nil || result.Root != main {
			t.Fatalf("in %s: got %q, %v", dir, result.Root, err)
		}
	}
}

func TestGithubAddresses(t *testing.T) {
	for _, url := range []string{
		"https://github.com/someone/thing.git",
		"https://github.com/someone/thing",
		"https://token@github.com/someone/thing.git",
		"git@github.com:someone/thing.git",
		"ssh://git@github.com/someone/thing.git",
		"https://github.com/someone/thing/",
	} {
		if got := ParseGithubRemote(url); got != "someone/thing" {
			t.Fatalf("%s: got %q", url, got)
		}
	}
	if got := ParseGithubRemote("git@github.com:some.one/a-b_c.d.git"); got != "some.one/a-b_c.d" {
		t.Fatalf("got %q", got)
	}
	for _, url := range []string{
		"https://gitlab.com/someone/thing.git",
		"git@example.com:someone/thing.git",
		"https://github.com/someone",
		"https://notgithub.com/someone/thing",
		"",
	} {
		if got := ParseGithubRemote(url); got != "" {
			t.Fatalf("%s: got %q", url, got)
		}
	}
}

func TestSettingFileDecides(t *testing.T) {
	root := base(t)
	both := folder(t, root, "both", ".beads/", "")
	remoteOnly := folder(t, root, "remote-only")
	for _, dir := range []string{both, remoteOnly} {
		runGit(t, dir, "init", "-q")
		runGit(t, dir, "remote", "add", "origin", "git@github.com:someone/thing.git")
	}
	setting := func(dir, text string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, SettingFile), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Both a .beads folder and a GitHub remote: beads, as before.
	expect(t, both, "beads")
	// No .beads folder: the remote says GitHub.
	expect(t, remoteOnly, "someone/thing")
	// The repository says so itself: GitHub, though .beads is there.
	setting(both, `{"tracker": "github"}`)
	expect(t, both, "someone/thing")
	// ...and it can name another repository than its remote.
	setting(both, `{"tracker": "github", "repository": "team/board"}`)
	expect(t, both, "team/board")
	expect(t, folder(t, both, "deep/er"), "team/board")
	// Only the repository is named: the remote still says "GitHub", the
	// setting says which repository.
	setting(remoteOnly, `{"repository": "team/board"}`)
	expect(t, remoteOnly, "team/board")
	// Saying beads keeps beads, whatever the remote is.
	setting(remoteOnly, `{"tracker": "beads"}`)
	expect(t, remoteOnly, "beads")

	// A caller that accepts beads only is never given GitHub: the setting
	// is passed over, and a GitHub-only folder has no tracker for it.
	expect(t, both, "beads", "beads")
	os.Remove(filepath.Join(remoteOnly, SettingFile))
	if _, err := found(remoteOnly, "beads"); tracker.KindOf(err) != tracker.KindNotSetUp {
		t.Fatalf("got %v", err)
	}
}

func TestSettingFileThatCannotBeUnderstood(t *testing.T) {
	root := base(t)
	for _, bad := range [][3]string{
		{"bad-json", "{tracker: github", "not valid JSON"},
		{"bad-shape", `["github"]`, "must hold one object"},
		{"bad-tracker", `{"tracker": "linear"}`, `names the tracker "linear"`},
		{"bad-repo", `{"tracker": "github", "repository": "just-a-name"}`, "owner/name"},
	} {
		dir := folder(t, root, bad[0], SettingFile, bad[1])
		_, err := ReadSetting(dir)
		if err == nil || tracker.KindOf(err) != tracker.KindRefused ||
			!strings.Contains(err.Error(), bad[2]) ||
			!strings.Contains(err.Error(), filepath.Join(dir, SettingFile)) {
			t.Fatalf("%s: got %v", bad[0], err)
		}
	}
	if setting, err := ReadSetting(folder(t, root, "no-setting")); setting != nil || err != nil {
		t.Fatalf("got %v, %v", setting, err)
	}
	setting, err := ReadSetting(folder(t, root, "empty-setting", SettingFile, "{}"))
	if err != nil || setting == nil || *setting != (Setting{}) {
		t.Fatalf("got %v, %v", setting, err)
	}
	// GitHub is asked for, but nothing says which repository.
	_, err = found(folder(t, root, "github-nowhere", SettingFile, `{"tracker": "github"}`))
	if err == nil || !strings.Contains(err.Error(), "which repository cannot be told") {
		t.Fatalf("got %v", err)
	}
}

func linkedFolders(t *testing.T, root string) (string, string) {
	t.Helper()
	main := folder(t, root, "main")
	tree := filepath.Join(root, "tree")
	runGit(t, main, "init", "-q")
	runGit(t, main, "commit", "-q", "--allow-empty", "-m", "start")
	runGit(t, main, "worktree", "add", "-q", tree, "-b", "tree")
	return main, tree
}

func TestLinkedWorktreeIgnoresAncestorMarkersAndRunsInCanonicalStore(t *testing.T) {
	t.Setenv(LiveVariable, "1")
	for _, ancestor := range []string{"beads", "github", "invalid-setting"} {
		t.Run(ancestor, func(t *testing.T) {
			root := base(t)
			main, tree := linkedFolders(t, root)
			folder(t, main, ".beads")
			// A worktree may contain checked-in metadata, not its own database.
			folder(t, tree, ".beads")
			switch ancestor {
			case "beads":
				folder(t, root, ".beads")
			case "github":
				folder(t, root, ".", SettingFile, `{"tracker":"github","repository":"other/board"}`)
			case "invalid-setting":
				folder(t, root, ".", SettingFile, "{")
			}
			start := folder(t, tree, "deep/inside")
			logFile := filepath.Join(root, "bd-log")
			t.Setenv("DETECT_BD_LOG", logFile)
			program := filepath.Join(root, "synthetic-bd")
			script := "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$*\" >> \"$DETECT_BD_LOG\"\n" +
				"if [ \"$1\" = create ]; then printf '{\"id\":\"test-1\"}\\n'; else printf '[]\\n'; fi\n"
			if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			result, err := Tracker(start, Options{BdCommand: program, GitHubClient: standIn})
			if err != nil || result.Root != main || result.Tracker.About().Tracker != "beads" {
				t.Fatalf("got %#v, %v; want canonical beads root %s", result, err, main)
			}
			if _, err := result.Tracker.List(tracker.ListFilter{}); err != nil {
				t.Fatal(err)
			}
			if id, err := result.Tracker.Create(tracker.Draft{Title: "test"}); err != nil || id != "test-1" {
				t.Fatalf("create got %q, %v", id, err)
			}
			logged, err := os.ReadFile(logFile)
			if err != nil {
				t.Fatal(err)
			}
			want := main + "\n--readonly list --all --json --limit 0\n" +
				main + "\n--readonly list --all --json --limit 0\n" +
				main + "\ncreate --json --title test\n"
			if string(logged) != want {
				t.Fatalf("child commands:\n%s\nwant:\n%s", logged, want)
			}
		})
	}
}

func TestCanonicalSettingPrecedesWorktreeBeadsMetadata(t *testing.T) {
	root := base(t)
	main, tree := linkedFolders(t, root)
	folder(t, main, ".", ".beads/", "", SettingFile, `{"tracker":"github","repository":"team/board"}`)
	folder(t, tree, ".beads")
	runGit(t, main, "remote", "add", "origin", "git@github.com:someone/thing.git")
	for _, dir := range []string{main, folder(t, tree, "deep/inside")} {
		expect(t, dir, "team/board")
		expect(t, dir, "beads", "beads")
	}
}

func TestRepositorySettingPrecedesSubdirectoryBeadsMetadata(t *testing.T) {
	root := folder(t, base(t), "repo", SettingFile, `{"tracker":"github","repository":"team/board"}`)
	runGit(t, root, "init", "-q")
	expect(t, folder(t, root, "deep", ".beads/", ""), "team/board")
}

func TestNestedRepositoryDoesNotInheritEnclosingTracker(t *testing.T) {
	for _, marker := range []string{"beads", "setting"} {
		t.Run(marker, func(t *testing.T) {
			outer := folder(t, base(t), "outer")
			runGit(t, outer, "init", "-q")
			if marker == "beads" {
				folder(t, outer, ".beads")
			} else {
				folder(t, outer, ".", SettingFile, `{"tracker":"github","repository":"other/board"}`)
			}
			inner := folder(t, outer, "inner")
			runGit(t, inner, "init", "-q")
			for _, start := range []string{inner, folder(t, inner, "deep/inside")} {
				if _, err := Tracker(start, Options{GitHubClient: standIn}); tracker.KindOf(err) != tracker.KindNotSetUp {
					t.Fatalf("in %s: got %v; want no tracker inherited", start, err)
				}
			}
			runGit(t, inner, "remote", "add", "origin", "git@github.com:inner/issues.git")
			expect(t, inner, "inner/issues")
			folder(t, inner, ".beads")
			result, err := Tracker(inner, Options{})
			if err != nil || result.Root != inner {
				t.Fatalf("got %#v, %v; want inner root %s", result, err, inner)
			}
		})
	}
}

func TestInvalidRepositoryCannotFallBackToAncestorTracker(t *testing.T) {
	root := folder(t, base(t), "outer", ".beads/", "")
	broken := folder(t, root, "broken", ".git", "gitdir: missing\n")
	_, err := Tracker(folder(t, broken, "deep"), Options{})
	if tracker.KindOf(err) != tracker.KindRefused {
		t.Fatalf("got %v; want visible invalid-repository refusal", err)
	}
}

func TestFileIsNotATrackerFolder(t *testing.T) {
	root := folder(t, base(t), "plain", ".beads", "not a directory")
	if _, err := Tracker(root, Options{Accept: []string{"beads"}}); tracker.KindOf(err) != tracker.KindRefused {
		t.Fatalf("got %v; want invalid-store refusal", err)
	}
	_, err := Tracker(filepath.Join(root, ".beads"), Options{})
	if tracker.KindOf(err) != tracker.KindRefused {
		t.Fatalf("got %v; want invalid-folder refusal", err)
	}
}

func TestBeadsChildUsesOwningRootFromSubdirectory(t *testing.T) {
	t.Setenv(LiveVariable, "1")
	for _, useGit := range []bool{false, true} {
		name := "standalone"
		if useGit {
			name = "git"
		}
		t.Run(name, func(t *testing.T) {
			root := folder(t, base(t), "repo", ".beads/", "")
			if useGit {
				runGit(t, root, "init", "-q")
			}
			start := folder(t, root, "deep/inside")
			program := filepath.Join(root, "synthetic-bd")
			logFile := filepath.Join(root, "bd-log")
			t.Setenv("DETECT_BD_LOG", logFile)
			script := "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$*\" > \"$DETECT_BD_LOG\"\nprintf '[]\\n'\n"
			if err := os.WriteFile(program, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			result, err := Tracker(start, Options{BdCommand: program})
			if err != nil || result.Root != root {
				t.Fatalf("got %#v, %v; want owner %s", result, err, root)
			}
			if _, err := result.Tracker.List(tracker.ListFilter{}); err != nil {
				t.Fatal(err)
			}
			logged, err := os.ReadFile(logFile)
			if err != nil {
				t.Fatal(err)
			}
			if want := root + "\n--readonly list --all --json --limit 0\n"; string(logged) != want {
				t.Fatalf("child got %q, want %q", logged, want)
			}
		})
	}
}

func TestInvalidCanonicalSettingCannotFallBackToWorktreeMetadata(t *testing.T) {
	main, tree := linkedFolders(t, base(t))
	folder(t, main, ".", SettingFile, "{")
	folder(t, tree, ".beads")
	if _, err := Tracker(tree, Options{}); tracker.KindOf(err) != tracker.KindRefused {
		t.Fatalf("got %v; want invalid-setting refusal", err)
	}
}

func TestExplicitWorktreeSettingOverridesCanonicalSetting(t *testing.T) {
	main, tree := linkedFolders(t, base(t))
	folder(t, main, ".", SettingFile, `{"tracker":"github","repository":"team/board"}`)
	folder(t, tree, ".", SettingFile, `{"tracker":"github","repository":"team/branch"}`)
	expect(t, folder(t, tree, "deep"), "team/branch")
}

func TestSeparateGitDirectoryKeepsTheWorkingFolderAsOwner(t *testing.T) {
	root := base(t)
	main := folder(t, root, "main", ".beads/", "")
	runGit(t, main, "init", "-q", "--separate-git-dir", filepath.Join(root, "metadata"))
	result, err := Tracker(folder(t, main, "deep"), Options{})
	if err != nil || result.Root != main {
		t.Fatalf("got %#v, %v; want owner %s", result, err, main)
	}
}

func TestStandaloneStorePrecedesUnrelatedAncestorSetting(t *testing.T) {
	for _, setting := range []string{`{"tracker":"github","repository":"other/board"}`, "{"} {
		root := folder(t, base(t), "outer", SettingFile, setting)
		owner := folder(t, root, "standalone", ".beads/", "")
		result, err := Tracker(folder(t, owner, "deep"), Options{GitHubClient: standIn})
		if err != nil || result.Root != owner || result.Tracker.About().Tracker != "beads" {
			t.Fatalf("ancestor setting %q: got %#v, %v; want standalone owner %s", setting, result, err, owner)
		}
	}
}

func TestLinkedWorktreeWithSeparateGitDirectoryUsesCanonicalStore(t *testing.T) {
	root := base(t)
	main := folder(t, root, "main", ".beads/", "")
	runGit(t, main, "init", "-q", "--separate-git-dir", filepath.Join(root, "metadata"))
	runGit(t, main, "config", "core.worktree", main)
	runGit(t, main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial")
	tree := filepath.Join(root, "linked")
	runGit(t, main, "worktree", "add", "-q", "-b", "linked", tree)
	result, err := Tracker(folder(t, tree, "deep"), Options{})
	if err != nil || result.Root != main {
		t.Fatalf("got %#v, %v; want canonical owner %s", result, err, main)
	}
}
