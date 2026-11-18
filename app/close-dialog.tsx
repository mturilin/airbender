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
// - Simple chooses an ending and optional agent commit. A read-only preview
//   drives availability; confirmation is the first operation with side effects.
// - A finished epic closed from the epic band has a wording of its own
//   (bead-bb-ty5.1): it is not cancelled, and nothing is committed for it,
//   since each of its sub-issues landed by itself. When epics can own a
//   branch (the user's plan), this is where "Close & merge" will go: with a
//   branch attached the button merges it, without one it only closes.
// - Every close refuses while a descendant is open; nothing cascades.

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
import { useEffect, useId, useState } from "react";
import { ENDINGS, ENDING_LABELS } from "../shared/closing.ts";
import type { Ending, GitChoice } from "../shared/closing.ts";
import type { ClosePreview } from "../server/simple-close.ts";
import { closeChoiceProblem, defaultCloseGit } from "./close-model.ts";
import { Input } from "@/components/ui/input";

/** UI boundaries supplied by the panel; preview reads, request acts only
 * after confirmation. Returning a problem leaves the dialog open. */
export interface SimpleCloseActions {
  targets: Issue[];
  preview(beadId: string): Promise<ClosePreview>;
  request(beadId: string, ending: Ending, git: GitChoice, duplicateOf: string | null): Promise<string | null>;
}

/** The Simple-only dialog. Its state is local until the user confirms;
 * cancelling a preview never sends a work request or changes an issue. */
function SimpleCloseDialog({ closing, actions, onCancel }: { closing: PendingClose; actions: SimpleCloseActions; onCancel(): void }) {
  const [ending, setEnding] = useState<Ending>("done");
  // A null selection follows the preview's default; an explicit choice
  // survives subsequent renders, including changes to the ending or search.
  const [gitChoice, setGit] = useState<GitChoice | null>(null);
  const groupName = useId();
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let active = true;
    actions.preview(closing.issue.id).then((value) => { if (active) setPreview(value); }, (cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [closing.issue.id]);
  const git = gitChoice ?? defaultCloseGit(preview);
  const problem = closeChoiceProblem(preview, git);
  const targets = actions.targets.filter((issue) => issue.id !== closing.issue.id && `${issue.id} ${issue.title}`.toLowerCase().includes(query.toLowerCase()));
  return <Dialog open onOpenChange={(open) => { if (!open && !sending) onCancel(); }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>Close this issue?</DialogTitle><DialogDescription><span className="font-mono">{closing.issue.id}</span> {closing.issue.title}</DialogDescription></DialogHeader>
      <fieldset className="space-y-2 text-sm" disabled={sending}>
        <legend className="mb-2 font-medium">How it ended</legend>
        {ENDINGS.map((value) => <label key={value} className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={`${groupName}-ending`} value={value} checked={ending === value} onChange={() => { setEnding(value); setDuplicateOf(null); }} />
          {ENDING_LABELS[value]}
        </label>)}
      </fieldset>
      {ending === "duplicate" ? <div className="grid gap-2 text-sm">
        <label htmlFor="duplicate-search">Duplicate of (optional)</label>
        <Input id="duplicate-search" placeholder="Search issues by id or title" value={query} disabled={sending} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="Duplicate issue" className="rounded border bg-background p-2" disabled={sending} value={duplicateOf ?? ""} onChange={(event) => setDuplicateOf(event.target.value || null)}>
          <option value="">No issue selected</option>
          {duplicateOf !== null && !targets.some((issue) => issue.id === duplicateOf) ? <option value={duplicateOf}>{actions.targets.find((issue) => issue.id === duplicateOf)?.title ?? duplicateOf}</option> : null}
          {targets.map((issue) => <option key={issue.id} value={issue.id}>{issue.id}: {issue.title}</option>)}
        </select>
      </div> : null}
      {preview?.changes ? <fieldset className="space-y-2 text-sm" disabled={sending}>
        <legend className="mb-2 font-medium">What to do with the work in Git</legend>
        {preview.conversationId !== null && preview.unavailableReason === null ? <>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" name={`${groupName}-git`} value="push" checked={git === "push"} onChange={() => setGit("push")} />
            Commit &amp; push
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" name={`${groupName}-git`} value="commit" checked={git === "commit"} onChange={() => setGit("commit")} />
            Commit only
          </label>
        </> : null}
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={`${groupName}-git`} value="none" checked={git === "none"} onChange={() => setGit("none")} />
          Don’t commit
        </label>
      </fieldset> : null}
      {preview?.unavailableReason ? <p className="text-sm text-muted-foreground">{preview.unavailableReason}</p> : null}
      {preview?.pending ? <p className="text-sm text-muted-foreground">A commit request is already pending in the working conversation.</p> : null}
      <p className="text-sm text-muted-foreground">{git === "none" ? "Closes this issue without committing its changes." : "The working agent will review and commit only this issue’s changes. It stays open until that commit is recorded."}</p>
      {git === "commit" ? <p className="text-sm text-muted-foreground">A repository’s own push hook may still push the commit.</p> : null}
      {error ?? problem ? <p role="alert" className="text-sm text-destructive">{error ?? problem}</p> : null}
      <DialogFooter>
        <Button variant="outline" disabled={sending} onClick={onCancel}>Cancel</Button>
        <Button disabled={sending || problem !== null} onClick={async () => {
          setSending(true); setError(null);
          try { const problem = await actions.request(closing.issue.id, ending, git, duplicateOf); if (problem === null) onCancel(); else setError(problem); }
          catch (cause) { setError(String(cause)); }
          finally { setSending(false); }
        }}>{sending ? "Sending…" : git === "none" ? "Close issue" : "Ask agent to commit"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

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
  /**
   * With `epicDone`, for an epic whose issues were worked on a branch of
   * its own (bead-bb-ty5.2): that branch. Closing the epic then goes
   * through the workflow (`moveId` is set) and merges the branch.
   */
  mergeBranch?: string;
}

/**
 * The close confirmation.
 *
 * @param closing The issue waiting to be closed; null keeps the dialog shut.
 * @param openSubIssues How many open descendants prevent this issue closing.
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
  simple,
}: {
  closing: PendingClose | null;
  openSubIssues: number;
  plain?: boolean;
  onConfirm: (closing: PendingClose) => void;
  onCancel: () => void;
  simple?: SimpleCloseActions;
}) {
  if (plain && closing !== null && simple !== undefined) return <SimpleCloseDialog key={closing.issue.id} closing={closing} actions={simple} onCancel={onCancel} />;
  const finishing = closing !== null && closing.moveId !== null;
  const epicDone = closing?.epicDone ?? 0;
  const mergeBranch = closing?.mergeBranch ?? null;
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
              ? mergeBranch === null
                ? "Close this epic?"
                : "Close and merge this epic?"
              : plain
                ? "Close this issue?"
                : finishing
                ? "Close this issue as finished?"
                : "Close this issue without finishing it?"}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{closing?.issue.id}</span>{" "}
            {/* For an epic the sentence below names it. */}
            {epicDone > 0 ? null : closing?.issue.title}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {epicDone > 0 ? (
            // The third wording tried, and the one the user chose: short,
            // naming the epic, saying its issues are closed and that this
            // can be undone. Before it: one that spoke of sub-issues and of
            // nothing being committed ("horrible"), and a chattier one
            // ("not good still").
            <>
              {epicDone === 1 ? "The only issue in " : `All ${epicDone} issues in `}
              <strong className="font-medium text-foreground">
                {closing?.issue.title}
              </strong>
              {epicDone === 1 ? " is closed." : " are closed."}{" "}
              {mergeBranch === null ? (
                "You can reopen the epic later."
              ) : (
                // The same short form, for an epic with a branch: what
                // happens to the branch, in the place of "you can reopen".
                <>
                  Its branch <span className="font-mono">{mergeBranch}</span>{" "}
                  is merged into the main branch and deleted.
                </>
              )}
            </>
          ) : plain || finishing ? (
            "The issue is closed."
          ) : (
            "The issue is closed without being finished. Nothing is committed."
          )}
          {openSubIssues === 0
            ? ""
            : ` It has ${openSubIssues} open ${openSubIssues === 1 ? "sub-issue" : "sub-issues"}. Close them first; this issue cannot close yet.`}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onCancel()}>
            {finishing || epicDone > 0 ? "Not yet" : "Keep it"}
          </Button>
          <Button
            disabled={openSubIssues > 0}
            onClick={() => {
              if (closing !== null) onConfirm(closing);
              onCancel();
            }}
          >
            {epicDone > 0
              ? mergeBranch === null
                ? "Close epic"
                : "Close & merge"
              : finishing
                ? (closing?.label ?? "Close")
                : "Close issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
