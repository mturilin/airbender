// tracker/github.ts — the adapter for GitHub issues.
//
// What: implements the Tracker interface on top of a GitHubClient
// (github-api.ts): turns a GitHub issue into the common Issue shape and
// each operation into the calls GitHub needs.
//
// Why: the owner wants an agent to run the same `bend` commands whether a
// repository's issues are in beads or on GitHub (bead-bb-c9l.1). GitHub is
// the first hosted tracker, and the first test of whether the common shape
// holds for one that is not beads. Everything that decides where a thing
// is kept on GitHub lives in this one file.
//
// Design notes:
// - Where things are kept. GitHub's own: title, description, comments,
//   assignee, open and closed, sub-issues, and "blocked by". As labels:
//   type (`type:<name>`), priority (`priority:<0-4>`), category
//   (`category:<name>`, the same convention as with beads) and "in
//   progress" (`in-progress`, on an open issue). GitHub makes a label the
//   first time it is applied. As marked sections at the end of the
//   description (see parts.ts): requirements, done, plan, notes.
// - "Discovered from" and "related" do not exist on GitHub. They are kept
//   as lines of a marked "Links" section, written on BOTH issues, so that
//   showing either one needs no search: GitHub's search is limited to
//   about thirty a minute and runs behind by up to minutes.
// - A hosted tracker is slow and counted (5,000 requests an hour), so
//   nothing here reads the whole list unless a list was asked for. An
//   operation on one issue fetches that issue, and the others it names.
//   This is the opposite of the beads adapter, where one local read of
//   everything is the cheapest thing there is.
// - What an issue waits for: its own unfinished blockers and those of the
//   open issues it sits inside, as with beads. The parents come with the
//   issue in the same request (four levels; see github-api.ts).
// - GitHub does everything as the signed-in account and cannot act as
//   another name. `start` assigns the issue to that account. A comment
//   written as someone else (`actor`, bend's --as) opens with that name,
//   so a hand-over or a decision still says which agent wrote it, and is
//   read back with that name as its author.
// - Closing with a reason adds the reason as a comment that begins
//   "Closed:", because GitHub's own reason is one of a few fixed words.
//
// Gotchas:
// - Sections and links live in the description, which is read, changed and
//   written back. Two writers within the same moment can overwrite each
//   other. Accepted for now; the cache layer has to deal with it anyway.
// - A person may edit the description on github.com. A removed marker
//   turns that section's text into description; nothing is lost.
// - An issue id is GitHub's number, as text ("12"); "#12" is accepted.
//   Issues of another repository cannot be named.

import type {
  GhChanges,
  GhIssue,
  GhParent,
  GhRef,
  GitHubClient,
} from "./github-api.ts";
import {
  cleanCategory,
  formatTextLinks,
  joinSections,
  parseTextLinks,
  splitSections,
  type TextLink,
} from "./parts.ts";
import {
  LINK_KINDS,
  Refused,
  Unsupported,
  type Capabilities,
  type Changes,
  type Comment,
  type Draft,
  type Issue,
  type IssueRef,
  type Link,
  type ListFilter,
  type Part,
  type Tracker,
} from "./types.ts";

/** The label prefixes that hold a field GitHub has none for. */
const TYPE_PREFIX = "type:";
const PRIORITY_PREFIX = "priority:";
const CATEGORY_PREFIX = "category:";
/** The label on an open issue that is being worked on. */
const IN_PROGRESS = "in-progress";

/** The marked sections of a description, in the order they are written. */
const SECTIONS = [
  ["requirements", "Requirements"],
  ["done", "Done when"],
  ["plan", "Plan"],
  ["notes", "Notes"],
  ["links", "Links"],
] as const;

/** A description taken apart into what `bend` calls its parts. */
export interface Parts {
  description: string;
  requirements: string;
  done: string;
  plan: string;
  notes: string;
  /** The links GitHub has no place for; see the header. */
  links: TextLink[];
}

/** Takes a GitHub description apart. Pure; the opposite of joinBody. */
export function splitBody(body: string): Parts {
  const { rest, sections } = splitSections(
    body,
    SECTIONS.map(([name]) => name),
  );
  return {
    description: rest,
    requirements: sections.requirements ?? "",
    done: sections.done ?? "",
    plan: sections.plan ?? "",
    notes: sections.notes ?? "",
    links: parseTextLinks(sections.links ?? ""),
  };
}

/** Puts the parts back into one GitHub description. Pure. */
export function joinBody(parts: Parts): string {
  const text: Record<string, string> = {
    requirements: parts.requirements,
    done: parts.done,
    plan: parts.plan,
    notes: parts.notes,
    links: formatTextLinks(parts.links),
  };
  return joinSections(
    parts.description,
    SECTIONS.map(([name, heading]) => ({
      name,
      heading,
      text: text[name] ?? "",
    })),
  );
}

/** How a comment written as someone else opens; see the header. */
const AS_OPEN = /^<!-- bend:as (.+?) -->\n\*\*.*?:\*\*\n\n/u;

/** The text of a comment written as `name`, who is not the signed-in account. */
export function signComment(name: string, text: string): string {
  // The name sits inside an HTML comment and on a line of its own.
  const safe = name.replace(/-->|[\r\n]/gu, " ").trim();
  return `<!-- bend:as ${safe} -->\n**${safe}:**\n\n${text}`;
}

/** A comment's author and text, with a signed opening taken off again. */
export function readComment(
  author: string,
  body: string,
): { author: string; text: string } {
  const signed = AS_OPEN.exec(body);
  return signed === null
    ? { author, text: body }
    : { author: signed[1]!, text: body.slice(signed[0].length) };
}

/** The one label with a prefix, without the prefix; "" when there is none. */
const labelValue = (labels: string[], prefix: string) =>
  labels
    .find((label) => label.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? "";

/** Whether a label holds one of the fields above, so is not a plain label. */
const holdsField = (label: string) =>
  label === IN_PROGRESS ||
  label.startsWith(TYPE_PREFIX) ||
  label.startsWith(PRIORITY_PREFIX) ||
  label.startsWith(CATEGORY_PREFIX);

const toIssueRef = (ref: GhRef): IssueRef => ({
  id: `${ref.number}`,
  title: ref.title,
  status: ref.state,
});

/**
 * Turns a GitHub issue into the common shape. Pure.
 *
 * @param known Pointers to the issues its text links name, by number. A
 *   link to an issue that is not among them (deleted since) is left out:
 *   it has no title to show.
 */
export function toIssue(issue: GhIssue, known: Map<number, GhRef>): Issue {
  const parts = splitBody(issue.body);
  const open = issue.state === "open";
  const priority = Number.parseInt(labelValue(issue.labels, PRIORITY_PREFIX), 10);
  const links: Link[] = [
    ...issue.blockedBy.map((ref) => ({
      ...toIssueRef(ref),
      kind: "blocked-by",
      direction: "out" as const,
    })),
    ...issue.blocking.map((ref) => ({
      ...toIssueRef(ref),
      kind: "blocked-by",
      direction: "in" as const,
    })),
    ...parts.links.flatMap((link) => {
      const ref = known.get(Number(link.id));
      return ref === undefined
        ? []
        : [{ ...toIssueRef(ref), kind: link.kind, direction: link.direction }];
    }),
  ];
  // What it waits for: its own unfinished blockers, then those of the open
  // issues it sits inside. A closed issue waits for nothing.
  const blockedBy: IssueRef[] = [];
  if (open) {
    const add = (refs: GhRef[]) => {
      for (const ref of refs) {
        if (ref.state === "open" && !blockedBy.some((had) => had.id === `${ref.number}`)) {
          blockedBy.push(toIssueRef(ref));
        }
      }
    };
    add(issue.blockedBy);
    for (let up: GhParent | null = issue.parent; up !== null; up = up.parent) {
      if (up.state === "open") add(up.blockedBy);
    }
  }
  return {
    id: `${issue.number}`,
    title: issue.title,
    status: !open
      ? "closed"
      : issue.labels.includes(IN_PROGRESS)
        ? "in_progress"
        : "open",
    type: labelValue(issue.labels, TYPE_PREFIX) || null,
    priority: Number.isInteger(priority) ? priority : null,
    category: labelValue(issue.labels, CATEGORY_PREFIX).toLowerCase() || null,
    assignee: issue.assignee,
    parentId: issue.parent === null ? null : `${issue.parent.number}`,
    description: parts.description,
    requirements: parts.requirements,
    done: parts.done,
    plan: parts.plan,
    notes: parts.notes,
    closeReason: open ? "" : (issue.stateReason ?? ""),
    labels: issue.labels.filter((label) => !holdsField(label)),
    links,
    subIssues: issue.subIssues.map(toIssueRef),
    blockedBy,
    commentCount: issue.commentCount,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    // GitHub has no place for free-form data with an issue, and an issue
    // here is not the counterpart of one elsewhere: it is the issue.
    metadata: {},
    externalRef: null,
  };
}

/** A set of labels with the one under `prefix` replaced (null removes it). */
function withLabel(
  labels: string[],
  prefix: string,
  value: string | null,
): string[] {
  const rest = labels.filter((label) => !label.startsWith(prefix));
  return value === null ? rest : [...rest, prefix + value];
}

/** The label that holds a priority; refused outside 0 to 4. */
function priorityLabel(priority: number): string {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Refused("A priority is a whole number from 0 (most urgent) to 4.");
  }
  return `${priority}`;
}

/**
 * Builds the GitHub adapter for one repository.
 *
 * @param client The connection to that repository (github-api.ts).
 * @param actor Who is acting, when it is not the signed-in account itself;
 *   see the header for what GitHub can and cannot do with it.
 * Side effects: none until a method is called. Reads cost requests against
 *   GitHub's hourly limit; the changing methods write to the repository's
 *   issues.
 */
export function createGitHubTracker({
  client,
  actor,
}: {
  client: GitHubClient;
  actor?: string;
}): Tracker {
  /** An id as GitHub's number; "#12" and "12" are both accepted. */
  function numberOf(id: string): number {
    const digits = id.trim().replace(/^#/u, "");
    if (!/^\d{1,9}$/u.test(digits) || Number(digits) === 0) {
      throw new Refused(
        `"${id}" is not a GitHub issue number. Issues here are named by their number, like 12.`,
      );
    }
    return Number(digits);
  }

  /** The issue with this id, or a refusal naming it. */
  async function need(id: string): Promise<GhIssue> {
    const issue = await client.issue(numberOf(id));
    if (issue === null) throw new Refused(`There is no issue with id ${id}.`);
    return issue;
  }

  /**
   * Issues in the common shape, with the pointers their text links need.
   *
   * @param among Issues already fetched, which serve as pointers for free.
   * Side effects: one more request when a link names an issue that is not
   *   among them; none otherwise.
   */
  async function inCommonShape(
    issues: GhIssue[],
    among: GhIssue[] = issues,
  ): Promise<Issue[]> {
    const known = new Map<number, GhRef>(
      among.map((issue) => [issue.number, issue]),
    );
    const missing = new Set<number>();
    for (const issue of issues) {
      for (const link of splitBody(issue.body).links) {
        if (!known.has(Number(link.id))) missing.add(Number(link.id));
      }
    }
    for (const ref of await client.refs([...missing])) {
      known.set(ref.number, ref);
    }
    return issues.map((issue) => toIssue(issue, known));
  }

  /** Text as it is to be posted: signed when written as someone else. */
  async function signed(text: string): Promise<string> {
    if (actor === undefined || actor.trim() === "") return text;
    return actor === (await client.viewer()) ? text : signComment(actor, text);
  }

  /** Writes an issue's description back with its parts changed. */
  async function rewrite(
    issue: GhIssue,
    change: (parts: Parts) => Parts,
  ): Promise<void> {
    const body = joinBody(change(splitBody(issue.body)));
    if (body !== issue.body) await client.update(issue.number, { body });
  }

  /** The parts with one text link added; one already there is kept once. */
  const withLink = (link: TextLink) => (parts: Parts): Parts => ({
    ...parts,
    links: parseTextLinks(formatTextLinks([...parts.links, link])),
  });

  /** The parts without the text links that `drop` picks. */
  const withoutLinks =
    (drop: (link: TextLink) => boolean) =>
    (parts: Parts): Parts => ({
      ...parts,
      links: parts.links.filter((link) => !drop(link)),
    });

  /**
   * The line the other issue carries for a text link: a "discovered from"
   * reads "led to" from the other side, a "related" reads the same.
   */
  const mirror = (link: TextLink, ownId: string): TextLink => ({
    kind: link.kind,
    direction:
      link.kind === "related" ? "out" : link.direction === "out" ? "in" : "out",
    id: ownId,
  });

  return {
    async capabilities(): Promise<Capabilities> {
      const warnings = [
        "GitHub is asked over the network: a command takes a moment, and there is a limit of about 5,000 requests an hour.",
        "Search runs a little behind: an issue made a moment ago may not be found yet.",
        "Everything is done as the signed-in GitHub account. A comment written as someone else opens with that name.",
      ];
      if (!(await client.hasIssues())) {
        warnings.unshift("Issues are switched off for this repository on GitHub.");
      }
      return {
        tracker: "github",
        where: `${client.repository} on GitHub, signed in as ${await client.viewer()}`,
        linkKinds: [...LINK_KINDS],
        supports: [
          { name: "sub-issues", level: "yes", note: "" },
          { name: "comments", level: "yes", note: "" },
          { name: "assignee", level: "yes", note: "a GitHub account" },
          { name: "link: blocked-by", level: "yes", note: "" },
          { name: "description", level: "yes", note: "" },
          {
            name: "type, priority, category",
            level: "another way",
            note: "kept as the labels type:<name>, priority:<0-4>, category:<name>",
          },
          {
            name: "in progress",
            level: "another way",
            note: "kept as the label in-progress on an open issue",
          },
          {
            name: "requirements, done, plan, notes",
            level: "another way",
            note: "kept as marked sections at the end of the description",
          },
          {
            name: "links: discovered-from, related",
            level: "another way",
            note: "kept as a marked Links section in the description of both issues",
          },
          {
            name: "close reason",
            level: "another way",
            note: "added as a comment that begins Closed:",
          },
          {
            name: "decisions and hand-overs",
            level: "another way",
            note: "kept as comments with a fixed opening",
          },
          {
            name: "ready for the owner to validate",
            level: "another way",
            note: "a hand-over comment on an issue left in progress",
          },
          {
            name: "acting as another name",
            level: "no",
            note: "GitHub acts as the signed-in account only",
          },
        ],
        warnings,
      };
    },

    async list(filter: ListFilter): Promise<Issue[]> {
      const category =
        filter.category === undefined ? undefined : cleanCategory(filter.category);
      // GitHub knows open and closed; "in progress" is an open issue with a
      // label, so it is fetched as open and narrowed below.
      const state =
        filter.status === "all"
          ? "all"
          : filter.status === "closed"
            ? "closed"
            : "open";
      const found = await inCommonShape(
        await client.issues({ state, since: filter.changedSince }),
      );
      return found.filter(
        (issue) =>
          (filter.status === undefined ||
            filter.status === "all" ||
            issue.status === filter.status) &&
          (filter.type === undefined || issue.type === filter.type) &&
          (filter.priority === undefined || issue.priority === filter.priority) &&
          (category === undefined || issue.category === category) &&
          (filter.assignee === undefined || issue.assignee === filter.assignee) &&
          (filter.parentId === undefined ||
            issue.parentId === `${numberOf(filter.parentId)}`),
      );
    },

    async ready(): Promise<Issue[]> {
      // GitHub has no notion of "ready". Here it is: open, not yet being
      // worked on, and waiting for nothing.
      const open = await inCommonShape(await client.issues({ state: "open" }));
      return open.filter(
        (issue) => issue.status === "open" && issue.blockedBy.length === 0,
      );
    },

    async show(id: string): Promise<Issue> {
      const [issue] = await inCommonShape([await need(id)]);
      return issue!;
    },

    async comments(id: string): Promise<Comment[]> {
      const issue = await need(id);
      const found = await client.comments(issue.number);
      return found
        .map((comment) => ({
          id: comment.id,
          createdAt: comment.createdAt,
          ...readComment(comment.author, comment.body),
        }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async search(text: string): Promise<Issue[]> {
      return inCommonShape(await client.search(text));
    },

    async create(draft: Draft): Promise<string> {
      // Everything the new issue names is fetched first, so that nothing is
      // created when one of them does not exist.
      const parent = draft.parentId === undefined ? null : await need(draft.parentId);
      const from = draft.from === undefined ? null : await need(draft.from);
      const blockers: GhIssue[] = [];
      for (const id of draft.blockedBy ?? []) blockers.push(await need(id));

      const labels: string[] = [];
      if (draft.type !== undefined) labels.push(TYPE_PREFIX + draft.type.trim());
      if (draft.priority !== undefined) {
        labels.push(PRIORITY_PREFIX + priorityLabel(draft.priority));
      }
      // A sub-issue takes its parent's category unless it has its own, and
      // none of its parent's other labels, as with beads.
      const category =
        draft.category !== undefined
          ? cleanCategory(draft.category)
          : parent === null
            ? ""
            : labelValue(parent.labels, CATEGORY_PREFIX).toLowerCase();
      if (category !== "") labels.push(CATEGORY_PREFIX + category);

      const made = await client.create({
        title: draft.title,
        body: joinBody({
          description: draft.description ?? "",
          requirements: "",
          done: draft.done ?? "",
          plan: "",
          notes: "",
          links:
            from === null
              ? []
              : [{ kind: "discovered-from", direction: "out", id: `${from.number}` }],
        }),
        labels,
      });
      if (parent !== null) await client.setParent(parent.number, made.id);
      if (from !== null) {
        await rewrite(
          from,
          withLink({ kind: "discovered-from", direction: "in", id: `${made.number}` }),
        );
      }
      for (const blocker of blockers) {
        await client.addBlockedBy(made.number, blocker.id);
      }
      return `${made.number}`;
    },

    async edit(id: string, changes: Changes): Promise<void> {
      if (Object.keys(changes.metadata ?? {}).length > 0) {
        throw new Unsupported(
          "GitHub issues have no place for free-form data kept with an issue.",
        );
      }
      const issue = await need(id);
      const update: GhChanges = {};
      if (changes.title !== undefined) update.title = changes.title;
      if (changes.assignee !== undefined) {
        update.assignees = changes.assignee === null ? [] : [changes.assignee];
      }
      let labels = issue.labels;
      if (changes.type !== undefined) {
        labels = withLabel(labels, TYPE_PREFIX, changes.type.trim());
      }
      if (changes.priority !== undefined) {
        labels = withLabel(labels, PRIORITY_PREFIX, priorityLabel(changes.priority));
      }
      if (changes.category !== undefined) {
        labels = withLabel(
          labels,
          CATEGORY_PREFIX,
          changes.category === null ? null : cleanCategory(changes.category),
        );
      }
      for (const label of changes.removeLabels ?? []) {
        labels = labels.filter((had) => had !== label);
      }
      for (const label of changes.addLabels ?? []) {
        if (label.trim() === "" || label.includes(",")) {
          throw new Refused(`"${label}" cannot be used as a label.`);
        }
        if (!labels.includes(label)) labels = [...labels, label];
      }
      if (
        labels.length !== issue.labels.length ||
        labels.some((label) => !issue.labels.includes(label))
      ) {
        update.labels = labels;
      }
      if (Object.keys(update).length === 0) return; // Nothing to change.
      await client.update(issue.number, update);
    },

    async write(id: string, part: Part, text: string): Promise<void> {
      await rewrite(await need(id), (parts) => ({ ...parts, [part]: text.trim() }));
    },

    async comment(id: string, text: string): Promise<void> {
      const issue = await need(id);
      await client.addComment(issue.number, await signed(text));
    },

    async start(id: string): Promise<void> {
      const issue = await need(id);
      if (issue.state === "closed") {
        throw new Refused(`${id} is closed. Reopen it before starting work on it.`);
      }
      await client.update(issue.number, {
        labels: issue.labels.includes(IN_PROGRESS)
          ? undefined
          : [...issue.labels, IN_PROGRESS],
        assignees: [await client.viewer()],
      });
    },

    async close(id: string, reason?: string): Promise<void> {
      const issue = await need(id);
      if (reason?.trim()) {
        await client.addComment(
          issue.number,
          await signed(`Closed: ${reason.trim()}`),
        );
      }
      await client.update(issue.number, {
        state: "closed",
        stateReason: "completed",
        // A closed issue is not being worked on; without this it would
        // come back as "in progress" when reopened.
        labels: issue.labels.includes(IN_PROGRESS)
          ? issue.labels.filter((label) => label !== IN_PROGRESS)
          : undefined,
      });
    },

    async reopen(id: string): Promise<void> {
      const issue = await need(id);
      if (issue.state === "open") return;
      await client.update(issue.number, { state: "open", stateReason: "reopened" });
    },

    async move(id: string, parentId: string | null): Promise<void> {
      const issue = await need(id);
      if (parentId === null) {
        if (issue.parent !== null) {
          await client.removeParent(issue.parent.number, issue.id);
        }
        return;
      }
      const parent = await need(parentId);
      // Checked here for the levels that came with the parent; GitHub
      // refuses a deeper loop itself.
      let inside = parent.number === issue.number;
      for (let up = parent.parent; up !== null && !inside; up = up.parent) {
        inside = up.number === issue.number;
      }
      if (inside) {
        throw new Refused(
          "An issue cannot be moved inside itself or inside one of its own sub-issues.",
        );
      }
      await client.setParent(parent.number, issue.id);
    },

    async link(id: string, otherId: string, kind: string): Promise<void> {
      if (!(LINK_KINDS as readonly string[]).includes(kind)) {
        throw new Unsupported(
          `GitHub issues have no "${kind}" link here. There are: ${LINK_KINDS.join(", ")}.`,
        );
      }
      const issue = await need(id);
      const other = await need(otherId);
      if (issue.number === other.number) {
        throw new Refused("An issue cannot be linked to itself.");
      }
      const already = (found: string) =>
        new Refused(`${id} and ${otherId} are already linked (${found}).`);
      if (kind === "blocked-by") {
        if (issue.blockedBy.some((ref) => ref.number === other.number)) {
          throw already("blocked-by");
        }
        await client.addBlockedBy(issue.number, other.id);
        return;
      }
      const link: TextLink = {
        kind: kind as TextLink["kind"],
        direction: "out",
        id: `${other.number}`,
      };
      if (
        splitBody(issue.body).links.some(
          (had) => had.kind === link.kind && had.id === link.id,
        )
      ) {
        throw already(kind);
      }
      await rewrite(issue, withLink(link));
      await rewrite(other, withLink(mirror(link, `${issue.number}`)));
    },

    async unlink(id: string, otherId: string, onlyFrom = false): Promise<void> {
      const issue = await need(id);
      const other = await need(otherId);
      let removed = false;
      if (issue.blockedBy.some((ref) => ref.number === other.number)) {
        await client.removeBlockedBy(issue.number, other.id);
        removed = true;
      }
      if (!onlyFrom && other.blockedBy.some((ref) => ref.number === issue.number)) {
        await client.removeBlockedBy(other.number, issue.id);
        removed = true;
      }
      // Text links: the lines on this issue that name the other, and their
      // counterparts there. With `onlyFrom`, a "led to" line (a link that
      // is about the other issue) is left, and so is its counterpart.
      const mine = splitBody(issue.body).links.filter(
        (link) =>
          link.id === `${other.number}` && !(onlyFrom && link.direction === "in"),
      );
      if (mine.length > 0) {
        const same = (left: TextLink, right: TextLink) =>
          left.kind === right.kind &&
          left.direction === right.direction &&
          left.id === right.id;
        await rewrite(
          issue,
          withoutLinks((link) => mine.some((gone) => same(gone, link))),
        );
        const theirs = mine.map((link) => mirror(link, `${issue.number}`));
        await rewrite(
          other,
          withoutLinks((link) => theirs.some((gone) => same(gone, link))),
        );
        removed = true;
      }
      if (!removed) {
        throw new Refused(`There is no link between ${id} and ${otherId}.`);
      }
    },
  };
}
