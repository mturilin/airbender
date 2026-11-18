// place_test.go — regression coverage for setup's shared and local files.
//
// What: reproduces an existing installation whose setup commit omitted
// beads' support files and root lock (bead-bb-ozo), using temporary git repos.
// Why: checking only a fresh bd init can miss files an older init left behind.
// Design notes: no real beads process, remote, user git config or hooks run;
// git failures fail the test rather than turning a regression into a skip.
package setup

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/mturilin/airbender/bend/internal/tracker"
)

// setupGit runs git in a throwaway repository and returns trimmed stdout.
// Any failure is fatal; all mutations stay within the supplied test folder.
func setupGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// writeSetupFile creates a test file and its parent folders, failing on error.
func writeSetupFile(t *testing.T, dir, name, text string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// setupRepo makes a main-branch repo with the old setup's narrow commit.
// It isolates git settings and disables hooks; options prevent running bd.
func setupRepo(t *testing.T) (string, Options) {
	t.Helper()
	for key, value := range map[string]string{
		"GIT_CONFIG_GLOBAL": os.DevNull, "GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": os.DevNull,
		"GIT_AUTHOR_NAME": "tester", "GIT_AUTHOR_EMAIL": "tester@example.com",
		"GIT_COMMITTER_NAME": "tester", "GIT_COMMITTER_EMAIL": "tester@example.com",
	} {
		t.Setenv(key, value)
	}
	dir := t.TempDir()
	setupGit(t, dir, "init", "-q", "--initial-branch=main")
	for _, name := range []string{"AGENTS.md", "FACTS.md", beadsConfig} {
		writeSetupFile(t, dir, name, "# Existing setup\n")
	}
	setupGit(t, dir, "add", "--", "AGENTS.md", "FACTS.md", beadsConfig)
	setupGit(t, dir, "commit", "-qm", "Existing setup")
	return dir, Options{BdCommand: filepath.Join(dir, "no-bd")}
}

// setupTerminal executes only git, in the test repository. Unexpected
// programs or git failures fail immediately; it never asks for input.
func setupTerminal(t *testing.T) Terminal {
	terminal := nobody(t)
	terminal.Run = func(dir, name string, args ...string) int {
		if name != "git" {
			t.Fatalf("unexpected program %s", name)
		}
		setupGit(t, dir, args...)
		return 0
	}
	return terminal
}

// TestSetupRepairsExistingBeadsSupportFiles covers the files omitted in
// Plumbum, confirmation, ignored files and preservation of unrelated staging.
func TestSetupRepairsExistingBeadsSupportFiles(t *testing.T) {
	dir, options := setupRepo(t)
	wanted := []string{".beads/.gitignore", ".beads/README.md", ".beads/metadata.json",
		".beads/hooks/post-checkout", ".beads/hooks/post-merge", ".beads/hooks/pre-commit",
		".beads/hooks/pre-push", ".beads/hooks/prepare-commit-msg"}
	for _, name := range wanted {
		writeSetupFile(t, dir, name, "support\n")
	}
	writeSetupFile(t, dir, ".beads/.gitignore", "dolt/\n*.lock\nhooks/*.tmp\n")
	for _, name := range []string{beadsLock, ".beads/dolt/local", ".beads/hooks/private.tmp"} {
		writeSetupFile(t, dir, name, "local\n")
	}
	writeSetupFile(t, dir, "other.txt", "unrelated staged content\n")
	setupGit(t, dir, "add", "--", "other.txt")
	staged := setupGit(t, dir, "diff", "--cached")
	exclude := textOf(filepath.Join(dir, ".git/info/exclude"))
	state, err := Read(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if step := state.Step(StepCommit); step.State != Missing || !strings.Contains(strings.Join(step.Explain, " "), beadsLock) {
		t.Fatalf("the repair was not offered: %+v", step)
	}
	if got := setupPending(dir); !slices.Equal(got, wanted) {
		t.Fatalf("pending %v, want %v", got, wanted)
	}
	if _, err := Commit(dir, setupTerminal(t), Answers{}, options); tracker.KindOf(err) != tracker.KindUsage {
		t.Fatalf("repair without confirmation: %v", err)
	}
	if textOf(filepath.Join(dir, ".git/info/exclude")) != exclude || setupGit(t, dir, "diff", "--cached") != staged {
		t.Fatal("reading or refusing setup changed the exclude file or index")
	}
	outcome, err := Commit(dir, setupTerminal(t), Answers{Yes: true}, options)
	if err != nil || !outcome.Changed {
		t.Fatalf("repair: %+v, %v", outcome, err)
	}
	committed := strings.Split(setupGit(t, dir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "\n")
	slices.Sort(wanted)
	if !slices.Equal(committed, wanted) {
		t.Fatalf("committed %v, want %v", committed, wanted)
	}
	if setupGit(t, dir, "diff", "--cached") != staged || setupGit(t, dir, "status", "--porcelain") != "A  other.txt" {
		t.Fatal("unrelated staged content changed, or setup left files untracked")
	}
	head := setupGit(t, dir, "rev-parse", "HEAD")
	exclude = textOf(filepath.Join(dir, ".git/info/exclude"))
	again, err := Commit(dir, nobody(t), Answers{Yes: true}, options)
	if err != nil || again.Changed || setupGit(t, dir, "rev-parse", "HEAD") != head ||
		textOf(filepath.Join(dir, ".git/info/exclude")) != exclude || setupGit(t, dir, "diff", "--cached") != staged {
		t.Fatalf("second setup changed the repository: %+v, %v", again, err)
	}
	// A later change to a shared support file must also be offered.
	writeSetupFile(t, dir, ".beads/metadata.json", "updated support\n")
	if got := setupPending(dir); !slices.Equal(got, []string{".beads/metadata.json"}) {
		t.Fatalf("changed support file was not offered: %v", got)
	}
}

// TestSetupRepairsOnlyTheMissingLockRuleWithoutACommit checks that adding
// the local rule is idempotent and cannot accidentally commit the index.
func TestSetupRepairsOnlyTheMissingLockRuleWithoutACommit(t *testing.T) {
	dir, options := setupRepo(t)
	writeSetupFile(t, dir, beadsLock, "local\n")
	// Preserve an existing exclude file even when its last line has no newline.
	writeSetupFile(t, dir, ".git/info/exclude", "# Owner's rules\n/local-only")
	head := setupGit(t, dir, "rev-parse", "HEAD")
	terminal := nobody(t) // Any attempt to run git add/commit fails.
	outcome, err := Commit(dir, terminal, Answers{Yes: true}, options)
	if err != nil || !outcome.Changed || strings.Contains(outcome.Message, "Committed") {
		t.Fatalf("ignore-only repair: %+v, %v", outcome, err)
	}
	exclude := textOf(filepath.Join(dir, ".git/info/exclude"))
	if !strings.HasPrefix(exclude, "# Owner's rules\n/local-only\n") || strings.Count(exclude, "/"+beadsLock+"\n") != 1 {
		t.Fatalf("exclude file: %q", exclude)
	}
	again, err := Commit(dir, terminal, Answers{Yes: true}, options)
	if err != nil || again.Changed || textOf(filepath.Join(dir, ".git/info/exclude")) != exclude {
		t.Fatalf("second setup was not a no-op: %+v, %v", again, err)
	}
	if setupGit(t, dir, "rev-parse", "HEAD") != head || setupGit(t, dir, "status", "--porcelain") != "" {
		t.Fatal("ignore-only setup changed HEAD or left files for git")
	}
}

// TestSetupRecognisesExistingLockRulesBeforeTheLockExists ensures setup
// catches future lock files and respects existing exact or broader rules.
func TestSetupRecognisesExistingLockRulesBeforeTheLockExists(t *testing.T) {
	for _, pattern := range []string{"", "/.beads.gate.lock", "*.lock"} {
		t.Run("pattern="+pattern, func(t *testing.T) {
			dir, options := setupRepo(t)
			if pattern != "" {
				writeSetupFile(t, dir, ".git/info/exclude", pattern+"\n")
			}
			state, err := Read(dir, options)
			if err != nil {
				t.Fatal(err)
			}
			want := Done
			if pattern == "" {
				want = Missing
			}
			if step := state.Step(StepCommit); step.State != want {
				t.Fatalf("step: %+v, want %s", step, want)
			}
		})
	}
}
