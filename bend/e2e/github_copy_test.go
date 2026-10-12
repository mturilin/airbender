// github_copy_test.go — the copy of GitHub's issues on this machine,
// against real GitHub.
//
// What: runs bend on the scratch repository the way it runs by default,
// from a copy on this machine, and checks what only real GitHub can show:
// that a change waits here and arrives with a sync, that what was changed
// behind bend's back comes in with "what changed since" (relations
// between issues included), that a workflow step is refused when the issue
// was moved meanwhile, and that work trees share one copy.
//
// Why: the copy's rules are tested against a stand-in
// (internal/github/copy_test.go). Whether GitHub counts an issue as
// changed when it gets a parent or a blocker is GitHub's to answer.
//
// How to run it: like github_test.go, skipped unless the scratch
// repository is named:
//
//	BEND_GITHUB_SCRATCH=mturilin/bend-scratch go test ./e2e -run GitHubCopy
//
// Gotchas:
//   - No background sync is started (BEND_NO_BACKGROUND): the tests sync
//     when they mean to, so that what they see does not depend on timing.
//   - The copies are kept under a temporary folder, not in the user's own.
//   - "Behind bend's back" is done with bend itself, asking GitHub directly
//     (BEND_LIVE), from the same folder.

package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newCopyScratch is newScratch, working from a copy on this machine.
func newCopyScratch(t *testing.T) *scratch {
	t.Helper()
	made := newScratch(t)
	made.env = []string{"BEND_NO_BACKGROUND=1", "XDG_DATA_HOME=" + t.TempDir()}
	return made
}

// live runs a command that asks GitHub directly, behind the copy's back,
// and must succeed.
func (made *scratch) live(argv ...string) string {
	made.t.Helper()
	kept := made.env
	made.env = append([]string{"BEND_LIVE=1"}, kept...)
	defer func() { made.env = kept }()
	return made.ok(argv...)
}

// copyStatus is the part of `bend status --json` about the copy.
type copyStatus struct {
	Copy *struct {
		Folder  string `json:"folder"`
		Waiting int    `json:"waiting"`
		Refused int    `json:"refused"`
	} `json:"copy"`
}

// waiting gives how many changes wait to be sent.
func (made *scratch) waiting() int {
	made.t.Helper()
	var status copyStatus
	made.parse(made.ok("status", "--json"), &status)
	if status.Copy == nil {
		made.t.Fatal("the status says nothing about a copy")
	}
	return status.Copy.Waiting
}

func TestGitHubCopyAChangeWaitsHereAndArrivesWithASync(t *testing.T) {
	repo := newCopyScratch(t)
	id := repo.create("Copy: waits and arrives", "--description", "Wanted.")
	// From the copy at once, and fast: no request is made.
	started := time.Now()
	same(t, repo.show(id).Title, "Copy: waits and arrives", "the new issue, from the copy")
	if took := time.Since(started); took > 300*time.Millisecond {
		t.Errorf("a read from the copy took %s", took)
	}
	repo.ok("edit", id, "--title", "Copy: changed here")
	repo.ok("write", id, "plan", "The plan.")
	repo.ok("comment", id, "A comment made here.")
	shown := repo.show(id)
	same(t, shown.Title, "Copy: changed here", "the title, here")
	same(t, shown.Plan, "The plan.", "the plan, here")
	same(t, shown.CommentCount, 1, "the comments, here")
	same(t, repo.waiting(), 3, "changes waiting")
	if !strings.Contains(repo.ok("show", id), "3 changes made here not yet on the tracker") {
		t.Error("the issue does not say that changes wait")
	}
	// GitHub does not have them yet.
	same(t, repo.live("show", id, "--json") != "" && strings.Contains(repo.live("show", id), "Copy: waits and arrives"), true, "GitHub still has the old title")

	if !strings.Contains(repo.ok("sync"), "Sent 3 changes.") {
		t.Fatal("the sync did not send three changes")
	}
	same(t, repo.waiting(), 0, "changes waiting after the sync")
	live := repo.live("show", id)
	for _, wanted := range []string{"Copy: changed here", "The plan.", "1 comment"} {
		if !strings.Contains(live, wanted) {
			t.Fatalf("GitHub lacks %q:\n%s", wanted, live)
		}
	}
	// The comment is read back from GitHub, under its real author.
	if comments := repo.ok("comments", id); !strings.Contains(comments, "A comment made here.") {
		t.Fatalf("got the comments:\n%s", comments)
	}
}

func TestGitHubCopyWhatChangedBehindItsBackComesInWithRelations(t *testing.T) {
	repo := newCopyScratch(t)
	parent := repo.create("Copy: parent")
	child := repo.create("Copy: child")
	blocker := repo.create("Copy: blocker")
	repo.ok("sync")

	// On GitHub, not through the copy.
	repo.live("move", child, "--under", parent)
	repo.live("link", child, blocker, "--kind", "blocked-by")
	repo.live("edit", blocker, "--title", "Copy: blocker, renamed")
	repo.live("comment", parent, "Said on GitHub.")
	same(t, text(repo.show(child).ParentID), "<none>", "the copy before a sync")

	// An ordinary sync: only what changed since is asked for.
	if out := repo.ok("sync"); strings.Contains(out, "Reread all") {
		t.Fatalf("the sync reread everything:\n%s", out)
	}
	moved := repo.show(child)
	same(t, text(moved.ParentID), parent, "the child's parent")
	same(t, ids(moved.BlockedBy), blocker, "what the child waits for")
	same(t, ids(repo.show(parent).SubIssues), child, "the parent's sub-issues")
	same(t, repo.show(blocker).Title, "Copy: blocker, renamed", "the blocker's title")
	if comments := repo.ok("comments", parent); !strings.Contains(comments, "Said on GitHub.") {
		t.Fatalf("got the comments:\n%s", comments)
	}
}

func TestGitHubCopyAStepIsRefusedWhenTheIssueWasMovedMeanwhile(t *testing.T) {
	repo := newCopyScratch(t)
	id := repo.create("Copy: moved")
	repo.ok("edit", id, "--add-label", "step:review-plan")
	// A step is on GitHub when the command returns, with nothing waiting.
	same(t, repo.waiting(), 0, "changes waiting after a step")
	if !strings.Contains(repo.live("show", id), "step:review-plan") {
		t.Fatal("the step is not on GitHub")
	}
	// Someone else moves it on.
	repo.live("edit", id, "--remove-label", "step:review-plan", "--add-label", "step:implement")
	refused := repo.fails("edit", id, "--remove-label", "step:review-plan", "--add-label", "step:plan")
	same(t, refused.Kind, "refused", "a move from a step the issue has left")
	if !strings.Contains(refused.Error, "step:implement") {
		t.Fatalf("got %q", refused.Error)
	}
	if live := repo.live("show", id); !strings.Contains(live, "step:implement") || strings.Contains(live, "step:plan") {
		t.Fatalf("GitHub was changed:\n%s", live)
	}
	// The copy took GitHub's version, so the next move works.
	repo.ok("edit", id, "--remove-label", "step:implement", "--add-label", "step:agent-review")
	if !strings.Contains(repo.live("show", id), "step:agent-review") {
		t.Fatal("the second move is not on GitHub")
	}
}

func TestGitHubCopyIsSharedByWorkTreesAndUnseenByGit(t *testing.T) {
	repo := newCopyScratch(t)
	git := func(dir string, args ...string) string {
		t.Helper()
		command := exec.Command("git", args...)
		command.Dir = dir
		command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := command.CombinedOutput()
		if err != nil {
			t.Skipf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return string(out)
	}
	// The scratch folder becomes a repository with the setting checked in,
	// and gets a work tree.
	git(repo.root, "init", "-q")
	git(repo.root, "add", ".bend.json")
	git(repo.root, "commit", "-q", "-m", "start")
	tree := filepath.Join(filepath.Dir(repo.root), "tree-"+filepath.Base(repo.root))
	git(repo.root, "worktree", "add", "-q", tree, "-b", "tree")
	t.Cleanup(func() { os.RemoveAll(tree) })

	id := repo.create("Copy: shared")
	repo.ok("edit", id, "--title", "Copy: shared, changed in the main folder")
	// Seen from the work tree at once, with no sync: it is the same copy.
	other := &repository{t: t, root: tree, env: repo.env}
	same(t, other.show(id).Title, "Copy: shared, changed in the main folder", "the title, from the work tree")
	var status copyStatus
	other.parse(other.ok("status", "--json"), &status)
	same(t, status.Copy.Waiting, 1, "changes waiting, from the work tree")
	if !strings.HasPrefix(status.Copy.Folder, filepath.Join(repo.root, ".git", "bend")) {
		t.Fatalf("the copy is kept in %s", status.Copy.Folder)
	}
	same(t, git(repo.root, "status", "--porcelain"), "", "git's view of the main folder")
	same(t, git(tree, "status", "--porcelain"), "", "git's view of the work tree")
	other.ok("sync")
	same(t, repo.waiting(), 0, "changes waiting, after the work tree synced")
}

func TestGitHubCopyKeptDataIsAHiddenLineAndASyncNamesItsIssues(t *testing.T) {
	repo := newCopyScratch(t)
	id := repo.create("Copy: an epic with a branch", "--description", "Wanted.")
	branch := "epic-with-a-branch-name-far-longer-than-the-fifty-characters-of-a-label"
	repo.ok("edit", id, "--set-data", "branch="+branch)
	// Shown at once, from the copy, while it waits.
	same(t, repo.show(id).Metadata["branch"], any(branch), "the branch, here")
	// The sync says which issue it sent.
	synced := repo.ok("sync", "--json")
	if !strings.Contains(synced, `"sentIssues": [`) || !strings.Contains(synced, `"`+id+`"`) {
		t.Fatalf("the sync does not name the issue it sent:\n%s", synced)
	}
	// On GitHub: read back directly, with the description as it was.
	live := repo.live("show", id, "--json")
	if !strings.Contains(live, branch) || !strings.Contains(live, `"description": "Wanted."`) {
		t.Fatalf("GitHub lacks the branch, or the description changed:\n%s", live)
	}
	repo.ok("edit", id, "--unset-data", "branch")
	repo.ok("sync")
	if strings.Contains(repo.live("show", id, "--json"), branch) {
		t.Fatal("the branch is still on GitHub after it was taken out")
	}
}
