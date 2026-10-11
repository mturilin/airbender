// Package localcopy keeps files for a hosted tracker's local copy.
//
// What: finds the folder a repository's copy lives in, reads and writes
// its files whole, and gives the two locks that let several bend processes
// share it: one for changing a file, one for "a sync is running".
//
// Why: a hosted tracker is too slow to ask for every read, so bend works
// from a copy on this machine (bead-bb-c9l.5). This package is the part of
// that which knows nothing about any tracker, so that another hosted
// tracker's copy can be built on it.
//
// Design notes:
//   - The copy lives in the repository's shared git folder (the owner's
//     choice): every work tree of the repository sees the same copy and the
//     same waiting changes, nothing of it is committed or shown by `git
//     status`, and it goes when the repository goes. A folder that is not a
//     git repository keeps its copy under the user's data folder.
//   - Every file is JSON, written whole to a temporary file and renamed into
//     place, so a reader never sees half a file and a crash leaves the old
//     one.
//   - Locks are advisory file locks: they are let go by the operating system
//     when the process ends, however it ends, so a crashed bend never leaves
//     the copy locked.
//
// Gotchas:
//   - Unix only (flock). bend is not built for Windows yet.
//   - Deleting the folder is safe except for changes still waiting to be
//     sent, which are in it.
package localcopy

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Store is the folder of one repository's copy.
type Store struct {
	// Dir is the folder; made when first written to.
	Dir string
}

// FolderFor gives the folder for the copy of a hosted repository, for a
// checkout at root.
//
// name is the hosted repository, e.g. "owner/name"; it becomes part of the
// folder's name, so that a checkout switched to another repository does not
// read the first one's copy.
// Side effects: one read-only git command.
func FolderFor(root, name string) string {
	leaf := strings.NewReplacer("/", "__", string(filepath.Separator), "__").Replace(name)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", "rev-parse", "--git-common-dir")
	command.Dir = root
	if out, err := command.Output(); err == nil {
		// git answers relative to root when root is the main folder.
		common := strings.TrimSpace(string(out))
		if common != "" {
			if !filepath.IsAbs(common) {
				common = filepath.Join(root, common)
			}
			return filepath.Join(filepath.Clean(common), "bend", leaf)
		}
	}
	// Not a git repository: under the user's own data folder.
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = os.TempDir()
		}
		data = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(data, "bend", leaf)
}

// path gives a file's place in the folder.
func (store Store) path(name string) string { return filepath.Join(store.Dir, name) }

// Read reads a file of the copy into value.
//
// Returns false, with no error, when the file is not there: value is left
// as it was. A file that cannot be understood is an error.
func (store Store) Read(name string, value any) (bool, error) {
	content, err := os.ReadFile(store.path(name))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(content, value)
}

// Write replaces a file of the copy with value, whole.
//
// Side effects: makes the folder when it is not there; the file is written
// beside its place and renamed into it.
func (store Store) Write(name string, value any) error {
	content, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		return err
	}
	target := store.path(name)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), filepath.Base(target)+".*")
	if err != nil {
		return err
	}
	_, err = temporary.Write(append(content, '\n'))
	// On the disk before it takes the old file's place: after a power cut
	// the file is the old one or the new one, never an empty one.
	if syncErr := temporary.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporary.Name(), target)
	}
	if err != nil {
		os.Remove(temporary.Name())
	}
	return err
}

// Remove deletes a file of the copy; one that is not there is no error.
func (store Store) Remove(name string) error {
	if err := os.Remove(store.path(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Append adds a line to a text file of the copy (its log). Failures are
// not reported: the log is a convenience.
func (store Store) Append(name, line string) {
	if os.MkdirAll(store.Dir, 0o755) != nil {
		return
	}
	file, err := os.OpenFile(store.path(name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	file.WriteString(line + "\n")
}

// lock takes an advisory lock on a file of the folder.
//
// wait says whether to wait for another holder to let go. Returns the
// function that lets go; ok is false, with no error, when wait is false and
// the lock is held by another process.
func (store Store) lock(name string, wait bool) (unlock func(), ok bool, err error) {
	if err := os.MkdirAll(store.Dir, 0o755); err != nil {
		return nil, false, err
	}
	file, err := os.OpenFile(store.path(name), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, err
	}
	how := syscall.LOCK_EX
	if !wait {
		how |= syscall.LOCK_NB
	}
	if err := syscall.Flock(int(file.Fd()), how); err != nil {
		file.Close()
		if !wait && errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return func() {
		syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		file.Close()
	}, true, nil
}

// Changing runs act while holding the lock for changing the copy's files,
// waiting for another process that holds it. The moments are short: read a
// file, change it, write it. Nothing slow (no network) belongs inside.
func (store Store) Changing(act func() error) error {
	unlock, _, err := store.lock("files.lock", true)
	if err != nil {
		return err
	}
	defer unlock()
	return act()
}

// Syncing takes the lock that says "a sync is running", without waiting.
//
// Returns the function that lets go; ok is false when another process is
// syncing, in which case there is nothing for this one to do.
func (store Store) Syncing() (done func(), ok bool, err error) {
	return store.lock("sync.lock", false)
}

// SetAside renames a file of the copy out of the way, so that a file that
// cannot be read is kept for a person to look at and the copy can go on
// without it. Returns the new name; "" when there was no such file.
func (store Store) SetAside(name string) string {
	aside := name + ".unreadable"
	if os.Rename(store.path(name), store.path(aside)) != nil {
		return ""
	}
	return aside
}
