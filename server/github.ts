// server/github.ts — syncing issues with GitHub, through beads' own command.
//
// What: what the "Sync with GitHub" window needs: the repository's open
// GitHub issues to choose from, and a run of `bd github sync` for the
// chosen issues, as a preview or for real, in either direction.
//
// Why: the user wants GitHub issues brought into beads and beads issues
// sent to GitHub from the tab, choosing which and seeing first what would
// happen (bead-bb-rh3). They asked that it be only a UI for the command
// ("can just build ui for `bd github sync`?"): the command keeps issues
// linked, detects conflicts, maps fields and handles GitHub's limits, some
// thousands of lines that must not be written a second time here.
//
// Design notes:
// - One run of the command per kind of choice, each limited to the issues
//   chosen for it: `--pull-only --issues <numbers>` for GitHub issues to
//   bring in, the command's own two-way mode `--issues <ids>` for issues
//   that exist on both sides, and `--push-only --issues <ids>` for issues
//   to send; in that order. One run for everything would also act on a
//   chosen issue in a direction it was not chosen for.
// - Closed issues are read and offered too (the user: "let's add closed
//   issues"): the command carries a close in either direction, and without
//   them a close made on one side could never be sent to the other.
// - The command has no code for comments (beads 1.3.1). Those of GitHub
//   issues that are brought in are copied by a step of the plugin's own
//   after the command, when the owner ticks it; it lives in
//   server/github-comments.ts (bead-bb-apc). Nothing goes the other way.
// - The token and the repository are given to the command in the
//   environment of that one process. Nothing is written to beads' own
//   settings: beads keeps a token in `.beads/config.yaml`, which is a file
//   in git in many repositories, and the user's condition was "token
//   stored is fine as long as it's not synced to the repo". The token is
//   kept as a secret setting of the plugin (server.ts) and read at use.
// - With no token set, the `gh` command is asked for the one it is signed
//   in with, for that one run (the user: "can it generate token
//   automatically with gh command"). Nothing is stored. A token in the
//   setting comes first, so a narrower one can be used on purpose.
// - The list of GitHub issues is the one thing fetched here and not by the
//   command, which can pull named issues but cannot say what is there.
// - The command reports in text. It is parsed line by line into what it
//   would do or did; a line that is not recognised is passed on as it is,
//   so a beads version that words things differently shows as text and
//   never as a wrong list.
//
// - A sync is a job that is started and then asked about, not one request
//   that answers at the end: a hundred issues take minutes, and the user
//   has to see that it is moving and be able to stop it. It runs the
//   command a batch of issues at a time (see `work`).
//
// Gotchas:
// - The command creates an issue on GitHub open even when it is closed
//   here, and then considers the two in step. `work` closes those on
//   GitHub itself: the one thing this file writes to GitHub directly.
// - Sending to GitHub publishes, and a GitHub issue can be closed but not
//   deleted. Nothing here asks "are you sure": the window does, and offers
//   a real run only after a preview of the same selection.
// - The token must never reach a log line, a message or the tab. Whatever
//   the command prints is passed through `withoutToken` before it is used.

import { execFile } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BEAD_ID_PATTERN, CLOSED_STATUS } from "../shared/constants.ts";
import { readGit } from "./bd.ts";
import { comments, copyComments } from "./github-comments.ts";
import type { Folders } from "./folder.ts";
import type { FolderRef, Store } from "./store.ts";

/** A GitHub repository, as its two names. */
export interface Repository {
  owner: string;
  name: string;
}

/**
 * The GitHub repository a remote's address points at.
 *
 * @param url A git remote address, in any of the forms git accepts for
 *   github.com: `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`,
 *   `ssh://git@github.com/o/r(.git)`.
 * @returns Null for anything that is not on github.com (GitHub Enterprise
 *   is out of scope), or that has no owner and name.
 */
export function repositoryOf(url: string): Repository | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu.exec(
      url.trim(),
    );
  return match === null ? null : { owner: match[1]!, name: match[2]! };
}

/**
 * The number of the GitHub issue a beads issue is linked to.
 *
 * @param ref The issue's external reference as beads keeps it: the GitHub
 *   issue's address, or the short form `github:<number>`.
 * @returns Null when there is none, or it points somewhere else (another
 *   tracker, another repository).
 */
export function linkedNumber(
  ref: string | null,
  repository: Repository,
): number | null {
  if (ref === null) return null;
  const short = /^github:(\d+)$/u.exec(ref.trim());
  if (short !== null) return Number(short[1]);
  const full = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/iu.exec(ref);
  if (full === null) return null;
  const same =
    full[1]!.toLowerCase() === repository.owner.toLowerCase() &&
    full[2]!.toLowerCase() === repository.name.toLowerCase();
  return same ? Number(full[3]) : null;
}

/** One thing a sync would do, or did. */
export interface SyncAction {
  /**
   * `import`: a GitHub issue becomes a new beads issue. `update-local`: a
   * beads issue is brought up to date from GitHub. `create-remote`: a beads
   * issue becomes a new GitHub issue. `update-remote`: a GitHub issue is
   * brought up to date from beads.
   */
  kind: "import" | "update-local" | "create-remote" | "update-remote";
  /** What the command said after the action: a number and title, or a title. */
  what: string;
}

/** What one run of the command reported, taken apart. */
export interface SyncReport {
  actions: SyncAction[];
  /** Everything else it said that is worth showing, as it said it. */
  notes: string[];
  /** Its warnings (an issue not found, a failed update). */
  warnings: string[];
}

/**
 * Takes the command's text apart.
 *
 * @param stdout Its report: one line per action in a preview
 *   ("[dry-run] Would import: 12 - title"), totals after a real run
 *   ("✓ Pulled 2 issues (1 created, 1 updated)"), and conflict lines.
 * @param stderr Where it writes warnings, each as "Warning: ...".
 * @returns The actions it recognised, with the rest as notes. The frame of
 *   a preview ("Dry run mode ...", "Run without --dry-run ...") is dropped.
 */
export function parseSyncOutput(stdout: string, stderr: string): SyncReport {
  const actions: SyncAction[] = [];
  const notes: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (
      line === "" ||
      line.startsWith("Dry run mode") ||
      line.startsWith("Run without --dry-run")
    ) {
      continue;
    }
    const would = /^\[dry-run\] Would (.+)$/u.exec(line);
    if (would !== null) {
      const said = would[1]!;
      const patterns: [SyncAction["kind"], RegExp][] = [
        ["import", /^import: (.+)$/u],
        ["update-local", /^update local issue: (.+)$/u],
        ["create-remote", /^create in [^:]+: (.+)$/u],
        ["update-remote", /^update in [^:]+: (.+)$/u],
      ];
      const found = patterns
        .map(([kind, pattern]) => ({ kind, match: pattern.exec(said) }))
        .find(({ match }) => match !== null);
      if (found !== undefined) {
        actions.push({ kind: found.kind, what: found.match![1]! });
      } else {
        // Something else it would do (create dependencies): said as it is.
        notes.push(`Would ${said}`);
      }
      continue;
    }
    notes.push(line.replace(/^[✓→]\s*/u, ""));
  }
  const warnings = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^Warning:\s*/u, ""));
  return { actions, notes, warnings };
}

/** A GitHub issue, as the window lists it. */
export interface RemoteIssue {
  number: number;
  title: string;
  labels: string[];
  url: string;
  /** Whether it is closed on GitHub. */
  closed: boolean;
  /** The beads issue it is linked to; null when it is not in beads. */
  linkedId: string | null;
}

/** How an issue changed on both sides is settled; the command's three ways. */
/** What is needed of a beads issue to tell whether it is on GitHub too. */
export interface OwnIssue {
  id: string;
  status: string;
  externalRef: string | null;
}

/** What `switchPreview` answers; see there. */
export interface SwitchPreview {
  /** Why no copy can be made, in one sentence; null when one can. */
  cannot: string | null;
  /** "owner/name"; null when it could not be told. */
  repository: string | null;
  /** Beads ids to create on GitHub (switching to GitHub issues). */
  createIds: string[];
  /** GitHub issue numbers to bring into beads (switching to beads). */
  createNumbers: number[];
  /** Beads ids of the issues that are on both sides already. */
  update: string[];
  /** Closed issues that exist only on the side being left: not copied. */
  closedLeft: number;
  /** GitHub has more issues than were read: the numbers are "at least". */
  truncated: boolean;
  /**
   * The folder's git remote does not name a repository on github.com, so
   * a switch to GitHub issues has to be told which repository is meant.
   */
  needsRepository: boolean;
}

/**
 * The lists a switch of tracker would copy by: pure, for `switchPreview`.
 *
 * @param to The tracker being switched to.
 * @param mine The beads issues; `remote` the GitHub issues, each with the
 *   beads issue it is linked to; `links` every link the beads issues carry.
 * @returns What exists only on the side being left and is open (to be
 *   created on the other), what is on both sides (to be brought up to
 *   date), and how many closed issues exist only on the side being left.
 */
export function switchLists(
  to: "beads" | "github",
  mine: readonly OwnIssue[],
  remote: readonly Pick<RemoteIssue, "number" | "closed" | "linkedId">[],
  links: readonly { id: string; number: number }[],
): Pick<SwitchPreview, "createIds" | "createNumbers" | "update" | "closedLeft"> {
  const linkedIds = new Set(links.map((link) => link.id));
  const update = mine.filter((issue) => linkedIds.has(issue.id)).map((issue) => issue.id);
  if (to === "github") {
    const only = mine.filter((issue) => !linkedIds.has(issue.id));
    return {
      update,
      createIds: only
        .filter((issue) => issue.status !== CLOSED_STATUS)
        .map((issue) => issue.id),
      createNumbers: [],
      closedLeft: only.filter((issue) => issue.status === CLOSED_STATUS).length,
    };
  }
  const only = remote.filter((issue) => issue.linkedId === null);
  return {
    update,
    createIds: [],
    createNumbers: only.filter((issue) => !issue.closed).map((issue) => issue.number),
    closedLeft: only.filter((issue) => issue.closed).length,
  };
}

export const PREFER = ["newer", "github", "local"] as const;
export type Prefer = (typeof PREFER)[number];

/** Most GitHub issues read: pages of 100, the most recently changed first. */
const MAX_PAGES = 10;

/** How many issues one run of the command is given. */
const BATCH_SIZE = 10;

/**
 * Longest one batch may take. Long on purpose: GitHub slows down whoever
 * creates many issues, and the command waits and goes on. The first limit
 * here, three minutes for a whole sync, cut a sync of 101 issues off.
 */
const BATCH_TIMEOUT_MS = 15 * 60_000;

/** Lines of the command's output kept per job, and sent per answer. */
const MAX_LINES = 400;
const SHOWN_LINES = 40;

/** How long a finished job can still be asked about. */
const JOB_KEPT_MS = 10 * 60_000;

/** One sync under way: what `progress` reports. */
interface Job extends SyncReport {
  id: string;
  path: string;
  threadId: string | null;
  /** Issues chosen, and how many of them the runs have been through. */
  total: number;
  finished: number;
  /** Which part is being done; null before the start and at the end. */
  doing: string | null;
  /** What the command has printed, newest last. */
  lines: string[];
  /** GitHub issues closed by this file because they are closed here. */
  closedRemote: number;
  /** Comments copied from GitHub into beads (server/github-comments.ts). */
  copied: number;
  message: string | null;
  done: boolean;
  /** Asked to stop: no further batch is started. */
  stopping: boolean;
  startedAt: number;
}

const reason = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The token the `gh` command is signed in with on github.com.
 *
 * @returns "" when gh is not installed, not signed in, or does not answer.
 * Side effects: one short-lived `gh auth token`; nothing is written.
 */
function ghToken(): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error === null ? stdout.trim() : ""),
    );
  });
}

/**
 * Builds the GitHub operations for this plugin instance.
 *
 * @param readToken Reads the GitHub token from the plugin's secret
 *   setting; "" when none is set.
 * @param readGhToken Asks the `gh` command for its token; "" when it has
 *   none. Replaced in tests.
 * @returns `issues` and `sync`.
 * Side effects: none until one of them is called.
 */
export function createGithub({
  bb,
  folders,
  store,
  readToken,
  readGhToken = ghToken,
  readBeads = async () => null,
}: {
  bb: BbPluginApi;
  folders: Folders;
  store: Store;
  /**
   * The issues a folder has in beads, whichever tracker its repository is
   * on; null when it has no beads database. For `switchPreview`.
   */
  readBeads?: (path: string) => Promise<OwnIssue[] | null>;
  readToken: () => Promise<string>;
  readGhToken?: () => Promise<string>;
}) {
  /** Any text with the token taken out, before it is shown or logged. */
  const withoutToken = (text: string, token: string) =>
    token === "" ? text : text.split(token).join("***");

  /**
   * What every operation starts with: the folder, its GitHub repository
   * and the token.
   *
   * @returns Those, or `{ state, message }` saying in plain words what is
   *   missing.
   */
  async function ready(input: FolderRef): Promise<
    | { path: string; repository: Repository; token: string }
    | { state: "unavailable" | "no-repository" | "no-token"; message: string }
  > {
    const folder = await folders.folderFor(input);
    if ("message" in folder) {
      return { state: "unavailable", message: folder.message };
    }
    const remote = await readGit(folder.path, ["remote", "get-url", "origin"]);
    const repository = remote === null ? null : repositoryOf(remote);
    if (repository === null) {
      return {
        state: "no-repository",
        message:
          remote === null
            ? "This folder has no git remote called origin, so there is no GitHub repository to sync with."
            : "This folder's origin remote is not a repository on github.com.",
      };
    }
    // The setting first; else whatever gh is signed in with, for this run.
    const token = (await readToken()).trim() || (await readGhToken()).trim();
    if (token === "") {
      return {
        state: "no-token",
        message: `There is no GitHub sign-in to use. Either sign in with the gh command (\`gh auth login\`), or set a token in BB under Tools, then Airbender, as "GitHub token": a personal access token that may read and write the issues of ${repository.owner}/${repository.name}. Neither is written into the repository.`,
      };
    }
    return { path: folder.path, repository, token };
  }

  /**
   * The repository's GitHub issues, open and closed, the most recently
   * changed first, each with the beads issue it is linked to; and every
   * link the beads issues carry, also to GitHub issues that were not read.
   *
   * @returns `state` "ok" with the issues, or what is missing with a
   *   message. `truncated` when there are more than were read.
   * Side effects: read requests to GitHub; one read of the beads issues.
   */
  async function issues(
    input: FolderRef,
    /**
     * The beads issues to go by, for a caller that has read them itself
     * (the folder's tracker may not be beads); the folder's own list when
     * left out.
     */
    own?: OwnIssue[],
  ): Promise<{
    state: "ok" | "unavailable" | "no-repository" | "no-token" | "error";
    message: string | null;
    repository: string | null;
    issues: RemoteIssue[];
    /** Beads issue id and the number of the GitHub issue it is linked to. */
    links: { id: string; number: number }[];
    truncated: boolean;
  }> {
    const none = { repository: null, issues: [], links: [], truncated: false };
    const start = await ready(input);
    if ("state" in start) return { ...start, ...none };
    const { path, repository, token } = start;
    const name = `${repository.owner}/${repository.name}`;
    // Which GitHub issue each beads issue is linked to.
    const linked = new Map<number, string>();
    // Every link, also where two issues here name the same GitHub issue:
    // the second is linked too, and must not be taken for one that is only
    // here and created on GitHub again.
    const links: { id: string; number: number }[] = [];
    let mine = own;
    if (mine === undefined) {
      const read = await store.readIssues(path);
      mine = read.state === "ok" ? read.issues : [];
    }
    for (const issue of mine) {
      const number = linkedNumber(issue.externalRef, repository);
      if (number === null) continue;
      links.push({ id: issue.id, number });
      if (!linked.has(number)) linked.set(number, issue.id);
    }
    const found: RemoteIssue[] = [];
    let truncated = false;
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await fetch(
          `https://api.github.com/repos/${repository.owner}/${repository.name}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "User-Agent": "airbender-bb-plugin",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        if (!response.ok) {
          const why =
            response.status === 401
              ? "GitHub did not accept the token. Check the \"GitHub token\" setting."
              : response.status === 403 || response.status === 404
                ? `The token cannot read the issues of ${name}, or that repository does not exist.`
                : `GitHub answered ${response.status}.`;
          return { state: "error", message: why, ...none, repository: name };
        }
        const rows = (await response.json()) as {
          number: number;
          title: string;
          html_url: string;
          state?: string;
          labels?: ({ name?: string } | string)[];
          pull_request?: unknown;
        }[];
        for (const row of rows) {
          // GitHub lists pull requests among the issues; they are not issues.
          if (row.pull_request !== undefined) continue;
          found.push({
            number: row.number,
            title: row.title,
            url: row.html_url,
            closed: row.state === "closed",
            labels: (row.labels ?? [])
              .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
              .filter((label) => label !== ""),
            linkedId: linked.get(row.number) ?? null,
          });
        }
        if (rows.length < 100) break;
        if (page === MAX_PAGES) truncated = true;
      }
    } catch (cause) {
      return {
        state: "error",
        message: `GitHub could not be reached: ${withoutToken(reason(cause), token)}`,
        ...none,
        repository: name,
      };
    }
    return {
      state: "ok",
      message: null,
      repository: name,
      issues: found,
      links,
      truncated,
    };
  }

  /**
   * One run of `bd github sync` in a folder, with the token and repository
   * in its environment only.
   *
   * @param onText Called with what it prints, as it prints it (already
   *   without the token), so that a long run can be watched.
   * @returns What it printed on both channels, or why it could not run.
   */
  async function runSync(
    path: string,
    args: string[],
    repository: Repository,
    token: string,
    onText: (text: string) => void,
  ): Promise<{ stdout: string; stderr: string } | { message: string }> {
    const bd = await folders.findBd(path);
    if (bd === null) return { message: folders.BD_NOT_FOUND_MESSAGE };
    return new Promise((resolve) => {
      const child = execFile(
        bd,
        ["github", "sync", ...args],
        {
          cwd: path,
          timeout: BATCH_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            GITHUB_TOKEN: token,
            GITHUB_REPOSITORY: `${repository.owner}/${repository.name}`,
          },
        },
        (error, stdout, stderr) => {
          const out = withoutToken(stdout, token);
          const err = withoutToken(stderr, token);
          if (error !== null) {
            const said =
              err
                .split("\n")
                .filter((line) => !line.startsWith("Warning:"))
                .join("\n")
                .trim() ||
              out.trim() ||
              withoutToken(error.message, token);
            bb.log.warn(`bd github sync failed in ${path}: ${said.slice(0, 400)}`);
            resolve({ message: said });
            return;
          }
          resolve({ stdout: out, stderr: err });
        },
      );
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer | string) =>
          onText(withoutToken(String(chunk), token)),
        );
      }
    });
  }

  /**
   * Closes a GitHub issue. The one change this file makes on GitHub itself
   * (see `work` for why the command cannot be left to do it).
   *
   * @returns Null when it is closed; otherwise why not.
   */
  async function closeOnGithub(
    repository: Repository,
    token: string,
    number: number,
  ): Promise<string | null> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repository.owner}/${repository.name}/issues/${number}`,
        {
          method: "PATCH",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "airbender-bb-plugin",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ state: "closed", state_reason: "completed" }),
        },
      );
      return response.ok ? null : `GitHub answered ${response.status}`;
    } catch (cause) {
      return withoutToken(reason(cause), token);
    }
  }

  /**
   * The texts of a beads issue's comments, for the comment copying; null
   * when they cannot be read.
   */
  const readLocal = (path: string, beadId: string): Promise<string[] | null> =>
    store.commentTextsIn(path, beadId);

  /** Adds a comment to a beads issue under another person's name. */
  const addAs = (
    path: string,
    beadId: string,
    author: string,
    text: string,
  ): Promise<string | null> => store.commentAsIn(path, beadId, author, text);

  /** The runs under way and just finished, by id. */
  const jobs = new Map<string, Job>();
  let jobCount = 0;

  /**
   * Does a job's runs, a batch of issues at a time, keeping the job's
   * progress up to date. Never throws: a problem becomes the job's message.
   *
   * In batches because the command says nothing while it works on a real
   * run, and one run for a hundred issues is minutes of silence (the user,
   * after syncing 101: "I had no idea what's going on"). A batch finished
   * is progress that can be shown, and a place where the run can be
   * stopped without cutting the command off in the middle of an issue.
   *
   * After a batch that sent issues to GitHub, the ones that are closed
   * here are closed there too. The command creates every issue open and
   * then counts it as in step, so the close would never follow; worse, the
   * next two-way sync would read "open on GitHub" as news and reopen the
   * issue here (seen on the user's first real sync: 91 closed issues
   * created open).
   */
  async function work(
    job: Job,
    plan: { label: string; flags: string[]; chosen: string[] }[],
    common: string[],
    start: { path: string; repository: Repository; token: string },
    preview: boolean,
    withComments: boolean,
  ): Promise<void> {
    const { path, repository, token } = start;
    const problems: string[] = [];
    try {
      for (const { label, flags, chosen } of plan) {
        for (let at = 0; at < chosen.length; at += BATCH_SIZE) {
          if (job.stopping) break;
          const batch = chosen.slice(at, at + BATCH_SIZE);
          job.doing = label;
          const pushing = !preview && flags.includes("--push-only");
          // Which of them are not on GitHub yet, to know afterwards which
          // were created by this batch.
          const before = pushing ? await store.readIssues(path) : null;
          const unlinked = new Set(
            before?.state === "ok"
              ? before.issues
                  .filter(
                    (issue) =>
                      batch.includes(issue.id) &&
                      linkedNumber(issue.externalRef, repository) === null,
                  )
                  .map((issue) => issue.id)
              : [],
          );
          const run = await runSync(
            path,
            [...flags, "--issues", batch.join(","), ...common],
            repository,
            token,
            (text) => {
              for (const line of text.split("\n")) {
                const said = line.trim();
                if (said !== "" && !said.startsWith("Dry run mode") && !said.startsWith("Run without")) {
                  job.lines.push(said);
                }
              }
              if (job.lines.length > MAX_LINES) {
                job.lines.splice(0, job.lines.length - MAX_LINES);
              }
            },
          );
          // The command changed issues here without going through the
          // store: the kept list no longer stands.
          store.stale(path);
          if ("message" in run) {
            problems.push(`${label}: ${run.message}`);
          } else {
            const part = parseSyncOutput(run.stdout, run.stderr);
            job.actions.push(...part.actions);
            job.notes.push(...part.notes);
            job.warnings.push(...part.warnings);
          }
          if (unlinked.size > 0) {
            const after = await store.readIssues(path);
            let closed = 0;
            for (const issue of after.state === "ok" ? after.issues : []) {
              if (!unlinked.has(issue.id) || issue.status !== CLOSED_STATUS) continue;
              const number = linkedNumber(issue.externalRef, repository);
              if (number === null) continue;
              const failed = await closeOnGithub(repository, token, number);
              if (failed === null) closed += 1;
              else job.warnings.push(`#${number} (${issue.id}) could not be closed on GitHub: ${failed}`);
            }
            if (closed > 0) {
              job.lines.push(`Closed ${closed} on GitHub (closed here).`);
              job.closedRemote += closed;
            }
          }
          // Comments, for a batch that brought issues in from GitHub (a
          // pull, or the two-way run of linked issues): the command
          // carries none, so they are copied after it. All of it is in
          // server/github-comments.ts; this only says which issues.
          if (withComments && !("message" in run) && !pushing && !flags.includes("--push-only")) {
            const now = await store.readIssues(path);
            const here = now.state === "ok" ? now.issues : [];
            const pairs = flags.includes("--pull-only")
              ? batch.map((number) => ({
                  number: Number(number),
                  beadId:
                    here.find(
                      (issue) =>
                        linkedNumber(issue.externalRef, repository) === Number(number),
                    )?.id ?? null,
                }))
              : batch.flatMap((id) => {
                  const number = linkedNumber(
                    here.find((issue) => issue.id === id)?.externalRef ?? null,
                    repository,
                  );
                  return number === null ? [] : [{ number, beadId: id }];
                });
            const done = await copyComments({
              repository,
              token,
              issues: pairs,
              preview,
              readLocal: (beadId) => readLocal(path, beadId),
              add: (beadId, author, text) => addAs(path, beadId, author, text),
            });
            job.copied += done.copied;
            job.notes.push(...done.would);
            job.warnings.push(...done.warnings);
            if (done.copied > 0) job.lines.push(`Copied ${comments(done.copied)}.`);
          }
          job.finished += batch.length;
        }
      }
    } catch (cause) {
      problems.push(withoutToken(reason(cause), token));
    }
    if (job.closedRemote > 0) {
      job.notes.push(
        `Closed ${job.closedRemote} ${job.closedRemote === 1 ? "issue" : "issues"} on GitHub that ${job.closedRemote === 1 ? "is" : "are"} closed here.`,
      );
    }
    if (job.copied > 0) {
      job.notes.push(`Copied ${comments(job.copied)} from GitHub.`);
    }
    if (job.stopping && job.finished < job.total) {
      job.notes.push(
        `Stopped after ${job.finished} of ${job.total}. What was done stays done; the rest was not touched.`,
      );
    }
    job.message = problems.length === 0 ? null : problems.join("\n");
    job.doing = null;
    job.done = true;
    if (!preview) store.changed(job.threadId);
    // Kept for a while so the window can read the end of it, then dropped.
    setTimeout(() => jobs.delete(job.id), JOB_KEPT_MS);
  }

  /**
   * Starts a sync of the chosen issues, or a preview of it, and returns at
   * once: the run is followed with `progress` and can be asked to stop.
   *
   * @param pull Numbers of GitHub issues to bring into beads.
   * @param both Ids of beads issues that are linked to a GitHub issue, to
   *   be brought into step in both directions.
   * @param push Ids of beads issues to send to GitHub.
   * @param prefer How an issue changed on both sides is settled.
   * @param preview Only say what would happen; change nothing.
   * @returns The job's id, or `message` saying why nothing was started.
   * Side effects: with `preview` false, the job writes to beads and to
   *   GitHub, and tells the tabs to reload when it ends.
   */
  async function sync(
    input: FolderRef & {
      pull: number[];
      both: string[];
      push: string[];
      prefer: Prefer;
      comments: boolean;
      preview: boolean;
    },
  ): Promise<{ jobId: string | null; message: string | null }> {
    const start = await ready(input);
    if ("state" in start) return { jobId: null, message: start.message };
    const pull = [...new Set(input.pull)].filter(
      (number) => Number.isInteger(number) && number > 0,
    );
    const ids = (given: string[]) =>
      [...new Set(given)].filter((id) => BEAD_ID_PATTERN.test(id));
    const both = ids(input.both);
    const push = ids(input.push);
    if (pull.length === 0 && both.length === 0 && push.length === 0) {
      return { jobId: null, message: "Nothing is ticked." };
    }
    if ([...jobs.values()].some((job) => !job.done && job.path === start.path)) {
      return { jobId: null, message: "A sync of this folder is already running." };
    }
    jobCount += 1;
    const job: Job = {
      id: `sync-${Date.now()}-${jobCount}`,
      path: start.path,
      threadId: input.threadId,
      total: pull.length + both.length + push.length,
      finished: 0,
      doing: null,
      lines: [],
      actions: [],
      notes: [],
      warnings: [],
      closedRemote: 0,
      copied: 0,
      message: null,
      done: false,
      stopping: false,
      startedAt: Date.now(),
    };
    jobs.set(job.id, job);
    void work(
      job,
      [
        { label: "From GitHub", flags: ["--pull-only"], chosen: pull.map(String) },
        { label: "Linked", flags: [], chosen: both },
        { label: "To GitHub", flags: ["--push-only"], chosen: push },
      ],
      [`--prefer-${input.prefer}`, ...(input.preview ? ["--dry-run"] : [])],
      start,
      input.preview,
      input.comments,
    );
    return { jobId: job.id, message: null };
  }

  /**
   * What copying the issues across would do when the repository's tracker
   * is switched: which exist only on the side being left and would be
   * created on the other, and which are on both sides already and would be
   * brought up to date. Nothing is changed.
   *
   * The window that offers the switch says this before anything is done
   * (bead-bb-c9l.18; the owner: "UI that doesn't ask you wrong questions
   * ... it will update issues that ... are linked ... and it will copy
   * over the issues that exist in a current and doesn't exist in a
   * target"). Only open issues are created on the other side: closed ones
   * by the hundred, on GitHub, could never be deleted again. Closed ones
   * that are linked are still brought up to date, so a close is carried.
   *
   * @param to The tracker being switched to.
   * @returns `cannot` null with the lists, or one sentence saying why no
   *   copy can be made (the lists are then empty).
   * Side effects: read requests to GitHub; one read of the beads issues.
   */
  async function switchPreview(
    input: FolderRef,
    to: "beads" | "github",
  ): Promise<SwitchPreview> {
    const none = {
      repository: null,
      createIds: [],
      createNumbers: [],
      update: [],
      closedLeft: 0,
      truncated: false,
      needsRepository: false,
    };
    const start = await ready(input);
    if ("state" in start) {
      return {
        cannot: start.message,
        ...none,
        needsRepository: start.state === "no-repository",
      };
    }
    const mine = await readBeads(start.path);
    if (mine === null) {
      return {
        cannot:
          to === "beads"
            ? "This folder has no beads database yet, so nothing can be copied into it now. After the switch the tab offers to set beads up; the issues can then be brought in with \"Import / export GitHub issues\"."
            : "This folder's beads issues could not be read, so nothing can be copied.",
        ...none,
      };
    }
    const remote = await issues(input, mine);
    if (remote.state !== "ok") {
      return {
        cannot: remote.message ?? "The GitHub issues could not be read.",
        ...none,
        repository: remote.repository,
      };
    }
    return {
      cannot: null,
      repository: remote.repository,
      truncated: remote.truncated,
      needsRepository: false,
      ...switchLists(to, mine, remote.issues, remote.links),
    };
  }

  /**
   * How a sync is getting on.
   *
   * @param stop Ask it to stop: it finishes the issues it is on (a batch)
   *   and starts no more.
   * @returns `known` false for a job that never was or was dropped long
   *   after it ended.
   */
  function progress(input: { jobId: string; stop: boolean }): {
    known: boolean;
    done: boolean;
    stopping: boolean;
    total: number;
    finished: number;
    doing: string | null;
    seconds: number;
    copied: number;
    lines: string[];
    message: string | null;
  } & SyncReport {
    const job = jobs.get(input.jobId);
    if (job === undefined) {
      return {
        known: false,
        done: true,
        stopping: false,
        total: 0,
        finished: 0,
        doing: null,
        seconds: 0,
        copied: 0,
        lines: [],
        message: "This sync is no longer known. Read the lists again to see where things stand.",
        actions: [],
        notes: [],
        warnings: [],
      };
    }
    if (input.stop && !job.done) job.stopping = true;
    return {
      known: true,
      done: job.done,
      stopping: job.stopping,
      total: job.total,
      finished: job.finished,
      doing: job.doing,
      seconds: Math.round((Date.now() - job.startedAt) / 1000),
      copied: job.copied,
      lines: job.lines.slice(-SHOWN_LINES),
      message: job.message,
      actions: job.actions,
      notes: job.notes,
      warnings: job.warnings,
    };
  }

  return { issues, sync, progress, switchPreview };
}

/** What createGithub returns. */
export type Github = ReturnType<typeof createGithub>;
