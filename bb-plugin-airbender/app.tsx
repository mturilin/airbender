// bb-plugin-airbender — frontend entry.
//
// What: the "Beads" tab in BB's right-hand panel. It lists the beads issues of
// the folder a thread works in, grouped by what you can do about them. Also
// three small controls in a thread's message box: a pill for the current
// issue and two quick-reply buttons (see the registration at the end).
//
// Why: issues are most useful beside the agent doing the work, so the tab
// lives next to a thread (and on the New thread screen, to pick what to start).
//
// Design notes:
// - Three bands. Pinned at the top: Current (the bead this thread works on)
//   and a toolbar with the folder and refresh. In the middle,
//   scrolling: the issues grouped by status. Pinned at the bottom: the field
//   for a new issue. The tab therefore asks BB for the "flush" layout and
//   does its own scrolling.
// - An opened issue shows its description, then one folded heading for each
//   other thing beads holds about it: acceptance criteria, design, notes,
//   close reason, comments. Each opens on its own chevron; empty ones are
//   left out. Comments are fetched only when their heading is opened.
// - Every issue is a collapsed row that opens on its chevron, so a long
//   description never pushes the rest of the tab away; the Current row's
//   opened text is additionally capped in height because it is pinned.
// - Issues can sit inside other issues, to any depth. A sub-issue is drawn
//   indented under its parent, whatever its status, and only one level is
//   drawn; a details button on any issue with sub-issues opens a window on
//   it, and the same button inside the window goes deeper. Dragging a row
//   onto another nests it; dragging it onto anything that is not a row
//   moves it out to the top level.
// - Every issue can have one category, shown and changed on its row like
//   type and priority. The list of categories is simply the ones in use.
// - The Ready group can be divided into collapsible sub-groups by priority,
//   type or category (the Group menu on the Ready heading, with the Filter
//   menu beside it; Ready is therefore always shown). Grouping arranges;
//   it is separate from filtering, which hides.
// - Filters (types, priorities, categories) hide rows; they never regroup and never hide
//   Current. They are remembered per folder in the browser.
// - The Closed group's heading is always shown, last in the list, with its
//   count and a Show/Hide button; its issues start hidden every time the
//   tab opens.
// - The tab can create, close and reopen issues, change an issue's type
//   and priority in place, edit its title and description from inside the
//   opened issue, and mark which bead a thread is working on (a note kept
//   in BB, not in beads). It cannot delete an issue or edit its design,
//   acceptance criteria, notes or comments.
// - "Define" starts a background agent for the job and marks the row
//   while it is busy; the thread the user is in is not touched.
// - One component, two entry points: a thread tab passes its thread id, the
//   New thread screen passes the selected project id. server.ts turns either
//   into a folder.
// - The list is refreshed when the tab opens, when the Refresh button is
//   pressed, when the BB window regains focus, and when server.ts signals a
//   change: one made through this plugin, or one made outside it (an agent or
//   a terminal running bd), which server.ts notices by watching a file that
//   beads rewrites on every write. There is deliberately no
//   timer: beads keeps its database in a single local store, and polling it
//   would compete with an agent that is writing issues at the same moment.
//
// Gotchas:
// - Only TYPES may be imported from ./server. Importing a value would pull the
//   backend (and Node's child_process) into the browser bundle, which is why
//   the channel name and issue types are repeated below.
// - Compiled by `bb plugin build`; React and the SDK come from BB at load
//   time, so this file only runs inside BB.
// - Colors come from BB's theme tokens (text-muted-foreground, border-border
//   and so on), never fixed colors, so the tab follows the selected theme.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import {
  Markdown,
  definePluginApp,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  Issue,
  IssueComment,
  IssueLink,
  IssuesResult,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tip";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** Must match CHANGED_CHANNEL in server.ts. */
const CHANGED_CHANNEL = "beads-changed";

/** Must match ISSUE_TYPES in server.ts. */
const ISSUE_TYPES = [
  "task",
  "feature",
  "bug",
  "chore",
  "epic",
  "decision",
] as const;
type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * A dropdown that looks like one of the small tags on an issue row, so the
 * row reads the same as before but its priority and type can be changed in
 * place. The browser's own arrow is kept as the hint that it opens.
 */
const TAG_SELECT_CLASS =
  "shrink-0 cursor-pointer rounded border border-border bg-transparent py-px pl-1 pr-0.5 text-[11px] leading-4 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Shared look of the plain <select> and <textarea> in the create form. */
const FIELD_CLASS =
  "rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Which thread or project the tab is showing; exactly one is usually set. */
interface Scope {
  threadId: string | null;
  projectId: string | null;
}

/** A titled group of issues, in the order the tab shows them. */
interface Section {
  id: "current" | "in_progress" | "ready" | "blocked" | "other" | "closed";
  title: string;
  /** One short line explaining what belongs in the group. */
  hint: string;
  issues: Issue[];
}

/**
 * Loads the issues for a scope and keeps them reasonably fresh.
 *
 * @returns `result` (null until the first answer), `loading` while a request
 *   is in flight, `failure` when the request itself failed (as opposed to
 *   server.ts answering with a non-"ok" state), and `refresh` to ask again.
 * Side effects: one RPC per refresh; listens for window focus while mounted.
 */
function useIssues(scope: Scope) {
  const rpc = useRpc<typeof rpcContract>();
  const { threadId, projectId } = scope;
  const [result, setResult] = useState<IssuesResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    rpc
      .call("issues_list", { threadId, projectId })
      .then(
        (next) => {
          setResult(next);
          setFailure(null);
        },
        (cause: unknown) => {
          setFailure(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => setLoading(false));
  }, [rpc, threadId, projectId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    // Coming back to BB after working in a terminal is the moment the list is
    // most likely to be out of date.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  // server.ts publishes after any change it makes and after any change it
  // sees made outside the plugin (an agent or a terminal running bd), so the
  // tab follows along on its own.
  useRealtime(CHANGED_CHANNEL, refresh);
  return { rpc, result, failure, loading, refresh };
}

/**
 * Whether the tab treats an open issue as blocked. Three ways, all worked
 * out in server.ts: it waits on an unfinished issue; an issue it sits
 * inside does (beads' own rule, already folded into `blockedBy`); or it has
 * open sub-issues and every one of them is blocked (the user's rule: an
 * issue with even one workable sub-issue is actionable and is not blocked).
 * A closed issue is never blocked.
 */
function isBlocked(issue: Issue): boolean {
  return (
    issue.status !== "closed" &&
    (issue.blockedBy.length > 0 || issue.subIssuesBlocked)
  );
}

/** Most urgent first; within one priority, most recently changed first. */
function byUrgency(left: Issue, right: Issue): number {
  const priority = (left.priority ?? 99) - (right.priority ?? 99);
  if (priority !== 0) return priority;
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

/**
 * Splits issues into the groups the tab shows.
 *
 * "Blocked" wins over the issue's own status, because an issue that waits on
 * unfinished work cannot be picked up whatever its status says. "Other"
 * catches statuses such as deferred or any custom one.
 */
function toSections(issues: Issue[]): Section[] {
  const sections: Section[] = [
    {
      id: "in_progress",
      title: "In progress",
      hint: "Someone has started these.",
      issues: [],
    },
    {
      id: "ready",
      title: "Ready",
      hint: "Open, and nothing unfinished stands in the way.",
      issues: [],
    },
    {
      id: "blocked",
      title: "Blocked",
      hint: "Waiting on other unfinished issues.",
      issues: [],
    },
    {
      id: "other",
      title: "Other",
      hint: "Deferred, or in a status of your own.",
      issues: [],
    },
    { id: "closed", title: "Closed", hint: "Finished or cancelled.", issues: [] },
  ];
  const find = (id: Section["id"]) =>
    sections.find((section) => section.id === id)!;
  for (const issue of issues) {
    if (issue.status === "closed") find("closed").issues.push(issue);
    else if (isBlocked(issue)) find("blocked").issues.push(issue);
    else if (issue.status === "in_progress")
      find("in_progress").issues.push(issue);
    else if (issue.status === "open") find("ready").issues.push(issue);
    else find("other").issues.push(issue);
  }
  for (const section of sections) section.issues.sort(byUrgency);
  return sections;
}

/** The dashed box BB's own list pages use for loading and empty states. */
function Notice({ children }: { children: ReactNode }) {
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
function Tag({
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
function StatusTag({ issue }: { issue: Issue }) {
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

/** What an issue row can do besides showing itself. */
interface IssueActions {
  /** Id of the bead this thread works on; null when none. */
  currentBeadId: string | null;
  /**
   * Changes which bead this thread works on without messaging the agent; the
   * tab uses it to clear the choice. Null when there is no thread.
   */
  setCurrent: ((beadId: string | null) => void) | null;
  /**
   * The play button: marks an issue as this thread's bead and tells the
   * agent to start on it (requirements, then a plan, then the work). Null
   * when there is no thread.
   */
  start: ((beadId: string) => void) | null;
  /**
   * Fetches one issue's comments, oldest first. Resolves to the comments, or
   * rejects with a plain-language reason.
   */
  loadComments: (beadId: string) => Promise<IssueComment[]>;
  /**
   * Asks to close an open issue (the user confirms in a dialog first).
   * `commit` true is the happy path: the work is accepted, so the thread's
   * agent is also asked to commit it. `commit` false closes without a
   * commit: the issue is dropped, not done.
   */
  close: (beadId: string, commit: boolean) => void;
  /**
   * Changes an issue's type and/or priority in beads, straight away and
   * without confirmation (it is one click to change back). A field left out
   * is not touched.
   */
  edit: (
    beadId: string,
    change: { type?: IssueType; priority?: number },
  ) => void;
  /**
   * Saves a new title and description for an issue. Resolves to null on
   * success, or to a plain-language reason on failure, so the edit form can
   * stay open with what was typed.
   */
  saveText: (
    beadId: string,
    text: { title: string; description: string },
  ) => Promise<string | null>;
  /**
   * Starts a background agent that defines the issue. Does nothing
   * visible here beyond the row showing that it is under way.
   */
  define: (beadId: string) => void;
  /**
   * The sub-issues drawn under an issue: its direct children, open ones
   * first. Leaves out the thread's current bead, which is drawn in Current.
   */
  childrenOf: (beadId: string) => Issue[];
  /**
   * Opens the details window on an issue that has sub-issues, or moves the
   * already open window to it.
   */
  openDetails: (beadId: string) => void;
  /**
   * Moves an issue inside another (parentId set) or out to the top level
   * (parentId null). No confirmation: it is undone by moving it back.
   */
  setParent: (beadId: string, parentId: string | null) => void;
  /**
   * Whether `beadId` may be dropped into `parentId`: not into itself, not
   * into one of its own sub-issues, and not where it already is.
   */
  canNest: (beadId: string, parentId: string) => boolean;
  /** The categories in use in this repository, in alphabetical order. */
  categories: string[];
  /**
   * Sets an issue's category (replacing the one it has) or, with null,
   * clears it. Straight away and without confirmation, like type and
   * priority.
   */
  setCategory: (beadId: string, category: string | null) => void;
  /**
   * The issues `beadId` may be moved into: every open issue except itself,
   * its own sub-issues at any depth, and the parent it is already in.
   */
  moveTargets: (beadId: string) => Issue[];
  /**
   * Adds a link of one of beads' kinds, stored on `fromId` and pointing at
   * `toId` ("fromId is blocked by toId"). Straight away, no confirmation:
   * it is undone with the chip's remove button.
   */
  link: (fromId: string, toId: string, kind: LinkKind) => void;
  /** Removes `link`, one of the links listed on issue `beadId`. */
  unlink: (beadId: string, link: IssueLink) => void;
  /** The issues `beadId` may be linked with: every issue except itself. */
  linkTargets: (beadId: string) => Issue[];
  /**
   * Gets the new-issue field at the bottom ready to create an issue inside
   * `parentId`: selects it as the parent there and puts the cursor in the
   * field. Nothing is created until the user types a title and presses
   * Enter. There is deliberately no second text field for this on the row.
   */
  addSubIssue: (parentId: string) => void;
  /** Reopens a closed issue; no confirmation. */
  reopen: (beadId: string) => void;
}

/**
 * Starts defining an issue with a background agent, so the thread the
 * user is in is left alone. The agent runs in a hidden worker thread that is
 * not in the sidebar; while it is busy the button turns into the one way to
 * open it, in case the user wants to look in or it is waiting on a question.
 */
function DefineButton({
  issue,
  actions,
  iconOnly = false,
}: {
  issue: Issue;
  actions: IssueActions;
  /**
   * Draw it as a bare icon, in the same style as the row's close button.
   * Used on a collapsed row, where a labelled button would crowd the title.
   */
  iconOnly?: boolean;
}) {
  const navigate = useBbNavigate();
  const running = issue.defineThreadId;
  const look = iconOnly
    ? ({
        variant: "ghost",
        size: "icon",
        className: "m-1 size-7 shrink-0 text-muted-foreground",
      } as const)
    : ({ variant: "outline", size: "sm" } as const);
  if (running !== null) {
    return (
      <Button
        {...look}
        tip="A background agent is writing this issue up. Click to open it."
        aria-label={`Open the background agent that is defining ${issue.id}`}
        onClick={() => navigate.toThread(running)}
      >
        <Icon name="Loading" className="size-4 animate-spin" />
        {iconOnly ? null : "Defining… open"}
      </Button>
    );
  }
  return (
    <Button
      {...look}
      tip="Define: have a background agent write this issue up (what is wanted, what done means, and an approach)"
      aria-label={`Define ${issue.id} with a background agent`}
      onClick={() => actions.define(issue.id)}
    >
      <Icon name="MessageSquare" className="size-4" />
      {iconOnly ? null : "Define"}
    </Button>
  );
}

/** Priority, type and similar small facts about an issue, on one line. */
/** Value of the dropdown entry that switches CategorySelect to typing. */
const NEW_CATEGORY = "\u0000new";

/**
 * Chooses a category: one already in use, none, or a new one typed in.
 *
 * A plain dropdown cannot be typed into, so "New category…" swaps the
 * dropdown for a short text field: Enter saves what was typed, Escape or
 * leaving the field empty goes back to the dropdown. The list of categories
 * grows only through this field; there is no separate list to maintain.
 *
 * @param value The current category; null for none.
 * @param noneLabel What the "no category" entry reads, e.g. "category" on a
 *   row or "Category: same as parent" in the new-issue form.
 * @param prefix Put before each category name in the list, e.g. "Category: ".
 * @param onChange Called with the chosen or typed name, or null for none.
 *   The name is passed as typed; the backend tidies it and reuses the
 *   spelling of an existing category.
 */
function CategorySelect({
  value,
  choices,
  onChange,
  noneLabel,
  prefix = "",
  className,
  ariaLabel,
}: {
  value: string | null;
  choices: string[];
  onChange: (category: string | null) => void;
  noneLabel: string;
  prefix?: string;
  className?: string;
  ariaLabel: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  if (typing) {
    const finish = (save: boolean) => {
      const name = draft.trim();
      setTyping(false);
      setDraft("");
      if (save && name !== "") onChange(name);
    };
    return (
      <input
        autoFocus
        value={draft}
        maxLength={40}
        aria-label={`${ariaLabel}: new category name`}
        placeholder="new category"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Not a form submit: inside the new-issue form Enter here must
            // save the category, not create the issue.
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className={cn(className, "w-32 cursor-text")}
      />
    );
  }
  // A category the issue has that is not (yet) in the list is still shown.
  const listed =
    value === null || choices.includes(value) ? choices : [value, ...choices];
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(event) => {
        if (event.target.value === NEW_CATEGORY) setTyping(true);
        else onChange(event.target.value === "" ? null : event.target.value);
      }}
      className={className}
    >
      <option value="">{noneLabel}</option>
      {listed.map((name) => (
        <option key={name} value={name}>
          {prefix}
          {name}
        </option>
      ))}
      <option value={NEW_CATEGORY}>New category…</option>
    </select>
  );
}

function IssueFacts({
  issue,
  onEdit,
  category,
  showStatus = false,
}: {
  issue: Issue;
  /** When given, priority and type become small dropdowns that call this. */
  onEdit?: IssueActions["edit"];
  /**
   * When given, the category becomes a dropdown too: `choices` are the
   * categories in use, `onChange` sets or clears this issue's.
   */
  category?: {
    choices: string[];
    onChange: IssueActions["setCategory"];
  };
  /**
   * Show the issue's status as a tag. Used for sub-issues, which sit under
   * their parent and so are not under a status heading that would say it.
   */
  showStatus?: boolean;
}) {
  // The current type is always offered, even if it is one this plugin does
  // not otherwise list (beads has more types than the new-issue form).
  const typeChoices: string[] =
    issue.type === null || (ISSUE_TYPES as readonly string[]).includes(issue.type)
      ? [...ISSUE_TYPES]
      : [issue.type, ...ISSUE_TYPES];
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      {/* Clicking the id copies it (bead-bb-c58): ids are what you type
          to an agent or into bd, and they are awkward to select by hand
          between the tags. */}
      <Tip label="Copy the id">
        <button
          type="button"
          className="cursor-copy font-mono text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            // The clipboard can be refused (no permission, or the page is
            // not focused); say so instead of failing silently.
            navigator.clipboard.writeText(issue.id).then(
              () => toast.success(`Copied ${issue.id}`),
              () => toast.error(`Could not copy ${issue.id}`),
            );
          }}
        >
          {issue.id}
        </button>
      </Tip>
      {showStatus ? <StatusTag issue={issue} /> : null}
      {onEdit === undefined ? (
        <>
          {issue.priority === null ? null : (
            <Tag strong={issue.priority <= 1}>P{issue.priority}</Tag>
          )}
          {issue.type === null ? null : <Tag>{issue.type}</Tag>}
        </>
      ) : (
        <>
          <select
            aria-label={`Priority of ${issue.id}`}
            value={issue.priority ?? ""}
            onChange={(event) =>
              onEdit(issue.id, { priority: Number(event.target.value) })
            }
            className={cn(
              TAG_SELECT_CLASS,
              issue.priority !== null && issue.priority <= 1
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {issue.priority === null ? <option value="">P?</option> : null}
            {[0, 1, 2, 3, 4].map((priority) => (
              <option key={priority} value={priority}>
                P{priority}
              </option>
            ))}
          </select>
          <select
            aria-label={`Type of ${issue.id}`}
            value={issue.type ?? ""}
            onChange={(event) =>
              onEdit(issue.id, { type: event.target.value as IssueType })
            }
            className={cn(TAG_SELECT_CLASS, "text-muted-foreground")}
          >
            {issue.type === null ? <option value="">type?</option> : null}
            {typeChoices.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </>
      )}
      {/* The category: a dropdown where it can be changed, a plain tag
          where it cannot (closed issues), nothing when there is none. */}
      {category !== undefined ? (
        <CategorySelect
          value={issue.category}
          choices={category.choices}
          onChange={(next) => category.onChange(issue.id, next)}
          noneLabel="category"
          ariaLabel={`Category of ${issue.id}`}
          className={cn(
            TAG_SELECT_CLASS,
            "max-w-40",
            issue.category === null
              ? "text-muted-foreground/60"
              : "text-muted-foreground",
          )}
        />
      ) : issue.category === null ? null : (
        <Tag>{issue.category}</Tag>
      )}
      {issue.assignee === null ? null : <Tag>{issue.assignee}</Tag>}
      {issue.blocks.length === 0 ? null : (
        <Tag>holds up {issue.blocks.length}</Tag>
      )}
      {issue.defineThreadId === null ? null : <Tag strong>defining…</Tag>}
      {issue.commentCount === 0 ? null : (
        <Tag>
          {issue.commentCount}{" "}
          {issue.commentCount === 1 ? "comment" : "comments"}
        </Tag>
      )}
    </span>
  );
}

/**
 * One part of an opened issue (design, notes, comments and so on) that starts
 * folded to its heading and opens on its own chevron. The user asked for
 * these to start collapsed, so opening an issue shows its description plus a
 * short list of what else exists, not a wall of text.
 *
 * Children are only mounted while open, which is what makes comments load on
 * demand.
 */
function Collapsible({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="size-3.5 shrink-0"
        />
        {label}
      </button>
      {open ? <div className="mt-1 pl-[18px]">{children}</div> : null}
    </div>
  );
}

/**
 * One titled block of an issue's free text (design, notes and so on),
 * rendered as Markdown and collapsed to start. Renders nothing when the text
 * is empty, so an issue with only a description looks as it did before.
 */
function TextSection({ label, text }: { label: string; text: string }) {
  if (text.trim() === "") return null;
  return (
    <Collapsible label={label}>
      <Markdown content={text} className="text-sm" />
    </Collapsible>
  );
}

/** "3 Oct 2026, 20:31" in the reader's own locale; the raw text if unparsable. */
function formatWhen(timestamp: string): string {
  const when = new Date(timestamp);
  return Number.isNaN(when.getTime())
    ? timestamp
    : when.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

/**
 * The comments of an issue, oldest first, shown inside the collapsed
 * "Comments" part of an opened issue.
 *
 * Fetched when that part is opened, because beads needs one run per issue
 * for comments. Fetched again whenever the issue's comment count or
 * last-changed time moves, which is how a refresh of the list reaches
 * comments that are already on screen. Nothing is fetched or shown for an
 * issue without comments. A failure is reported in place; the rest of the
 * opened issue is unaffected.
 */
function CommentList({
  issue,
  load,
}: {
  issue: Issue;
  load: IssueActions["loadComments"];
}) {
  const [comments, setComments] = useState<IssueComment[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { id, commentCount, updatedAt } = issue;
  useEffect(() => {
    if (commentCount === 0) return;
    // Ignore an answer that arrives after the issue changed or was closed up.
    let stale = false;
    load(id).then(
      (next) => {
        if (stale) return;
        setComments(next);
        setProblem(null);
      },
      (cause: unknown) => {
        if (stale) return;
        setProblem(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [load, id, commentCount, updatedAt]);
  if (problem !== null) {
    return (
      <p role="alert" className="text-xs text-destructive">
        Could not load comments: {problem}
      </p>
    );
  }
  if (comments === null) {
    return <p className="text-xs text-muted-foreground">Loading comments…</p>;
  }
  return (
    <ul className="space-y-2">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className="rounded-md border border-border px-3 py-2"
        >
          <div className="text-xs text-muted-foreground">
            {comment.author === "" ? "Unknown" : comment.author}
            {comment.createdAt === ""
              ? ""
              : ` · ${formatWhen(comment.createdAt)}`}
          </div>
          <Markdown content={comment.text} className="mt-1 text-sm" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Id of the issue being dragged, or null. Kept here, outside React, because
 * the browser does not let a row read what is being dragged while it is only
 * hovering (the drag's data is readable on drop, not on drag-over), and the
 * row has to decide during the hover whether it is a valid place to drop.
 */
let draggedBeadId: string | null = null;

/**
 * The form that replaces an opened issue's description while its title and
 * description are being edited.
 *
 * The description is edited as the raw Markdown beads stores. Saving an empty
 * description clears it; an empty title cannot be saved. Cancel leaves the
 * issue untouched. A failed save keeps the form open with what was typed and
 * shows the reason.
 *
 * @param save Saves both fields; resolves to null on success or to the
 *   reason on failure.
 * @param onDone Called after a successful save or a cancel, to close the form.
 */
function EditIssueText({
  issue,
  save,
  onDone,
}: {
  issue: Issue;
  save: IssueActions["saveText"];
  onDone: () => void;
}) {
  // Started from the issue as it was when Edit was pressed, and deliberately
  // not refreshed afterwards: a list reload must not overwrite half-typed text.
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    const reason = await save(issue.id, { title: title.trim(), description });
    setPending(false);
    setProblem(reason);
    if (reason === null) onDone();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label={`Title of ${issue.id}`}
        placeholder="Title"
      />
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        aria-label={`Description of ${issue.id}`}
        placeholder="Description (Markdown, optional)"
        rows={8}
        className={cn(FIELD_CLASS, "block w-full resize-y font-mono text-xs")}
      />
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          Could not save: {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || title.trim() === ""}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * How well `query` matches `text`, for the "Move to" search: higher is
 * better, 0 is no match. A run of the query's letters found together beats
 * the same letters found scattered, and a match at the start of a word beats
 * one in the middle, so typing a few letters of an id or of a title's words
 * finds it without typing it exactly.
 */
function fuzzyScore(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 1;
  const haystack = text.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at !== -1) {
    const atWordStart = at === 0 || /[^a-z0-9]/u.test(haystack[at - 1]!);
    return 1000 + (atWordStart ? 100 : 0) - Math.min(at, 99);
  }
  // Otherwise every letter must appear in order; closer together is better.
  let position = 0;
  let gaps = 0;
  for (const letter of needle.replaceAll(" ", "")) {
    const found = haystack.indexOf(letter, position);
    if (found === -1) return 0;
    gaps += found - position;
    position = found + 1;
  }
  return Math.max(1, 500 - gaps);
}

/**
 * The link kinds the Link box offers: beads' own dependency types, in the
 * order of server.ts's LINK_KINDS (repeated here because this file can only
 * import types from there). Nothing is added to beads' set: the user asked
 * for "standard bead to bead rels semantics, nothing additional".
 */
const LINK_KINDS = [
  "blocks",
  "discovered-from",
  "related",
  "tracks",
  "until",
  "caused-by",
  "validates",
  "supersedes",
] as const;
type LinkKind = (typeof LINK_KINDS)[number];

/**
 * How a link reads from the issue it is stored on, as in "this issue is
 * blocked by X". Beads' own names, with the dashes taken out; only "blocks"
 * is reworded, because beads stores "A blocks-type-depends on B" on the
 * issue that waits, and "this issue blocks X" would say the opposite.
 * "relates-to" is what a "related" link made here is stored as.
 */
const LINK_WORDS: Record<string, string> = {
  blocks: "blocked by",
  "discovered-from": "discovered from",
  related: "related",
  "relates-to": "related",
  tracks: "tracks",
  until: "until",
  "caused-by": "caused by",
  validates: "validates",
  supersedes: "supersedes",
};

/** Kinds that read the same from both ends, so they have no direction. */
const TWO_WAY_KINDS: readonly string[] = ["related", "relates-to"];

/** A link's wording; a kind this file does not know is shown as beads names it. */
function linkWords(kind: string): string {
  return LINK_WORDS[kind] ?? kind;
}

/**
 * A chain-link icon for the Link button. Drawn here because BB's icon set
 * has none (checked in its bundle: only ExternalLink), and an unknown name
 * would show BB's fallback icon. Takes its colour from the text around it.
 */
function LinkIcon({ className }: { className?: string }) {
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
 * The links of an opened issue, as one line of chips (bead-bb-zty.4). It
 * replaced two separate lists, "Blocked by" and "Holds up", which showed
 * only blocking links to unfinished issues.
 *
 * Every link of every kind is here, from both ends. A link stored on this
 * issue reads "blocked by · <title>"; one stored on the other issue and
 * pointing here reads "blocks · <title>" for a blocking link and
 * "<title> · discovered from this" (and so on) for the other kinds, so the
 * direction is always in the words. A closed issue's title is struck out.
 *
 * Clicking a chip opens that issue in the details window. The x, which
 * shows on hover, removes the link without asking: it is put back with the
 * Link button. Draws nothing for an issue without links.
 */
function LinksLine({
  issue,
  actions,
}: {
  issue: Issue;
  actions: IssueActions;
}) {
  if (issue.links.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">Links</div>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {issue.links.map((link) => {
          const words = linkWords(link.kind);
          const title = (
            <span className={cn(link.closed && "line-through")}>
              {link.title}
            </span>
          );
          return (
            <li
              key={`${link.direction}:${link.kind}:${link.id}`}
              className="group/link flex max-w-full items-center rounded-full border border-border text-xs"
            >
              <Tip label={`Open ${link.id}`}>
                <button
                  type="button"
                  className="min-w-0 cursor-pointer truncate rounded-full py-0.5 pl-2 pr-1 hover:bg-state-hover"
                  onClick={() => actions.openDetails(link.id)}
                >
                  {link.direction === "out" ||
                  TWO_WAY_KINDS.includes(link.kind) ? (
                    <>
                      <span className="text-muted-foreground">{words} · </span>
                      {title}
                    </>
                  ) : link.kind === "blocks" ? (
                    <>
                      <span className="text-muted-foreground">blocks · </span>
                      {title}
                    </>
                  ) : (
                    <>
                      {title}
                      <span className="text-muted-foreground">
                        {" "}
                        · {words} this
                      </span>
                    </>
                  )}
                </button>
              </Tip>
              <Tip label="Remove this link">
                <button
                  type="button"
                  aria-label={`Remove the link with ${link.id}`}
                  className="mr-1 shrink-0 cursor-pointer rounded-full px-1 text-muted-foreground opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover/link:opacity-100"
                  onClick={() => actions.unlink(issue.id, link)}
                >
                  ×
                </button>
              </Tip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The box behind the "Link" button: links this issue with another, using
 * beads' own link kinds.
 *
 * It reads as a sentence, so what will be saved is in front of the user
 * before Enter: "This issue [blocked by] <the issue searched for>". The swap
 * button turns it round, "<the issue searched for> [blocked by] this issue",
 * which is the same kind of link stored on the other issue. The user chose
 * the swap button over always linking from the open issue (awkward when you
 * are looking at the blocker) and over listing each direction as its own
 * kind (twice the list, with reverse names beads does not have). A two-way
 * kind ("related") has nothing to swap.
 *
 * Drawn inside the opened issue, like the Move to picker and for the same
 * reason: the list the rows sit in clips anything that hangs outside it.
 *
 * Keys: typing narrows the list, Enter takes the first result, Escape
 * cancels.
 *
 * @param targets Issues this one may be linked with (already excludes itself).
 * @param onPick Called with the link to add: the issue it is stored on, the
 *   issue it points at, and its kind.
 */
function LinkPicker({
  issue,
  targets,
  onPick,
  onCancel,
}: {
  issue: Issue;
  targets: Issue[];
  onPick: (fromId: string, toId: string, kind: LinkKind) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  // Starts on "blocks", as beads does when no kind is given.
  const [kind, setKind] = useState<LinkKind>("blocks");
  const [swapped, setSwapped] = useState(false);
  const twoWay = TWO_WAY_KINDS.includes(kind);
  const reversed = swapped && !twoWay;
  const shown = useMemo(
    () =>
      targets
        .map((target) => ({
          target,
          score: fuzzyScore(query, `${target.id} ${target.title}`),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            // Open issues first: they are the likelier other end.
            Number(left.target.status === "closed") -
              Number(right.target.status === "closed") ||
            byUrgency(left.target, right.target),
        )
        .map((entry) => entry.target),
    [targets, query],
  );
  const listed = shown.slice(0, MOVE_TO_RESULTS);
  const pick = (otherId: string) =>
    reversed ? onPick(otherId, issue.id, kind) : onPick(issue.id, otherId, kind);
  // The fixed half of the sentence: "This issue [kind]" or "[kind] this issue".
  const sentence = (
    <div className="flex items-center gap-1.5 px-1 text-sm">
      {reversed ? null : <span>This issue</span>}
      <select
        aria-label="Kind of link"
        value={kind}
        onChange={(event) => setKind(event.target.value as LinkKind)}
        className={cn(TAG_SELECT_CLASS, "text-foreground")}
      >
        {LINK_KINDS.map((choice) => (
          <option key={choice} value={choice}>
            {linkWords(choice)}
          </option>
        ))}
      </select>
      {reversed ? <span>this issue</span> : null}
      <span className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={twoWay}
        tip={
          twoWay
            ? "This kind of link has no direction"
            : "Swap which issue is which"
        }
        aria-label="Swap which issue is which"
        onClick={() => setSwapped((current) => !current)}
      >
        <Icon name="ArrowUpDown" className="size-4" />
      </Button>
    </div>
  );
  const search = (
    <>
      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (listed[0] !== undefined) pick(listed[0].id);
          }
        }}
        placeholder="Type to find the other issue…"
        aria-label={`Search for an issue to link with ${issue.id}`}
      />
      <ul>
        {listed.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              className={cn(
                "block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm hover:bg-state-hover",
                target.status === "closed" &&
                  "text-muted-foreground line-through",
              )}
              onClick={() => pick(target.id)}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {target.id}
              </span>{" "}
              {target.title}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
      {/* The order on screen is the order of the sentence. */}
      {reversed ? (
        <>
          {search}
          {sentence}
        </>
      ) : (
        <>
          {sentence}
          {search}
        </>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {listed.length === 0
            ? "No issue matches."
            : shown.length > listed.length
              ? `${shown.length - listed.length} more — keep typing to narrow.`
              : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Most results the "Move to" picker lists at once. */
const MOVE_TO_RESULTS = 8;

/**
 * The picker behind "Move to": a search field and a short list of issues to
 * move this one into, with "Top level" first for an issue that has a parent.
 *
 * Drawn inside the opened issue rather than floating over it, because the
 * list the rows sit in clips anything that hangs outside it.
 *
 * Keys: typing narrows the list, Enter takes the first result, Escape
 * cancels.
 *
 * @param targets Issues this one may be moved into (already excludes itself,
 *   its sub-issues and its present parent).
 * @param onPick Called with the chosen parent's id, or null for top level.
 */
function MoveToPicker({
  issue,
  targets,
  onPick,
  onCancel,
}: {
  issue: Issue;
  targets: Issue[];
  onPick: (parentId: string | null) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () =>
      targets
        .map((target) => ({
          target,
          score: fuzzyScore(query, `${target.id} ${target.title}`),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || byUrgency(left.target, right.target),
        )
        .map((entry) => entry.target),
    [targets, query],
  );
  // "Top level" is offered while it would change something and the search
  // does not rule it out.
  const offerTopLevel =
    issue.parentId !== null && fuzzyScore(query, "top level") > 0;
  const shown = matches.slice(0, MOVE_TO_RESULTS);
  const option =
    "block w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm hover:bg-state-hover";
  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (offerTopLevel && shown.length === 0) onPick(null);
            else if (shown[0] !== undefined) onPick(shown[0].id);
          }
        }}
        placeholder={`Move ${issue.id} into… type to search`}
        aria-label={`Search for an issue to move ${issue.id} into`}
      />
      <ul>
        {offerTopLevel ? (
          <li>
            <button type="button" className={option} onClick={() => onPick(null)}>
              Top level{" "}
              <span className="text-muted-foreground">(out of its parent)</span>
            </button>
          </li>
        ) : null}
        {shown.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              className={option}
              onClick={() => onPick(target.id)}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {target.id}
              </span>{" "}
              {target.title}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {shown.length === 0 && !offerTopLevel
            ? "No issue matches."
            : matches.length > shown.length
              ? `${matches.length - shown.length} more — keep typing to narrow.`
              : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Whether a description is long enough to be cut short in an opened row:
 * more than about four lines' worth, by length or by line count.
 */
function isLongDescription(text: string): boolean {
  return text.length > 240 || text.split("\n").length > 4;
}

/** Everything shown when an issue is opened: text, relations, actions. */
function IssueDetails({
  issue,
  actions,
  fullDescription = false,
  showFacts = false,
}: {
  issue: Issue;
  actions: IssueActions;
  /**
   * Show the id, priority and type line at the top. Used for compact
   * sub-issue rows, whose one-line row has no room for them.
   */
  showFacts?: boolean;
  /**
   * Show the whole description. False (the default) cuts a long one to a
   * few lines with "View more", which opens the details window; true is for
   * the issue the details window is showing, where the full text belongs.
   */
  fullDescription?: boolean;
}) {
  const closed = issue.status === "closed";
  // Whether the title and description are being edited. Kept here, in the
  // opened issue, so it ends when the issue is closed up; it also ends if
  // the row is rebuilt because the issue moved to another group.
  const [editing, setEditing] = useState(false);
  // Whether the "Move to" picker is showing under the buttons.
  const [moving, setMoving] = useState(false);
  // Whether the "Link" box is showing under the buttons. Only one of the
  // two boxes shows at a time.
  const [linking, setLinking] = useState(false);
  return (
    <div className="space-y-3">
      {showFacts ? (
        <IssueFacts
          issue={issue}
          onEdit={closed ? undefined : actions.edit}
          category={
            closed
              ? undefined
              : { choices: actions.categories, onChange: actions.setCategory }
          }
        />
      ) : null}
      {editing ? (
        <EditIssueText
          issue={issue}
          save={actions.saveText}
          onDone={() => setEditing(false)}
        />
      ) : issue.description.trim() === "" ? (
        <p className="text-xs text-muted-foreground">No description.</p>
      ) : fullDescription || !isLongDescription(issue.description) ? (
        <Markdown content={issue.description} className="text-sm" />
      ) : (
        // A long description is cut to about four lines so an opened row
        // stays short; the rest is read in the details window.
        <div>
          <div className="relative max-h-[5.5rem] overflow-hidden">
            <Markdown content={issue.description} className="text-sm" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />
          </div>
          <button
            type="button"
            className="mt-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => actions.openDetails(issue.id)}
          >
            View more
          </button>
        </div>
      )}
      <TextSection label="Acceptance criteria" text={issue.acceptance} />
      <TextSection label="Design" text={issue.design} />
      <TextSection label="Notes" text={issue.notes} />
      <TextSection label="Close reason" text={issue.closeReason} />
      <LinksLine issue={issue} actions={actions} />
      {issue.labels.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <Tag key={label}>{label}</Tag>
          ))}
        </div>
      )}
      {issue.status === "open" ||
      issue.status === "in_progress" ||
      closed ? null : (
        <p className="text-xs text-muted-foreground">Status: {issue.status}</p>
      )}
      {issue.commentCount === 0 ? null : (
        <Collapsible label={`Comments (${issue.commentCount})`}>
          <CommentList issue={issue} load={actions.loadComments} />
        </Collapsible>
      )}
      {/* The opened issue's buttons are deliberately quiet (the user's
          request, bead-bb-zty.1): short, small text, no border, a soft
          background, so a row of them does not pull the eye away from the
          issue's text. Styled here once, for every button in the row. */}
      <div className="flex flex-wrap gap-1.5 [&>button]:h-6 [&>button]:gap-1 [&>button]:rounded [&>button]:border-0 [&>button]:bg-foreground/[0.06] [&>button]:px-2 [&>button]:text-xs [&>button]:font-normal [&>button]:text-muted-foreground [&>button]:shadow-none [&>button:hover]:bg-foreground/[0.12] [&>button:hover]:text-foreground [&>button_[data-icon-root]]:size-3.5">
        {closed ? null : (
          <DefineButton issue={issue} actions={actions} />
        )}
        {closed || editing ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Edit the title and description"
            onClick={() => setEditing(true)}
          >
            <Icon name="EditFile" className="size-4" />
            Edit
          </Button>
        )}
        {/* Does not create anything here: it selects this issue as the
            parent in the new-issue field at the bottom and puts the cursor
            there, so there is one place to type a new issue, not two. */}
        {closed ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Create a new issue inside this one, using the new-issue field below"
            onClick={() => actions.addSubIssue(issue.id)}
          >
            <Icon name="Plus" className="size-4" />
            Add sub-issue
          </Button>
        )}
        {/* Moving without dragging: for long lists, where the place to
            drop is far off screen. It also covers moving out, so there is
            one button for both. */}
        {moving ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Move this issue inside another issue, or out to the top level"
            onClick={() => {
              setLinking(false);
              setMoving(true);
            }}
          >
            <Icon name="MoveTo" className="size-4" />
            Move to
          </Button>
        )}
        {closed ? null : (
          <Button
            variant="outline"
            size="sm"
            tip="Link this issue with another: blocked by, discovered from, related and beads' other kinds"
            onClick={() => {
              setMoving(false);
              setLinking(true);
            }}
          >
            <LinkIcon className="size-4" />
            Link
          </Button>
        )}
        {/* A compact sub-issue row has no buttons of its own (see
            IssueRow), so the ones a full row carries are repeated here:
            play, and the way into the details window. */}
        {showFacts &&
        !closed &&
        actions.start !== null &&
        actions.currentBeadId === null ? (
          <Button
            variant="outline"
            size="sm"
            tip="Make this the issue the conversation is working on and start the agent on it"
            onClick={() => actions.start?.(issue.id)}
          >
            <Icon name="Play" className="size-4" />
            Start work
          </Button>
        ) : null}
        {showFacts && actions.childrenOf(issue.id).length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            tip="Open this issue and its sub-issues in the details window"
            onClick={() => actions.openDetails(issue.id)}
          >
            <Icon name="Maximize2" className="size-4" />
            Open with sub-issues
          </Button>
        ) : null}
        {/* A compact sub-issue row has no close or reopen button of its own
            (see IssueRow); they are here instead. The current bead's own
            button follows below, so it is skipped here. */}
        {!showFacts || actions.currentBeadId === issue.id ? null : closed ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            tip="Reopen this issue"
            onClick={() => actions.reopen(issue.id)}
          >
            <Icon name="RotateCcw" className="size-4" />
            Reopen
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            tip="Close this issue without committing anything"
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
            Close
          </Button>
        )}
        {/* The current bead's "drop it" action lives here, out of the way,
            instead of on the row beside "Close & commit". */}
        {closed || actions.currentBeadId !== issue.id ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            tip="Close this issue without committing: use it to drop the issue"
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
            Close without commit
          </Button>
        )}
      </div>
      {moving ? (
        <MoveToPicker
          issue={issue}
          targets={actions.moveTargets(issue.id)}
          onPick={(parentId) => {
            setMoving(false);
            actions.setParent(issue.id, parentId);
          }}
          onCancel={() => setMoving(false)}
        />
      ) : null}
      {linking ? (
        <LinkPicker
          issue={issue}
          targets={actions.linkTargets(issue.id)}
          onPick={(fromId, toId, kind) => {
            setLinking(false);
            actions.link(fromId, toId, kind);
          }}
          onCancel={() => setLinking(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * One issue: a compact line that opens to show its details, with its
 * sub-issues drawn indented underneath.
 *
 * Nesting is drawn one level deep only (the user's rule): a top-level row
 * shows its direct sub-issues, and those show none of their own. Any row
 * that has sub-issues carries a details button that opens the details
 * window on it, which is how deeper levels are reached.
 *
 * The line is a drop target: dropping another issue on it moves that issue
 * inside this one. Dragging starts only from the grip at its left edge.
 *
 * State kept in the row (so it resets when the tab is closed): whether the
 * issue is opened. Opening shows both its details and its sub-issues.
 */
function IssueRow({
  issue,
  actions,
  detailsClassName,
  nested = false,
  showSubIssues = true,
  subIssuesClassName,
  isDetailsRoot = false,
  lean = false,
  hoverClassName = "hover:bg-state-hover",
}: {
  issue: Issue;
  actions: IssueActions;
  /** Extra classes for the opened area, e.g. a height cap for pinned rows. */
  detailsClassName?: string;
  /** This row is a sub-issue drawn under its parent. */
  nested?: boolean;
  /** Draw this issue's direct sub-issues under it. False for nested rows. */
  showSubIssues?: boolean;
  /** Extra classes for the sub-issue list, e.g. a height cap when pinned. */
  subIssuesClassName?: string;
  /**
   * This row is the issue the details window is showing, so it needs no
   * button to open the details window on itself. Its sub-issues are drawn
   * as full-size rows: the window has the room (bead-bb-zty.2).
   */
  isDetailsRoot?: boolean;
  /**
   * Draw this row as the lean one-line sub-issue row. Set by a parent row in
   * the panel for its sub-issues.
   */
  lean?: boolean;
  /**
   * The background a row's line takes while the pointer is on it. The
   * default is the app's gray hover. Current passes a green one: the gray,
   * laid over Current's green background, came out gray-green.
   */
  hoverClassName?: string;
}) {
  const subIssues = actions.childrenOf(issue.id);
  const hasSubIssues = showSubIssues && subIssues.length > 0;
  // One chevron opens everything about the issue: its description and its
  // sub-issues. It starts open for an issue that has sub-issues (the user's
  // rule), so the nesting is visible without clicking, and for the issue the
  // details window is showing, which was opened to be read.
  const [open, setOpen] = useState(isDetailsRoot || hasSubIssues);
  // An issue that gains its first sub-issue while on screen opens too;
  // otherwise the new sub-issue would be created out of sight.
  useEffect(() => {
    if (hasSubIssues) setOpen(true);
  }, [hasSubIssues]);
  // True while a draggable issue hovers over this row and may be dropped.
  const [dropTarget, setDropTarget] = useState(false);
  // The row's line, used as the picture that follows the pointer in a drag.
  const line = useRef<HTMLDivElement>(null);
  const closed = issue.status === "closed";
  // A sub-issue drawn under its parent in the panel is a leaner row than a
  // top-level one (the user's request: they looked the same and were as
  // tall): one line, smaller text, only status and priority beside the
  // title, no buttons on the row at all, and the grip shown only while the
  // pointer or the keyboard is on the row. In the details window sub-issues
  // are full-size rows instead, so `lean` is passed down, not worked out
  // from `nested`.
  const compact = lean;
  const openCount = subIssues.filter(
    (subIssue) => subIssue.status !== "closed",
  ).length;
  return (
    <li>
      <div
        ref={line}
        onDragOver={(event) => {
          // Always stop here, valid or not: an invalid drop on a row must not
          // fall through to the list behind it and be taken as "move out".
          event.stopPropagation();
          if (
            draggedBeadId === null ||
            !actions.canNest(draggedBeadId, issue.id)
          ) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(event) => {
          event.stopPropagation();
          setDropTarget(false);
          const dragged = draggedBeadId;
          draggedBeadId = null;
          if (dragged === null || !actions.canNest(dragged, issue.id)) return;
          event.preventDefault();
          actions.setParent(dragged, issue.id);
        }}
        className={cn(
          "group/row relative flex",
          hoverClassName,
          compact ? "items-center" : "items-start",
          dropTarget && "bg-state-active outline outline-1 outline-ring",
        )}
      >
        {/* The drag anchor. Only this grip starts a drag, so that selecting
            the title's text, using the dropdowns and clicking buttons on the
            row never drags it by accident. The whole line is shown as the
            thing being dragged. */}
        <Tip label="Drag onto another issue to nest it, or onto a group heading to move it out">
        <span
          draggable
          role="img"
          aria-label={`Drag ${issue.id} to move it into or out of another issue`}
          onDragStart={(event) => {
            draggedBeadId = issue.id;
            event.dataTransfer.effectAllowed = "move";
            // Some browsers will not start a drag without data.
            event.dataTransfer.setData("text/plain", issue.id);
            if (line.current !== null) {
              event.dataTransfer.setDragImage(line.current, 12, 12);
            }
          }}
          onDragEnd={() => {
            draggedBeadId = null;
          }}
          className={cn(
            "cursor-grab pl-2 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing",
            // Kept in the layout while invisible, so the title does not
            // jump sideways when the grip appears.
            compact
              ? "py-1 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
              : "py-2",
          )}
        >
          <Icon
            name="DragDropVertical"
            className={cn("size-4 shrink-0", !compact && "mt-0.5")}
          />
        </span>
        </Tip>
        {/* The chevron and the title both open the issue. They are two
            separate buttons with the facts line outside them, because the
            priority and type dropdowns on that line are controls of their
            own and may not sit inside a button. */}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          onClick={() => setOpen((current) => !current)}
          className={cn("cursor-pointer pl-1 pr-2", compact ? "py-1" : "py-2")}
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              !compact && "mt-0.5",
            )}
          />
        </button>
        {compact ? (
          // One line: the title, then status and priority. The id and the
          // type are inside the opened issue (see IssueDetails).
          <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-[13px]">
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              className={cn(
                "min-w-0 flex-1 cursor-pointer truncate text-left",
                closed && "text-muted-foreground line-through",
              )}
            >
              {issue.title}
            </button>
            {hasSubIssues ? <Tag>{subIssues.length} sub</Tag> : null}
            <StatusTag issue={issue} />
            {issue.priority === null ? null : (
              <Tag strong={issue.priority <= 1}>P{issue.priority}</Tag>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1 py-2 pr-1 text-sm">
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              className={cn(
                "block w-full cursor-pointer text-left",
                closed && "text-muted-foreground line-through",
              )}
            >
              {issue.title}
            </button>
            {/* Closed issues are finished business: their facts stay fixed. */}
            <IssueFacts
              issue={issue}
              onEdit={closed ? undefined : actions.edit}
              category={
                closed
                  ? undefined
                  : {
                      choices: actions.categories,
                      onChange: actions.setCategory,
                    }
              }
              showStatus={nested}
            />
            {/* Says that there is something nested here even while the row
                is closed up. Not a control: the chevron opens it. */}
            {hasSubIssues ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {subIssues.length}{" "}
                {subIssues.length === 1 ? "sub-issue" : "sub-issues"}
                {openCount === subIssues.length
                  ? ""
                  : `, ${subIssues.length - openCount} closed`}
              </span>
            ) : null}
          </div>
        )}
        {/* The row's buttons. A compact sub-issue row has none (the user's
            rule: no buttons on hover for sub-issues); everything they did is
            inside the opened sub-issue instead (see IssueDetails). Only the
            drag grip appears on hover, since it is a handle, not an action. */}
        <div className={compact ? "hidden" : "contents"}>
        {/* Opens the details window on this issue: the roomy view of an
            issue with its sub-issues, and the only way to levels deeper than
            the one drawn here. */}
        {subIssues.length === 0 || isDetailsRoot ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0 text-muted-foreground"
            tip="Open this issue and its sub-issues in the details window"
            aria-label={`Open ${issue.id} and its sub-issues in the details window`}
            onClick={() => actions.openDetails(issue.id)}
          >
            <Icon name="Maximize2" className="size-4" />
          </Button>
        )}
        {/* An issue that is only a title is the one that most needs
            defining, so the button is on the row for it instead of
            hidden inside the opened issue. Once the issue has a description
            the button is found inside, as before. */}
        {closed || issue.description.trim() !== "" ? null : (
          <DefineButton issue={issue} actions={actions} iconOnly />
        )}
        {/* Offered only while the thread has no bead: with one already
            chosen, a stray click here would redirect an agent mid-task. */}
        {actions.start === null ||
        actions.currentBeadId !== null ||
        closed ? null : (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0"
            tip="Start work: make this the current issue and start the agent on it"
            aria-label={`Start work on ${issue.id}: ${issue.title}`}
            onClick={() => actions.start?.(issue.id)}
          >
            <Icon name="Play" className="size-4" />
          </Button>
        )}
        {/* Two different ways to close, two different icons.
            - Finishing (check plus the words "Close & commit", in the
              ordinary gray button style; the user did not want colour) is
              the expected outcome, so on the thread's current bead it is the
              one close button on the row. It exists only there, because that is the
              work the thread's agent can commit.
            - Dropping (cross) closes without a commit. On the current bead
              it is kept off the row and shown only inside the opened issue
              (see IssueDetails), so it cannot be mistaken for the default.
              On every other open issue it is the only way to close, so it
              stays on the row, muted.
            Both ask for confirmation first (see BeadsPanel); reopening does
            not, since it only puts an issue back on the list. */}
        {/* Not on a compact sub-issue row: closing (and reopening) a
            sub-issue is done from inside the opened sub-issue, so a slip of
            the pointer over a short row cannot cancel it. */}
        {compact ? null : closed ? (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0"
            tip="Reopen this issue"
            aria-label={`Reopen ${issue.id}: ${issue.title}`}
            onClick={() => actions.reopen(issue.id)}
          >
            <Icon name="RotateCcw" className="size-4" />
          </Button>
        ) : actions.currentBeadId === issue.id ? (
          <Button
            variant="outline"
            size="sm"
            className="m-1 h-7 shrink-0 px-2"
            tip="The work is accepted: close the issue and ask the agent to commit it"
            aria-label={`Close and commit ${issue.id}: ${issue.title}`}
            onClick={() => actions.close(issue.id, true)}
          >
            <Icon name="CircleCheck" className="size-4" />
            Close &amp; commit
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0 text-muted-foreground"
            tip="Close this issue without committing: use it to drop the issue"
            aria-label={`Close ${issue.id}: ${issue.title}`}
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
          </Button>
        )}
        </div>
      </div>
      {open ? (
        <div
          className={cn(
            "border-t border-border px-3 py-3 pl-14",
            detailsClassName,
          )}
        >
          <IssueDetails
            issue={issue}
            actions={actions}
            fullDescription={isDetailsRoot}
            showFacts={compact}
          />
        </div>
      ) : null}
      {hasSubIssues && open ? (
        <ul
          className={cn(
            // A rail down the left edge, so the sub-issues read as "inside"
            // the row above them. In the panel the block is also slightly
            // darker than the rows around it (the user asked for a slight
            // difference); in the details window the rows are full size and
            // need no tint to be told apart.
            "ml-6 divide-y divide-border border-l-2 border-t border-border border-l-foreground/25",
            !isDetailsRoot && "bg-black/[0.035]",
            subIssuesClassName,
          )}
        >
          {subIssues.map((subIssue) => (
            <IssueRow
              key={subIssue.id}
              issue={subIssue}
              actions={actions}
              nested
              showSubIssues={false}
              lean={!isDetailsRoot}
              hoverClassName={hoverClassName}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * One titled group of issues. `headerActions` puts buttons at the right end
 * of the title line; the Current group uses it for Clear and "define".
 */
function SectionBlock({
  section,
  actions,
  headerActions = null,
  detailsClassName,
  collapsed = false,
  subIssuesClassName,
  listClassName,
  rowHoverClassName,
  subGroups = [],
  collapsedSubGroups = [],
  onToggleSubGroup,
  emptyNote,
}: {
  section: Section;
  actions: IssueActions;
  headerActions?: ReactNode;
  detailsClassName?: string;
  /** Show only the heading line (with its count), not the issues. */
  collapsed?: boolean;
  /** Passed to each row; see IssueRow. */
  subIssuesClassName?: string;
  /** Extra classes for the box around the rows, e.g. Current's border. */
  listClassName?: string;
  /** Passed to each row as its hover background; see IssueRow. */
  rowHoverClassName?: string;
  /**
   * When not empty, the group is drawn as these sub-groups, each with its
   * own collapsible heading, instead of one list. Used for Ready when a
   * grouping is chosen. The group's own heading keeps the total count.
   */
  subGroups?: SubGroup[];
  /** Keys of the sub-groups that are collapsed. */
  collapsedSubGroups?: string[];
  /** Collapses or opens a sub-group. */
  onToggleSubGroup?: (key: string) => void;
  /** Shown in place of the list when the group has no issues. */
  emptyNote?: string;
}) {
  /** One boxed list of rows; a group has one, or one per sub-group. */
  const rows = (issues: Issue[]) => (
    <ul
      className={cn(
        "mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card",
        listClassName,
      )}
    >
      {issues.map((issue) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          actions={actions}
          detailsClassName={detailsClassName}
          subIssuesClassName={subIssuesClassName}
          hoverClassName={rowHoverClassName}
        />
      ))}
    </ul>
  );
  return (
    <section>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-baseline gap-2 text-sm font-medium">
            {section.title}
            <span className="text-xs font-normal text-muted-foreground">
              {section.issues.length}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground">{section.hint}</p>
        </div>
        {headerActions}
      </div>
      {section.issues.length === 0 && emptyNote !== undefined ? (
        <p className="mt-2 text-xs text-muted-foreground">{emptyNote}</p>
      ) : null}
      {collapsed || section.issues.length === 0 ? null : subGroups.length ===
        0 ? (
        rows(section.issues)
      ) : (
        subGroups.map((subGroup) => {
          const folded = collapsedSubGroups.includes(subGroup.key);
          return (
            <div key={subGroup.key} className="mt-3">
              <button
                type="button"
                aria-expanded={!folded}
                onClick={() => onToggleSubGroup?.(subGroup.key)}
                className="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <Icon
                  name={folded ? "ChevronRight" : "ChevronDown"}
                  className="size-3.5 shrink-0"
                />
                {subGroup.label}
                <span className="font-normal">· {subGroup.issues.length}</span>
              </button>
              {folded ? null : rows(subGroup.issues)}
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * The first group in a thread's tab: the bead this thread is working on. It
 * looks and behaves like every other group — one collapsed row that opens on
 * its chevron — so a long description never pushes the rest of the tab down.
 * Shown only for threads, because "what this thread works on" has no meaning
 * on the New thread screen.
 *
 * Three cases: a bead is chosen and exists; a bead is chosen but is no longer
 * in the list (deleted, or from another repository); nothing is chosen yet.
 */
function CurrentSection({
  issue,
  actions,
}: {
  issue: Issue | null;
  actions: IssueActions;
}) {
  const { currentBeadId, setCurrent } = actions;
  if (setCurrent === null) return null;
  const clear = (
    <Button
      variant="ghost"
      size="sm"
      tip="Stop treating this as the issue the conversation is working on"
      onClick={() => setCurrent(null)}
    >
      Clear
    </Button>
  );
  if (issue !== null) {
    return (
      <SectionBlock
        section={{
          id: "current",
          title: "Current",
          hint: "The bead this thread is working on.",
          issues: [issue],
        }}
        actions={actions}
        // Pinned, so an opened long description scrolls inside itself
        // instead of covering the list below. For the same reason the
        // current bead's sub-issues scroll inside a cap. The two caps
        // together leave at least half the panel to the list.
        detailsClassName="max-h-[22vh] overflow-y-auto"
        // The current issue stands out by a box with a thicker border and a
        // light green background, the look the user chose after trying it
        // (bead-bb-6ui).
        //
        // The green is BB's theme "success" colour mixed INTO the card
        // colour, giving a solid colour. The first attempts used the green
        // at low opacity instead, which let whatever lay underneath show
        // through: the panel's gray background at rest, and the gray hover
        // on top, so it read as gray-green. A solid mix cannot pick up gray.
        // Hover is the same mix with more green, nothing else.
        listClassName="border-2 border-success/40 bg-[color:color-mix(in_oklab,var(--success)_9%,var(--card))]"
        rowHoverClassName="hover:bg-[color:color-mix(in_oklab,var(--success)_18%,var(--card))]"
        // The current issue's sub-issues get no darker tint of their own:
        // gray over green is the same gray-green again.
        subIssuesClassName="max-h-[22vh] overflow-y-auto bg-transparent"
      />
    );
  }
  return (
    <section>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Current</h3>
          <p className="text-xs text-muted-foreground">
            The bead this thread is working on.
          </p>
        </div>
        {currentBeadId === null ? null : clear}
      </div>
      <div className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        {currentBeadId === null ? (
          <>
            None yet. Press play on an issue to start the agent on it.
          </>
        ) : (
          <>
            <span className="font-mono text-foreground">{currentBeadId}</span>{" "}
            is not in the list any more.
          </>
        )}
      </div>
    </section>
  );
}

/** What the quick tags typed into a new issue's title came to. */
interface QuickTags {
  /** The title with the recognised tags taken out. */
  title: string;
  type: IssueType | null;
  priority: number | null;
  category: string | null;
}

/**
 * Reads the quick tags out of a new issue's title (bead-bb-ky8):
 *
 * - `#task`, `#bug` and the other issue types set the type;
 * - `#p0` to `#p4` set the priority;
 * - `$name` sets the category.
 *
 * A tag counts only as a word of its own (at the start, or after a space),
 * in any mix of capitals. Recognised tags are removed from the title;
 * anything else, such as `#123` or `$5`, is left in it as typed. When a kind
 * of tag appears twice, the last one wins.
 *
 * A category tag must start with a letter and may contain letters, digits,
 * `-` and `_`. That rules out prices (`$5`); a title that really needs a
 * word like `$HOME` in it has to be fixed up with Edit afterwards.
 */
function parseQuickTags(typed: string): QuickTags {
  const found: QuickTags = {
    title: "",
    type: null,
    priority: null,
    category: null,
  };
  const kept: string[] = [];
  for (const word of typed.split(/\s+/u)) {
    const lower = word.toLowerCase();
    const priority = /^#p([0-4])$/u.exec(lower);
    if (priority !== null) {
      found.priority = Number(priority[1]);
    } else if (
      lower.startsWith("#") &&
      (ISSUE_TYPES as readonly string[]).includes(lower.slice(1))
    ) {
      found.type = lower.slice(1) as IssueType;
    } else if (/^\$[a-z][a-z0-9_-]*$/u.test(lower)) {
      found.category = lower.slice(1);
    } else if (word !== "") {
      kept.push(word);
    }
  }
  found.title = kept.join(" ");
  return found;
}

/** One entry in the tag auto-complete list. */
interface TagSuggestion {
  /** What is shown, e.g. "#bug" or "$ux polish". */
  label: string;
  /** A word saying what kind of thing it sets: type, priority or category. */
  kind: "type" | "priority" | "category";
  /** The value it sets, without the `#` or `$`. */
  value: string;
}

/** Most suggestions listed at once. */
const TAG_SUGGESTIONS_MAX = 8;

/** Whether a category name can be typed as a `$tag` (one plain word). */
function isTagSafeCategory(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/u.test(name);
}

/**
 * The tag being typed at the caret, if any: the run of characters from the
 * last space before the caret up to the caret, when it starts with `#` or
 * `$`. Returns where it starts in the title and what has been typed of it.
 */
function tagAtCaret(
  title: string,
  caret: number,
): { start: number; token: string } | null {
  const before = title.slice(0, caret);
  const start = before.search(/\S*$/u);
  const token = before.slice(start);
  return token.startsWith("#") || token.startsWith("$")
    ? { start, token }
    : null;
}

/**
 * What to offer for a partly typed tag. `#` offers the issue types and the
 * priorities that start with what was typed; `$` offers the categories in
 * use, those that start with it first, then those that merely contain it. Nothing is offered
 * once the tag is typed in full, so the list gets out of the way.
 */
function suggestTags(token: string, categories: string[]): TagSuggestion[] {
  const typed = token.slice(1).toLowerCase();
  const all: TagSuggestion[] =
    token[0] === "#"
      ? [
          ...ISSUE_TYPES.map((type) => ({
            label: `#${type}`,
            kind: "type" as const,
            value: type,
          })),
          ...[0, 1, 2, 3, 4].map((priority) => ({
            label: `#p${priority}`,
            kind: "priority" as const,
            value: `p${priority}`,
          })),
        ]
      : categories.map((category) => ({
          label: `$${category}`,
          kind: "category" as const,
          value: category,
        }));
  if (all.some((entry) => entry.value === typed)) return [];
  return [
    ...all.filter((entry) => entry.value.startsWith(typed)),
    // "Contains" matches are for categories only, whose names the user may
    // half remember. For `#` they would offer #epic for "#p", which is noise.
    ...all.filter(
      (entry) =>
        entry.kind === "category" &&
        !entry.value.startsWith(typed) &&
        entry.value.includes(typed),
    ),
  ].slice(0, TAG_SUGGESTIONS_MAX);
}

/**
 * The line for creating an issue. Type a title and press Enter for the fast
 * path; the chevron on the left reveals type, priority and description for a
 * full issue.
 *
 * @param onCreate Creates the issue and resolves to null on success or a
 *   plain-language reason on failure. The form keeps what was typed when it
 *   fails, so nothing is lost.
 */
function CreateIssue({
  onCreate,
  parent,
  onParentChange,
  parentChoices,
  focusRequest,
  categories,
  allowTopLevel = true,
}: {
  onCreate: (draft: {
    title: string;
    description: string;
    type: IssueType | null;
    priority: number | null;
    category: string | null;
  }) => Promise<string | null>;
  /** The issue the new one will be created inside; null for the top level. */
  parent: Issue | null;
  onParentChange: (parentId: string | null) => void;
  /** Open issues offered as a parent in the expanded form. */
  parentChoices: Issue[];
  /**
   * Changes each time something outside (the "Add sub-issue" button) wants
   * the cursor put in the title field.
   */
  focusRequest: number;
  /** Categories in use, offered in the expanded form. */
  categories: string[];
  /**
   * Whether "no parent" can be chosen. True in the panel. False in the
   * details window, where a new issue always goes inside the issue being
   * shown or one of the issues under it, so the choice is which, not
   * whether.
   */
  allowTopLevel?: boolean;
}) {
  const titleField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest > 0) titleField.current?.focus();
  }, [focusRequest]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Empty string = "let beads decide" (task, priority 2).
  const [type, setType] = useState<IssueType | "">("");
  const [priority, setPriority] = useState("");
  // Null = not chosen: a sub-issue then takes its parent's category.
  const [category, setCategory] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Quick tags in the title, read as the user types so the line under the
  // field can show what they will do.
  const tags = parseQuickTags(title);
  // Auto-complete for a tag being typed. `caret` follows the text cursor;
  // `active` is the highlighted suggestion; `dismissed` is the partly typed
  // tag the user closed the list on with Escape, so it stays closed until
  // they type something else.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typing = tagAtCaret(title, caret);
  const suggestions =
    typing === null || typing.token === dismissed
      ? []
      : suggestTags(typing.token, categories);
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1));
  // Where to put the text cursor after a completion has rewritten the title;
  // applied once React has put the new text in the field.
  const caretAfter = useRef<number | null>(null);
  useEffect(() => {
    if (caretAfter.current === null) return;
    const position = caretAfter.current;
    caretAfter.current = null;
    titleField.current?.setSelectionRange(position, position);
    setCaret(position);
  }, [title]);
  /**
   * Completes the tag being typed with a suggestion.
   *
   * Usually that replaces the partly typed tag with the full one. A category
   * whose name cannot be written as a tag (it has a space, say) is set
   * directly instead, and the partly typed tag is removed from the title.
   */
  const complete = (suggestion: TagSuggestion) => {
    if (typing === null) return;
    const end = typing.start + typing.token.length;
    const asTag =
      suggestion.kind !== "category" || isTagSafeCategory(suggestion.value);
    const inserted = asTag ? `${suggestion.label} ` : "";
    if (!asTag) setCategory(suggestion.value);
    // Do not leave two spaces behind when the tag was followed by one.
    const rest = title.slice(end).replace(/^ /u, "");
    setTitle(title.slice(0, typing.start) + inserted + rest);
    caretAfter.current = typing.start + inserted.length;
    setActive(0);
    setDismissed(null);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A title that is nothing but tags is not an issue.
    if (tags.title === "" || pending) return;
    setPending(true);
    // A tag typed in the title wins over the same choice in the expanded
    // form: it is the more recent, more deliberate of the two.
    const reason = await onCreate({
      title: tags.title,
      description,
      type: tags.type ?? (type === "" ? null : type),
      priority: tags.priority ?? (priority === "" ? null : Number(priority)),
      category: tags.category ?? category,
    });
    setPending(false);
    setProblem(reason);
    if (reason !== null) return;
    setTitle("");
    setDescription("");
    setCategory(null);
    // The parent is for the one issue just created (the user's rule,
    // bead-bb-zty.5): left selected, the next issue typed here would land
    // inside it unnoticed. In the details window this puts the field back to
    // the issue the window is showing.
    onParentChange(null);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          Could not create the issue: {problem}
        </p>
      )}
      {/* Always shown while a parent is selected, expanded or not, so a new
          issue never lands inside another one unnoticed. */}
      {parent === null ? null : (
        <div className="flex items-center gap-2 pl-9 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            New sub-issue of{" "}
            <span className="font-mono text-foreground">{parent.id}</span>{" "}
            {parent.title}
          </span>
          {allowTopLevel ? (
            <button
              type="button"
              aria-label="Create at the top level instead"
              className="shrink-0 cursor-pointer hover:text-foreground"
              onClick={() => onParentChange(null)}
            >
              <Icon name="CircleX" className="size-4" />
            </button>
          ) : null}
        </div>
      )}
      {more ? (
        <div className="space-y-2 pl-9">
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Type"
              value={type}
              onChange={(event) => setType(event.target.value as IssueType | "")}
              className={FIELD_CLASS}
            >
              <option value="">Type: task</option>
              {ISSUE_TYPES.filter((name) => name !== "task").map((name) => (
                <option key={name} value={name}>
                  Type: {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">Priority: P2 (normal)</option>
              <option value="0">Priority: P0 (most urgent)</option>
              <option value="1">Priority: P1</option>
              <option value="3">Priority: P3</option>
              <option value="4">Priority: P4 (least urgent)</option>
            </select>
            <CategorySelect
              value={category}
              choices={categories}
              onChange={setCategory}
              noneLabel={
                parent === null
                  ? "Category: none"
                  : `Category: same as parent${parent.category === null ? " (none)" : ` (${parent.category})`}`
              }
              prefix="Category: "
              ariaLabel="Category"
              className={cn(FIELD_CLASS, "min-w-0 max-w-full")}
            />
            <select
              aria-label="Parent issue"
              value={parent?.id ?? ""}
              onChange={(event) =>
                onParentChange(
                  event.target.value === "" ? null : event.target.value,
                )
              }
              className={cn(FIELD_CLASS, "min-w-0 max-w-full")}
            >
              {allowTopLevel ? (
                <option value="">Parent: none (top level)</option>
              ) : null}
              {parentChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  Parent: {choice.id} {choice.title.slice(0, 50)}
                </option>
              ))}
            </select>
          </div>
          <textarea
            aria-label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description (optional)"
            rows={4}
            className={cn(FIELD_CLASS, "block w-full resize-y")}
          />
        </div>
      ) : null}
      {/* Auto-complete for a tag being typed. In the flow above the field,
          not floating: the field sits at the bottom edge, and the list above
          it clips anything that hangs outside. Clicking an entry must not
          take the focus out of the field, hence onMouseDown. */}
      {suggestions.length === 0 ? null : (
        <ul
          role="listbox"
          aria-label="Tag suggestions"
          className="ml-9 flex flex-wrap gap-1"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.label} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => complete(suggestion)}
                className={cn(
                  "cursor-pointer rounded border px-1.5 py-px text-xs",
                  index === highlighted
                    ? "border-foreground/40 bg-state-active text-foreground"
                    : "border-border text-muted-foreground hover:bg-state-hover",
                )}
              >
                {suggestion.label}
              </button>
            </li>
          ))}
          <li className="self-center text-[11px] text-muted-foreground">
            Tab to complete
          </li>
        </ul>
      )}
      {/* What the quick tags in the title will do, shown while typing so
          that a type, priority or category is never set by surprise. A
          category picked from the suggestions without becoming a tag (its
          name has a space) is shown here too. */}
      {tags.type === null &&
      tags.priority === null &&
      (tags.category ?? category) === null ? null : (
        <div className="flex flex-wrap items-center gap-1.5 pl-9 text-xs text-muted-foreground">
          <span>Will be created as</span>
          {tags.type === null ? null : <Tag strong>{tags.type}</Tag>}
          {tags.priority === null ? null : (
            <Tag strong>P{tags.priority}</Tag>
          )}
          {(tags.category ?? category) === null ? null : (
            <Tag strong>category {tags.category ?? category}</Tag>
          )}
          {tags.title === "" ? <span>— add a title</span> : null}
        </div>
      )}
      <div className="flex items-center gap-2">
        {/* Same place as an issue row's chevron. The extra fields open
            upward, because this line sits on the bottom edge of the tab. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-expanded={more}
          tip="Set type, priority, description and parent"
          aria-label={more ? "Hide type, priority and description" : "Add type, priority and description"}
          onClick={() => setMore((current) => !current)}
        >
          <Icon
            name={more ? "ChevronUp" : "ChevronRight"}
            className="size-4 text-muted-foreground"
          />
        </Button>
        <Input
          ref={titleField}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setActive(0);
            setDismissed(null);
          }}
          // Fires when the text cursor moves without the text changing
          // (arrow keys, a click), so the suggestions follow the cursor.
          onSelect={(event) =>
            setCaret(
              event.currentTarget.selectionStart ??
                event.currentTarget.value.length,
            )
          }
          onKeyDown={(event) => {
            // Only while suggestions are showing. Otherwise the keys keep
            // their normal meaning; in particular Enter creates the issue.
            if (suggestions.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (highlighted + step + suggestions.length) % suggestions.length,
              );
            } else if (event.key === "Tab" || event.key === "Enter") {
              // With the list open, Enter completes the tag instead of
              // creating the issue.
              event.preventDefault();
              complete(suggestions[highlighted]!);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(typing?.token ?? null);
            }
          }}
          placeholder={
            parent === null
              ? "New issue — title, then Enter. #bug #p1 $category"
              : `New sub-issue of ${parent.id} — type a title and press Enter`
          }
          aria-label="New issue title"
        />
        <Button
          type="submit"
          size="sm"
          disabled={pending || tags.title === ""}
        >
          <Icon name="Plus" className="size-4" />
          Add
        </Button>
      </div>
    </form>
  );
}

/**
 * What the user chose to see. An empty list means "all". Whether closed
 * issues are shown is not a filter: it is the Closed group's own Show/Hide
 * button (see BeadsPanel).
 */
interface Filters {
  types: string[];
  priorities: number[];
  /** Category names; the empty string stands for "no category". */
  categories: string[];
  /**
   * How the Ready group is divided into sub-groups; "none" leaves it one
   * list. Kept here, with the filter, because it is the same kind of thing:
   * a remembered choice about how this folder's list is shown.
   */
  groupBy: GroupBy;
  /**
   * Sub-groups the user has collapsed, as "<grouping>:<value>" (for example
   * "priority:1", "category:ux", "category:" for no category). Kept per
   * grouping, so switching the grouping and back restores what was folded.
   */
  collapsed: string[];
}

/** The ways the Ready group can be divided. */
const GROUPINGS = ["none", "priority", "type", "category"] as const;
type GroupBy = (typeof GROUPINGS)[number];

const NO_FILTERS: Filters = {
  types: [],
  priorities: [],
  categories: [],
  groupBy: "none",
  collapsed: [],
};

/** One sub-group of the Ready group. */
interface SubGroup {
  /** "<grouping>:<value>", the key used in Filters.collapsed. */
  key: string;
  /** Heading shown to the user, e.g. "P1", "bug", "ux", "No category". */
  label: string;
  issues: Issue[];
}

/**
 * Divides issues into sub-groups by priority, type or category.
 *
 * Order: priority from P0 to P4; type in the order of the type dropdown,
 * then any other type alphabetically; category alphabetically. Issues with
 * no value come last, in a sub-group of their own. Sub-groups with no issues
 * are left out. The order of issues inside a sub-group is the order they
 * came in.
 *
 * Only the issues passed in are placed (top-level ones); an issue's
 * sub-issues are drawn under it by the row and so travel with their parent,
 * whatever their own values are.
 *
 * @returns An empty list for "none", meaning "do not divide".
 */
function toSubGroups(issues: Issue[], groupBy: GroupBy): SubGroup[] {
  if (groupBy === "none") return [];
  // The value an issue is grouped under; "" stands for "has none".
  const valueOf = (issue: Issue): string =>
    groupBy === "priority"
      ? issue.priority === null
        ? ""
        : `${issue.priority}`
      : groupBy === "type"
        ? (issue.type ?? "")
        : (issue.category ?? "");
  const byValue = new Map<string, Issue[]>();
  for (const issue of issues) {
    const value = valueOf(issue);
    byValue.set(value, [...(byValue.get(value) ?? []), issue]);
  }
  const known = ISSUE_TYPES as readonly string[];
  const rank = (value: string): [number, string] =>
    value === ""
      ? [2, ""] // no value: last
      : groupBy === "type" && known.includes(value)
        ? [0, `${known.indexOf(value)}`.padStart(3, "0")] // dropdown order
        : [groupBy === "type" ? 1 : 0, value]; // otherwise alphabetical
  const label = (value: string) =>
    value !== ""
      ? groupBy === "priority"
        ? `P${value}`
        : value
      : groupBy === "priority"
        ? "No priority"
        : groupBy === "type"
          ? "No type"
          : "No category";
  return [...byValue.entries()]
    .sort(([left], [right]) => {
      const [leftRank, leftName] = rank(left);
      const [rightRank, rightName] = rank(right);
      return leftRank - rightRank || leftName.localeCompare(rightName);
    })
    .map(([value, grouped]) => ({
      key: `${groupBy}:${value}`,
      label: label(value),
      issues: grouped,
    }));
}

/**
 * Filters for one folder, remembered in the browser's local storage so they
 * survive closing the tab and reloading BB.
 *
 * @param path Folder the tab is showing; null while it is not known yet, in
 *   which case nothing is read or saved.
 * Gotcha: stored text is treated as untrusted and re-checked field by field;
 *   anything unexpected falls back to "no filters".
 */
function useFilters(path: string | null) {
  const key = path === null ? null : `bb-plugin-airbender:filters:${path}`;
  // The key the filters were saved under before the plugin was renamed;
  // read when nothing is saved under the new one, so the remembered filters
  // survive the rename.
  const legacyKey = path === null ? null : `bb-plugin-beads:filters:${path}`;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  useEffect(() => {
    if (key === null) return;
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(key) ??
          (legacyKey === null ? null : localStorage.getItem(legacyKey)) ??
          "null",
      );
      if (typeof stored !== "object" || stored === null) {
        setFilters(NO_FILTERS);
        return;
      }
      const { types, priorities, categories, groupBy, collapsed } =
        stored as Record<string, unknown>;
      setFilters({
        types: Array.isArray(types)
          ? types.filter((value): value is string => typeof value === "string")
          : [],
        priorities: Array.isArray(priorities)
          ? priorities.filter(
              (value): value is number => typeof value === "number",
            )
          : [],
        categories: Array.isArray(categories)
          ? categories.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        groupBy: (GROUPINGS as readonly unknown[]).includes(groupBy)
          ? (groupBy as GroupBy)
          : "none",
        collapsed: Array.isArray(collapsed)
          ? collapsed.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      });
    } catch {
      setFilters(NO_FILTERS);
    }
  }, [key]);
  const update = useCallback(
    (next: Filters) => {
      setFilters(next);
      if (key === null) return;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or disabled: the filter still works for this session.
      }
    },
    [key],
  );
  return [filters, update] as const;
}

/** Adds the value to the list if absent, removes it if present. */
function toggled<Value>(list: Value[], value: Value): Value[] {
  return list.includes(value)
    ? list.filter((candidate) => candidate !== value)
    : [...list, value];
}

/** One labelled checkbox line in the filter menu. */
function FilterOption({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-state-hover">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

/**
 * Open/closed state for a small menu that hangs under its button.
 *
 * The menu closes on a press outside it or on Escape. Shared by the Filter
 * and Group menus so both behave alike.
 *
 * @returns `open` and `setOpen`, and `root`: a ref to put on the element
 *   that wraps both the button and the menu, so a press inside either does
 *   not count as "outside". Also `panel`: an optional second ref, for a menu
 *   that is drawn elsewhere in the page (a portal) and so is not inside
 *   `root`; a press inside it does not count as "outside" either.
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return { open, setOpen, root, panel };
}

/** What each grouping is called in the Group menu and on its button. */
const GROUPING_LABELS: Record<GroupBy, string> = {
  none: "None",
  priority: "Priority",
  type: "Type",
  category: "Category",
};

/**
 * The Group button and its menu, on the Ready heading: how the Ready group
 * is divided into sub-groups (none, priority, type or category).
 *
 * Drawn like the Filter button beside it, and for the same reason shows the
 * active choice on the button: a divided list should say what divides it.
 * It replaced a browser dropdown, which the owner found ugly (its open list
 * is drawn by the operating system, not in the app's style).
 *
 * Choosing an entry applies it and closes the menu.
 */
function GroupMenu({
  groupBy,
  onChange,
}: {
  groupBy: GroupBy;
  onChange: (next: GroupBy) => void;
}) {
  const { open, setOpen, root } = useMenu();
  return (
    <div ref={root} className="relative shrink-0">
      <Button
        variant={groupBy === "none" ? "ghost" : "secondary"}
        size="sm"
        aria-expanded={open}
        tip="Divide the Ready issues into sub-groups you can collapse"
        onClick={() => setOpen((current) => !current)}
      >
        {groupBy === "none"
          ? "Group"
          : `By ${GROUPING_LABELS[groupBy].toLowerCase()}`}
        <Icon name="ChevronDown" className="size-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-40 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md"
        >
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            Group Ready by
          </div>
          {GROUPINGS.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={choice === groupBy}
              onClick={() => {
                onChange(choice);
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-state-hover",
                choice === groupBy && "font-medium",
              )}
            >
              {GROUPING_LABELS[choice]}
              {choice === groupBy ? (
                <Icon name="Check" className="size-4 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Filter button and its menu: types, priorities and categories.
 *
 * The button shows how many narrowing choices (types and priorities) are
 * active, so a shortened list is never mistaken for the whole list. The menu
 * closes on a click outside it or on Escape.
 *
 * @param types Issue types that occur in this folder, so the menu only offers
 *   choices that can match something.
 */
function FilterMenu({
  filters,
  onChange,
  types,
  categories,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  types: string[];
  /** Categories in use, so the menu only offers ones that can match. */
  categories: string[];
}) {
  const { open, setOpen, root } = useMenu();
  const narrowing =
    filters.types.length +
    filters.priorities.length +
    filters.categories.length;
  return (
    <div ref={root} className="relative shrink-0">
      <Button
        variant={narrowing > 0 ? "secondary" : "ghost"}
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Filter{narrowing > 0 ? ` (${narrowing})` : ""}
        <Icon name="ChevronDown" className="size-4" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 space-y-2 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
          {types.length === 0 ? null : (
            <div>
              <div className="px-2 text-xs font-medium text-muted-foreground">
                Type
              </div>
              {types.map((type) => (
                <FilterOption
                  key={type}
                  label={type}
                  checked={filters.types.includes(type)}
                  onChange={() =>
                    onChange({ ...filters, types: toggled(filters.types, type) })
                  }
                />
              ))}
            </div>
          )}
          <div>
            <div className="px-2 text-xs font-medium text-muted-foreground">
              Priority
            </div>
            {[0, 1, 2, 3, 4].map((priority) => (
              <FilterOption
                key={priority}
                label={`P${priority}`}
                checked={filters.priorities.includes(priority)}
                onChange={() =>
                  onChange({
                    ...filters,
                    priorities: toggled(filters.priorities, priority),
                  })
                }
              />
            ))}
          </div>
          {/* Shown only once a category exists: with none in use there is
              nothing to narrow by. */}
          {categories.length === 0 ? null : (
            <div>
              <div className="px-2 text-xs font-medium text-muted-foreground">
                Category
              </div>
              {["", ...categories].map((category) => (
                <FilterOption
                  key={category}
                  label={category === "" ? "No category" : category}
                  checked={filters.categories.includes(category)}
                  onChange={() =>
                    onChange({
                      ...filters,
                      categories: toggled(filters.categories, category),
                    })
                  }
                />
              ))}
            </div>
          )}
          <p className="px-2 text-xs text-muted-foreground">
            Nothing ticked under a heading shows all of them.
          </p>
          {narrowing === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() =>
                onChange({ ...filters, types: [], priorities: [], categories: [] })
              }
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The tab body: current bead, create line, then the grouped issues or a
 * plain-language explanation of why there are none.
 */
function BeadsPanel({ scope }: { scope: Scope }) {
  const { rpc, result, failure, loading, refresh } = useIssues(scope);
  const [filters, setFilters] = useFilters(result?.path ?? null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  // The issue waiting for the user's "yes, close it"; null when none is.
  const [closing, setClosing] = useState<{
    issue: Issue;
    commit: boolean;
  } | null>(null);
  const { threadId, projectId } = scope;
  // The current bead is shown in its own group, so it is left out of the
  // status groups to avoid listing it twice.
  const currentIssue = useMemo(
    () =>
      result?.issues.find((issue) => issue.id === result.currentBeadId) ??
      null,
    [result],
  );
  // The tree. beads gives each issue one parent; everything else is derived.
  const tree = useMemo(() => {
    const all = result?.state === "ok" ? result.issues : [];
    const byId = new Map(all.map((issue) => [issue.id, issue]));
    const currentId = currentIssue?.id ?? null;
    // An issue is drawn under its parent unless:
    // - it has none, or its parent is not in the list;
    // - it is the thread's current bead, which is drawn in Current;
    // - it is still open while its parent is closed: under its parent it
    //   would be hidden inside the folded Closed group.
    const drawnUnderParent = (issue: Issue) => {
      if (issue.parentId === null || issue.id === currentId) return false;
      const parent = byId.get(issue.parentId);
      if (parent === undefined) return false;
      return !(parent.status === "closed" && issue.status !== "closed");
    };
    const children = new Map<string, Issue[]>();
    for (const issue of all) {
      if (!drawnUnderParent(issue)) continue;
      const list = children.get(issue.parentId!) ?? [];
      list.push(issue);
      children.set(issue.parentId!, list);
    }
    // Open sub-issues first, each part by urgency; closed ones stay listed,
    // struck through, at the end (the user's choice).
    for (const list of children.values()) {
      list.sort(
        (left, right) =>
          Number(left.status === "closed") - Number(right.status === "closed") ||
          byUrgency(left, right),
      );
    }
    return {
      byId,
      children,
      // What the status groups hold: everything not drawn somewhere else.
      topLevel: all.filter(
        (issue) => issue.id !== currentId && !drawnUnderParent(issue),
      ),
    };
  }, [result, currentIssue]);
  const others = tree.topLevel;
  /** Every issue inside `beadId`, at any depth (by the stored parents). */
  const descendantIds = useCallback(
    (beadId: string) => {
      const found = new Set<string>();
      const queue = [beadId];
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        for (const issue of tree.byId.values()) {
          if (issue.parentId !== parentId || found.has(issue.id)) continue;
          if (issue.id === beadId) continue;
          found.add(issue.id);
          queue.push(issue.id);
        }
      }
      return found;
    },
    [tree],
  );
  // The issue the details window is showing; null when it is closed. The
  // path shown at its top is worked out from the stored parents, so moving
  // deeper or back up is just changing this one id.
  const [detailsId, setDetailsId] = useState<string | null>(null);
  // The parent selected in the new-issue field at the bottom, and a counter
  // that asks that field to take the cursor (see CreateIssue).
  const [newIssueParentId, setNewIssueParentId] = useState<string | null>(null);
  const [focusNewIssue, setFocusNewIssue] = useState(0);
  // A parent that has since been closed or deleted is no longer a parent to
  // create into; the field falls back to the top level.
  const newIssueParent =
    newIssueParentId === null
      ? null
      : (tree.byId.get(newIssueParentId) ?? null);
  const newIssueParentOpen =
    newIssueParent !== null && newIssueParent.status !== "closed"
      ? newIssueParent
      : null;
  const detailsIssue =
    detailsId === null ? null : (tree.byId.get(detailsId) ?? null);
  const detailsPath = useMemo(() => {
    const path: Issue[] = [];
    const seen = new Set<string>();
    let step = detailsIssue;
    while (step !== null && !seen.has(step.id)) {
      seen.add(step.id);
      path.unshift(step);
      step =
        step.parentId === null ? null : (tree.byId.get(step.parentId) ?? null);
    }
    return path;
  }, [detailsIssue, tree]);
  // Types offered in the filter menu: those that actually occur here.
  const types = useMemo(
    () =>
      [
        ...new Set(others.flatMap((issue) => (issue.type ? [issue.type] : []))),
      ].sort(),
    [others],
  );
  // Categories in use anywhere in the repository (not only at the top
  // level), for the dropdowns and the filter menu.
  const categories = useMemo(
    () =>
      [
        ...new Set(
          (result?.issues ?? []).flatMap((issue) =>
            issue.category === null ? [] : [issue.category],
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [result],
  );
  // Closed issues are hidden each time the tab opens; the Closed group's
  // own button shows them. Deliberately not remembered, so the tab always
  // starts with the short list.
  const [showClosed, setShowClosed] = useState(false);
  const { openSections, closedSection } = useMemo(() => {
    const matching = others.filter(
      (issue) =>
        (filters.types.length === 0 ||
          (issue.type !== null && filters.types.includes(issue.type))) &&
        (filters.priorities.length === 0 ||
          (issue.priority !== null &&
            filters.priorities.includes(issue.priority))) &&
        // "" in the filter stands for "no category".
        (filters.categories.length === 0 ||
          filters.categories.includes(issue.category ?? "")),
    );
    const sections = toSections(matching);
    return {
      openSections: sections.filter(
        // Ready stays even when empty: its heading carries the Group and
        // Filter buttons, and a filter that emptied Ready must still be
        // reachable to undo.
        (section) =>
          section.id === "ready" ||
          (section.id !== "closed" && section.issues.length > 0),
      ),
      // Always present, even when empty, so the Closed heading never moves.
      closedSection: sections.find((section) => section.id === "closed")!,
    };
  }, [others, filters]);
  const narrowed =
    filters.types.length +
    filters.priorities.length +
    filters.categories.length >
    0;
  const reportProblem = (cause: unknown) =>
    setActionProblem(cause instanceof Error ? cause.message : String(cause));
  const loadComments = useCallback(
    async (beadId: string) => {
      const answer = await rpc.call("issue_comments", {
        threadId,
        projectId,
        beadId,
      });
      if (answer.message !== null) throw new Error(answer.message);
      return answer.comments;
    },
    [rpc, threadId, projectId],
  );
  /**
   * Closes (open=false) or reopens (open=true) an issue in beads.
   *
   * @param commit When closing, also ask the thread's agent to commit the
   *   issue's work. Has no effect when reopening or without a thread.
   */
  const applyOpen = (beadId: string, open: boolean, commit = false) => {
    const target = { threadId, projectId, beadId };
    (open
      ? rpc.call("issue_reopen", target)
      : rpc.call("issue_close", { ...target, commit })
    ).then((outcome) => {
      setActionProblem(outcome.message);
      refresh();
    }, reportProblem);
  };
  // Whether the issue in the close dialog is this thread's current bead,
  // the only case in which committing is a meaningful part of the question.
  const closingIsCurrent =
    closing !== null && closing.issue.id === (result?.currentBeadId ?? null);
  // "Close & commit" on an issue with sub-issues closes the open ones too;
  // the dialog says how many, so it is never a surprise.
  const closingOpenSubIssues =
    closing === null || !closing.commit
      ? 0
      : [...descendantIds(closing.issue.id)].filter(
          (id) => tree.byId.get(id)?.status !== "closed",
        ).length;
  const actions: IssueActions = {
    currentBeadId: result?.currentBeadId ?? null,
    loadComments,
    close: (beadId, commit) => {
      // Confirmed in a dialog first: remember which issue and which kind of
      // close, and let the dialog below call applyOpen when the user agrees.
      const issue = result?.issues.find((candidate) => candidate.id === beadId);
      if (issue !== undefined) setClosing({ issue, commit });
    },
    reopen: (beadId) => applyOpen(beadId, true),
    categories,
    setCategory: (beadId, category) => {
      rpc
        .call("issue_set_category", { threadId, projectId, beadId, category })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    childrenOf: (beadId) => tree.children.get(beadId) ?? [],
    openDetails: setDetailsId,
    canNest: (beadId, parentId) =>
      beadId !== parentId &&
      tree.byId.get(beadId)?.parentId !== parentId &&
      !descendantIds(beadId).has(parentId),
    setParent: (beadId, parentId) => {
      rpc
        .call("issue_set_parent", { threadId, projectId, beadId, parentId })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    link: (fromId, toId, kind) => {
      rpc
        .call("issue_link", { threadId, projectId, fromId, toId, kind })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    unlink: (beadId, link) => {
      // The link is stored on whichever issue is its "from" end.
      const [fromId, toId] =
        link.direction === "out" ? [beadId, link.id] : [link.id, beadId];
      rpc
        .call("issue_unlink", {
          threadId,
          projectId,
          fromId,
          toId,
          kind: link.kind,
        })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    linkTargets: (beadId) =>
      [...tree.byId.values()].filter((issue) => issue.id !== beadId),
    moveTargets: (beadId) => {
      const inside = descendantIds(beadId);
      const presentParent = tree.byId.get(beadId)?.parentId ?? null;
      return [...tree.byId.values()].filter(
        (issue) =>
          issue.status !== "closed" &&
          issue.id !== beadId &&
          issue.id !== presentParent &&
          !inside.has(issue.id),
      );
    },
    addSubIssue: (parentId) => {
      setNewIssueParentId(parentId);
      // The bottom field is behind the details window; get it out of the way.
      setDetailsId(null);
      setFocusNewIssue((count) => count + 1);
    },
    define: (beadId) => {
      rpc.call("issue_define", { threadId, projectId, beadId }).then(
        (outcome) => {
          setActionProblem(outcome.message);
          refresh();
        },
        reportProblem,
      );
    },
    saveText: async (beadId, text) => {
      try {
        const outcome = await rpc.call("issue_update", {
          threadId,
          projectId,
          beadId,
          type: null,
          priority: null,
          title: text.title,
          description: text.description,
        });
        if (outcome.message === null) refresh();
        return outcome.message;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
    edit: (beadId, change) => {
      rpc
        .call("issue_update", {
          threadId,
          projectId,
          beadId,
          type: change.type ?? null,
          priority: change.priority ?? null,
          title: null,
          description: null,
        })
        .then((outcome) => {
          setActionProblem(outcome.message);
          refresh();
        }, reportProblem);
    },
    start:
      threadId === null
        ? null
        : (beadId) => {
            // Play starts the agent in the conversation, which the details
            // window covers, so the window gets out of the way.
            setDetailsId(null);
            rpc.call("current_start", { threadId, beadId }).then(() => {
              setActionProblem(null);
              refresh();
            }, reportProblem);
          },
    setCurrent:
      threadId === null
        ? null
        : (beadId) => {
            rpc.call("current_set", { threadId, beadId }).then(
              () => {
                setActionProblem(null);
                refresh();
              },
              reportProblem,
            );
          },
  };
  /**
   * Creates an issue inside `parentId` (null for the top level). Shared by
   * the panel's new-issue field and the one in the details window, which
   * differ only in which parent they pass.
   */
  const createIn = async (
    parentId: string | null,
    draft: {
      title: string;
      description: string;
      type: IssueType | null;
      priority: number | null;
      category: string | null;
    },
  ) => {
    try {
      const created = await rpc.call("issue_create", {
        threadId,
        projectId,
        ...draft,
        parentId,
      });
      refresh();
      return created.message;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  // The details window has its own new-issue field, so that adding a
  // sub-issue there stays there (the user's rule: in the panel it stays in
  // the panel, in the window it stays in the window). Its parent is the
  // issue the window shows unless "Add sub-issue" on a row inside the window
  // picked another; moving to a different issue puts it back.
  const [windowParentId, setWindowParentId] = useState<string | null>(null);
  const [focusWindowNewIssue, setFocusWindowNewIssue] = useState(0);
  useEffect(() => {
    setWindowParentId(null);
  }, [detailsId]);
  const windowPicked =
    windowParentId === null ? null : (tree.byId.get(windowParentId) ?? null);
  const windowParent =
    windowPicked !== null && windowPicked.status !== "closed"
      ? windowPicked
      : detailsIssue;
  // Inside the window, "Add sub-issue" readies the window's own field
  // instead of closing the window and going to the panel's.
  const windowActions: IssueActions = {
    ...actions,
    addSubIssue: (parentId) => {
      setWindowParentId(parentId);
      setFocusWindowNewIssue((count) => count + 1);
    },
  };
  const ok = result?.state === "ok";
  // The scrolling band loses the width of its scrollbar; the pinned bands
  // above and below have no scrollbar, so without this their cards would be
  // that much wider than the cards in the list. Measuring is used rather
  // than a fixed number because scrollbar width differs by system and theme
  // (and is zero where scrollbars float over the content). The pinned bands
  // cannot simply reserve a gutter of their own with CSS: that needs
  // overflow clipping, which would cut off the filter menu that drops down
  // out of the top band.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () =>
      setScrollbarWidth(element.offsetWidth - element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // 12px is the bands' own padding (p-3), kept and added to.
  const pinnedStyle = { paddingRight: 12 + scrollbarWidth };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top band, pinned: Current, then the toolbar. */}
      <div
        className="shrink-0 space-y-3 border-b border-border p-3"
        style={pinnedStyle}
      >
        {ok ? <CurrentSection issue={currentIssue} actions={actions} /> : null}
        {actionProblem === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            That did not work: {actionProblem}
          </p>
        )}
        <div className="flex items-center gap-1">
          <p
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={result?.path ?? undefined}
          >
            {result?.path ?? ""}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            tip="Refresh the list"
            aria-label="Refresh"
            disabled={loading}
            onClick={refresh}
          >
            <Icon
              name="ArrowReloadHorizontal"
              className={cn("size-4", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>
      {/* Middle band, the only part that scrolls: the grouped issues. */}
      {/* Dropping a dragged sub-issue anywhere in this band that is not a
          row (a group heading, the gaps, the empty space below) moves it
          out to the top level. Rows stop the event themselves, so this only
          sees drops that missed every row. */}
      <div
        ref={scroller}
        onDragOver={(event) => {
          if (
            draggedBeadId === null ||
            tree.byId.get(draggedBeadId)?.parentId == null
          ) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          const dragged = draggedBeadId;
          draggedBeadId = null;
          if (dragged === null || tree.byId.get(dragged)?.parentId == null) {
            return;
          }
          event.preventDefault();
          actions.setParent(dragged, null);
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 [scrollbar-gutter:stable]"
      >
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            Could not load issues: {failure}
          </p>
        )}
        {result === null ? (
          failure === null ? (
            <Notice>Loading issues…</Notice>
          ) : null
        ) : result.state !== "ok" ? (
          <Notice>{result.message}</Notice>
        ) : result.issues.length === 0 ? (
          <Notice>No issues yet. Create the first one below.</Notice>
        ) : (
          <>
            {openSections.map((section) => (
              <SectionBlock
                key={section.id}
                section={section}
                actions={actions}
                // Only Ready is divided (the user's choice): it is the long
                // group, the backlog to choose from.
                subGroups={
                  section.id === "ready"
                    ? toSubGroups(section.issues, filters.groupBy)
                    : []
                }
                collapsedSubGroups={filters.collapsed}
                onToggleSubGroup={(key) =>
                  setFilters({
                    ...filters,
                    collapsed: toggled(filters.collapsed, key),
                  })
                }
                emptyNote={
                  section.id !== "ready"
                    ? undefined
                    : narrowed
                      ? "No ready issues match the filter."
                      : "No ready issues."
                }
                // Group and Filter sit on the Ready heading (the owner's
                // choice). Group only affects Ready; Filter still narrows
                // every group below Current.
                headerActions={
                  section.id !== "ready" ? null : (
                    <div className="flex shrink-0 items-center gap-1">
                      <GroupMenu
                        groupBy={filters.groupBy}
                        onChange={(groupBy) =>
                          setFilters({ ...filters, groupBy })
                        }
                      />
                      <FilterMenu
                        filters={filters}
                        onChange={setFilters}
                        types={types}
                        categories={categories}
                      />
                    </div>
                  )
                }
              />
            ))}
            {/* The Closed heading is always here; its issues are folded
                away until Show is pressed. */}
            <SectionBlock
              section={closedSection}
              actions={actions}
              collapsed={!showClosed}
              headerActions={
                closedSection.issues.length === 0 ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={showClosed}
                    onClick={() => setShowClosed((current) => !current)}
                  >
                    {showClosed ? "Hide" : "Show"}
                  </Button>
                )
              }
            />
          </>
        )}
      </div>
      {/* One dialog, three wordings. Committing is only mentioned where it
          applies, which is the thread's current bead: closing any other
          issue is a plain "are you sure", with Close and Cancel. */}
      <Dialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {closing?.commit
                ? "Close this issue and commit its work?"
                : closingIsCurrent
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
              {closingOpenSubIssues === 0
                ? ""
                : ` Its ${closingOpenSubIssues} open ${closingOpenSubIssues === 1 ? "sub-issue is" : "sub-issues are"} closed with it.`}
            </p>
          ) : closingIsCurrent ? (
            <p className="text-sm text-muted-foreground">
              The issue is closed and nothing is committed.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (closing !== null) {
                  applyOpen(closing.issue.id, false, closing.commit);
                }
                setClosing(null);
              }}
            >
              {closing?.commit
                ? "Close and commit"
                : closingIsCurrent
                  ? "Close without commit"
                  : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* The details window: one issue with its sub-issues, one level deep,
          in a window wide enough to read a hierarchy. It is a single window
          that is moved through, not a stack: a sub-issue's details button
          changes which issue it shows, and the path at the top goes back
          up. Its rows are the same rows as the list, so everything the list
          can do works here too. */}
      <Dialog
        open={detailsIssue !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
      >
        {/* A fixed, large size: the window is the same whether the issue has
            one sub-issue or fifty (the user's rule), so it does not jump
            about while moving through the hierarchy. The list scrolls
            inside it. */}
        <DialogContent className="flex h-[85vh] w-[min(64rem,92vw)] max-w-none flex-col">
          <DialogHeader>
            <DialogTitle>Issue details</DialogTitle>
            <DialogDescription asChild>
              <nav
                aria-label="Path to this issue"
                className="flex flex-wrap items-center gap-1 text-sm"
              >
                <button
                  type="button"
                  className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => setDetailsId(null)}
                >
                  All issues
                </button>
                {detailsPath.map((step, index) => (
                  <span key={step.id} className="flex items-center gap-1">
                    <Icon
                      name="ChevronRight"
                      className="size-3.5 text-muted-foreground"
                    />
                    {index === detailsPath.length - 1 ? (
                      <span className="text-foreground">{step.title}</span>
                    ) : (
                      <button
                        type="button"
                        className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline"
                        onClick={() => setDetailsId(step.id)}
                      >
                        {step.title}
                      </button>
                    )}
                  </span>
                ))}
              </nav>
            </DialogDescription>
          </DialogHeader>
          {detailsIssue === null ? null : (
            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
              <IssueRow
                // A fresh row per issue, so moving deeper does not carry the
                // previous issue's opened or folded state along.
                key={detailsIssue.id}
                issue={detailsIssue}
                actions={windowActions}
                nested
                isDetailsRoot
              />
            </ul>
          )}
          {/* The window's own new-issue field, fixed at its bottom like the
              panel's. Closed issues take no new sub-issues. */}
          {detailsIssue === null || detailsIssue.status === "closed" ? null : (
            <div className="shrink-0">
              <CreateIssue
                onCreate={(draft) =>
                  createIn(windowParent?.id ?? detailsIssue.id, draft)
                }
                parent={windowParent}
                onParentChange={setWindowParentId}
                parentChoices={[
                  detailsIssue,
                  ...[...descendantIds(detailsIssue.id)]
                    .map((id) => tree.byId.get(id))
                    .filter(
                      (issue): issue is Issue =>
                        issue !== undefined && issue.status !== "closed",
                    ),
                ]}
                focusRequest={focusWindowNewIssue}
                categories={categories}
                allowTopLevel={false}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* Bottom band, pinned: the field for a new issue. */}
      {ok ? (
        <div
          className="shrink-0 border-t border-border p-3"
          style={pinnedStyle}
        >
          <CreateIssue
            onCreate={(draft) =>
              createIn(newIssueParentOpen?.id ?? null, draft)
            }
            parent={newIssueParentOpen}
            onParentChange={setNewIssueParentId}
            parentChoices={(result?.issues ?? []).filter(
              (issue) => issue.status !== "closed",
            )}
            focusRequest={focusNewIssue}
            categories={categories}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the quick-reply buttons send, for their tooltips. The wording that is
 * actually sent is QUICK_REPLIES in server.ts; this is a copy because this
 * file is compiled for the browser and can only import types from there.
 */
const QUICK_REPLY_TEXT = {
  go: "Go ahead.",
  agree: "I agree with your recommendations. Go ahead.",
} as const;

/** How long the pointer must rest on the pill before its card opens. */
const HOVER_OPEN_MS = 2000;
/** How long a hover-opened card stays after the pointer leaves it. */
const HOVER_CLOSE_MS = 300;

/**
 * The thread a message-box control belongs to, or null when the message box
 * is not a thread's own (a queued-message editor, a side chat, the New
 * thread screen). The controls below draw nothing in that case.
 */
function useComposerThreadId(): string | null {
  const { scope } = useComposer();
  return scope.kind === "thread" ? scope.threadId : null;
}

/**
 * One quick-reply button in the message box (bead-bb-lit): a click sends the
 * thread's agent a fixed reply, so the user does not have to type "yes, go
 * ahead" after every plan.
 *
 * The message goes through server.ts, not through the message box, so text
 * the user has typed there stays untouched. Disabled while there is text
 * in the message box, and while the agent is
 * working or a send is under way: a go-ahead queued behind a running turn
 * would answer a question the agent has not asked yet.
 *
 * An icon with a tooltip, not a text button: the user asked for that, to
 * keep the message box's row quiet. The tooltip names the button and shows
 * the exact message, since an icon alone cannot say what will be sent.
 *
 * Side effects: one RPC per click, which sends a message to the thread; a
 * toast if that fails.
 */
function QuickReplyButton({
  kind,
  label,
  icon,
}: {
  kind: keyof typeof QUICK_REPLY_TEXT;
  /** The button's name, for the tooltip and for screen readers. */
  label: string;
  /** A BB icon name; an unknown one shows BB's fallback icon. */
  icon: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const threadId = useComposerThreadId();
  const { run, draft } = useComposerView();
  const [sending, setSending] = useState(false);
  // With something typed (or attached), the user is writing their own
  // answer; a quick reply would go out beside it and contradict it. The
  // user asked for the buttons to be off then.
  const typing = !draft.isEmpty || draft.attachmentCount > 0;
  if (threadId === null) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label={label}
      tip={`${label}: sends "${QUICK_REPLY_TEXT[kind]}"`}
      disabled={sending || typing || run.isRunning || run.isSubmitting}
      onClick={() => {
        setSending(true);
        rpc
          .call("thread_reply", { threadId, kind })
          .catch((cause: unknown) =>
            toast.error(
              `Could not send: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          )
          .finally(() => setSending(false));
      }}
    >
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

/**
 * The current-issue pill in the message box (bead-bb-prr): shows the title
 * of the issue this thread is working on; a click, or resting the pointer
 * on it for two seconds, opens a card with the issue's details
 * (CurrentIssueCard).
 *
 * Two ways of opening, two ways of closing. Opened by a click, the card
 * stays until a press outside it or Escape. Opened by hovering (the user
 * asked for this, with the two-second wait so that merely passing over the
 * pill does nothing), it goes away shortly after the pointer leaves both
 * the pill and the card; the short wait lets the pointer cross the gap
 * between them. Clicking while a hover-opened card is showing keeps it.
 *
 * Draws nothing when the thread has no current issue or the folder has no
 * beads: the play button in the Airbender tab stays the way to choose one
 * (the user's decision). It follows changes through useIssues, the same
 * loading and change notifications the tab uses.
 *
 * The card opens upwards, because the message box is at the bottom of the
 * window.
 */
function CurrentIssuePill({ threadId }: { threadId: string }) {
  const { result } = useIssues({ threadId, projectId: null });
  const { open, setOpen, root, panel } = useMenu();
  // Where the card goes, in window coordinates, worked out from the pill
  // when it is clicked. See CurrentIssueCard for why it is not simply
  // positioned against the pill.
  const [place, setPlace] = useState<CSSProperties>({});
  const pill = useRef<HTMLButtonElement>(null);
  // True while the card is open only because of hovering; a click clears it.
  const hoverOpened = useRef(false);
  // The pending "open after 2 s" and "close shortly after leaving" timers.
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  /** Works out where the card goes from where the pill is right now. */
  const placeCard = () => {
    const box = pill.current?.getBoundingClientRect();
    if (box === undefined) return;
    // Above the pill, left edges in line, but never off the right edge of
    // the window (the card is at most 24rem wide).
    const width = Math.min(384, window.innerWidth * 0.85);
    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      bottom: window.innerHeight - box.top + 8,
      // Never taller than the room above the pill; it scrolls inside.
      maxHeight: Math.max(160, box.top - 16),
    });
  };
  /** The pointer came onto the pill or the card. */
  const onEnter = () => {
    window.clearTimeout(closeTimer.current);
    if (open) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      hoverOpened.current = true;
      placeCard();
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  /** The pointer left the pill or the card. */
  const onLeave = () => {
    window.clearTimeout(openTimer.current);
    if (!hoverOpened.current) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      hoverOpened.current = false;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  // No timer may fire after the pill is gone.
  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const issue =
    result?.state === "ok" && result.currentBeadId !== null
      ? (result.issues.find(
          (candidate) => candidate.id === result.currentBeadId,
        ) ?? null)
      : null;
  if (issue === null || result === null) return null;
  const issues = result.issues;
  return (
    <div
      ref={root}
      className="relative min-w-0 shrink"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <Button
        ref={pill}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        tip={open ? undefined : `Current issue: ${issue.title}`}
        // Subtle on purpose (the user's request): no border, muted text, a
        // faint dot. It is a reminder, not a call to action.
        className="max-w-48 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
        onClick={() => {
          window.clearTimeout(openTimer.current);
          window.clearTimeout(closeTimer.current);
          if (open && hoverOpened.current) {
            // Already showing because of hovering: the click keeps it.
            hoverOpened.current = false;
            return;
          }
          hoverOpened.current = false;
          placeCard();
          setOpen((current) => !current);
        }}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-success/60" />
        <span className="truncate">{issue.title}</span>
      </Button>
      {open ? (
        <CurrentIssueCard
          panel={panel}
          place={place}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          issue={issue}
          parent={
            issue.parentId === null
              ? null
              : (issues.find((other) => other.id === issue.parentId) ?? null)
          }
          subIssues={issues.filter((other) => other.parentId === issue.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * The card the current-issue pill opens: what this thread is working on, at
 * a glance, without opening the Airbender tab.
 *
 * Top to bottom: a "Current issue" line with when it last changed; the
 * parent, when it is a sub-issue; the title; the id (click to copy) with
 * status, priority, type and category tags, drawn by the same IssueFacts
 * the tab uses so the two never disagree; the description as formatted
 * text; what "done" means, when the issue says; and its sub-issues with a
 * progress bar, closed ones struck through as in the tab.
 *
 * Read-only: changing the issue is the tab's job. Long text scrolls inside
 * its own block so the card keeps a bounded height above the message box.
 * It opens upwards because the message box sits at the bottom of the window.
 *
 * Drawn at the top level of the page (a portal), at a fixed place in the
 * window. The first version was positioned against the pill, inside the
 * message box, and the user saw nothing happen on a click: BB's message box
 * cuts off whatever sticks out of it. Content moved out like this loses the
 * plugin's styles unless it carries usePortalScopeProps().
 *
 * @param panel Ref for the card's element, so useMenu knows a press inside
 *   the card is not a press "outside".
 * @param place Fixed position and height limit, from the pill's position.
 * @param parent The issue this one is a sub-issue of, if any.
 * @param subIssues Direct sub-issues only, in the order the list gave them.
 */
function CurrentIssueCard({
  panel,
  place,
  onMouseEnter,
  onMouseLeave,
  issue,
  parent,
  subIssues,
}: {
  panel: React.RefObject<HTMLDivElement | null>;
  place: CSSProperties;
  /** Tell the pill the pointer is on / off the card (hover-opened cards). */
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  issue: Issue;
  parent: Issue | null;
  subIssues: Issue[];
}) {
  const closed = subIssues.filter((sub) => sub.status === "closed").length;
  const scopeProps = usePortalScopeProps();
  return createPortal(
    <div
      {...scopeProps}
      ref={panel}
      role="dialog"
      aria-label={`Current issue ${issue.id}`}
      style={place}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 w-96 max-w-[85vw] overflow-y-auto rounded-xl border border-border bg-popover text-left text-popover-foreground shadow-lg"
    >
      {/* A thin green line on top: the same colour the tab gives Current. */}
      <div className="h-0.5 bg-success/60" />
      <div className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-1.5 rounded-full bg-success" />
            Current issue
          </span>
          {issue.updatedAt === null ? null : (
            <span>Changed {formatWhen(issue.updatedAt)}</span>
          )}
        </div>
        {parent === null ? null : (
          <p className="truncate text-xs text-muted-foreground">
            Part of {parent.title}
          </p>
        )}
        <h4 className="text-base font-semibold leading-snug">{issue.title}</h4>
        <IssueFacts issue={issue} showStatus />
      </div>
      <div className="max-h-48 overflow-y-auto border-t border-border px-4 py-3">
        {issue.description.trim() === "" ? (
          <p className="text-sm text-muted-foreground">No description yet.</p>
        ) : (
          <Markdown content={issue.description} className="text-sm" />
        )}
      </div>
      {issue.acceptance.trim() === "" ? null : (
        <div className="max-h-32 overflow-y-auto border-t border-border px-4 py-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Done means
          </div>
          <Markdown content={issue.acceptance} className="text-sm" />
        </div>
      )}
      {subIssues.length === 0 ? null : (
        <div className="border-t border-border px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Sub-issues</span>
            <span>
              {closed} of {subIssues.length} closed
            </span>
          </div>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-success/70"
              style={{ width: `${(closed / subIssues.length) * 100}%` }}
            />
          </div>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm">
            {subIssues.map((sub) => (
              <li
                key={sub.id}
                className={cn(
                  "truncate",
                  sub.status === "closed" &&
                    "text-muted-foreground line-through",
                )}
              >
                {sub.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** The pill for whichever thread the message box belongs to, if any. */
function ComposerCurrentIssue() {
  const threadId = useComposerThreadId();
  return threadId === null ? null : <CurrentIssuePill threadId={threadId} />;
}

// Two registrations of the same tab: BB offers a different slot for an
// existing thread than for the New thread screen, and each hands the tab a
// different id to work from.
export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "issues",
    title: "Airbender",
    icon: "ListTodo",
    // "flush": the tab does its own scrolling so its top and bottom stay put.
    layout: "flush",
    component: ({ threadId }) => (
      <BeadsPanel scope={{ threadId, projectId: null }} />
    ),
  });
  app.slots.experimental_newThreadPanelAction({
    id: "issues",
    title: "Airbender",
    icon: "ListTodo",
    layout: "flush",
    component: ({ projectId }) => (
      <BeadsPanel scope={{ threadId: null, projectId }} />
    ),
  });
  // The main window's message box (bead-bb-3l4): the current-issue pill and
  // the two quick-reply buttons, in its row of controls. Threads only: on
  // the New thread screen there is no agent to answer and no current issue.
  // BB does not draw plugin controls here in its compact layout.
  app.composer.customize({
    id: "main-window",
    scopes: ["thread"],
    actions: [
      { id: "current-issue", component: ComposerCurrentIssue },
      {
        id: "reply-go",
        component: () => <QuickReplyButton kind="go" label="Go" icon="ArrowRight" />,
      },
      {
        id: "reply-agree",
        component: () => (
          <QuickReplyButton kind="agree" label="Agree & go" icon="Check" />
        ),
      },
    ],
  });
});
