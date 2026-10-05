// app/close-dialog.tsx — "are you sure?" before an issue is closed.
//
// What: the confirmation shown when a row asks to close an issue.
//
// Why: the user asked that closing always asks first, and that committing is
// only mentioned where it applies.
//
// Design notes:
// - One dialog, three wordings. Committing is only mentioned for the
//   thread's current issue: "Close & commit" there, or closing it without a
//   commit. Closing any other issue is a plain "are you sure", with Close
//   and Cancel.
// - "Close & commit" on an issue with sub-issues closes the open ones too;
//   the dialog says how many, so it is never a surprise.

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
  /** Also ask the thread's agent to commit the issue's work. */
  commit: boolean;
}

/**
 * The close confirmation.
 *
 * @param closing The issue waiting to be closed; null keeps the dialog shut.
 * @param isCurrent Whether that issue is the thread's current one.
 * @param openSubIssues How many open sub-issues will be closed with it
 *   (only said when committing).
 * @param onConfirm Called with the pending close when the user agrees;
 *   `onCancel` is called afterwards as well, to shut the dialog.
 */
export function CloseDialog({
  closing,
  isCurrent,
  openSubIssues,
  onConfirm,
  onCancel,
}: {
  closing: PendingClose | null;
  isCurrent: boolean;
  openSubIssues: number;
  onConfirm: (closing: PendingClose) => void;
  onCancel: () => void;
}) {
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
            {closing?.commit
              ? "Close this issue and commit its work?"
              : isCurrent
                ? "Close this issue without committing?"
                : "Are you sure you want to close this issue?"}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{closing?.issue.id}</span>{" "}
            {closing?.issue.title}
          </DialogDescription>
        </DialogHeader>
        {closing?.commit ? (
          <p className="text-sm text-muted-foreground">
            The issue is closed, and this thread's agent is asked to commit
            its work.
            {openSubIssues === 0
              ? ""
              : ` Its ${openSubIssues} open ${openSubIssues === 1 ? "sub-issue is" : "sub-issues are"} closed with it.`}
          </p>
        ) : isCurrent ? (
          <p className="text-sm text-muted-foreground">
            The issue is closed and nothing is committed.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onCancel()}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (closing !== null) onConfirm(closing);
              onCancel();
            }}
          >
            {closing?.commit
              ? "Close and commit"
              : isCurrent
                ? "Close without commit"
                : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
