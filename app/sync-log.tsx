// app/sync-log.tsx — the sync log's window.
//
// What: a small window listing the syncs run from here for the folder's
// repository, newest first: when, what set each off, how it ended, and
// which issues were sent and brought in.
//
// Why: syncing runs unseen every few minutes. The owner asked for a log:
// "When you see in a small window all the logs of the syncs, was one issue
// or whatever. Too troubleshooting, you know?" (bead-bb-6a9).
//
// Design notes:
// - Every run is listed, also the many that found nothing new: for
//   troubleshooting, that a sync ran and found nothing is the answer as
//   often as not.
// - It speaks the sync layer's words only (sync/types.ts); nothing here
//   knows which tracker or remote is behind it.
// - Read when it opens and again on every change notice while open, so a
//   sync that ends meanwhile appears.
// - Above the runs, the changes a hosted tracker refused for good
//   (bead-bb-c9l.6): each with its issue, what it was, the text it carried
//   and the tracker's reason, so nothing the owner wrote is lost unseen;
//   and two ways out, forget it or send it once more.

import { useRealtime } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import { syncDid } from "./use-issue-sync.ts";
import type { RefusedChange, SyncEntry } from "./use-issue-sync.ts";

/** What set a sync off, in the owner's words. */
const CAUSE_WORDS: Record<SyncEntry["cause"], string> = {
  timer: "every five minutes",
  change: "after a change here",
  opened: "tab opened",
  refresh: "refresh pressed",
};

/** A moment as a date and time of day, in the reader's own format. */
const when = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * The window.
 *
 * @param load Reads the log, newest first.
 * @param remote What the issues are synced with, in words; null when with
 *   nothing.
 * @param refused The changes the tracker refused for good, oldest first.
 * @param onSettle Dismisses one (`again` false) or has it sent again;
 *   resolves to a message when that could not be done.
 */
export function SyncLog({
  open,
  onClose,
  load,
  remote,
  refused,
  onSettle,
}: {
  open: boolean;
  onClose: () => void;
  load: () => Promise<SyncEntry[]>;
  remote: string | null;
  refused: RefusedChange[];
  onSettle: (seq: number, again: boolean) => Promise<string | null>;
}) {
  // Null while the log is being read for the first time.
  const [entries, setEntries] = useState<SyncEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const read = useCallback(() => {
    if (!open) return;
    load().then(
      (found) => {
        setEntries(found);
        setProblem(null);
      },
      (cause: unknown) =>
        setProblem(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [open, load]);
  useEffect(() => {
    if (open) setEntries(null);
    read();
  }, [open, read]);
  useRealtime(CHANGED_CHANNEL, read);
  // Why a refused change could not be dismissed or sent again. Its own
  // line: the log below is still good and stays in view.
  const [settleProblem, setSettleProblem] = useState<string | null>(null);
  const settle = (seq: number, again: boolean) => {
    onSettle(seq, again).then(setSettleProblem, (cause: unknown) =>
      setSettleProblem(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] w-[min(44rem,92vw)] max-w-none flex-col">
        <DialogHeader>
          <DialogTitle>Sync log</DialogTitle>
          <DialogDescription>
            {remote === null
              ? "This folder's issues are not synced with anything."
              : `The syncs of this folder's issues with ${remote}, run from this computer. Newest first.`}
          </DialogDescription>
        </DialogHeader>
        {refused.length === 0 ? null : (
          <div className="max-h-[40%] shrink-0 overflow-y-auto rounded-md border border-amber-600/40">
            <p className="border-b border-border px-3 py-1.5 text-sm font-medium">
              Refused changes
              <span className="block text-xs font-normal text-muted-foreground">
                Made here and refused for good, so not sent again by itself.
                Dismiss one to forget it, or send it once more after
                mending what stood in its way.
              </span>
              {settleProblem === null ? null : (
                <span className="block text-xs font-normal text-destructive">
                  {settleProblem}
                </span>
              )}
            </p>
            {refused.map((change) => (
              <div
                key={change.seq}
                className="border-b border-border px-3 py-1.5 text-sm last:border-b-0"
              >
                <div className="flex items-baseline gap-3">
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="shrink-0 font-mono text-xs">{change.issue}</span>
                    <span className="min-w-0 break-words">{change.what}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => settle(change.seq, true)}
                  >
                    Send again
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => settle(change.seq, false)}
                  >
                    Dismiss
                  </Button>
                </div>
                <p className="text-xs text-amber-600 dark:text-amber-400">{change.reason}</p>
                {change.text === "" ? null : (
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {change.text}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
        {problem !== null ? (
          <p className="text-sm text-destructive">{problem}</p>
        ) : entries === null ? (
          <p className="text-sm text-muted-foreground">Reading…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sync has run from here yet.</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
            {entries.map((entry) => (
              <div
                key={`${entry.at}-${entry.cause}`}
                className="border-b border-border px-3 py-1.5 text-sm last:border-b-0"
              >
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {when(entry.at)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 break-words",
                      entry.end === "failed" && "text-amber-600 dark:text-amber-400",
                      (entry.end === "conflict" || entry.end === "stuck") &&
                        "text-destructive",
                    )}
                  >
                    {syncDid(entry)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {CAUSE_WORDS[entry.cause]} · {entry.seconds} s
                  </span>
                </div>
                {entry.message === "" ? null : (
                  <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                    {entry.message}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
