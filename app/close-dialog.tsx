// app/close-dialog.tsx — "are you sure?" before an issue is closed.
//
// What: the confirmation shown before an issue is closed, whether it is
// being finished (the workflow's closing move) or cancelled.
//
// Why: the user asked that closing always asks first, and that committing is
// only mentioned where it applies.
//
// Design notes:
// - One dialog, two wordings. Finishing is the workflow's closing move, and
//   its button carries that move's own label. Cancelling says the issue is closed without
//   being finished; its buttons read "Cancel issue" and "Keep it", so that
//   the word Cancel never means two things in one dialog.
// - Finishing an issue with sub-issues closes the open ones too; the dialog
//   says how many, so it is never a surprise.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Issue } from "../server/contract.ts";

/** An issue waiting for the user's "yes, close it". */
export interface PendingClose {
  issue: Issue;
  /**
   * The workflow move that closes it, or null when the
   * issue is being cancelled: closed without finishing.
   */
  moveId: string | null;
  /** The closing move's label, for the button; null when cancelling. */
  label: string | null;
}

/**
 * The close confirmation.
 *
 * @param closing The issue waiting to be closed; null keeps the dialog shut.
 * @param openSubIssues How many open sub-issues will be closed with it
 *   (only when finishing; cancelling leaves them alone).
 * @param onConfirm Called with the pending close when the user agrees;
 *   `onCancel` is called afterwards as well, to shut the dialog.
 */
export function CloseDialog({
  closing,
  openSubIssues,
  onConfirm,
  onCancel,
}: {
  closing: PendingClose | null;
  openSubIssues: number;
  onConfirm: (closing: PendingClose) => void;
  onCancel: () => void;
}) {
  const finishing = closing !== null && closing.moveId !== null;
  return (
    <Dialog
      open={closing !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {finishing ? "Close this issue as finished?" : "Cancel this issue?"}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{closing?.issue.id}</span>{" "}
            {closing?.issue.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {finishing
            ? "The issue is closed."
            : "The issue is closed without being finished. Nothing is committed."}
          {!finishing || openSubIssues === 0
            ? ""
            : ` Its ${openSubIssues} open ${openSubIssues === 1 ? "sub-issue is" : "sub-issues are"} closed with it.`}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onCancel()}>
            {finishing ? "Not yet" : "Keep it"}
          </Button>
          <Button
            onClick={() => {
              if (closing !== null) onConfirm(closing);
              onCancel();
            }}
          >
            {finishing ? (closing?.label ?? "Close") : "Cancel issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
