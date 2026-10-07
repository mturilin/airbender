// tracker/beads.ts — the adapter for beads (the `bd` command-line tool).
//
// What: implements the Tracker interface on top of `bd`: turns beads' rows
// into the common Issue shape, and each operation into bd commands.
//
// Why: beads is the first tracker the owner uses. Everything beads-specific
// in this layer lives in this one file.
//
// Design notes:
// - Reads use one `bd --readonly list --all --json` and work the rest out
//   in memory (links from both ends, sub-issues, what blocks what), so every
//   answer is one consistent snapshot. Beads' `show` gives an issue's links
//   in one direction only.
// - Where the parts are kept: description, done and plan are beads' own
//   description, acceptance criteria and design; notes are notes.
//   Requirements have no field in beads and are kept as a marked section
//   inside the description (see parts.ts); `capabilities` says so.
// - The category is the label `category:<name>`, the same convention the
//   Airbender tab uses, so the two agree.
// - Links: "blocked-by" is beads' dependency type "blocks" (stored on the
//   issue that waits); "discovered-from" is the same name in beads;
//   "related" goes through `bd dep relate`, beads' see-also command.
// - Free text is never put where bd could read it as an option: it is the
//   value of a named flag, or is sent on standard input. No shell is used.
//
// Gotchas:
// - With --json, bd may report an error on standard output as
//   `{"error": ...}`; that is read before falling back to standard error.
// - bd prints `null` where an empty list would be expected.
// - Beads keeps one link per ordered pair of issues, whatever its kind.
// - `bd close` refuses an issue that still has open sub-issues; its message
//   is passed on.

import { execFile } from "node:child_process";
import { cleanCategory, joinSection, splitSection } from "./parts.ts";
import {
  Refused,
  type Capabilities,
  type Changes,
  type Comment,
  type Draft,
  type Issue,
  type IssueRef,
  type Link,
  type LinkKind,
  type ListFilter,
  type Part,
  type Tracker,
} from "./types.ts";

/** The label prefix that holds an issue's category. */
const CATEGORY_PREFIX = "category:";
/** Beads' status for a finished issue. */
const CLOSED = "closed";
/** The name of the section that holds requirements inside a description. */
const REQUIREMENTS = "requirements";
/** How long one bd command may take. */
const BD_TIMEOUT_MS = 30_000;
/** Upper bound on bd output we are willing to buffer (32 MiB). */
const BD_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** One row of `bd list --json`, limited to what is used; all else ignored. */
export interface BdRow {
  id: string;
  title: string;
  status: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  close_reason?: string;
  comment_count?: number;
  priority?: number;
  issue_type?: string;
  assignee?: string;
  parent?: string | null;
  labels?: string[] | null;
  created_at?: string;
  updated_at?: string;
  dependencies?: { depends_on_id: string; type: string }[] | null;
}

/** Beads' dependency types and the common link kinds they are shown as. */
const KIND_OF: Record<string, string> = {
  blocks: "blocked-by",
  "discovered-from": "discovered-from",
  related: "related",
  "relates-to": "related",
};

/** Kinds that read the same from both ends. */
const TWO_WAY = new Set(["related"]);

/**
 * Turns beads' rows into issues in the common shape.
 *
 * Pure: rows in, issues out. Links are listed from both ends; a two-way
 * link stored on both issues is listed once per issue. `blockedBy` holds the
 * unfinished issues an open issue waits for, its own and those of the open
 * issues it sits inside (beads' own rule: a sub-issue of a blocked issue is
 * blocked). A loop in the parent data is not followed.
 */
export function toIssues(rows: BdRow[]): Issue[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ref = (row: BdRow): IssueRef => ({
    id: row.id,
    title: row.title,
    status: row.status,
  });
  const links = new Map<string, Link[]>();
  const add = (owner: string, link: Link) => {
    const list = links.get(owner) ?? [];
    // A two-way link stored on both issues would otherwise show twice.
    if (
      !list.some(
        (known) =>
          known.id === link.id &&
          known.kind === link.kind &&
          (TWO_WAY.has(link.kind) || known.direction === link.direction),
      )
    ) {
      list.push(link);
    }
    links.set(owner, list);
  };
  const direct = new Map<string, IssueRef[]>();
  for (const row of rows) {
    for (const dependency of row.dependencies ?? []) {
      if (dependency.type === "parent-child") continue;
      const other = byId.get(dependency.depends_on_id);
      // A link to an issue outside this list has no title to show.
      if (other === undefined) continue;
      const kind = KIND_OF[dependency.type] ?? dependency.type;
      add(row.id, { ...ref(other), kind, direction: "out" });
      add(other.id, {
        ...ref(row),
        kind,
        direction: TWO_WAY.has(kind) ? "out" : "in",
      });
      if (
        dependency.type === "blocks" &&
        row.status !== CLOSED &&
        other.status !== CLOSED
      ) {
        direct.set(row.id, [...(direct.get(row.id) ?? []), ref(other)]);
      }
    }
  }
  const children = new Map<string, IssueRef[]>();
  for (const row of rows) {
    if (row.parent == null || !byId.has(row.parent)) continue;
    children.set(row.parent, [...(children.get(row.parent) ?? []), ref(row)]);
  }
  return rows.map((row) => {
    const blockedBy = [...(direct.get(row.id) ?? [])];
    if (row.status !== CLOSED) {
      const seen = new Set([row.id]);
      let parent = row.parent == null ? undefined : byId.get(row.parent);
      while (parent !== undefined && !seen.has(parent.id)) {
        seen.add(parent.id);
        if (parent.status !== CLOSED) {
          for (const blocker of direct.get(parent.id) ?? []) {
            if (!blockedBy.some((known) => known.id === blocker.id)) {
              blockedBy.push(blocker);
            }
          }
        }
        parent = parent.parent == null ? undefined : byId.get(parent.parent);
      }
    }
    const labels = row.labels ?? [];
    const category = labels
      .find((label) => label.startsWith(CATEGORY_PREFIX))
      ?.slice(CATEGORY_PREFIX.length)
      .trim();
    const { rest, section } = splitSection(row.description ?? "", REQUIREMENTS);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      type: row.issue_type ?? null,
      priority: row.priority ?? null,
      category: category === undefined || category === "" ? null : category,
      assignee: row.assignee ?? null,
      parentId: row.parent ?? null,
      description: rest,
      requirements: section,
      done: row.acceptance_criteria ?? "",
      plan: row.design ?? "",
      notes: row.notes ?? "",
      closeReason: row.close_reason ?? "",
      labels: labels.filter((label) => !label.startsWith(CATEGORY_PREFIX)),
      links: links.get(row.id) ?? [],
      subIssues: children.get(row.id) ?? [],
      blockedBy,
      commentCount: row.comment_count ?? 0,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? row.created_at ?? null,
    };
  });
}

/**
 * Every id inside `rootId`, at any depth, by the parents in `rows`.
 * Guarded against a loop in the data: each issue is taken once.
 */
export function descendantIds(rootId: string, rows: BdRow[]): Set<string> {
  const found = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const row of rows) {
      if (row.parent !== parentId || found.has(row.id) || row.id === rootId) {
        continue;
      }
      found.add(row.id);
      queue.push(row.id);
    }
  }
  return found;
}

/**
 * Turns one of bd's error messages into words that make sense to someone
 * using `bend`: without bd's own prefixes, and without advice to use bd
 * commands or options that `bend` does not have.
 */
export function explain(message: string): string {
  // bd adds usage text after some errors; the first line is the reason.
  const reason = message
    .split("\n")[0]!
    .replace(/^Error( updating \S+)?:\s*/u, "")
    .trim();
  const assigned = /assignee is "(.*?)", actor is "(.*?)"/u.exec(reason);
  if (assigned !== null) {
    return `The issue is assigned to ${assigned[1]}, and you are acting as ${assigned[2]}. Close it as ${assigned[1]} (--as), or change its assignee first (bend edit).`;
  }
  if (/would create a cycle/iu.test(reason)) {
    return "That would make a loop: one of the two already depends on the other.";
  }
  return reason
    .replace(/;? ?(close children first )?or use --force to override/u, (_, first) =>
      first === undefined ? "" : "; close them first",
    )
    .replace(/; remove it first with 'bd dep remove' then re-add/u, "");
}

/**
 * The link stored on `from` that points at `to`, of any kind but
 * parent-child; undefined when there is none.
 */
function storedLink(from: BdRow, to: string) {
  return (from.dependencies ?? []).find(
    (dependency) =>
      dependency.depends_on_id === to && dependency.type !== "parent-child",
  );
}

/**
 * Builds the beads adapter for one folder.
 *
 * @param dir A folder inside the repository; bd finds its database from
 *   there upward.
 * @param actor Who is acting, for beads' history; bd's own default (the git
 *   user) when left out.
 * @param bdCommand The bd program to run; "bd" on the PATH by default.
 * Side effects: none until a method is called. Reads run `bd --readonly`;
 *   the changing methods write to the beads database.
 */
export function createBeadsTracker({
  dir,
  actor,
  bdCommand = "bd",
}: {
  dir: string;
  actor?: string;
  bdCommand?: string;
}): Tracker {
  /**
   * Runs one bd command and gives its standard output.
   *
   * @param input Text to send on standard input, for commands that read
   *   free text from there.
   * @throws Refused with bd's own message when the command fails, or with
   *   a plain explanation when bd is not installed.
   */
  function bd(args: string[], input?: string): Promise<string> {
    const full = actor === undefined ? args : ["--actor", actor, ...args];
    return new Promise((resolve, reject) => {
      const child = execFile(
        bdCommand,
        full,
        { cwd: dir, timeout: BD_TIMEOUT_MS, maxBuffer: BD_MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (error === null) return resolve(stdout);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(
              new Refused(
                `The beads program (${bdCommand}) was not found. Install beads, or set BEND_BD to its full path.`,
              ),
            );
          }
          let detail = stderr.trim() || stdout.trim() || error.message;
          try {
            const parsed: unknown = JSON.parse(stdout);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "error" in parsed &&
              typeof parsed.error === "string"
            ) {
              detail = parsed.error;
            }
          } catch {
            // Not JSON: the text is already the message.
          }
          reject(new Refused(explain(detail)));
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });
  }

  /** bd's answer parsed as JSON; `null` is given as an empty list. */
  async function bdJson<Answer>(args: string[]): Promise<Answer> {
    const out = await bd(args);
    try {
      return (JSON.parse(out) ?? []) as Answer;
    } catch {
      throw new Refused(
        "bd answered in a format this program does not understand. It may be a newer or older bd than bend was written for.",
      );
    }
  }

  /** Every issue of the repository, as beads gives them. */
  const rows = () =>
    bdJson<BdRow[]>(["--readonly", "list", "--all", "--json", "--limit", "0"]);

  /** The row for `id`, or a refusal naming it. */
  function need(all: BdRow[], id: string): BdRow {
    const row = all.find((candidate) => candidate.id === id);
    if (row === undefined) throw new Refused(`There is no issue with id ${id}.`);
    return row;
  }

  /** Issues with these ids, in the order of `ids`; unknown ids are skipped. */
  async function byIds(ids: string[]): Promise<Issue[]> {
    const all = new Map(toIssues(await rows()).map((issue) => [issue.id, issue]));
    return ids.flatMap((id) => {
      const issue = all.get(id);
      return issue === undefined ? [] : [issue];
    });
  }

  return {
    async capabilities(): Promise<Capabilities> {
      const warnings: string[] = [];
      // Beads keeps its issues in a local database. Unless a remote is set
      // up for it, they exist on this machine only.
      const remotes = await bd(["dolt", "remote", "list"]).catch(() => "");
      if (/no remotes configured/iu.test(remotes) || remotes.trim() === "") {
        warnings.push(
          "The beads database is not synced anywhere: the issues exist on this machine only (see `bd dolt remote`).",
        );
      }
      return {
        tracker: "beads",
        where: dir,
        supports: [
          { name: "sub-issues", level: "yes", note: "" },
          { name: "comments", level: "yes", note: "" },
          { name: "type", level: "yes", note: "" },
          { name: "priority", level: "yes", note: "" },
          { name: "assignee", level: "yes", note: "" },
          { name: "links: blocked-by, discovered-from, related", level: "yes", note: "" },
          { name: "description, done, plan, notes", level: "yes", note: "" },
          {
            name: "category",
            level: "another way",
            note: "kept as the label category:<name>",
          },
          {
            name: "requirements",
            level: "another way",
            note: "kept as a marked section inside the description",
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
        ],
        warnings,
      };
    },

    async list(filter: ListFilter): Promise<Issue[]> {
      const category =
        filter.category === undefined ? undefined : cleanCategory(filter.category);
      return toIssues(await rows()).filter(
        (issue) =>
          (filter.status === "all" ||
            (filter.status === undefined
              ? issue.status !== CLOSED
              : issue.status === filter.status)) &&
          (filter.type === undefined || issue.type === filter.type) &&
          (filter.priority === undefined || issue.priority === filter.priority) &&
          (category === undefined || issue.category === category) &&
          (filter.assignee === undefined || issue.assignee === filter.assignee) &&
          (filter.parentId === undefined || issue.parentId === filter.parentId),
      );
    },

    async ready(): Promise<Issue[]> {
      // "Can be worked on now" is beads' own judgement, not re-derived here.
      const ready = await bdJson<{ id: string }[]>([
        "--readonly",
        "ready",
        "--json",
        "--limit",
        "0",
      ]);
      return byIds(ready.map((row) => row.id));
    },

    async show(id: string): Promise<Issue> {
      const all = await rows();
      need(all, id);
      return toIssues(all).find((issue) => issue.id === id)!;
    },

    async comments(id: string): Promise<Comment[]> {
      need(await rows(), id);
      const found = await bdJson<
        { id: string | number; author?: string; text?: string; created_at?: string }[]
      >(["--readonly", "comments", id, "--json"]);
      return found
        .map((row) => ({
          id: `${row.id}`,
          author: row.author ?? "",
          createdAt: row.created_at ?? "",
          text: row.text ?? "",
        }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async search(text: string): Promise<Issue[]> {
      const found = await bdJson<{ id: string }[]>([
        "--readonly",
        "search",
        text,
        "--json",
        "--limit",
        "0",
      ]);
      return byIds(found.map((row) => row.id));
    },

    async create(draft: Draft): Promise<string> {
      const all = await rows();
      for (const id of [draft.parentId, draft.from, ...(draft.blockedBy ?? [])]) {
        if (id !== undefined) need(all, id);
      }
      const args = ["create", "--json", "--title", draft.title];
      if (draft.description?.trim()) args.push("--description", draft.description);
      if (draft.done?.trim()) args.push("--acceptance", draft.done);
      if (draft.type !== undefined) args.push("--type", draft.type);
      if (draft.priority !== undefined) args.push("--priority", `${draft.priority}`);
      if (draft.parentId !== undefined) args.push("--parent", draft.parentId);
      // Without a category of its own a sub-issue takes its parent's: beads
      // copies the parent's labels to a new child by itself.
      if (draft.category !== undefined) {
        args.push("--labels", CATEGORY_PREFIX + cleanCategory(draft.category));
      }
      if (draft.from !== undefined) {
        args.push("--deps", `discovered-from:${draft.from}`);
      }
      const created = await bdJson<{ id?: string }>(args);
      if (typeof created.id !== "string") {
        throw new Refused(
          "bd reported success but did not say which issue it created. Check with `bend list`.",
        );
      }
      for (const blocker of draft.blockedBy ?? []) {
        await bd(["dep", "add", created.id, blocker, "--json"]);
      }
      return created.id;
    },

    async edit(id: string, changes: Changes): Promise<void> {
      const row = need(await rows(), id);
      const args = ["update", id, "--json"];
      if (changes.title !== undefined) args.push("--title", changes.title);
      if (changes.type !== undefined) args.push("--type", changes.type);
      if (changes.priority !== undefined) {
        args.push("--priority", `${changes.priority}`);
      }
      if (changes.assignee !== undefined) {
        args.push("--assignee", changes.assignee ?? "");
      }
      if (changes.category !== undefined) {
        const wanted =
          changes.category === null
            ? null
            : CATEGORY_PREFIX + cleanCategory(changes.category);
        const present = (row.labels ?? []).filter((label) =>
          label.startsWith(CATEGORY_PREFIX),
        );
        // Every category label is removed first, so an issue never ends up
        // with two, even if one was added by hand with bd.
        for (const label of present) {
          if (label !== wanted) args.push("--remove-label", label);
        }
        if (wanted !== null && !present.includes(wanted)) {
          args.push("--add-label", wanted);
        }
      }
      if (args.length === 3) return; // Nothing to change.
      await bd(args);
    },

    async write(id: string, part: Part, text: string): Promise<void> {
      const row = need(await rows(), id);
      const { rest, section } = splitSection(row.description ?? "", REQUIREMENTS);
      const flag: Record<Part, [string, string]> = {
        // The description and the requirements share beads' one field; each
        // is written without disturbing the other.
        description: [
          "--description",
          joinSection(text, REQUIREMENTS, "Requirements", section),
        ],
        requirements: [
          "--description",
          joinSection(rest, REQUIREMENTS, "Requirements", text),
        ],
        done: ["--acceptance", text.trim()],
        plan: ["--design", text.trim()],
        notes: ["--notes", text.trim()],
      };
      await bd(["update", id, "--json", ...flag[part]]);
    },

    async comment(id: string, text: string): Promise<void> {
      need(await rows(), id);
      // On standard input, so text that starts with a dash is still text.
      await bd(["comment", id, "--stdin"], text);
    },

    async start(id: string): Promise<void> {
      const row = need(await rows(), id);
      if (row.status === CLOSED) {
        throw new Refused(`${id} is closed. Reopen it before starting work on it.`);
      }
      const args = ["update", id, "--json", "--status", "in_progress"];
      if (actor !== undefined) args.push("--assignee", actor);
      await bd(args);
    },

    async close(id: string, reason?: string): Promise<void> {
      need(await rows(), id);
      const args = ["close", id, "--json"];
      if (reason?.trim()) args.push("--reason", reason);
      await bd(args);
    },

    async reopen(id: string): Promise<void> {
      need(await rows(), id);
      await bd(["reopen", id, "--json"]);
    },

    async move(id: string, parentId: string | null): Promise<void> {
      const all = await rows();
      const row = need(all, id);
      if (parentId !== null) {
        const parent = need(all, parentId);
        // Beads keeps "sub-issue of" as a link too, and allows one link per
        // pair of issues, so an existing link between the two is in the way.
        if (storedLink(row, parentId) ?? storedLink(parent, id)) {
          throw new Refused(
            `${id} and ${parentId} are linked. Remove that link first (bend unlink ${id} ${parentId}), then move it.`,
          );
        }
        // Checked here and not left to bd: an issue inside itself would
        // disappear from every view that walks the tree from the top.
        if (parentId === id || descendantIds(id, all).has(parentId)) {
          throw new Refused(
            "An issue cannot be moved inside itself or inside one of its own sub-issues.",
          );
        }
      }
      // An empty --parent is how bd takes an issue out of its parent.
      await bd(["update", id, "--json", "--parent", parentId ?? ""]);
    },

    async link(id: string, otherId: string, kind: LinkKind): Promise<void> {
      const all = await rows();
      const row = need(all, id);
      const other = need(all, otherId);
      if (id === otherId) throw new Refused("An issue cannot be linked to itself.");
      // Beads keeps one link per pair in each direction, and a "related"
      // link takes both directions. Said here in bend's own words, because
      // bd's refusal advises bd commands.
      const existing =
        storedLink(row, otherId) ??
        (kind === "related" ? storedLink(other, id) : undefined);
      if (existing !== undefined) {
        throw new Refused(
          `${id} and ${otherId} are already linked (${KIND_OF[existing.type] ?? existing.type}). Remove that link first: bend unlink ${id} ${otherId}.`,
        );
      }
      await bd(
        kind === "related"
          ? ["dep", "relate", id, otherId, "--json"]
          : [
              "dep",
              "add",
              id,
              otherId,
              "--type",
              kind === "blocked-by" ? "blocks" : kind,
              "--json",
            ],
      );
    },

    async unlink(id: string, otherId: string): Promise<void> {
      const all = await rows();
      const forward = storedLink(need(all, id), otherId);
      const backward = storedLink(need(all, otherId), id);
      if (forward === undefined && backward === undefined) {
        throw new Refused(`There is no link between ${id} and ${otherId}.`);
      }
      // A two-way link is undone with the command that made it, so both
      // halves go; `dep remove` would leave the other issue's half behind.
      if (forward?.type === "relates-to" || backward?.type === "relates-to") {
        await bd(["dep", "unrelate", id, otherId, "--json"]);
        return;
      }
      if (forward !== undefined) await bd(["dep", "remove", id, otherId, "--json"]);
      if (backward !== undefined) await bd(["dep", "remove", otherId, id, "--json"]);
    },
  };
}
