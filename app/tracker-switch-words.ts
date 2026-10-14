// app/tracker-switch-words.ts — what the "switch tracker" window says.
//
// What: turns what a copy of the issues would do (the server's
// `tracker_switch_preview`) into the sentences the window shows and the
// label of its copy button.
//
// Why: the owner asked for a window that says what it will do and does not
// ask how (bead-bb-c9l.18): "I want UI that doesn't ask you wrong
// questions. When it tells you ... it will update issues that ... are
// linked, already synced, and it will copy over the issues that exist in a
// current and doesn't exist in a target." The wording is kept apart from
// the window so that every case can be tested.
//
// Gotchas:
// - No imports from React or BB: loaded by the tests as it is.

/** The answer of `tracker_switch_preview` (server/contract.ts). */
export interface SwitchPreview {
  cannot: string | null;
  repository: string | null;
  createIds: string[];
  createNumbers: number[];
  update: string[];
  closedLeft: number;
  truncated: boolean;
  needsRepository: boolean;
}

/** A tracker by the name the owner knows it by. */
export const trackerLabel = (name: string): string =>
  name === "github" ? "GitHub issues" : name === "beads" ? "beads" : name;

/** "1 issue", "3 issues", with words between the number and the noun. */
const issues = (count: number, between = ""): string =>
  `${count} ${between}${count === 1 ? "issue" : "issues"}`;

/**
 * What the window says before a switch, and what its copy button reads.
 *
 * @param to The tracker being switched to.
 * @param preview What a copy would do; null while it is being worked out.
 * @param waiting Changes made here that still wait to be sent to the
 *   tracker being left (only a hosted tracker has any).
 * @param named The GitHub repository the switch is about, "owner/name":
 *   the one in use when leaving GitHub issues, the one typed when going to
 *   them; null when none is named. The copying works with the repository
 *   of the folder's git remote only, so where another is named no copy is
 *   offered: it would copy to or from the wrong one.
 * @returns `lines`, one sentence each, in the order shown; `copy`, the
 *   label of the button that copies and switches, or null when there is
 *   nothing to copy or no copy can be made (the window then offers the
 *   switch alone).
 */
export function switchWords(
  to: "beads" | "github",
  preview: SwitchPreview | null,
  waiting: number,
  named: string | null = null,
): { lines: string[]; copy: string | null } {
  const always = [
    "Nothing is deleted. Switch back at any time and the issues here are as you left them.",
    ".bend.json changes; commit it so that others get the same.",
  ];
  const queued =
    waiting === 0
      ? []
      : [
          `${waiting} ${waiting === 1 ? "change" : "changes"} made here still ${waiting === 1 ? "waits" : "wait"} to be sent. Refresh first to send ${waiting === 1 ? "it" : "them"}.`,
        ];
  if (preview === null) {
    return { lines: ["Working out what would be copied…", ...queued, ...always], copy: null };
  }
  if (preview.cannot !== null) {
    return {
      lines: [`The issues cannot be copied: ${preview.cannot}`, ...queued, ...always],
      copy: null,
    };
  }
  if (
    named !== null &&
    named.trim() !== "" &&
    preview.repository !== null &&
    named.trim().toLowerCase() !== preview.repository.toLowerCase()
  ) {
    return {
      lines: [
        `The issues cannot be copied: copying works with the repository of this folder's git remote (${preview.repository}), not with ${named.trim()}.`,
        ...queued,
        ...always,
      ],
      copy: null,
    };
  }
  const create = to === "github" ? preview.createIds.length : preview.createNumbers.length;
  const [here, there] = to === "github" ? ["beads", "GitHub"] : ["GitHub", "beads"];
  const lines: string[] = [];
  if (create > 0) {
    lines.push(
      `${issues(create, "open ")} that ${create === 1 ? "is" : "are"} only ${here === "beads" ? "in beads" : "on GitHub"} ${create === 1 ? "is" : "are"} ${to === "github" ? "created on GitHub" : "brought into beads"}.`,
    );
  }
  if (preview.update.length > 0) {
    const count = preview.update.length;
    lines.push(
      `${issues(count)} that ${count === 1 ? "is" : "are"} already on both sides ${count === 1 ? "is" : "are"} brought up to date.`,
    );
  }
  if (create === 0 && preview.update.length === 0) {
    lines.push("There is nothing to copy.");
  }
  if (preview.closedLeft > 0) {
    const count = preview.closedLeft;
    lines.push(
      `${issues(count, "closed ")} ${count === 1 ? "stays" : "stay"} ${here === "beads" ? "in beads" : "on GitHub"}; closed issues are not copied.`,
    );
  }
  if (preview.truncated) {
    lines.push("GitHub has more issues than were read; the numbers are at least these.");
  }
  return {
    lines: [...lines, ...queued, ...always],
    copy:
      create > 0
        ? `Copy ${issues(create)} and switch`
        : preview.update.length > 0
          ? `Update ${issues(preview.update.length)} and switch`
          : null,
  };
}
