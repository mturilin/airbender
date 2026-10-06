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
//   being finished; its buttons read "Close issue" and "Keep it", matching
//   the "Close" entry and button that lead here.
// - On the simple workflow there is nothing to finish or cancel: closing is
//   just closing (`plain`), and the dialog says only that.
// - A finished epic closed from the epic band has a wording of its own
//   (bead-bb-ty5.1): it is not cancelled, and nothing is committed for it,
//   since each of its sub-issues landed by itself. When epics can own a
//   branch (the user's plan), this is where "Close & merge" will go: with a
//   branch attached the button merges it, without one it only closes.
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
  /**
   * Set when a finished epic is being closed from the epic band: how many
   * issues it has under it, all of them closed. The epic is then neither
   * cancelled nor taken through a workflow step of its own: its work was
   * its sub-issues'.
   */
  epicDone?: number;
}

/**
 * The close confirmation.
 *
 * @param closing The issue waiting to be closed; null keeps the dialog shut.
 * @param openSubIssues How many open sub-issues will be closed with it
 *   (0 when cancelling on the standard workflow, which leaves them alone).
 * @param plain The repository is on the simple workflow: a close is neither
 *   finishing nor cancelling.
 * @param onConfirm Called with the pending close when the user agrees;
 *   `onCancel` is called afterwards as well, to shut the dialog.
 */
export function CloseDialog({
  closing,
  openSubIssues,
  plain = false,
  onConfirm,
  onCancel,
}: {
  closing: PendingClose | null;
  openSubIssues: number;
  plain?: boolean;
  onConfirm: (closing: PendingClose) => void;
  onCancel: () => void;
}) {
  const finishing = closing !== null && closing.moveId !== null;
  const epicDone = closing?.epicDone ?? 0;
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
            {epicDone > 0
              ? "All done. Close this epic?"
              : plain
                ? "Close this issue?"
                : finishing
                ? "Close this issue as finished?"
                : "Close this issue without finishing it?"}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{closing?.issue.id}</span>{" "}
            {closing?.issue.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {epicDone > 0
            ? // Said the way a person would (the user found the first
              // version, which spoke of sub-issues and of nothing being
              // committed, "horrible"): what is true, what happens, and
              // that it can be undone.
              `${epicDone === 1 ? "Its one issue is" : `All ${epicDone} of its issues are`} finished, so there is nothing left to do here. Closing the epic moves it to Closed. You can reopen it later if more work comes up.`
            : plain || finishing
              ? "The issue is closed."
              : "The issue is closed without being finished. Nothing is committed."}
          {openSubIssues === 0
            ? ""
            : ` Its ${openSubIssues} open ${openSubIssues === 1 ? "sub-issue is" : "sub-issues are"} closed with it.`}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onCancel()}>
            {finishing || epicDone > 0 ? "Not yet" : "Keep it"}
          </Button>
          <Button
            onClick={() => {
              if (closing !== null) onConfirm(closing);
              onCancel();
            }}
          >
            {epicDone > 0
              ? "Close epic"
              : finishing
                ? (closing?.label ?? "Close")
                : "Close issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
