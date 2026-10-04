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
// - Filters (types, priorities) hide rows; they never regroup and never hide
//   Current. They are remembered per folder in the browser.
// - The Closed group's heading is always shown, last in the list, with its
//   count and a Show/Hide button; its issues start hidden every time the
//   tab opens.
// - The tab can create, close and reopen issues, change an issue's type
//   and priority in place, and mark which bead a thread is working on (a
//   note kept in BB, not in beads). It cannot edit an issue's text or
//   delete one.
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
import { cn } from "@/lib/utils";

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
   * Starts a background agent that defines the issue. Does nothing
   * visible here beyond the row showing that it is under way.
   */
  define: (beadId: string) => void;
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
      aria-label={`Define ${issue.id} with a background agent`}
      onClick={() => actions.define(issue.id)}
    >
      <Icon name="MessageSquare" className="size-4" />
      {iconOnly ? null : "Define"}
    </Button>
  );
}

/** Priority, type and similar small facts about an issue, on one line. */
function IssueFacts({
  issue,
  onEdit,
}: {
  issue: Issue;
  /** When given, priority and type become small dropdowns that call this. */
  onEdit?: IssueActions["edit"];
}) {
  // The current type is always offered, even if it is one this plugin does
  // not otherwise list (beads has more types than the new-issue form).
  const typeChoices: string[] =
    issue.type === null || (ISSUE_TYPES as readonly string[]).includes(issue.type)
      ? [...ISSUE_TYPES]
      : [issue.type, ...ISSUE_TYPES];
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs text-muted-foreground">
        {issue.id}
      </span>
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

/** Everything shown when an issue is opened: text, relations, actions. */
function IssueDetails({
  issue,
  actions,
}: {
  issue: Issue;
  actions: IssueActions;
}) {
  const closed = issue.status === "closed";
  return (
    <div className="space-y-3">
      {issue.description.trim() === "" ? (
        <p className="text-xs text-muted-foreground">No description.</p>
      ) : (
        <Markdown content={issue.description} className="text-sm" />
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
      <div className="flex flex-wrap gap-2">
        {closed ? null : (
          <DefineButton issue={issue} actions={actions} />
        )}
        {/* The current bead's "drop it" action lives here, out of the way,
            instead of on the row beside "Close & commit". */}
        {closed || actions.currentBeadId !== issue.id ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
            Close without commit
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * One issue: a compact line that opens to show its details. Whether it is
 * open is kept in the row, so it resets when the tab is closed.
 */
function IssueRow({
  issue,
  actions,
  detailsClassName,
}: {
  issue: Issue;
  actions: IssueActions;
  /** Extra classes for the opened area, e.g. a height cap for pinned rows. */
  detailsClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const closed = issue.status === "closed";
  return (
    <li>
      <div className="flex items-start hover:bg-state-hover">
        {/* The chevron and the title both open the issue. They are two
            separate buttons with the facts line outside them, because the
            priority and type dropdowns on that line are controls of their
            own and may not sit inside a button. */}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          onClick={() => setOpen((current) => !current)}
          className="cursor-pointer py-2 pl-3 pr-2"
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
        </button>
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
          <IssueFacts issue={issue} onEdit={closed ? undefined : actions.edit} />
        </div>
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
        {closed ? (
          <Button
            variant="ghost"
            size="icon"
            className="m-1 size-7 shrink-0"
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
            aria-label={`Close ${issue.id}: ${issue.title}`}
            onClick={() => actions.close(issue.id, false)}
          >
            <Icon name="CircleX" className="size-4" />
          </Button>
        )}
      </div>
      {open ? (
        <div
          className={cn(
            "border-t border-border px-3 py-3 pl-9",
            detailsClassName,
          )}
        >
          <IssueDetails issue={issue} actions={actions} />
        </div>
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
}: {
  section: Section;
  actions: IssueActions;
  headerActions?: ReactNode;
  detailsClassName?: string;
  /** Show only the heading line (with its count), not the issues. */
  collapsed?: boolean;
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
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {section.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              actions={actions}
              detailsClassName={detailsClassName}
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
    <Button variant="ghost" size="sm" onClick={() => setCurrent(null)}>
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
        // instead of covering the list below.
        detailsClassName="max-h-[33vh] overflow-y-auto"
        headerActions={
          <>
            <DefineButton issue={issue} actions={actions} />
            {clear}
          </>
        }
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
}: {
  onCreate: (draft: {
    title: string;
    description: string;
    type: IssueType | null;
    priority: number | null;
  }) => Promise<string | null>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Empty string = "let beads decide" (task, priority 2).
  const [type, setType] = useState<IssueType | "">("");
  const [priority, setPriority] = useState("");
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
    });
    setPending(false);
    setProblem(reason);
    if (reason !== null) return;
    setTitle("");
    setDescription("");
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          Could not create the issue: {problem}
        </p>
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
          aria-label={more ? "Hide type, priority and description" : "Add type, priority and description"}
          onClick={() => setMore((current) => !current)}
        >
          <Icon
            name={more ? "ChevronUp" : "ChevronRight"}
            className="size-4 text-muted-foreground"
          />
        </Button>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="New issue — type a title and press Enter"
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
}

const NO_FILTERS: Filters = { types: [], priorities: [] };

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
      const { types, priorities } = stored as Record<
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
 * The Filter button and its menu: types and priorities.
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
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  types: string[];
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
  const narrowing = filters.types.length + filters.priorities.length;
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
          <p className="px-2 text-xs text-muted-foreground">
            Nothing ticked under Type or Priority shows all of them.
          </p>
          {narrowing === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => onChange({ ...filters, types: [], priorities: [] })}
            >
              Clear type and priority
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
  const others = useMemo(
    () =>
      result?.state === "ok"
        ? result.issues.filter((issue) => issue.id !== currentIssue?.id)
        : [],
    [result, currentIssue],
  );
  // Types offered in the filter menu: those that actually occur here.
  const types = useMemo(
    () =>
      [
        ...new Set(others.flatMap((issue) => (issue.type ? [issue.type] : []))),
      ].sort(),
    [others],
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
            filters.priorities.includes(issue.priority))),
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
  const narrowed = filters.types.length + filters.priorities.length > 0;
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
    define: (beadId) => {
      rpc.call("issue_define", { threadId, projectId, beadId }).then(
        (outcome) => {
          setActionProblem(outcome.message);
          refresh();
        },
        reportProblem,
      );
    },
    edit: (beadId, change) => {
      rpc
        .call("issue_update", {
          threadId,
          projectId,
          beadId,
          type: change.type ?? null,
          priority: change.priority ?? null,
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
  const create = useCallback(
    async (draft: {
      title: string;
      description: string;
      type: IssueType | null;
      priority: number | null;
    }) => {
      try {
        const created = await rpc.call("issue_create", {
          threadId,
          projectId,
          ...draft,
        });
        refresh();
        return created.message;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    },
    [rpc, threadId, projectId, refresh],
  );
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
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
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
      <div
        ref={scroller}
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
      {/* Bottom band, pinned: the field for a new issue. */}
      {ok ? (
        <div
          className="shrink-0 border-t border-border p-3"
          style={pinnedStyle}
        >
          <CreateIssue onCreate={create} />
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
