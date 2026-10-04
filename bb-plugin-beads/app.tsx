// bb-plugin-beads — frontend entry.
//
// What: the "Beads" tab in BB's right-hand panel. It lists the beads issues of
// the folder a thread works in, grouped by what you can do about them.
//
// Why: issues are most useful beside the agent doing the work, so the tab
// lives next to a thread (and on the New thread screen, to pick what to start).
//
// Design notes:
// - Three bands. Pinned at the top: Current (the bead this thread works on)
//   and a toolbar with the folder, the filter menu and refresh. In the middle,
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
import type { FormEvent, ReactNode } from "react";
import {
  Markdown,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  Issue,
  IssueComment,
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
    else if (issue.blockedBy.length > 0) find("blocked").issues.push(issue);
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

/** "Blocked by" / "Blocks" list inside an expanded issue. */
function RelatedIssues({
  label,
  issues,
}: {
  label: string;
  issues: Issue["blockedBy"];
}) {
  if (issues.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <ul className="mt-1 space-y-0.5">
        {issues.map((issue) => (
          <li key={issue.id} className="flex gap-2 text-xs">
            <span className="shrink-0 font-mono text-muted-foreground">
              {issue.id}
            </span>
            <span className="min-w-0">{issue.title}</span>
          </li>
        ))}
      </ul>
    </div>
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
      {showStatus ? (
        <Tag strong={issue.status === "in_progress"}>
          {issue.blockedBy.length > 0 && issue.status !== "closed"
            ? "blocked"
            : issue.status.replace("_", " ")}
        </Tag>
      ) : null}
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
      <RelatedIssues label="Blocked by" issues={issue.blockedBy} />
      <RelatedIssues label="Holds up" issues={issue.blocks} />
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
            onClick={() => setMoving(true)}
          >
            <Icon name="MoveTo" className="size-4" />
            Move to
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
            <Tag strong={issue.status === "in_progress"}>
              {issue.blockedBy.length > 0 && !closed
                ? "blocked"
                : issue.status.replace("_", " ")}
            </Tag>
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
}) {
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
      {collapsed || section.issues.length === 0 ? null : (
        <ul
          className={cn(
            "mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card",
            listClassName,
          )}
        >
          {section.issues.map((issue) => (
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
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    const reason = await onCreate({
      title: title.trim(),
      description,
      type: type === "" ? null : type,
      priority: priority === "" ? null : Number(priority),
      category,
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
          onChange={(event) => setTitle(event.target.value)}
          placeholder={
            parent === null
              ? "New issue — type a title and press Enter"
              : `New sub-issue of ${parent.id} — type a title and press Enter`
          }
          aria-label="New issue title"
        />
        <Button
          type="submit"
          size="sm"
          disabled={pending || title.trim() === ""}
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
}

const NO_FILTERS: Filters = { types: [], priorities: [], categories: [] };

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
  const key = path === null ? null : `bb-plugin-beads:filters:${path}`;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  useEffect(() => {
    if (key === null) return;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (typeof stored !== "object" || stored === null) {
        setFilters(NO_FILTERS);
        return;
      }
      const { types, priorities, categories } = stored as Record<
        string,
        unknown
      >;
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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
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
                onChange({ types: [], priorities: [], categories: [] })
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
        (section) => section.id !== "closed" && section.issues.length > 0,
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
          {ok ? (
            <FilterMenu
              filters={filters}
              onChange={setFilters}
              types={types}
              categories={categories}
            />
          ) : null}
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
            {openSections.length > 0 ? (
              openSections.map((section) => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  actions={actions}
                />
              ))
            ) : others.length === 0 ? null : (
              <Notice>
                {narrowed
                  ? "No open issues match the filter."
                  : "No open issues."}
              </Notice>
            )}
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

// Two registrations of the same tab: BB offers a different slot for an
// existing thread than for the New thread screen, and each hands the tab a
// different id to work from.
export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "issues",
    title: "Beads issues",
    icon: "ListTodo",
    // "flush": the tab does its own scrolling so its top and bottom stay put.
    layout: "flush",
    component: ({ threadId }) => (
      <BeadsPanel scope={{ threadId, projectId: null }} />
    ),
  });
  app.slots.experimental_newThreadPanelAction({
    id: "issues",
    title: "Beads issues",
    icon: "ListTodo",
    layout: "flush",
    component: ({ projectId }) => (
      <BeadsPanel scope={{ threadId: null, projectId }} />
    ),
  });
});
