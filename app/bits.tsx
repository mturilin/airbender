// app/bits.tsx — small shared pieces of the tab.
//
// What: the dashed Notice box, the Tag and StatusTag chips, the link and robot
// icons, and
// the class strings shared by the small dropdowns and form fields.
//
// Why: these are used by rows, opened issues, the new-issue form and the
// message-box card alike; in a file of their own, none of those has to import
// another just for a chip.
//
// Gotchas:
// - Colours come from BB's theme tokens, never fixed colours, so the pieces
//   follow the selected theme.

import type { ReactNode } from "react";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import type { Issue } from "../server/contract.ts";
import { isBlocked } from "./issue-model.ts";

/**
 * A dropdown that looks like one of the small tags on an issue row, so the
 * row reads the same as before but its priority and type can be changed in
 * place. The browser's own arrow is kept as the hint that it opens.
 */
export const TAG_SELECT_CLASS =
  "shrink-0 cursor-pointer rounded border border-border bg-transparent py-px pl-1 pr-0.5 text-[11px] leading-4 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Shared look of the plain <select> and <textarea> in the create form. */
export const FIELD_CLASS =
  "rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** The dashed box BB's own list pages use for loading and empty states. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** Small rounded label, e.g. an issue's priority or type. */
export function Tag({
  children,
  strong = false,
}: {
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border border-border px-1.5 py-px text-[11px] leading-4",
        strong ? "font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * An issue's status as a tag, shown where no group heading says it
 * (sub-issues, and the current-issue card).
 *
 * A blocked issue (see isBlocked) reads "blocked" instead of its own
 * status, and the tag's tooltip names what it waits for, or says that all
 * its sub-issues are blocked, so the
 * reason is one hover away without opening the issue. The user asked for
 * the tooltip only: blocked issues are not marked any more loudly than
 * before, and rows that had no status tag still have none.
 */
export function StatusTag({ issue }: { issue: Issue }) {
  if (!isBlocked(issue)) {
    return (
      <Tag strong={issue.status === "in_progress"}>
        {issue.status.replace("_", " ")}
      </Tag>
    );
  }
  return (
    <Tip
      label={
        issue.blockedBy.length > 0
          ? `Waits for: ${issue.blockedBy.map((blocker) => blocker.title).join("; ")}`
          : "All its sub-issues are blocked"
      }
    >
      {/* A span of its own for the tooltip to attach to: Tag takes no ref. */}
      <span className="flex shrink-0 cursor-default">
        <Tag>blocked</Tag>
      </span>
    </Tip>
  );
}

/**
 * A chain-link icon for the Link button. Drawn here because BB's icon set
 * has none (checked in its bundle: only ExternalLink), and an unknown name
 * would show BB's fallback icon. Takes its colour from the text around it.
 */
export function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/**
 * A robot's head, marking a step that is the agent's. Drawn here because
 * BB's icon set has no robot (checked in its bundle), and an unknown name
 * would show BB's fallback icon. Takes its colour from the text around it.
 */
export function RobotIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  );
}

/**
 * A person, marking a step that needs the user. Drawn here, like the robot
 * beside it, so the two are the same size and sit the same way in a tag;
 * BB's own person icon comes in a wrapper that threw the tag's line off.
 */
export function PersonIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  );
}
