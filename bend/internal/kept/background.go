// background.go — rereading the copy after a command, without holding it
// up.
//
// What: remembers the copies a command opened, and after the command
// starts `bend refresh` as a process of its own for each one that asked for
// it: after a change was made through it, or a read found it a few minutes
// old.
//
// Why: a change must return as soon as the tracker has answered, and a read
// must not wait for a reread it does not strictly need (bead-bb-c9l.14).
// The reread costs one start of the tracker's program; done behind the
// command, the next read finds a fresh copy and costs nothing.
//
// Design notes:
//   - The process is bend itself, started detached: its own session, no
//     terminal, its complaints into the copy's log. Nobody waits for it and
//     nothing depends on it: if it fails, the next read finds the copy
//     behind and rereads it itself.
//
// Gotchas:
//   - BEND_NO_BACKGROUND, when set, starts nothing: for tests, which must
//     not leave processes behind, and for the process started here.
//   - Unix only (a session of its own).

package kept

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
)

// logFile is where a reread behind a command leaves its complaints.
const logFile = "refresh.log"

// opened is the copies this process has opened, with the folder each was
// opened for.
var (
	openedLock sync.Mutex
	opened     []struct {
		made *Tracker
		dir  string
	}
)

// Opened notes that a copy was opened for a command run in dir, so that
// AfterCommand can have it reread.
func Opened(made *Tracker, dir string) {
	openedLock.Lock()
	defer openedLock.Unlock()
	opened = append(opened, struct {
		made *Tracker
		dir  string
	}{made, dir})
}

// AfterCommand starts a reread behind the command for every copy that
// asked for one. Call it once, when the command is over.
//
// Side effects: may start processes that outlive this one.
func AfterCommand() {
	openedLock.Lock()
	defer openedLock.Unlock()
	if os.Getenv("BEND_NO_BACKGROUND") != "" {
		return
	}
	for _, one := range opened {
		if !one.made.wantsReread {
			continue
		}
		one.made.wantsReread = false
		program, err := os.Executable()
		if err != nil {
			continue
		}
		// A queued tracker's copy is synced (what waits is sent); if a sync
		// is running this one leaves, and that one goes round again. A
		// straight one's is reread.
		command := exec.Command(program, "-C", one.dir, "refresh")
		if one.made.isQueued() {
			command = exec.Command(program, "-C", one.dir, "sync", "--no-wait")
		}
		// Its own session: it is not ended with the terminal or the caller.
		command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if os.MkdirAll(one.made.store.Dir, 0o755) == nil {
			if log, err := os.OpenFile(filepath.Join(one.made.store.Dir, logFile), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				command.Stderr = log
				defer log.Close()
			}
		}
		// A reread started from a reread would go on for ever.
		command.Env = append(os.Environ(), "BEND_NO_BACKGROUND=1")
		if command.Start() == nil {
			command.Process.Release()
		}
	}
}
