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
import { WORKFLOW_IDS } from "../shared/workflows.ts";

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
   * The workflow step recorded on the issue (a state id from the workflow in
   * shared/), or null when none is. Kept in beads as a label `step:<id>`.
   * Read it through `stateOf`, which gives an issue without one the
   * workflow's first state.
   */
  step: z.string().nullable(),
  /**
   * The issue's size (a size id from the workflow in shared/): how much of
   * the workflow it takes. Null when nobody has sized it. Kept in beads as
   * a label `size:<id>`.
   */
  size: z.string().nullable(),
  /**
   * For an epic whose issues are worked on a branch of its own
   * (bead-bb-ty5.2): that branch. Null otherwise, and for a moment after
   * such an epic is started in a work tree, until the tree's branch is
   * known. Kept in beads as a label `branch:<name>`.
   */
  branch: z.string().nullable(),
  /**
   * The conversation Airbender opened for this issue in a work tree of its
   * own, while that conversation is still there; null otherwise. Not kept
   * in beads: the plugin remembers which conversations it opened. The tab
   * uses it to say that an epic lives in a parallel conversation, and to
   * go there.
   */
  conversationId: z.string().nullable(),
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
  /** The issue's labels, without the ones for its category and its step. */
  labels: z.array(z.string()),
  updatedAt: z.string().nullable(),
  /** When the issue was created (ISO); null when bd reported none. */
  createdAt: z.string().nullable(),
  /**
   * The issue's counterpart in another tracker, as beads keeps it: for a
   * GitHub issue its address, or `github:<number>`. Null when it has none.
   */
  externalRef: z.string().nullable(),
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
  /**
   * The home folder of the user the plugin's server runs as, so that the
   * tab can show a path inside it with "~" (bead-bb-ty5.3).
   */
  home: z.string(),
  /** Plain-language explanation for every state except "ok". */
  message: z.string().nullable(),
  issues: z.array(issueSchema),
  /**
   * Id of the issue this thread is working on, or null when none was chosen
   * (always null without a thread). Never names a closed issue: closing an
   * issue ends its time as current. May name an issue that no longer exists.
   */
  currentBeadId: z.string().nullable(),
  /**
   * Whether the folder is on a branch other than the repository's main one,
   * so that finished work will need merging as well as committing. False
   * when it is on the main branch, and when that cannot be told (not a git
   * folder, no branch checked out, no main branch found).
   */
  ownBranch: z.boolean(),
  /**
   * The branch the folder is on; null when it cannot be told or no branch
   * is checked out. Compared with an epic's `branch` to tell whether this
   * is the folder that epic's issues are worked in.
   */
  branch: z.string().nullable(),
  /**
   * Whether the folder is a work tree of its repository, not the
   * repository's main folder. False when that cannot be told.
   */
  workTree: z.boolean(),
  /**
   * Autopilot in this conversation (bead-bb-8ff): the epic it is on for,
   * or was last, whether it is on, and why it last turned itself off (null
   * when the owner turned it off or it never stopped). Null when the
   * conversation never had it, and without a conversation.
   */
  autopilot: z
    .object({
      epicId: z.string(),
      on: z.boolean(),
      reason: z.string().nullable(),
    })
    .nullable(),
  /**
   * Which workflow the folder's repository uses: "standard" (every issue
   * goes through its steps) or "simple" (no steps). The default when the
   * repository never chose, and when there is no folder.
   */
  workflow: z.enum(WORKFLOW_IDS),
});

export type IssuesResult = z.infer<typeof issuesResultSchema>;

/**
 * What is and is not in place for a folder, and what can be done about it.
 * The tab draws its setup panel, its suggestions and its "more" menu from
 * this one answer.
 */
/** One setup step of the issue sync, as the tab shows it. */
const syncStepSchema = z.object({
  label: z.string(),
  why: z.string(),
  explain: z.object({ lead: z.string(), points: z.array(z.string()) }),
});

/** One run of the issue sync, as the log keeps it (sync/types.ts). */
const syncEntrySchema = z.object({
  at: z.number(),
  seconds: z.number(),
  cause: z.enum(["timer", "change", "opened", "refresh"]),
  end: z.enum(["synced", "failed", "busy", "conflict", "stuck"]),
  message: z.string(),
  /** Issues changed here that this run sent; null when not known. */
  sent: z
    .array(
      z.object({
        id: z.string(),
        kinds: z.array(
          z.enum(["created", "updated", "closed", "deleted", "comment", "link"]),
        ),
      }),
    )
    .nullable(),
  /** Issues this run brought in; null when not known. */
  broughtIn: z.array(z.string()).nullable(),
});

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
    z.object({
      id: z.string(),
      label: z.string(),
      configured: z.boolean(),
      /**
       * Beads is set up for the agent, but the instructions it wrote into
       * this file no longer match what it would write now (its check says
       * "installed but stale"): the file's name, e.g. "AGENTS.md". Null
       * otherwise. Such an agent counts as configured; the instructions
       * can be updated.
       */
      stale: z.string().nullable(),
    }),
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
  /**
   * The setup steps the folder's issue sync offers now, each with the
   * words to show for it: `on` to start syncing issues that are synced
   * nowhere, `fetch` to get the issues of a folder that has none while its
   * remote holds them (a fresh clone), in place of starting empty. Null
   * for a step that does not apply. What they say and do is the sync
   * source's (sync/), not this plugin's: another tracker's differ.
   */
  syncSteps: z.object({ on: syncStepSchema.nullable(), fetch: syncStepSchema.nullable() }),
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
      /**
       * Read the issues anew, whatever the server has kept: set by the
       * refresh button and when the window comes back into focus.
       */
      fresh: z.boolean().optional(),
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
    // Cancel: closes the issue in beads without finishing it. Finishing goes
    // through the workflow (workflow_move). On the simple workflow this is
    // the one way to close, and it closes the open sub-issues too. If it was the thread's current
    // bead, that choice is cleared too.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
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
  workflow_run: {
    // Play: makes the issue the thread's current one and gets the agent
    // going on the step the issue is at. Only for a step that is the agent's.
    input: z.object({ threadId: z.string(), beadId: z.string() }),
    // `message` is null on success, else the reason in plain words.
    output: z.object({ message: z.string().nullable() }),
  },
  workflow_move: {
    // One of the user's moves in the workflow (approve, send back, skip,
    // accept, or reporting a step the agent finished). Refused when the
    // workflow does not allow it from the issue's present step.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      moveId: z.string(),
      /** Why: required by some moves, optional for the rest. */
      note: z.string().max(2000),
    }),
    // `warning` true: the message is a warning the user can act on (the
    // folder has uncommitted changes), to be shown in a message box, and
    // nothing was moved.
    // `openThreadId`: the move opened a conversation of its own for the
    // issue (a work tree start); the tab goes there. Null otherwise.
    output: z.object({
      message: z.string().nullable(),
      warning: z.boolean(),
      openThreadId: z.string().nullable(),
      // The move set an epic up to be worked issue by issue: the tab goes
      // into epic mode on it (in the conversation opened, when one was).
      enterEpic: z.boolean(),
    }),
  },
  issue_set_size: {
    // The user sets or changes an issue's size. Allowed until the work
    // reaches them for review. When the agent is already on the issue it is
    // told to take the new size's path.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
      size: z.string(),
    }),
    output: z.object({ message: z.string().nullable() }),
  },
  issue_request_sizing: {
    // The user asks for one issue to be sized now by the background agent.
    // Only for an open issue that has not been started.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      beadId: z.string(),
    }),
    // `message` is null when a worker was started or the issue queued.
    output: z.object({ message: z.string().nullable() }),
  },
  workflow_set: {
    // Chooses the workflow for the folder's repository. Its work trees
    // follow. Issues keep their steps; on "simple" they are only not shown.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      workflow: z.enum(WORKFLOW_IDS),
    }),
    output: z.object({ message: z.string().nullable() }),
  },
  github_issues: {
    // The GitHub issues of the folder's repository, open and closed, for
    // the "Sync with GitHub" window. `state` says what is missing when it is not
    // "ok": no folder, no GitHub remote, no token, or GitHub's refusal.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: z.object({
      state: z.enum(["ok", "unavailable", "no-repository", "no-token", "error"]),
      message: z.string().nullable(),
      /** "owner/name"; null when it could not be told. */
      repository: z.string().nullable(),
      issues: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          labels: z.array(z.string()),
          url: z.string(),
          closed: z.boolean(),
          /** The beads issue it is linked to; null when not in beads. */
          linkedId: z.string().nullable(),
        }),
      ),
      /** Every link the beads issues carry: issue id and GitHub number. */
      links: z.array(z.object({ id: z.string(), number: z.number() })),
      /** There are more issues on GitHub than were read. */
      truncated: z.boolean(),
    }),
  },
  github_sync: {
    // Runs beads' own `bd github sync` for the chosen issues: `pull` are
    // GitHub issue numbers to bring in, `both` beads ids of linked issues
    // to bring into step both ways, `push` beads ids to send. With
    // `preview` nothing is changed anywhere.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
      pull: z.array(z.number().int().positive()).max(500),
      both: z.array(z.string()).max(500),
      push: z.array(z.string()).max(500),
      prefer: z.enum(["newer", "github", "local"]),
      /**
       * Also copy the comments of the GitHub issues brought in (`pull`
       * and `both`) into their beads issues (bead-bb-apc).
       */
      comments: z.boolean(),
      preview: z.boolean(),
    }),
    // Started, not finished: `jobId` is what `github_sync_progress` is
    // asked about. Null with a `message` when nothing was started.
    output: z.object({
      jobId: z.string().nullable(),
      message: z.string().nullable(),
    }),
  },
  github_sync_progress: {
    // How a sync is getting on; `stop` asks it to finish the issues it is
    // on and start no more. When `done`, `message` is null if every run
    // worked, `actions` are what would be done (preview), and after a real
    // run the command's totals are in `notes`.
    input: z.object({ jobId: z.string(), stop: z.boolean() }),
    output: z.object({
      known: z.boolean(),
      done: z.boolean(),
      stopping: z.boolean(),
      total: z.number(),
      finished: z.number(),
      /** Which part is being done ("To GitHub"); null when none is. */
      doing: z.string().nullable(),
      seconds: z.number(),
      /** Comments copied from GitHub so far. */
      copied: z.number(),
      /** The last lines the command printed. */
      lines: z.array(z.string()),
      message: z.string().nullable(),
      actions: z.array(
        z.object({
          kind: z.enum(["import", "update-local", "create-remote", "update-remote"]),
          what: z.string(),
        }),
      ),
      notes: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
  },
  autopilot_set: {
    // Turns autopilot on for an epic in a conversation, or off (epicId
    // null). On: the epic's next ready issue is started whenever the
    // conversation is on none; every review stays the user's.
    input: z.object({ threadId: z.string(), epicId: z.string().nullable() }),
    output: z.object({ message: z.string().nullable() }),
  },
  current_set: {
    // Makes an open issue the thread's current one; beadId null releases
    // it. No workflow step is moved; the agent is told with a short note.
    input: z.object({ threadId: z.string(), beadId: z.string().nullable() }),
    output: z.object({ message: z.string().nullable() }),
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
  sync_status: {
    // How the folder's issues stand with their remote, in the sync layer's
    // words; nothing here names a tracker. `remote` null: they are synced
    // with nothing. `last` is the last sync run from here.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: z.object({
      /** The sync source's name; null when the folder has none. */
      source: z.string().nullable(),
      /** What the issues are synced with, in words; null when nothing. */
      remote: z.string().nullable(),
      running: z.boolean(),
      /** Syncing by itself has stopped until a sync asked for succeeds. */
      halted: z.boolean(),
      last: syncEntrySchema.nullable(),
      /** When the last sync that worked ended; null when none did. */
      syncedAt: z.number().nullable(),
    }),
  },
  sync_log: {
    // The syncs run from here for the folder's repository, newest first.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: z.object({ entries: z.array(syncEntrySchema) }),
  },
  sync_now: {
    // The owner asks for a sync now; it waits its turn behind a running one.
    input: z.object({
      threadId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
    output: z.object({ message: z.string().nullable() }),
  },
  thread_reply: {
    // The quick-reply button in the message box: sends the thread's agent
    // the fixed reply in QUICK_REPLIES.
    input: z.object({ threadId: z.string(), kind: z.enum(["agree"]) }),
    output: z.object({ sent: z.literal(true) }),
  },
});
