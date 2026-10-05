// server/contract.ts — the typed boundary between the two halves.
//
// What: the zod schemas for issues, comments, links, the list result and the
// setup status, the RPC contract built from them, and the types derived from
// them.
//
// Why: the frontend and the backend agree on shapes through this one file. The
// backend registers handlers for the contract; the frontend imports its types.
//
// Gotchas:
// - The frontend may import TYPES from here and nothing else: a value import
//   would bundle zod and the server SDK into the browser.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ISSUE_TYPES, LINK_KINDS, SETUP_ACTIONS } from "../shared/constants.ts";

const issueRefSchema = z.object({ id: z.string(), title: z.string() });

/**
 * One link between this issue and another, as beads stores it.
 *
 * `kind` is beads' dependency type, passed through as is (it may be one this
 * plugin does not list). `direction` says which end this issue is: "out"
 * when the link is stored on this issue and points at the other ("this issue
 * is blocked by the other"), "in" when it is stored on the other and points
 * here. `closed` is the other issue's state, so the tab can strike it out.
 */
const issueLinkSchema = z.object({
  kind: z.string(),
  direction: z.enum(["out", "in"]),
  id: z.string(),
  title: z.string(),
  closed: z.boolean(),
});

export type IssueLink = z.infer<typeof issueLinkSchema>;

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  /** How the issue is to be built and why; "" when beads has none. */
  design: z.string(),
  /** What "done" means; "" when beads has none. */
  acceptance: z.string(),
  /** Free-text notes appended over time; "" when beads has none. */
  notes: z.string(),
  /** Why the issue was closed; "" for open issues or when none was given. */
  closeReason: z.string(),
  /**
   * How many comments the issue has. The comments themselves are fetched
   * separately (issue_comments), because bd lists only their count.
   */
  commentCount: z.number(),
  /**
   * Id of the issue this one is a sub-issue of, or null for a top-level
   * issue. Any issue can hold sub-issues, to any depth; the tab builds the
   * tree from this one field.
   */
  parentId: z.string().nullable(),
  /**
   * Id of the hidden worker thread that is defining this issue right now,
   * or null. Known only to the running plugin: it is forgotten when the
   * plugin reloads, which costs the "in progress" mark, not the work.
   */
  defineThreadId: z.string().nullable(),
  status: z.string(),
  /** 0 (most urgent) to 4; null when bd reported none. */
  priority: z.number().nullable(),
  type: z.string().nullable(),
  assignee: z.string().nullable(),
  /**
   * The issue's category, or null when it has none. One per issue. Kept in
   * beads as a label of the form `category:<name>` (see CATEGORY_PREFIX).
   */
  category: z.string().nullable(),
  /** The issue's labels, without the one that carries its category. */
  labels: z.array(z.string()),
  updatedAt: z.string().nullable(),
  /**
   * Unfinished issues this one waits on. Empty for closed issues. Includes
   * what the issues it sits inside wait on: a sub-issue of a blocked issue
   * is blocked too, which is beads' own rule (`bd blocked` lists it).
   */
  blockedBy: z.array(issueRefSchema),
  /**
   * True for an open issue that has open sub-issues, every one of which is
   * blocked: there is nothing in it that can be worked on. The tab treats
   * such an issue as blocked. This is the tab's reading, at the user's
   * request; beads itself still calls the issue ready, and nothing is
   * written to beads for it.
   */
  subIssuesBlocked: z.boolean(),
  /** Unfinished issues waiting on this one. */
  blocks: z.array(issueRefSchema),
  /**
   * Every link between this issue and another, of any kind except
   * parent-child, in both directions, whatever the other issue's status.
   * This is what the opened issue shows; `blockedBy` and `blocks` above stay
   * as the narrower "what is in the way right now" used for grouping.
   */
  links: z.array(issueLinkSchema),
});

export type Issue = z.infer<typeof issueSchema>;

/** One comment on an issue, oldest first in every list. */
const commentSchema = z.object({
  id: z.string(),
  author: z.string(),
  /** ISO timestamp, or "" when bd reported none. */
  createdAt: z.string(),
  text: z.string(),
});

export type IssueComment = z.infer<typeof commentSchema>;

const issuesResultSchema = z.object({
  /**
   * ok — `issues` is the full list for `path`.
   * no-beads — the folder exists but has no beads database.
   * unavailable — there is no folder on this machine to look in.
   * no-bd — the beads program is not on this machine. Its own state, apart
   *   from "error", so the tab can offer to install it (bead-bb-80e).
   * error — bd failed; `message` says why.
   */
  state: z.enum(["ok", "no-beads", "no-bd", "unavailable", "error"]),
  /** Folder bd ran in; null when none could be resolved. */
  path: z.string().nullable(),
  /** Plain-language explanation for every state except "ok". */
  message: z.string().nullable(),
  issues: z.array(issueSchema),
  /**
   * Id of the issue this thread is working on, or null when none was chosen
   * (always null without a thread). Never names a closed issue: closing an
   * issue ends its time as current. May name an issue that no longer exists.
   */
  currentBeadId: z.string().nullable(),
});

export type IssuesResult = z.infer<typeof issuesResultSchema>;

/**
 * What is and is not in place for a folder, and what can be done about it.
 * The tab draws its setup panel, its suggestions and its "more" menu from
 * this one answer.
 */
const setupStatusSchema = z.object({
  /** The folder, or null when there is none on this machine. */
  path: z.string().nullable(),
  /** Why nothing can be set up (no folder here); null when setup applies. */
  unavailable: z.string().nullable(),
  /** Whether the beads program was found. */
  bdInstalled: z.boolean(),
  /**
   * The ways to install beads that this machine has the tools for. `command`
   * is shown to the user before it is run, so nothing runs unseen.
   */
  installMethods: z.array(
    z.object({ id: z.string(), label: z.string(), command: z.string() }),
  ),
  /** Whether the folder has a beads issue database. */
  folderReady: z.boolean(),
  /**
   * The coding agents beads can be configured for here, and whether it is.
   * Empty until beads is installed and the folder is set up, because the
   * check is beads' own (`bd setup <agent> --check`).
   */
  agents: z.array(
    z.object({ id: z.string(), label: z.string(), configured: z.boolean() }),
  ),
  /**
   * Whether Airbender's rules are in place: in the folder's AGENTS.md, with
   * CLAUDE.md pointing at it.
   */
  rulesPresent: z.boolean(),
  /** The setup action running in a terminal for this folder right now. */
  running: z
    .object({ action: z.enum(SETUP_ACTIONS), title: z.string() })
    .nullable(),
  /**
   * How the last terminal run for this folder ended, until the next one
   * starts: its exit code (0 is success; null when it could not be read)
   * and the last lines it printed, so a failure can be read in the tab even
   * if the terminal was never looked at.
   */
  lastRun: z
    .object({
      action: z.enum(SETUP_ACTIONS),
      title: z.string(),
      exitCode: z.number().nullable(),
      tail: z.string(),
    })
    .nullable(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

// Both schemas run at the wire boundary; app.tsx imports only the types.
export const rpcContract = defineRpcContract({
  issues_list: {
    // The tab passes whichever it has: a thread tab knows its thread, the
    // new-thread screen only knows the selected project.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: issuesResultSchema,
  },
  issue_create: {
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      title: z.string().trim().min(1).max(500),
      description: z.string().max(20_000),
      /** One of beads' issue types; null uses beads' default (task). */
      type: z.enum(ISSUE_TYPES).nullable(),
      /** 0 (most urgent) to 4; null uses beads' default (2). */
      priority: z.number().int().min(0).max(4).nullable(),
      /** Create it as a sub-issue of this issue; null for a top-level one. */
      parentId: z.string().nullable(),
      /**
       * Category for the new issue. Null means "not chosen": a sub-issue
       * then takes its parent's category, a top-level issue gets none.
       */
      category: z.string().nullable(),
    }),
    // `id` is set on success; `message` explains a failure in plain words.
    output: z.object({ id: z.string().nullable(), message: z.string().nullable() }),
  },
  issue_comments: {
    // Fetched per issue, when it is opened: bd needs one run per issue for
    // comments, which would be too slow to do for the whole list.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({
      comments: z.array(commentSchema),
      message: z.string().nullable(),
    }),
  },
  issue_close: {
    // Closes the issue in beads. If it was the thread's current bead, that
    // choice is cleared too, since a finished issue is no longer worked on.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      /**
       * Also ask the thread's agent to commit this issue's work. Ignored
       * without a thread, since there is then no agent to ask.
       */
      commit: z.boolean(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_define: {
    // Starts a background agent (a hidden worker thread) that defines the
    // issue (writes up what is wanted, acceptance criteria and a design), so
    // the thread the user is working in is not interrupted. The button was
    // called "Flesh out" until the user renamed it to "Define".
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    // `threadId` is the new thread on success; `message` the reason if not.
    output: z.object({
      threadId: z.string().nullable(),
      message: z.string().nullable(),
    }),
  },
  issue_link: {
    // Adds a link of one of beads' kinds, stored on `fromId` and pointing at
    // `toId` ("fromId is blocked by toId"). "related" has no direction.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      fromId: z.string(),
      toId: z.string(),
      kind: z.enum(LINK_KINDS),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_unlink: {
    // Removes the link stored on `fromId` that points at `toId`. `kind` is
    // the link's beads type as listed; it decides which bd command undoes it.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      fromId: z.string(),
      toId: z.string(),
      kind: z.string(),
    }),
    output: z.object({ message: z.string().nullable() }),
  },
  issue_set_category: {
    // Sets an issue's category (replacing any it has) or, with null, clears
    // it.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      category: z.string().nullable(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_set_parent: {
    // Moves an issue inside another issue (parentId set) or out to the top
    // level (parentId null). Refused when it would put an issue inside
    // itself or inside one of its own sub-issues.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      parentId: z.string().nullable(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_update: {
    // Changes any of an issue's type, priority, title and description; a
    // null field is left as is. An empty description is a value, not "leave
    // as is": it clears the description.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      type: z.enum(ISSUE_TYPES).nullable(),
      priority: z.number().int().min(0).max(4).nullable(),
      title: z.string().trim().min(1).max(500).nullable(),
      description: z.string().max(20_000).nullable(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  issue_reopen: {
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    output: z.object({ message: z.string().nullable() }),
  },
  current_start: {
    // The play button: makes the bead the thread's current one and sends the
    // thread's agent the message that starts work on it (see workRequest).
    input: z.object({ threadId: z.string(), beadId: z.string() }),
    output: z.object({ currentBeadId: z.string() }),
  },
  current_set: {
    // beadId null clears the thread's current bead.
    input: z.object({ threadId: z.string(), beadId: z.string().nullable() }),
    output: z.object({ currentBeadId: z.string().nullable() }),
  },
  setup_status: {
    // What is in place for the folder and what could be set up.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: setupStatusSchema,
  },
  setup_run: {
    // Starts one setup action. `option` picks the install method (for
    // "install") or the agent (for "agent"); null otherwise. Install, folder
    // setup and agent setup run in a visible BB terminal; the rules are
    // written straight into AGENTS.md.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      action: z.enum(SETUP_ACTIONS),
      option: z.string().nullable(),
    }),
    // `message` is null when the action was started (or, for the rules,
    // done), else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  thread_reply: {
    // The quick-reply buttons in the message box: sends the thread's agent
    // one of the fixed replies in QUICK_REPLIES.
    input: z.object({ threadId: z.string(), kind: z.enum(["go", "agree"]) }),
    output: z.object({ sent: z.literal(true) }),
  },
});
