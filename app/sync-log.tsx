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

import { useRealtime } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CHANGED_CHANNEL } from "../shared/constants.ts";
import { syncDid } from "./use-issue-sync.ts";
import type { SyncEntry } from "./use-issue-sync.ts";

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
 */
export function SyncLog({
  open,
  onClose,
  load,
  remote,
}: {
  open: boolean;
  onClose: () => void;
  load: () => Promise<SyncEntry[]>;
  remote: string | null;
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
