// app/tracker-switch.tsx — the window that switches a repository's tracker.
//
// What: opened from the first line of the tab's menu ("This project uses
// …", "Switch…"). It shows the tracker in use and the other one, says what
// copying the issues across would do, with numbers, and then does one of
// two things: copies and switches, or switches only.
//
// Why: the owner chose the menu as the place to switch between beads and
// GitHub issues (bead-bb-c9l.18), and asked that the window say what it
// will do instead of asking how: "I want UI that doesn't ask you wrong
// questions."
//
// Design notes:
// - It decides nothing about what is copied: the lists come from the
//   server (`tracker_switch_preview`), and the copying is the "Import /
//   export GitHub issues" window's own (`github_sync`), run for exactly
//   those lists, the newer side winning.
// - Two buttons and no tick boxes. "Copy and switch" is a choice of its
//   own because an issue created on GitHub cannot be deleted afterwards,
//   only closed.
// - The order of the two halves depends on the direction, because the
//   copying works on the beads side: going to GitHub issues the copy comes
//   first and the switch only if it went through, so a failure leaves
//   everything as it was; going to beads the switch comes first and the
//   copy follows, and a failure of the copy is said as that.
// - Doing it again doubles nothing: what was copied is linked, and linked
//   issues are only brought up to date.
//
// - The order itself is in tracker-switch-run.ts, where it is tested.
// - The copying works with the repository of the folder's git remote.
//   Where the switch is about another one (typed in the field, or the one
//   in use), no copy is offered: it would go to the wrong place.
// - A copy counts as gone through only if no issue was left out: what it
//   could not do for single issues stops the switch like a failure.
//
// Gotchas:
// - Closing the window while a copy runs asks the copy to stop (it runs in
//   the server and finishes the issues it is on); going to GitHub issues,
//   the switch is then not made.

import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { rpcContract } from "../server/contract.ts";
import { runSwitch } from "./tracker-switch-run.ts";
import type { CopyEnd } from "./tracker-switch-run.ts";
import { switchWords, trackerLabel } from "./tracker-switch-words.ts";
import type { SwitchPreview } from "./tracker-switch-words.ts";
import type { Scope } from "./use-issues.ts";

/** How often a running copy is asked how it is getting on. */
const POLL_MS = 1_000;

/** How a copy under way stands, for the window. */
interface Progress {
  total: number;
  finished: number;
  lines: string[];
}

/**
 * The window.
 *
 * @param from The tracker in use: its name and, for GitHub issues, the
 *   repository; null keeps the window closed.
 * @param waiting Changes made here that still wait to be sent.
 * @param onSwitched Called once the tracker was switched, whether or not a
 *   copy that followed went through: the tab reads everything again.
 */
export function TrackerSwitch({
  from,
  scope,
  waiting,
  onClose,
  onSwitched,
}: {
  from: { name: string; repository: string | null } | null;
  scope: Scope;
  waiting: number;
  onClose: () => void;
  onSwitched: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const to: "beads" | "github" = from?.name === "github" ? "beads" : "github";
  // For GitHub issues, the repository when the remote does not say it.
  const [repository, setRepository] = useState("");
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  // What is going on: nothing, a copy, or the switch itself.
  const [doing, setDoing] = useState<"copy" | "switch" | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The tracker was switched in this opening (a copy that followed did not
  // go through): the window then only says so; what it shows is about the
  // tracker that was left.
  const [switched, setSwitched] = useState(false);
  // Asks the copy under way to stop.
  const stopping = useRef(false);
  // Set when the window is closed or reopened: what was started for an
  // earlier opening must not write into this one.
  const opening = useRef(0);
  const open = from !== null;
  useEffect(() => {
    opening.current += 1;
    const mine = opening.current;
    setPreview(null);
    setProblem(null);
    setProgress(null);
    setDoing(null);
    setRepository("");
    setSwitched(false);
    // A copy still running for an earlier opening is asked to stop.
    stopping.current = true;
    if (!open) return;
    rpc.call("tracker_switch_preview", { threadId, projectId, to }).then(
      (found) => {
        if (mine === opening.current) setPreview(found);
      },
      (cause: unknown) => {
        if (mine !== opening.current) return;
        setPreview({
          cannot: cause instanceof Error ? cause.message : String(cause),
          repository: null,
          createIds: [],
          createNumbers: [],
          update: [],
          closedLeft: 0,
          truncated: false,
          needsRepository: false,
        });
      },
    );
  }, [open, to, rpc, threadId, projectId]);

  const words = switchWords(
    to,
    preview,
    waiting,
    // The repository the switch is about, where one is named.
    to === "github" ? repository : (from?.repository ?? null),
  );

  /** Runs the chosen way through, and says what went wrong where it did. */
  const run = (withCopy: boolean) => {
    const mine = opening.current;
    const alive = () => mine === opening.current;
    const lists = preview;
    stopping.current = false;
    setProblem(null);
    setProgress(null);
    /** Copies what the preview listed, showing how it is getting on. */
    const copy = async (): Promise<CopyEnd> => {
      if (lists === null) return { failed: "Nothing was worked out to copy.", warnings: [] };
      if (alive()) setDoing("copy");
      const started = await rpc.call("github_sync", {
        threadId,
        projectId,
        pull: lists.createNumbers,
        both: lists.update,
        push: lists.createIds,
        prefer: "newer",
        comments: true,
        preview: false,
      });
      if (started.jobId === null) {
        return { failed: started.message ?? "The copy could not be started.", warnings: [] };
      }
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const now = await rpc.call("github_sync_progress", {
          jobId: started.jobId,
          stop: stopping.current || !alive(),
        });
        if (!now.known) {
          return {
            failed: "The copy was lost sight of; look at the issues before trying again.",
            warnings: [],
          };
        }
        if (alive()) {
          setProgress({ total: now.total, finished: now.finished, lines: now.lines.slice(-3) });
        }
        if (now.done) {
          return {
            failed:
              now.message ??
              (now.finished < now.total ? "It was stopped before every issue was done." : null),
            warnings: now.warnings,
          };
        }
      }
    };
    void runSwitch({
      to,
      copy: withCopy ? copy : null,
      switchTracker: async () => {
        if (alive()) setDoing("switch");
        const outcome = await rpc.call("setup_run", {
          threadId,
          projectId,
          action: "tracker",
          option:
            to === "github" && repository.trim() !== "" ? `github:${repository.trim()}` : to,
        });
        // The tab is about the other tracker from here on, whatever a copy
        // that follows does.
        if (outcome.message === null) onSwitched();
        return outcome.message;
      },
      alive,
    }).then((end) => {
      if (end.switched) onSwitched();
      if (!alive()) return;
      setDoing(null);
      setSwitched(end.switched);
      if (end.problem === null) onClose();
      else setProblem(end.problem);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch where the issues are kept</DialogTitle>
          <DialogDescription>
            {switched ? (
              <>This project now uses {trackerLabel(to)}.</>
            ) : (
              <>
                This project uses {trackerLabel(from?.name ?? "")}
                {from?.repository == null ? "" : ` (${from.repository})`}. Switch it to{" "}
                {trackerLabel(to)}
                {to === "github"
                  ? repository.trim() !== ""
                    ? ` (${repository.trim()})`
                    : preview?.repository != null
                      ? ` (${preview.repository})`
                      : ""
                  : ""}
                ?
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          {switched ? null : (
            <>
              <p className="font-medium">What happens</p>
              <ul className="list-disc space-y-1 pl-5">
                {words.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          {!switched && to === "github" && words.copy !== null ? (
            <p className="text-muted-foreground">
              Issues created on GitHub cannot be deleted afterwards, only closed.
            </p>
          ) : null}
          {/* Asked only where the folder's git remote does not say it: a
              repository that is already known is not asked for. */}
          {!switched && to === "github" && preview?.needsRepository === true ? (
            <label className="block text-xs text-muted-foreground">
              This folder's git remote is not on github.com. Which repository's issues?
              <input
                type="text"
                className="mt-1 block w-full rounded border border-border bg-transparent px-2 py-1 font-mono text-sm text-foreground"
                placeholder="owner/name"
                value={repository}
                disabled={doing !== null}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
          ) : null}
          {doing === null ? null : (
            <div className="rounded-md border border-border px-3 py-2 text-xs">
              <p>
                {doing === "switch"
                  ? "Switching…"
                  : progress === null || progress.total === 0
                    ? "Copying…"
                    : `Copying: ${progress.finished} of ${progress.total} done.`}
              </p>
              {doing === "copy" && progress !== null && progress.total > 0 ? (
                <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${(100 * progress.finished) / progress.total}%` }}
                  />
                </div>
              ) : null}
              {doing === "copy" && progress !== null && progress.lines.length > 0 ? (
                <pre className="mt-1 whitespace-pre-wrap font-mono text-muted-foreground">
                  {progress.lines.join("\n")}
                </pre>
              ) : null}
            </div>
          )}
          {problem === null ? null : (
            <p role="alert" className="whitespace-pre-wrap text-destructive">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          {doing === "copy" ? (
            <Button
              variant="ghost"
              onClick={() => {
                stopping.current = true;
              }}
            >
              Stop the copy
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {doing === null && !switched ? "Cancel" : "Close"}
          </Button>
          {switched ? null : (
            <>
              {/* Not while it is still being worked out what a copy would
                  do: a switch pressed then would be one without the copy,
                  never offered. */}
              <Button
                variant={words.copy === null ? "default" : "outline"}
                disabled={
                  doing !== null ||
                  preview === null ||
                  // A switch to GitHub issues with no repository named
                  // and none to be read from the remote cannot be made.
                  (to === "github" && preview.needsRepository && repository.trim() === "")
                }
                onClick={() => run(false)}
              >
                {words.copy === null ? "Switch" : "Switch only"}
              </Button>
              {words.copy === null ? null : (
                <Button disabled={doing !== null} onClick={() => run(true)}>
                  {words.copy}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
