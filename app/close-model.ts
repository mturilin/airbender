// close-model.ts — pure availability rules for the Simple close dialog.
// The server rechecks these rules on submission; a stale preview grants no
// authority to close or commit (bead-bb-o6j).
import type { GitChoice } from "../shared/closing.ts";

/** The server's preview, kept structural so tests need no UI/runtime imports. */
export interface CloseAvailability {
  message: string | null; blocked: string | null; changes: boolean;
  conversationId: string | null; unavailableReason: string | null;
}

/** Returns a reason to refuse confirmation, or null when the choice is valid. */
export function closeChoiceProblem(preview: CloseAvailability | null, git: GitChoice): string | null {
  if (preview === null) return "Checking the issue and its changes…";
  if (preview.message !== null || preview.blocked !== null) return preview.message ?? preview.blocked;
  if (git === "none") return null;
  if (!preview.changes) return "There are no changes to commit.";
  return preview.unavailableReason ?? (preview.conversationId === null ? "No conversation is working on this issue." : null);
}

/** Defaults to Commit & push only after the preview permits it. The dialog
 * uses this until the user chooses, so loading never overrides their choice. */
export function defaultCloseGit(preview: CloseAvailability | null): GitChoice {
  return closeChoiceProblem(preview, "push") === null ? "push" : "none";
}
