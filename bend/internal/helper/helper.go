// Package helper is the process that syncs a repository's issues on a
// clock.
//
// What: a small process of bend's own, one per copy of a repository's
// issues. Any bend command starts it when it is not running; it syncs every
// few minutes and ends by itself when bend has not been used for a while.
// This file is everything about it: starting, stopping, disabling, what it
// says about itself, and its loop.
//
// Why: bend runs only when a command is typed, so it cannot keep time. The
// Airbender plugin used to keep it, which put the plugin on the path the
// owner's data takes: "asking plugin to do critical data management path is
// kind of smelly". The owner proposed this instead (bead-bb-c9l.16): "on
// every bend invocation ... check if the process is there ... if bend is
// not called for ... half an hour, it dies automatically. So there is this
// kind of very nonsticky process."
//
// Design notes:
//   - It knows no tracker. It is told three things by whoever starts its
//     loop: whether syncing is switched on, how the last sync ended and
//     when, and how to run one. A third tracker gets the clock for nothing.
//   - Never two: it holds a lock file for as long as it lives, and one that
//     cannot take it ends at once. The system lets the lock go however the
//     process ends, so nothing has to be cleaned up after a crash.
//   - It talks to nobody. What it is doing is read from files in the copy's
//     folder: who holds the lock, when bend was last used, whether it is
//     disabled, when it last gave up.
//   - Each sync is a process of its own (`bend sync`), with a limit: one
//     that hangs is ended, and it is exactly what a sync by hand runs.
//   - Four plain words for the owner (their decision): stop ends the one
//     running and nothing more, start starts one now, disable ends it and
//     keeps it from being started in this repository, enable allows it
//     again.
//   - "Bend was used" is any command a person or an agent ran on purpose.
//     A caller that reads only because it was told the files changed (the
//     plugin's watcher) says so with BEND_PASSIVE, and is not counted:
//     otherwise a helper's own sync would keep it alive through an open
//     tab.
//   - After three failed syncs in a row it gives up and ends, so that one
//     started where the remote cannot be reached (inside an agent's
//     sandbox) does not hold the place of a working one. No helper is then
//     started from the same surroundings for a while, longer each time; a
//     command from other surroundings (another network view) starts one at
//     once, and replaces a running one that is failing.
//
// Gotchas:
//   - Unix only (a session of its own, a lock on a file).
//   - BEND_NO_BACKGROUND switches the starting by itself off, for tests and
//     for a caller that wants no process left behind; BEND_NO_HELPER does
//     the same for the helper alone. `bend helper start` still starts one.

package helper

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mturilin/airbender/bend/internal/localcopy"
	"github.com/mturilin/airbender/bend/internal/tracker"
)

// The files of the helper, in the copy's folder.
const (
	lockFile     = "helper.lock"
	aboutFile    = "helper.json"
	usedFile     = "used"
	disabledFile = "helper-disabled"
	gaveUpFile   = "helper-gave-up.json"
	logFile      = "helper.log"
)

// Times are the times the helper works by.
type Times struct {
	// Every is how long after the last sync, by anyone, the next is run.
	Every time.Duration
	// Idle is how long bend may go unused before the helper ends.
	Idle time.Duration
	// Wake is how often it looks whether anything is to be done.
	Wake time.Duration
	// Limit is the longest one sync may take before it is ended. Longer
	// than the limits a sync sets itself (a tracker's own program is ended
	// after five minutes), so that a sync that hangs is ended by itself,
	// from the inside, and leaves its entry in the log.
	Limit time.Duration
}

// failuresToGiveUp is how many syncs in a row may fail before it ends.
const failuresToGiveUp = 3

// longestPause is the longest no helper is started after giving up.
const longestPause = time.Hour

// TimesNow gives the times to work by: three minutes, half an hour, with
// BEND_HELPER_EVERY, BEND_HELPER_IDLE and BEND_HELPER_WAKE (durations such
// as "2s") to shorten them in tests.
func TimesNow() Times {
	times := Times{Every: 3 * time.Minute, Idle: 30 * time.Minute, Wake: 15 * time.Second, Limit: 7 * time.Minute}
	read := func(name string, into *time.Duration) {
		if given, err := time.ParseDuration(os.Getenv(name)); err == nil && given > 0 {
			*into = given
		}
	}
	read("BEND_HELPER_EVERY", &times.Every)
	read("BEND_HELPER_IDLE", &times.Idle)
	read("BEND_HELPER_WAKE", &times.Wake)
	return times
}

// about is what a running helper writes about itself.
type about struct {
	Pid int `json:"pid"`
	// StartedAt is in milliseconds since 1970.
	StartedAt int64 `json:"startedAt"`
	// Surroundings is the mark of where it was started from (see
	// surroundings).
	Surroundings string `json:"surroundings"`
	// Failing is how many syncs in a row have failed.
	Failing int `json:"failing"`
}

// gaveUp is what a helper leaves when it ends after failures.
type gaveUp struct {
	Surroundings string `json:"surroundings"`
	// At is in milliseconds since 1970.
	At int64 `json:"at"`
	// Times is how many helpers in a row gave up.
	Times int `json:"times"`
}

// State is what can be said about a copy's helper.
type State struct {
	Running bool `json:"running"`
	// Pid and Since (milliseconds since 1970) are of the running one; 0
	// when none runs.
	Pid   int   `json:"pid"`
	Since int64 `json:"since"`
	// Disabled says it is kept from being started in this repository.
	Disabled bool `json:"disabled"`
	// GaveUpAt is when the last one ended after failed syncs, and
	// HeldBackUntil until when none is started by itself from the same
	// surroundings (both milliseconds since 1970; 0 for neither).
	GaveUpAt      int64 `json:"gaveUpAt"`
	HeldBackUntil int64 `json:"heldBackUntil"`
}

// surroundings gives a mark of the network this process sees: the network
// namespace where the system has such a thing, and the proxies it is told
// to use. A sandbox that closes the network differs in one or the other,
// which is how a helper that fails there is told from one that would work.
func surroundings() string {
	parts := []string{}
	if space, err := os.Readlink("/proc/self/ns/net"); err == nil {
		parts = append(parts, space)
	}
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		parts = append(parts, os.Getenv(name))
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:6])
}

// pauseAfter is how long no helper is started after so many gave up in a
// row: the sync's own pace, doubled each time, up to an hour.
func pauseAfter(times int, every time.Duration) time.Duration {
	pause := every
	for step := 1; step < times && pause < longestPause; step++ {
		pause *= 2
	}
	return min(pause, longestPause)
}

// Look says how the helper of the copy in dir stands. Nothing is changed.
func Look(dir string) State {
	store := localcopy.Store{Dir: dir}
	state := State{}
	if _, err := os.Stat(filepath.Join(dir, disabledFile)); err == nil {
		state.Disabled = true
	}
	if store.Held(lockFile) {
		state.Running = true
		var running about
		if there, _ := store.Read(aboutFile, &running); there {
			state.Pid, state.Since = running.Pid, running.StartedAt
		}
	}
	var gave gaveUp
	if there, _ := store.Read(gaveUpFile, &gave); there && gave.Times > 0 {
		state.GaveUpAt = gave.At
		if gave.Surroundings == surroundings() {
			until := gave.At + pauseAfter(gave.Times, TimesNow().Every).Milliseconds()
			if until > time.Now().UnixMilli() {
				state.HeldBackUntil = until
			}
		}
	}
	return state
}

// Used marks that bend was used on the copy in dir now.
func Used(dir string) {
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	mark := filepath.Join(dir, usedFile)
	now := time.Now()
	if os.Chtimes(mark, now, now) != nil {
		os.WriteFile(mark, nil, 0o644)
	}
}

// SyncedWell forgets that a helper gave up: a sync has just ended well, so
// the next one may be started at once.
func SyncedWell(dir string) {
	os.Remove(filepath.Join(dir, gaveUpFile))
}

// AfterCommand is called when a bend command that was run on purpose is
// over: it marks bend as used, and starts the helper when none is running.
//
// dir is the copy's folder; work is the folder the command was run for,
// which the helper syncs from.
// Side effects: may start a process that outlives this one.
func AfterCommand(dir, work string) {
	if os.Getenv("BEND_NO_BACKGROUND") != "" || os.Getenv("BEND_PASSIVE") != "" {
		return
	}
	Used(dir)
	if os.Getenv("BEND_NO_HELPER") != "" {
		return
	}
	state := Look(dir)
	if state.Disabled {
		return
	}
	if state.Running {
		// One that is failing, started from other surroundings than these,
		// is replaced: these may reach what those cannot.
		var running about
		store := localcopy.Store{Dir: dir}
		if there, _ := store.Read(aboutFile, &running); !there || running.Failing == 0 || running.Surroundings == surroundings() {
			return
		}
		if !Stop(dir) {
			return
		}
	} else if state.HeldBackUntil > 0 {
		return
	}
	start(dir, work)
}

// start starts the helper for the copy in dir, working from work, as a
// process nobody waits for. Returns whether it was started.
func start(dir, work string) bool {
	program, err := os.Executable()
	if err != nil {
		return false
	}
	command := exec.Command(program, "-C", work, "helper", "run")
	// Its own session: it is not ended with the terminal or the caller.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if os.MkdirAll(dir, 0o755) == nil {
		if log, err := os.OpenFile(filepath.Join(dir, logFile), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			command.Stderr = log
			defer log.Close()
		}
	}
	// What the helper runs is not bend being used, and starts nothing
	// behind itself.
	command.Env = append(os.Environ(), "BEND_NO_BACKGROUND=1", "BEND_PASSIVE=1")
	if command.Start() != nil {
		return false
	}
	command.Process.Release()
	return true
}

// Start starts the helper now, whatever held it back; it is the owner's
// `bend helper start`.
//
// Returns what happened in words, and whether one is running or was
// started.
func Start(dir, work string) (string, bool) {
	state := Look(dir)
	switch {
	case state.Disabled:
		return "The helper is disabled in this repository. `bend helper enable` allows it again.", false
	case state.Running:
		return "The helper is already running.", true
	}
	Used(dir)
	SyncedWell(dir)
	if !start(dir, work) {
		return "The helper could not be started.", false
	}
	return "The helper is started.", true
}

// isHelper says whether the process with this id is a bend helper, where
// the system lets that be seen (/proc); true where it cannot be told. The
// id is read from a file, and a file can outlive the process that wrote
// it: a signal must not go to whatever has the number now.
func isHelper(pid int) bool {
	line, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		_, statErr := os.Stat("/proc/self/cmdline")
		// No /proc at all: it cannot be told. With /proc and no such
		// process: it is not there.
		return statErr != nil
	}
	words := strings.Split(string(line), "\x00")
	for at := 0; at+1 < len(words); at++ {
		if words[at] == "helper" && words[at+1] == "run" {
			return true
		}
	}
	return false
}

// Stop ends the running helper of the copy in dir and waits for it to be
// gone. Returns whether none is running afterwards.
func Stop(dir string) bool {
	store := localcopy.Store{Dir: dir}
	if !store.Held(lockFile) {
		return true
	}
	// A helper that has only just taken the lock writes its file a moment
	// later: looked for a few times.
	var running about
	for tries := 0; tries < 10; tries++ {
		if there, _ := store.Read(aboutFile, &running); there && running.Pid > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if running.Pid <= 0 || !isHelper(running.Pid) {
		return !store.Held(lockFile)
	}
	syscall.Kill(running.Pid, syscall.SIGTERM)
	for waited := 0; waited < 50; waited++ {
		if !store.Held(lockFile) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// Disable ends the helper and keeps it from being started for the copy in
// dir, until Enable. Returns false when the mark could not be written.
func Disable(dir string) bool {
	if os.MkdirAll(dir, 0o755) != nil || os.WriteFile(filepath.Join(dir, disabledFile), nil, 0o644) != nil {
		return false
	}
	Stop(dir)
	return true
}

// Enable allows the helper again for the copy in dir.
func Enable(dir string) {
	os.Remove(filepath.Join(dir, disabledFile))
}

// Config is what the helper's loop is given.
type Config struct {
	// Dir is the copy's folder; Work the folder it syncs from.
	Dir, Work string
	Times     Times
	// On says whether syncing is switched on for the repository; known is
	// false when that could not be told now (the remote was not reached).
	On func() (on, known bool)
	// Last gives when a sync last ended well (the zero time for never), and
	// whether syncing by itself has stopped until a person settles
	// something.
	Last func() (syncedAt time.Time, halted bool)
	// Sync runs one sync and says how it ended.
	Sync func() tracker.SyncEnd
	// Now and Sleep stand in for the clock in tests; the real ones when
	// nil.
	Now   func() time.Time
	Sleep func(time.Duration)
	// Program is the file this process runs from, watched for being
	// replaced; os.Executable when "".
	Program string
}

// programStamp gives a mark of a program file that changes when the file
// is replaced; "" when it is not there.
func programStamp(path string) string {
	file, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return strconv.FormatInt(file.ModTime().UnixNano(), 10) + "." + strconv.FormatInt(file.Size(), 10)
}

// Run is the helper's loop. It returns when the helper is to end, with the
// reason in a few words.
//
// Side effects: holds the helper's lock until it returns; writes its own
// files in the copy's folder; runs syncs.
func Run(config Config) string {
	now := config.Now
	if now == nil {
		now = time.Now
	}
	store := localcopy.Store{Dir: config.Dir}
	release, free, err := store.Hold(lockFile)
	if err != nil {
		return "its folder cannot be written"
	}
	if !free {
		return "another helper is running"
	}
	defer release()
	program := config.Program
	if program == "" {
		program, _ = os.Executable()
	}
	stamp := programStamp(program)
	me := about{Pid: os.Getpid(), StartedAt: now().UnixMilli(), Surroundings: surroundings()}
	store.Write(aboutFile, me)
	// Its file names a process: it goes when the process does, so that the
	// number is not taken for a helper's later.
	defer store.Remove(aboutFile)
	// Told to stop: it ends the usual way, letting go of what it holds.
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(stopped)

	// failed counts a try that did not work; true when it was one too many.
	failed := func() bool {
		me.Failing++
		store.Write(aboutFile, me)
		if me.Failing < failuresToGiveUp {
			return false
		}
		var gave gaveUp
		store.Read(gaveUpFile, &gave)
		store.Write(gaveUpFile, gaveUp{Surroundings: me.Surroundings, At: now().UnixMilli(), Times: gave.Times + 1})
		return true
	}
	// attempted is when this helper last tried a sync: nothing is tried
	// again before the usual time has passed.
	var attempted time.Time
	first := true
	for {
		// The first look comes soon: a helper is started because bend was
		// just used, and what was changed should not wait a whole round.
		pause := config.Times.Wake
		if first {
			pause, first = min(pause, time.Second), false
		}
		if config.Sleep != nil {
			config.Sleep(pause)
		} else {
			select {
			case <-stopped:
				return "stopped"
			case <-time.After(pause):
			}
		}
		if _, err := os.Stat(filepath.Join(config.Dir, disabledFile)); err == nil {
			return "disabled"
		}
		used, err := os.Stat(filepath.Join(config.Dir, usedFile))
		if err != nil || now().Sub(used.ModTime()) >= config.Times.Idle {
			return "bend was not used for a while"
		}
		if programStamp(program) != stamp {
			return "the bend program was replaced"
		}
		if _, err := os.Stat(config.Work); err != nil {
			return "its folder is gone"
		}
		syncedAt, halted := config.Last()
		if halted {
			// A person has to settle it; a sync asked for takes it up again.
			continue
		}
		// A sync that ended well, by anyone, pushes this one back. One that
		// failed does not: it may have failed where the remote cannot be
		// reached (an agent's sandbox), and this helper may reach it.
		since := attempted
		if syncedAt.After(since) {
			since = syncedAt
		}
		if !since.IsZero() && now().Sub(since) < config.Times.Every {
			continue
		}
		attempted = now()
		on, known := config.On()
		if !known {
			// It cannot be told whether there is anything to sync with:
			// from here the remote is not reached. That counts as a try
			// that failed, so that this helper does not hold the place of
			// one that could reach it.
			if failed() {
				return "syncs kept failing"
			}
			continue
		}
		if !on {
			continue
		}
		switch config.Sync() {
		case tracker.SyncSynced:
			if me.Failing != 0 {
				me.Failing = 0
				store.Write(aboutFile, me)
			}
			SyncedWell(config.Dir)
		case tracker.SyncFailed:
			if failed() {
				return "syncs kept failing"
			}
		}
		attempted = now()
	}
}
