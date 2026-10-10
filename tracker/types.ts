// tracker/types.ts — the one shape every issue tracker is seen through.
//
// What: the common description of an issue, of the operations a tracker must
// offer (the Tracker interface), of what a tracker can and cannot hold
// (Capabilities), and the three kinds of failure.
//
// Why: the owner wants agents to work on issues without knowing whether they
// live in beads, GitHub or Linear ("the agent doesn't have to think twice"),
// and wants this layer free of BB so it can move to a standalone program.
// Everything above this file (the `bend` command today, the Airbender tab
// later) talks only in these terms; everything below it is an adapter for
// one tracker.
//
// Design notes:
// - The written parts of an issue are named for the owner's way of working
//   (description, requirements, done, plan, notes), not for any tracker's
//   fields. Each adapter decides where a part is kept, and says so in its
//   capabilities when that is not a field of its own.
// - Failures are thrown as one of three classes, which the command turns
//   into its exit status: Refused (1), UsageError (2), Unsupported (3).
//   "The tracker cannot do this" is kept apart from "you asked wrongly" so
//   an agent can adapt instead of retrying.
// - Three kinds of link are common to every tracker (LINK_KINDS). A tracker
//   may accept kinds of its own as well; it names them in its capabilities,
//   and answers Unsupported for any other.
// - Two refusals have a class of their own, NoProgram and NotSetUp, because
//   a caller with a screen (the Airbender tab) offers a different way out of
//   each. A command-line caller needs no change: both are still Refused.
//
// Gotchas:
// - This file must stay free of imports from the plugin, from BB and from
//   any tracker. It is types and three small classes, nothing else.

/** The written parts of an issue that `write` can replace. */
export const PARTS = [
  "description",
  "requirements",
  "done",
  "plan",
  "notes",
] as const;
export type Part = (typeof PARTS)[number];

/** The kinds of link every tracker can add; see the header. */
export const LINK_KINDS = ["blocked-by", "discovered-from", "related"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** A short pointer to another issue. */
export interface IssueRef {
  id: string;
  title: string;
  /** The other issue's status, as the tracker names it; "closed" when done. */
  status: string;
}

/**
 * One link between an issue and another.
 *
 * `direction` says which end this issue is: "out" when the statement is
 * about this issue ("this issue is blocked by the other"), "in" when it is
 * about the other ("the other is blocked by this one"). A link with no
 * direction, such as "related", is always "out".
 */
export interface Link extends IssueRef {
  /** One of LINK_KINDS, or a kind of the tracker's own, shown as it is. */
  kind: string;
  direction: "out" | "in";
}

/** An issue, in the shape that is the same for every tracker. */
export interface Issue {
  id: string;
  title: string;
  /** "open", "in_progress", "closed", or another status of the tracker's. */
  status: string;
  type: string | null;
  /** 0 (most urgent) to 4; null when the tracker holds none. */
  priority: number | null;
  category: string | null;
  assignee: string | null;
  /** The issue this one is a sub-issue of; null at the top level. */
  parentId: string | null;
  /** What is wanted and why. */
  description: string;
  /** The agreed requirements; "" when none are written. */
  requirements: string;
  /** What "done" means. */
  done: string;
  /** How it is to be built. */
  plan: string;
  notes: string;
  /** Why it was closed; "" for an open issue or when no reason was given. */
  closeReason: string;
  /** Labels other than the ones the adapter uses to hold a field. */
  labels: string[];
  links: Link[];
  /** Direct sub-issues. */
  subIssues: IssueRef[];
  /** Unfinished issues this one waits for, its own or its parents'. */
  blockedBy: IssueRef[];
  commentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One comment on an issue. */
export interface Comment {
  id: string;
  author: string;
  createdAt: string;
  text: string;
}

/** What `list` can narrow by; a field left out does not narrow. */
export interface ListFilter {
  /** A status, or "all" to include closed issues. Open ones by default. */
  status?: string;
  type?: string;
  priority?: number;
  category?: string;
  assignee?: string;
  /** Only the direct sub-issues of this issue. */
  parentId?: string;
}

/** What a new issue is created from. */
export interface Draft {
  title: string;
  description?: string;
  done?: string;
  type?: string;
  priority?: number;
  /** Inherited from the parent when left out. */
  category?: string;
  parentId?: string;
  /** The issue this one was discovered while working on. */
  from?: string;
  blockedBy?: string[];
}

/** What `edit` can change; a field left out is left as it is. */
export interface Changes {
  title?: string;
  type?: string;
  priority?: number;
  /** null removes the category. */
  category?: string | null;
  /** null removes the assignee. */
  assignee?: string | null;
  /**
   * Labels to add and to take away, as they are; one already there, or
   * already gone, is left alone. For a caller that keeps something of its
   * own on an issue (the tab's workflow step is the label `step:<id>`).
   */
  addLabels?: string[];
  removeLabels?: string[];
}

/**
 * How well a tracker holds one thing: "yes" as a field of its own,
 * "another way" with a note saying where, or "no".
 */
export interface Support {
  name: string;
  level: "yes" | "another way" | "no";
  /** Where it is kept, or why it is not available; "" for a plain yes. */
  note: string;
}

/** What `status` reports about a repository's tracker. */
export interface Capabilities {
  /** The tracker's name, e.g. "beads". */
  tracker: string;
  /** One line on which tracker instance this is, e.g. its folder. */
  where: string;
  supports: Support[];
  /**
   * Every kind of link `link` accepts here: the common ones this tracker
   * can hold, then kinds of its own.
   */
  linkKinds: string[];
  /** Things worth knowing that are not about a single feature. */
  warnings: string[];
}

/**
 * The operations every tracker adapter offers.
 *
 * Every method rejects with Refused when the tracker says no (an unknown id,
 * a move into itself), with Unsupported when the tracker has no way to do
 * it, and resolves otherwise. `actor` on the adapter, not here, says who is
 * acting.
 */
export interface Tracker {
  capabilities(): Promise<Capabilities>;
  list(filter: ListFilter): Promise<Issue[]>;
  /** Issues that can be worked on now, by the tracker's own definition. */
  ready(): Promise<Issue[]>;
  show(id: string): Promise<Issue>;
  comments(id: string): Promise<Comment[]>;
  search(text: string): Promise<Issue[]>;
  /** @returns The new issue's id. */
  create(draft: Draft): Promise<string>;
  edit(id: string, changes: Changes): Promise<void>;
  /** Replaces one written part; an empty text clears it. */
  write(id: string, part: Part, text: string): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  /** Marks an issue as being worked on by the actor. */
  start(id: string): Promise<void>;
  close(id: string, reason?: string): Promise<void>;
  reopen(id: string): Promise<void>;
  /** Puts an issue under a parent, or with null back at the top level. */
  move(id: string, parentId: string | null): Promise<void>;
  /**
   * Records "`id` <kind> `otherId`", e.g. id is blocked by otherId.
   *
   * @param kind One of the tracker's `linkKinds`; Unsupported otherwise.
   */
  link(id: string, otherId: string, kind: string): Promise<void>;
  /**
   * Removes whatever link there is between the two, in either direction.
   *
   * @param onlyFrom Remove only the link recorded on `id` that points at
   *   `otherId`, and leave one recorded the other way round. For a caller
   *   that shows the two as separate links.
   */
  unlink(id: string, otherId: string, onlyFrom?: boolean): Promise<void>;
}

/** The tracker, or a rule of this layer, said no. The message says why. */
export class Refused extends Error {
  override name = "Refused";
}

/** The tracker's own program is not installed on this machine. */
export class NoProgram extends Refused {
  override name = "NoProgram";
}

/** The folder has no tracker in it, or the one it has holds no issues yet. */
export class NotSetUp extends Refused {
  override name = "NotSetUp";
}

/** The request itself was wrong: a missing argument, an unknown option. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** This repository's tracker has no way to do what was asked. */
export class Unsupported extends Error {
  override name = "Unsupported";
}
