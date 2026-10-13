// copy_test.go — the local copy of a beads repository's issues, with the
// real bd.
//
// What: counts how often bend starts bd, and checks that a read from a
// fresh copy starts it not at all and is quick; that a change made through
// bend, and one made with bd directly, both show in the next read; that the
// copy is reread behind a command; where the copy is kept; and that
// deleting it is harmless.
//
// Why: the copy exists to spare the half second bd takes to open its
// database on every read (bead-bb-c9l.14), and must never show less than
// asking bd would.
//
// Gotchas:
//   - bd is counted by putting a small script in its place (BEND_BD) that
//     notes each start and then runs the real one.

package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// counted makes a repository whose bd is counted; starts gives how many
// times bend has started it since the last call.
func counted(t *testing.T) (repo *repository, starts func() int) {
	t.Helper()
	repo = newRepository(t)
	real, err := exec.LookPath("bd")
	if err != nil {
		t.Skip("bd is not available")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "starts")
	script := filepath.Join(dir, "bd")
	os.WriteFile(script, []byte("#!/bin/sh\necho x >> "+log+"\nexec "+real+" \"$@\"\n"), 0o755)
	repo.env = []string{"BEND_BD=" + script}
	seen := 0
	return repo, func() int {
		content, _ := os.ReadFile(log)
		now := strings.Count(string(content), "x")
		since := now - seen
		seen = now
		return since
	}
}

func TestBeadsReadsFromAFreshCopyStartNoBd(t *testing.T) {
	newOnly(t)
	repo, starts := counted(t)
	id := repo.ok("create", "Kept", "--description", "Wanted.")
	starts()
	// The first read after a change rereads the copy: one start of bd.
	same(t, repo.show(id).Title, "Kept", "the new issue")
	same(t, starts(), 1, "starts of bd for the first read after a change")
	// From then on, none, whatever is read; and quickly.
	began := time.Now()
	repo.ok("list")
	repo.ok("list", "--status", "all", "--json", "--with-body")
	repo.ok("show", id)
	took := time.Since(began) / 3
	same(t, starts(), 0, "starts of bd for reads from a fresh copy")
	if took > 50*time.Millisecond {
		t.Errorf("a read from the copy took %s", took)
	}
	// What is ready is beads' own answer: asked once, then kept.
	repo.ok("ready")
	if asked := starts(); asked < 1 {
		t.Fatalf("bd was not asked what is ready")
	}
	repo.ok("ready")
	same(t, starts(), 0, "starts of bd for a second ready")
	// Comments: once per issue, until the issue changes.
	repo.ok("comments", id)
	starts()
	repo.ok("comments", id)
	same(t, starts(), 0, "starts of bd for comments read again")

	// A change made with bd directly, behind bend's back, shows at once.
	direct := exec.Command("bd", "update", id, "--title", "Renamed with bd")
	direct.Dir = repo.root
	if out, err := direct.CombinedOutput(); err != nil {
		t.Fatalf("bd update: %v\n%s", err, out)
	}
	same(t, repo.show(id).Title, "Renamed with bd", "the title after a change made with bd")
	starts()
	// A change through bend shows in the next read, comments included.
	repo.ok("comment", id, "Said through bend.")
	if comments := repo.ok("comments", id); !strings.Contains(comments, "Said through bend.") {
		t.Fatalf("got the comments:\n%s", comments)
	}
	same(t, repo.show(id).CommentCount, 1, "the comment count")
	// --fresh and refresh reread whatever the copy holds.
	starts()
	repo.ok("list", "--fresh")
	same(t, starts(), 1, "starts of bd for a fresh list")
	repo.ok("refresh")
	same(t, starts(), 1, "starts of bd for a refresh")
	// BEND_LIVE asks bd every time, as before there was a copy.
	repo.env = append(repo.env, "BEND_LIVE=1")
	repo.ok("list")
	same(t, starts(), 1, "starts of bd for a read that asks the tracker itself")
}

func TestBeadsCopyIsInTheGitFolderAndDeletingItIsHarmless(t *testing.T) {
	newOnly(t)
	repo := newRepository(t)
	id := repo.ok("create", "Kept")
	repo.ok("list")
	var about struct {
		Copy *string `json:"copy"`
	}
	repo.parse(repo.ok("status", "--quick", "--json"), &about)
	want := filepath.Join(repo.root, ".git", "bend", "beads")
	if about.Copy == nil || *about.Copy != want {
		t.Fatalf("the copy is said to be in %v", about.Copy)
	}
	if _, err := os.Stat(filepath.Join(want, "issues.json")); err != nil {
		t.Fatalf("the copy's file is not there: %v", err)
	}
	// git sees nothing of it.
	status := exec.Command("git", "status", "--porcelain", "--", ".git")
	status.Dir = repo.root
	if out, _ := status.Output(); strings.TrimSpace(string(out)) != "" {
		t.Fatalf("git status shows the copy:\n%s", out)
	}
	if !strings.Contains(repo.ok("status"), "Kept in      "+want) {
		t.Fatal("the status does not say where the copy is")
	}
	// Deleted, it is made anew by the next read.
	os.RemoveAll(want)
	same(t, repo.show(id).Title, "Kept", "the issue after the copy was deleted")
	// Half-written, the same.
	os.WriteFile(filepath.Join(want, "issues.json"), []byte("[{"), 0o644)
	same(t, repo.show(id).Title, "Kept", "the issue after the copy was damaged")
}

func TestBeadsCopyInAWorkTreeSeesAChangeMadeWithBd(t *testing.T) {
	newOnly(t)
	repo, starts := counted(t)
	repo.run("git", "add", "-A")
	repo.run("git", "commit", "-q", "-m", "start")
	tree := filepath.Join(filepath.Dir(repo.root), "tree-"+filepath.Base(repo.root))
	repo.run("git", "worktree", "add", "-q", tree, "-b", "tree")
	t.Cleanup(func() { os.RemoveAll(tree) })
	id := repo.ok("create", "Seen from a work tree")

	// The work tree has a `.beads` folder of its own (the checked-in
	// settings), and beads writes to the main folder's all the same.
	inTree := &repository{t: t, root: tree, env: repo.env}
	same(t, inTree.show(id).Title, "Seen from a work tree", "the issue, from the work tree")
	starts()
	inTree.ok("list")
	same(t, starts(), 0, "starts of bd for a read from the work tree with a fresh copy")
	var about struct {
		Copy  *string `json:"copy"`
		Watch *string `json:"watch"`
	}
	inTree.parse(inTree.ok("status", "--quick", "--json"), &about)
	if about.Copy == nil || *about.Copy != filepath.Join(repo.root, ".git", "bend", "beads") {
		t.Fatalf("the work tree's copy is said to be in %v", about.Copy)
	}
	if about.Watch == nil || *about.Watch != filepath.Join(repo.root, ".beads", "last-touched") {
		t.Fatalf("the file to watch is said to be %v", about.Watch)
	}
	// A change made with bd in the work tree, behind bend's back.
	direct := exec.Command("bd", "update", id, "--title", "Renamed in the work tree")
	direct.Dir = tree
	if out, err := direct.CombinedOutput(); err != nil {
		t.Fatalf("bd update: %v\n%s", err, out)
	}
	same(t, inTree.show(id).Title, "Renamed in the work tree", "the title in the work tree after a change made with bd")
	// The main folder sees it too, from the same copy, with no start of bd.
	starts()
	same(t, repo.show(id).Title, "Renamed in the work tree", "the title in the main folder")
	same(t, starts(), 0, "starts of bd for the main folder's read of the shared copy")
}

func TestBeadsCopyIsRereadBehindACommand(t *testing.T) {
	newOnly(t)
	repo, starts := counted(t)
	id := repo.ok("create", "Kept")
	repo.ok("list")
	starts()
	// With the reread behind the command allowed: after a change it is
	// done by a process of its own, and the next read finds a fresh copy.
	// The helper that syncs on a clock is left out: it starts bd too, at
	// moments of its own.
	repo.env = append(repo.env, "BEND_NO_BACKGROUND=", "BEND_NO_HELPER=1")
	repo.ok("edit", id, "--title", "Kept, changed")
	fresh := false
	for range 50 {
		time.Sleep(100 * time.Millisecond)
		state, _ := os.ReadFile(filepath.Join(repo.root, ".git", "bend", "beads", "state.json"))
		if len(state) > 0 && !strings.Contains(string(state), `"behind"`) {
			fresh = true
			break
		}
	}
	if !fresh {
		t.Fatal("the copy was not reread behind the command")
	}
	starts()
	same(t, repo.show(id).Title, "Kept, changed", "the title, from the copy reread behind the command")
	same(t, starts(), 0, "starts of bd for that read")
}
