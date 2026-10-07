// bend/format.ts — how issues are printed for a reader.
//
// What: the plain-text forms of a list of issues, one issue in full, its
// comments, the repository's status, and saved facts.
//
// Why: the same answers are also available as JSON (--json) for programs;
// this file is the form meant to be read, by a person or by an agent, and
// is kept apart from the command logic so that either can change alone.
//
// Design notes:
// - One line per issue in lists, the id first, so a line can be cut down
//   to its id with standard tools.
// - A part that is empty is left out of the full view; nothing is printed
//   as a bare heading.
// - Pure functions, tested in format.test.ts.

import type { Fact } from "../tracker/memory.ts";
import type {
  Capabilities,
  Comment,
  Issue,
  IssueRef,
} from "../tracker/types.ts";

/** "P2", or "" when the issue has no priority. */
const priority = (issue: Issue) =>
  issue.priority === null ? "" : `P${issue.priority}`;

/** The status shown for an issue: "blocked" wins over its stored status. */
function shownStatus(issue: Issue): string {
  return issue.status !== "closed" && issue.blockedBy.length > 0
    ? "blocked"
    : issue.status;
}

/** One line per issue: id, status, priority, type, title, category. */
export function formatList(issues: Issue[]): string {
  if (issues.length === 0) return "No issues.";
  const idWidth = Math.max(...issues.map((issue) => issue.id.length));
  return issues
    .map((issue) =>
      [
        issue.id.padEnd(idWidth),
        shownStatus(issue).padEnd(11),
        priority(issue).padEnd(2),
        (issue.type ?? "").padEnd(8),
        issue.title + (issue.category === null ? "" : `  [${issue.category}]`),
      ].join("  "),
    )
    .join("\n");
}

/** "id title" for a pointer to another issue, marked when it is closed. */
const refLine = (ref: IssueRef) =>
  `${ref.id}  ${ref.title}${ref.status === "closed" ? "  (closed)" : ""}`;

/** One issue in full. */
export function formatIssue(issue: Issue): string {
  const facts = [
    shownStatus(issue),
    priority(issue),
    issue.type ?? "",
    issue.category === null ? "" : `category ${issue.category}`,
    issue.assignee === null ? "" : `assigned to ${issue.assignee}`,
  ].filter((fact) => fact !== "");
  const lines = [`${issue.id}  ${issue.title}`, facts.join(" · ")];
  if (issue.parentId !== null) lines.push(`Sub-issue of ${issue.parentId}`);
  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
  if (issue.closeReason !== "") lines.push(`Closed because: ${issue.closeReason}`);
  const block = (heading: string, items: string[]) => {
    if (items.length > 0) lines.push("", `${heading}:`, ...items.map((item) => `  ${item}`));
  };
  block("Waits for", issue.blockedBy.map(refLine));
  block(
    "Links",
    issue.links.map((link) =>
      link.direction === "out"
        ? `${link.kind}  ${refLine(link)}`
        : `${refLine(link)}  — ${link.kind} this`,
    ),
  );
  block(
    "Sub-issues",
    issue.subIssues.map((sub) => `${sub.status.padEnd(11)}  ${sub.id}  ${sub.title}`),
  );
  const part = (heading: string, text: string) => {
    if (text.trim() !== "") lines.push("", heading, text.trim());
  };
  part("DESCRIPTION", issue.description);
  part("REQUIREMENTS", issue.requirements);
  part("DONE MEANS", issue.done);
  part("PLAN", issue.plan);
  part("NOTES", issue.notes);
  if (issue.commentCount > 0) {
    lines.push(
      "",
      `${issue.commentCount} ${issue.commentCount === 1 ? "comment" : "comments"}: bend comments ${issue.id}`,
    );
  }
  return lines.join("\n");
}

/** An issue's comments, oldest first. */
export function formatComments(comments: Comment[]): string {
  if (comments.length === 0) return "No comments.";
  return comments
    .map(
      (comment) =>
        `${comment.createdAt.slice(0, 16).replace("T", " ")}  ${comment.author}\n${comment.text.trim()}`,
    )
    .join("\n\n");
}

/** What `bend status` prints. */
export function formatStatus(capabilities: Capabilities): string {
  const group = (level: string, mark: string, heading: string) => {
    const items = capabilities.supports.filter((item) => item.level === level);
    if (items.length === 0) return [];
    const width = Math.max(...items.map((item) => item.name.length));
    return [
      "",
      heading,
      ...items.map((item) =>
        `  ${mark} ${item.name.padEnd(width)}  ${item.note}`.trimEnd(),
      ),
    ];
  };
  return [
    `Tracker   ${capabilities.tracker}`,
    `Folder    ${capabilities.where}`,
    ...group("yes", "✓", "Supported here"),
    ...group("another way", "~", "Stored another way"),
    ...group("no", "✗", "Not available"),
    ...(capabilities.warnings.length === 0
      ? []
      : ["", "Worth knowing", ...capabilities.warnings.map((warning) => `  ! ${warning}`)]),
  ].join("\n");
}

/** Saved facts, one per line. */
export function formatFacts(facts: Fact[]): string {
  if (facts.length === 0) return "No saved facts.";
  return facts.map((fact) => `${fact.key}: ${fact.text}`).join("\n");
}
