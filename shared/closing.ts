// closing.ts — the shared vocabulary of issue endings (bead-bb-o6j).
// Closedness and dependency resolution deliberately differ for Cancelled.
export const ENDINGS = ["done", "verified", "cancelled", "duplicate"] as const;
export type Ending = (typeof ENDINGS)[number];
export const ENDING_LABELS: Record<Ending, string> = {
  done: "Done", verified: "Verified", cancelled: "Cancelled", duplicate: "Duplicate",
};
export const GIT_CHOICES = ["none", "commit", "push"] as const;
export type GitChoice = (typeof GIT_CHOICES)[number];

/** Closing data handed to bend; none of these fields execute Git. */
export interface ClosingOptions {
  ending: Ending;
  reason?: string;
  commit?: string;
  duplicateOf?: string;
  requestId?: string;
  pushResult?: string;
}

/** True for unresolved or Cancelled dependencies, independent of grouping. */
export function blocksWork(issue: { status: string; ending?: string | null }): boolean {
  return issue.status !== "closed" || issue.ending === "cancelled";
}
