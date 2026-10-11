// background.go — syncing after a command, without holding it up.
//
// What: remembers the copies a command opened, and after the command
// starts `bend sync` as a process of its own for each one that asked for
// it: after a change was recorded, or a read found the copy a few minutes
// old.
//
// Why: the owner's rule is that a read never waits for the network while
// the copy is less than a day old, and that changes are sent
// asynchronously, with no daemon for now (bead-bb-c9l.5). A process that
// outlives the command does both.
//
// Design notes:
//   - The process is bend itself, started detached: its own session, no
//     terminal, its output into the copy's log. Nobody waits for it and
//     nothing depends on it: if it fails (no network in a sandbox, say) the
//     changes still wait in the queue for the next command, the next sync,
//     or whoever calls `bend sync` on a timer.
//   - Two of them cannot run at once: the second finds the sync lock held
//     and leaves.
//
// Gotchas:
//   - BEND_NO_BACKGROUND, when set, starts nothing: for tests, which sync
//     when they mean to, and for a caller that syncs on its own timer.
//   - Unix only (a session of its own).

package github

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
)

// opened is the copies this process has opened, with the folder each was
// opened for.
var (
	openedLock sync.Mutex
	opened     []struct {
		made *Copy
		root string
	}
)

// Opened notes that a copy was opened for the repository at root, so that
// AfterCommand can sync it.
func Opened(made *Copy, root string) {
	openedLock.Lock()
	defer openedLock.Unlock()
	opened = append(opened, struct {
		made *Copy
		root string
	}{made, root})
}

// AfterCommand starts a sync in the background for every copy that asked
// for one during this command. Call it once, when the command is over.
//
// Side effects: may start processes that outlive this one.
func AfterCommand() {
	openedLock.Lock()
	defer openedLock.Unlock()
	if os.Getenv("BEND_NO_BACKGROUND") != "" {
		return
	}
	for _, one := range opened {
		if !one.made.wantsSync {
			continue
		}
		one.made.wantsSync = false
		program, err := os.Executable()
		if err != nil {
			continue
		}
		// --no-wait: if a sync is running, this one leaves; the running one
		// goes round again for what was recorded meanwhile.
		command := exec.Command(program, "-C", one.root, "sync", "--no-wait")
		// Its own session: it is not ended with the terminal or the caller.
		command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if os.MkdirAll(one.made.store.Dir, 0o755) == nil {
			if log, err := os.OpenFile(filepath.Join(one.made.store.Dir, logFile), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				command.Stderr = log
				defer log.Close()
			}
		}
		// A sync started from a sync would go on for ever.
		command.Env = append(os.Environ(), "BEND_NO_BACKGROUND=1")
		if command.Start() == nil {
			command.Process.Release()
		}
	}
}
