// app/github-sync.tsx — the "Sync with GitHub" window.
//
// What: a window in which the owner ticks GitHub issues to bring into beads
// and beads issues to send to GitHub, previews what that would do, and then
// has it done.
//
// Why: the user asked for a dialog to sync with GitHub issues, both ways,
// with issues chosen and the result previewed first (bead-bb-rh3). The
// syncing itself is beads' own command, run by the server
// (server/github.ts); this file only chooses, shows and confirms.
//
// Design notes:
// - A window, not part of the panel: a list of issues with labels and a
//   before-and-after preview needs more width than a side tab has, and it
//   is an occasional task with a clear end. The same fixed size as the
//   details window, with the lists scrolling inside.
// - Three columns side by side, nothing ticked to begin with: "To GitHub"
//   (issues not yet there), "Linked" (issues that exist on both sides,
//   synced both ways in one step) and "From GitHub" (GitHub issues not
//   yet here): this folder's side on the left, GitHub's on the right. The
//   user's layout: "three columns ... in each we select. Where do we need
//   the tabs?" The first version showed one list at a time behind three
//   buttons, to save width; seeing all three at once is worth more.
// - Closed issues are included (the user: "let's add closed issues"), and
//   one filter above the columns says which are shown: open (to begin
//   with), closed, or all (the user: "a filter for kind of closed, not
//   closed"). A linked issue counts as open while either side is open, so
//   that an issue closed on one side only, the very one whose close has to
//   be sent across, is not hidden among the closed.
// - A row is two lines, the id and a note over the title: a third of the
//   window is too narrow for both on one line. GitHub's labels are left
//   out of the rows for the same reason.
// - Comments are not synced: the command does not carry them.
// - Sending to GitHub publishes, and a GitHub issue cannot be deleted
//   afterwards, only closed. So: "Sync" is offered only for a selection
//   that has just been previewed, and when the preview says issues would
//   be created on GitHub, the button asks once more, with the number and
//   the repository.
// - Any change to the ticks or to the conflict choice throws the preview
//   away: what is confirmed is always what was shown.
//
// Gotchas:
// - The list of GitHub issues is read when the window opens and after a
//   sync, not kept up to date in between.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { CLOSED_STATUS } from "../shared/constants.ts";
import type { Scope, useIssues } from "./use-issues.ts";

type Rpc = ReturnType<typeof useIssues>["rpc"];
/** The answer of `github_issues` (server/contract.ts). */
type Listed = {
  state: "ok" | "unavailable" | "no-repository" | "no-token" | "error";
  message: string | null;
  repository: string | null;
  issues: {
    number: number;
    title: string;
    labels: string[];
    url: string;
    closed: boolean;
    linkedId: string | null;
  }[];
  links: { id: string; number: number }[];
  truncated: boolean;
};
/** The answer of `github_sync` (server/contract.ts). */
type Report = {
  message: string | null;
  actions: {
    kind: "import" | "update-local" | "create-remote" | "update-remote";
    what: string;
  }[];
  notes: string[];
  warnings: string[];
};
type Prefer = "newer" | "github" | "local";
/** The answer of `github_sync_progress` (server/contract.ts). */
type Progress = Report & {
  /** Comments copied from GitHub so far. */
  copied: number;
  known: boolean;
  done: boolean;
  stopping: boolean;
  total: number;
  finished: number;
  doing: string | null;
  seconds: number;
  lines: string[];
};

/** Seconds as m:ss, for the time a run has taken. */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** How each kind of action reads in the preview. */
const ACTION_WORDS: Record<Report["actions"][number]["kind"], string> = {
  import: "Import into beads",
  "update-local": "Update in beads",
  "create-remote": "Create on GitHub",
  "update-remote": "Update on GitHub",
};

/** The three ways an issue changed on both sides is settled. */
const PREFER_CHOICES: { id: Prefer; label: string }[] = [
  { id: "newer", label: "the newer one wins" },
  { id: "github", label: "GitHub wins" },
  { id: "local", label: "beads wins" },
];

/** A set with one member added or taken out; a new set either way. */
function toggledIn<T>(set: ReadonlySet<T>, member: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(member)) next.add(member);
  return next;
}

/** One row of a list, as it is drawn and ticked. */
interface Line {
  /** What is ticked: a GitHub number for "pull", a beads id otherwise. */
  key: string;
  /** Shown first, in the id's lettering. */
  id: string;
  title: string;
  /** Drawn struck through: closed on this side (or on GitHub, for "pull"). */
  closed: boolean;
  /**
   * Listed with the open issues. The same as not closed, except for a
   * linked issue, which counts as open while either side is.
   */
  open: boolean;
  /** A note after the id; null for none. */
  note: string | null;
}

/** The three columns, left to right: this folder's side, then GitHub's. */
const SIDES = [
  {
    id: "push",
    label: "To GitHub",
    hint: "Issues that are not on GitHub yet. Ticked ones are sent there, where anyone who can see the repository can read them.",
    empty: "Nothing here that is not on GitHub already.",
  },
  {
    id: "both",
    label: "Linked",
    hint: "Issues that are both here and on GitHub. Ticked ones are brought into step in both directions, closing included.",
    empty: "No issue is both here and on GitHub.",
  },
  {
    id: "pull",
    label: "From GitHub",
    hint: "GitHub issues that are not here yet. Ticked ones are brought into this folder's issues.",
    empty: "Nothing on GitHub that is not here already.",
  },
] as const;
type Side = (typeof SIDES)[number]["id"];

/** Which issues the columns show, by whether they are closed. */
const STATES = [
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
] as const;
type StateFilter = (typeof STATES)[number]["id"];

/**
 * One row: a checkbox, then the id with its note over the title. A closed
 * issue is struck through, as in the tab's own list.
 */
function Row({
  line,
  checked,
  onToggle,
}: {
  line: Line;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-state-hover">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="shrink-0 font-mono">{line.id}</span>
          {line.note === null ? null : (
            <span className="min-w-0 truncate" title={line.note}>
              {line.note}
            </span>
          )}
        </span>
        <span
          className={cn(
            "block truncate",
            line.closed && "text-muted-foreground line-through",
          )}
          title={line.title}
        >
          {line.title}
        </span>
      </span>
    </label>
  );
}

/**
 * The window.
 *
 * @param open Whether it is shown; `onClose` shuts it.
 * @param scope The conversation or project whose folder is synced.
 * @param issues The folder's beads issues, open and closed, as the tab has
 *   them.
 * @param onSynced Called after a real sync, so the tab reloads its list.
 */
export function GithubSync({
  open,
  onClose,
  scope,
  rpc,
  issues,
  onSynced,
}: {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  rpc: Rpc;
  issues: Issue[];
  onSynced: () => void;
}) {
  const { threadId, projectId } = scope;
  // The GitHub side: null while it is being read.
  const [listed, setListed] = useState<Listed | null>(null);
  // What is ticked in each list, by the row's key.
  const [ticked, setTicked] = useState<Record<Side, ReadonlySet<string>>>({
    both: new Set(),
    pull: new Set(),
    push: new Set(),
  });
  const [state, setState] = useState<StateFilter>("open");
  const [prefer, setPrefer] = useState<Prefer>("newer");
  // Also copy the comments of what is brought in from GitHub; on to begin
  // with, since leaving a discussion behind is the worse mistake.
  const [withComments, setWithComments] = useState(true);
  const [filter, setFilter] = useState("");
  // What a preview of the present selection said; null when there is none.
  const [preview, setPreview] = useState<Report | null>(null);
  // What the last real sync said; shown until the selection changes.
  const [done, setDone] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"preview" | "sync" | null>(null);
  // How the run under way is getting on; null before its first answer.
  const [progress, setProgress] = useState<Progress | null>(null);
  // The owner pressed Stop: passed along with the next question.
  const stopAsked = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The owner has been asked once more about creating issues on GitHub.
  const [confirming, setConfirming] = useState(false);
  const noTicks = () => ({
    both: new Set<string>(),
    pull: new Set<string>(),
    push: new Set<string>(),
  });

  /** Reads the GitHub issues again. */
  const load = () => {
    setListed(null);
    rpc.call("github_issues", { threadId, projectId }).then(
      (answer) => setListed(answer),
      (cause: unknown) =>
        setListed({
          state: "error",
          message: cause instanceof Error ? cause.message : String(cause),
          repository: null,
          issues: [],
          links: [],
          truncated: false,
        }),
    );
  };
  // Opened: start clean, and read what is on GitHub.
  useEffect(() => {
    if (!open) return;
    setTicked(noTicks());
    setPreview(null);
    setDone(null);
    setProblem(null);
    setConfirming(false);
    setFilter("");
    setState("open");
    setWithComments(true);
    load();
    // Only on opening: `load` and the scope do not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** A change of what is chosen: what was previewed no longer stands. */
  const changed = () => {
    setPreview(null);
    setDone(null);
    setProblem(null);
    setConfirming(false);
  };

  // The three columns' issues, before the filters.
  const lines = useMemo((): Record<Side, Line[]> => {
    const remote = listed?.issues ?? [];
    const byNumber = new Map(remote.map((issue) => [issue.number, issue]));
    const numberOf = new Map(
      (listed?.links ?? []).map((link) => [link.id, link.number]),
    );
    const both: Line[] = [];
    const push: Line[] = [];
    for (const issue of issues) {
      const closed = issue.status === CLOSED_STATUS;
      const number = numberOf.get(issue.id);
      if (number === undefined) {
        // Linked to something else (another tracker): not ours to send.
        if (issue.externalRef !== null) continue;
        push.push({
          key: issue.id,
          id: issue.id,
          title: issue.title,
          closed,
          open: !closed,
          note: closed ? "closed" : null,
        });
        continue;
      }
      // What GitHub has, where it was read; an old issue may not have been.
      const there = byNumber.get(number);
      both.push({
        key: issue.id,
        id: issue.id,
        title: issue.title,
        closed,
        // Open while either side is: see the design notes.
        open: !closed || (there !== undefined && !there.closed),
        note:
          there === undefined || there.closed === closed
            ? `#${number}${closed ? ", closed" : ""}`
            : closed
              ? `#${number}: closed here, open on GitHub`
              : `#${number}: open here, closed on GitHub`,
      });
    }
    const pull: Line[] = remote
      .filter((issue) => issue.linkedId === null)
      .map((issue) => ({
        key: String(issue.number),
        id: `#${issue.number}`,
        title: issue.title,
        closed: issue.closed,
        open: !issue.closed,
        note: issue.closed ? "closed" : null,
      }));
    return { both, pull, push };
  }, [listed, issues]);

  const wanted = filter.trim().toLowerCase();
  /** What a column shows: its issues that pass both filters. */
  const shownIn = (side: Side) =>
    lines[side].filter(
      (line) =>
        (state === "all" || (state === "open") === line.open) &&
        (wanted === "" ||
          line.title.toLowerCase().includes(wanted) ||
          line.id.toLowerCase().includes(wanted)),
    );

  const total = ticked.both.size + ticked.pull.size + ticked.push.size;
  const creating =
    preview?.actions.filter((action) => action.kind === "create-remote").length ?? 0;

  /**
   * Starts a preview or a real sync of what is ticked, then follows it:
   * the server runs it as a job (it can take minutes for many issues), and
   * this asks how it is getting on about once a second until it is done.
   */
  const run = (asPreview: boolean) => {
    setBusy(asPreview ? "preview" : "sync");
    setProblem(null);
    setProgress(null);
    const fail = (cause: unknown) => {
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    };
    /** Asks once, and again a second later while it is not done. */
    const follow = (jobId: string) => {
      rpc
        .call("github_sync_progress", { jobId, stop: stopAsked.current })
        .then((now) => {
          setProgress(now);
          if (!now.done) {
            window.setTimeout(() => follow(jobId), 1000);
            return;
          }
          setBusy(null);
          setProblem(now.message);
          const report = {
            message: now.message,
            actions: now.actions,
            notes: now.notes,
            warnings: now.warnings,
          };
          if (asPreview) {
            setPreview(report);
            return;
          }
          setPreview(null);
          setConfirming(false);
          setDone(report);
          setTicked(noTicks());
          onSynced();
          load();
        }, fail);
    };
    stopAsked.current = false;
    rpc
      .call("github_sync", {
        threadId,
        projectId,
        pull: [...ticked.pull].map(Number),
        both: [...ticked.both],
        push: [...ticked.push],
        prefer,
        comments: withComments,
        preview: asPreview,
      })
      .then((started) => {
        if (started.jobId === null) {
          fail(started.message ?? "The sync could not be started.");
          return;
        }
        follow(started.jobId);
      }, fail);
  };

  /** Ticks, or unticks, everything a column is showing. */
  const toggleAllShown = (side: Side, shown: Line[], allTicked: boolean) => {
    changed();
    const next = new Set(ticked[side]);
    for (const line of shown) {
      if (allTicked) next.delete(line.key);
      else next.add(line.key);
    }
    setTicked({ ...ticked, [side]: next });
  };

  const report = preview ?? done;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* Wider than the details window: three columns of titles. */}
      <DialogContent className="flex h-[88vh] w-[min(96rem,96vw)] max-w-none flex-col">
        <DialogHeader>
          <DialogTitle>Sync with GitHub</DialogTitle>
          <DialogDescription>
            {listed?.repository == null
              ? "Bring GitHub issues into this folder's issues, and send issues to GitHub."
              : `Issues of ${listed.repository} on GitHub, and this folder's issues.`}
          </DialogDescription>
        </DialogHeader>
        {listed === null ? (
          <p className="text-sm text-muted-foreground">Reading GitHub…</p>
        ) : listed.state !== "ok" ? (
          // No folder, no GitHub remote, no sign-in, or GitHub's refusal:
          // said in the server's words, with nothing to tick.
          <div className="space-y-3">
            <p className="text-sm">{listed.message}</p>
            <Button variant="outline" size="sm" onClick={() => load()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {/* Above the columns, for all three: the text filter and
                which issues are shown, open, closed or all. */}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by title or number"
                aria-label="Filter the columns"
                className="h-8 w-64"
              />
              <div
                role="group"
                aria-label="Which issues are shown"
                className="inline-flex overflow-hidden rounded-md border border-border text-sm"
              >
                {STATES.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={state === id}
                    onClick={() => setState(id)}
                    className={cn(
                      "cursor-pointer px-3 py-1",
                      state === id
                        ? "bg-foreground/[0.08] font-medium"
                        : "text-muted-foreground hover:bg-state-hover",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {listed.truncated ? (
                <span className="text-xs text-muted-foreground">
                  GitHub has more issues than are listed; the most recently
                  changed are shown.
                </span>
              ) : null}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
              {SIDES.map(({ id, label, hint, empty }) => {
                const shown = shownIn(id);
                const allTicked =
                  shown.length > 0 && shown.every((line) => ticked[id].has(line.key));
                return (
                  <section
                    key={id}
                    aria-label={label}
                    className="flex min-h-0 min-w-0 flex-col rounded-md border border-border"
                  >
                    <header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Tick all ${shown.length} shown under ${label}`}
                        title="Tick or untick all that is shown in this column"
                        checked={allTicked}
                        disabled={shown.length === 0}
                        onChange={() => toggleAllShown(id, shown, allTicked)}
                      />
                      <span className="text-sm font-medium" title={hint}>
                        {label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {ticked[id].size === 0
                          ? `${shown.length}`
                          : `${ticked[id].size} of ${shown.length} ticked`}
                      </span>
                    </header>
                    <p className="px-2 pt-1 text-xs text-muted-foreground">{hint}</p>
                    <div className="min-h-0 flex-1 overflow-y-auto py-1">
                      {shown.length === 0 ? (
                        <p className="px-2 py-1 text-sm text-muted-foreground">
                          {wanted !== "" || state !== "all"
                            ? lines[id].length === 0
                              ? empty
                              : "Nothing matches the filters."
                            : empty}
                        </p>
                      ) : (
                        shown.map((line) => (
                          <Row
                            key={line.key}
                            line={line}
                            checked={ticked[id].has(line.key)}
                            onToggle={() => {
                              changed();
                              setTicked({
                                ...ticked,
                                [id]: toggledIn(ticked[id], line.key),
                              });
                            }}
                          />
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
            {/* A run under way (the user: "we need a progress indicator or
                at least the shell command output because otherwise you
                don't know if you stuck or not"): how far it is, how long
                it has taken, and what the command has printed so far. */}
            {busy === null ? null : (
              <div className="shrink-0 space-y-1.5 rounded-md bg-foreground/[0.05] px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-medium">
                    {busy === "preview" ? "Previewing" : "Syncing"}
                    {progress?.doing == null ? "" : `: ${progress.doing}`}
                  </span>
                  <span className="text-muted-foreground">
                    {progress === null
                      ? "starting…"
                      : `${progress.finished} of ${progress.total} issues · ${clock(progress.seconds)}${
                          progress.copied === 0
                            ? ""
                            : ` · ${progress.copied} ${progress.copied === 1 ? "comment" : "comments"} copied`
                        }`}
                  </span>
                  <span className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={progress?.stopping === true}
                    tip="Finish the issues it is on (up to ten) and start no more. What was done stays done."
                    onClick={() => {
                      stopAsked.current = true;
                    }}
                  >
                    {progress?.stopping === true ? "Stopping…" : "Stop"}
                  </Button>
                </div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress?.total ?? 1}
                  aria-valuenow={progress?.finished ?? 0}
                  className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
                >
                  <div
                    className="h-full rounded-full bg-blue-500 transition-[width]"
                    style={{
                      width: `${progress === null || progress.total === 0 ? 0 : Math.round((100 * progress.finished) / progress.total)}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Done ten issues at a time. GitHub slows down the creating
                  of many issues, so a batch can sit for a minute or two.
                </p>
                {progress === null || progress.lines.length === 0 ? null : (
                  <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {progress.lines.join("\n")}
                  </pre>
                )}
              </div>
            )}
            {/* What a preview said would happen, or what a sync did. */}
            {busy !== null || (report === null && problem === null) ? null : (
              <div className="max-h-[28%] shrink-0 space-y-1 overflow-y-auto rounded-md bg-foreground/[0.05] px-3 py-2 text-sm">
                {report === null ? null : (
                  <div className="font-medium">
                    {preview !== null
                      ? report.actions.length === 0 && report.notes.length === 0
                        ? "Nothing would change: what is ticked is already in step."
                        : "What a sync would do:"
                      : "Synced."}
                  </div>
                )}
                {report?.actions.map((action, index) => (
                  <div key={index} className="flex gap-2">
                    <span className="w-36 shrink-0 text-muted-foreground">
                      {ACTION_WORDS[action.kind]}
                    </span>
                    <span className="min-w-0 break-words">{action.what}</span>
                  </div>
                ))}
                {report?.notes.map((note, index) => (
                  <div key={index}>{note}</div>
                ))}
                {report?.warnings.map((warning, index) => (
                  <div key={index} className="text-amber-600 dark:text-amber-400">
                    {warning}
                  </div>
                ))}
                {problem === null ? null : (
                  <div className="whitespace-pre-wrap text-destructive">{problem}</div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Changed on both sides:
                <select
                  value={prefer}
                  onChange={(event) => {
                    changed();
                    setPrefer(event.target.value as Prefer);
                  }}
                  className="rounded border border-border bg-transparent px-1 py-0.5 text-xs text-foreground"
                >
                  {PREFER_CHOICES.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              {/* Comments of GitHub issues come along only if asked for:
                  the sync itself does not carry them (bead-bb-apc). */}
              <label
                className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                title="Also copy the comments of the GitHub issues that are brought in (From GitHub and Linked) into the issues here, each under its author's name with a link to the original. One more request to GitHub per issue. Nothing is written to GitHub."
              >
                <input
                  type="checkbox"
                  checked={withComments}
                  onChange={(event) => {
                    changed();
                    setWithComments(event.target.checked);
                  }}
                />
                Copy comments
              </label>
              <span className="flex-1" />
              {confirming ? (
                // Asked once more: this creates issues other people see.
                <>
                  <span className="text-sm">
                    Create {creating} {creating === 1 ? "issue" : "issues"} on
                    GitHub, in {listed.repository}?
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirming(false)}
                  >
                    Not yet
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => run(false)}>
                    {busy === "sync" ? "Syncing…" : "Create and sync"}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={total === 0 || busy !== null}
                    tip="Show what a sync of the ticked issues would do. Changes nothing."
                    onClick={() => run(true)}
                  >
                    {busy === "preview" ? "Previewing…" : "Preview"}
                  </Button>
                  <Button
                    size="sm"
                    // Only what was just previewed can be synced.
                    disabled={
                      preview === null || preview.message !== null || busy !== null
                    }
                    tip={
                      preview === null
                        ? "Preview first: a sync is offered for what was just previewed."
                        : "Do what the preview shows."
                    }
                    onClick={() => (creating > 0 ? setConfirming(true) : run(false))}
                  >
                    {busy === "sync" ? "Syncing…" : `Sync ${total === 0 ? "" : total}`.trim()}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
