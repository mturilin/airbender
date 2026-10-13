// app/sync-trouble.tsx — the bar that says the issues are not being synced.
//
// What: a bar across the top of the issue list, shown for as long as bend
// reports trouble with the syncing of the folder's issues: what is wrong,
// since when, when they were last synced well, the tracker's own words,
// what to do, and two buttons, "Sync now" and "Show log".
//
// Why: the owner (bead-bb-c9l.16): "Failures should be displayed in the
// plugin ... it will be pretty prominent because ... it can mess up the
// data." A sync that does not work means changes made here stay here and
// changes made elsewhere do not arrive; work is then lost or done twice.
// Before, that showed only as a red refresh button with the words in a
// menu.
//
// Design notes:
// - It decides nothing. What counts as trouble, and how serious, is bend's
//   (bend/internal/kept/report.go), so the tab and a terminal say the same.
// - It cannot be dismissed: a warning put away is how a sync that does not
//   work goes unseen. It goes when the trouble does.
// - Red where the issues are not being synced; amber for what is to be
//   known and dealt with at leisure (refused changes, syncing by itself
//   switched off).

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { troubleLines } from "./use-issue-sync.ts";
import type { SyncStatus } from "./use-issue-sync.ts";

/**
 * The bar; nothing when there is no trouble.
 *
 * @param onSync Asks for a sync now.
 * @param onLog Opens the sync log; `failed` to show only the runs that did
 *   not work.
 */
export function SyncTrouble({
  status,
  now,
  onSync,
  onLog,
}: {
  status: SyncStatus | null;
  now: number;
  onSync: () => void;
  onLog: (failed: boolean) => void;
}) {
  const trouble = status?.trouble ?? null;
  if (status === null || trouble === null) return null;
  return (
    <div
      role="alert"
      className={cn(
        "mx-3 mb-2 rounded-md border px-3 py-2 text-sm",
        trouble.serious
          ? "border-destructive/60 bg-destructive/10"
          : "border-amber-600/50 bg-amber-500/10",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-medium",
              trouble.serious ? "text-destructive" : "text-amber-700 dark:text-amber-400",
            )}
          >
            {trouble.title}
          </p>
          {troubleLines(status, now).map((line) => (
            <p key={line} className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
          {trouble.message === "" ? null : (
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
              {trouble.message}
            </pre>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {/* A disabled helper is not mended by a sync; refused changes
              are settled in the log. */}
          {trouble.serious ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={status.running}
              onClick={onSync}
            >
              {status.running ? "Syncing…" : "Sync now"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onLog(trouble.serious)}
          >
            Show log
          </Button>
        </div>
      </div>
    </div>
  );
}
