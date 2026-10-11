// store_test.go — tests for the copy's file store.
//
// What: checks where the copy is kept (the repository's shared git folder,
// the same from every work tree; the user's data folder outside git),
// reading and writing files whole, and the two locks.
//
// Why: the waiting changes of a hosted tracker's copy live in these files
// and nowhere else; and work trees must share one copy, or they would
// disagree (the owner's choice of the git folder).

package localcopy

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// git runs git in a folder, kept apart from the user's own settings; the
// test is skipped where git is not available.
func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	if out, err := command.CombinedOutput(); err != nil {
		t.Skipf("git is not available: %v\n%s", err, out)
	}
}

func TestTheCopyIsInTheSharedGitFolder(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	main, tree := filepath.Join(base, "main"), filepath.Join(base, "tree")
	os.MkdirAll(filepath.Join(main, "deep"), 0o755)
	git(t, main, "init", "-q")
	git(t, main, "commit", "-q", "--allow-empty", "-m", "start")
	git(t, main, "worktree", "add", "-q", tree, "-b", "tree")
	want := filepath.Join(main, ".git", "bend", "owner__name")
	for _, from := range []string{main, tree} {
		if got := FolderFor(from, "owner/name"); got != want {
			t.Fatalf("from %s: got %s, want %s", from, got, want)
		}
	}
	// A folder below the top is another place for a tracker: its own copy,
	// in the same git folder.
	deep := FolderFor(filepath.Join(main, "deep"), "owner/name")
	if deep == want || filepath.Dir(deep) != filepath.Dir(want) {
		t.Fatalf("a folder below the top got %s", deep)
	}
	// Another hosted repository gets a folder of its own.
	if got := FolderFor(main, "owner/other"); got == want {
		t.Fatal("two repositories share one copy")
	}
	// Outside git: under the user's data folder.
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	one, other := t.TempDir(), t.TempDir()
	got := FolderFor(one, "owner/name")
	if filepath.Dir(got) != filepath.Join(data, "bend") || !strings.HasPrefix(filepath.Base(got), "owner__name-") {
		t.Fatalf("got %s", got)
	}
	// The same folder gives the same place; another folder, another.
	if FolderFor(one, "owner/name") != got || FolderFor(other, "owner/name") == got {
		t.Fatal("folders outside git do not each have their own copy")
	}
}

func TestFilesAreReadAndWrittenWhole(t *testing.T) {
	store := Store{Dir: filepath.Join(t.TempDir(), "not", "made", "yet")}
	var value map[string]int
	if there, err := store.Read("a.json", &value); there || err != nil {
		t.Fatalf("got %v, %v", there, err)
	}
	if err := store.Write("sub/a.json", map[string]int{"n": 1}); err != nil {
		t.Fatal(err)
	}
	if there, err := store.Read("sub/a.json", &value); !there || err != nil || value["n"] != 1 {
		t.Fatalf("got %v, %v, %v", there, err, value)
	}
	// Nothing is left beside the file.
	if entries, _ := os.ReadDir(filepath.Join(store.Dir, "sub")); len(entries) != 1 {
		t.Fatalf("got %d files", len(entries))
	}
	os.WriteFile(filepath.Join(store.Dir, "bad.json"), []byte("{half"), 0o644)
	if _, err := store.Read("bad.json", &value); err == nil {
		t.Fatal("a file that is not JSON was read")
	}
	if store.Remove("sub/a.json") != nil || store.Remove("sub/a.json") != nil {
		t.Fatal("removing failed")
	}
}

func TestOnlyOneSyncAtATime(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	done, free, err := store.Syncing()
	if err != nil || !free {
		t.Fatalf("got %v, %v", free, err)
	}
	if _, second, err := store.Syncing(); second || err != nil {
		t.Fatalf("a second sync got the lock: %v, %v", second, err)
	}
	// Changing files is a lock of its own: a sync does not hold it.
	ran := false
	if err := store.Changing(func() error { ran = true; return nil }); err != nil || !ran {
		t.Fatal("files could not be changed while a sync runs")
	}
	done()
	if again, free, _ := store.Syncing(); !free {
		t.Fatal("the lock was not let go")
	} else {
		again()
	}
}
