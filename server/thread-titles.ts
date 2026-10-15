// server/thread-titles.ts — each conversation named after what it works on.
//
// What: keeps a conversation's title in step with its current issue, as a
// few words summing the issue up ("Mac accessibility permission"), puts
// back the title it had
// before when the issue is cleared, and, for a conversation with no current
// issue, has a small model write a title that says what it is doing now.
//
// Why: the user wants to see at a glance which issue each conversation is
// working on (bead-bb-du7): "can we build it as part of Airbender to show
// which issue each thread is working on?" They agreed to these rules: a
// name for the issue ("the current issue summarized in very short words",
// no id); the old title back when the issue is cleared; a
// rename of their own wins until the conversation's issue changes; an AI
// summary for conversations with no issue, in Airbender rather than in a
// separate plugin.
//
// Design notes:
// - What Airbender last wrote is kept on the thread, under this plugin's
//   own metadata (key "title"). A title that differs from it was written by
//   someone else, which is how a user's rename is told apart.
// - The rules are pure functions (`onIssue`, `summaryDue`), tested in
//   thread-titles.test.ts; `createThreadTitles` only reads, decides and
//   writes, one thread at a time.
// - A title is re-checked when the current issue is stored (every way of
//   setting it goes through current-bead.ts), when a tab lists the issues
//   and when a turn ends, so an issue whose title was edited is followed.
//   Every conversation is also checked once after the plugin loads, so one
//   whose issue was set before an update is named without waiting for the
//   next change.
// - The short name of an issue is asked of the summary model once per
//   issue title and kept in the plugin's storage, shared by every
//   conversation on that issue. Without a model, or when it fails, the
//   issue title cut to the words that fit is used, and not kept, so a
//   model chosen later replaces it.
//
// Gotchas:
// - A conversation Airbender opens in a work tree is renamed only after BB
//   has named its branch, which BB does from the conversation's first title.
// - Hidden threads are left alone: the background sizing workers are told
//   apart by their title (server/sizing.ts), so renaming one would break it.
// - Nothing here may throw into its caller: a title is never worth failing a
//   change of issue or a list for. Failures are logged.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CurrentBead } from "./current-bead.ts";
import type { Store } from "./store.ts";
import {
  BACKENDS,
  backendProblem,
  fallbackShortName,
  generateShortName,
  generateTitle,
  type Backend,
  type BackendConfig,
} from "./summary-title.ts";

/** The longest AI-written summary title. */
const SUMMARY_LENGTH = 60;

/** How long a summary may take; local command-line models can be slow. */
const SUMMARY_TIMEOUT_MS = 120_000;

/** Key under which a thread's title bookkeeping is stored in its metadata. */
const TITLE_KEY = "title";

/** The summary backend setting's value that turns summaries off. */
export const SUMMARY_OFF = "off";
export const SUMMARY_BACKENDS = [SUMMARY_OFF, ...BACKENDS] as const;

/** What Airbender remembers about a thread's title. */
export interface TitleState {
  /** The issue whose title Airbender last wrote; null when none. */
  issueId: string | null;
  /** The title Airbender last wrote, for an issue or as a summary. */
  written: string | null;
  /** The title the thread had before its first issue; restored on clear. */
  before: string | null;
  /** The user renamed the thread since its issue last changed. */
  manual: boolean;
}

export const EMPTY_STATE: TitleState = {
  issueId: null,
  written: null,
  before: null,
  manual: false,
};

const stateSchema = z
  .object({
    issueId: z.string().nullable().catch(null),
    written: z.string().nullable().catch(null),
    before: z.string().nullable().catch(null),
    manual: z.boolean().catch(false),
  })
  .catch(EMPTY_STATE);

/** What a rule decided: the title to write (undefined: none) and the state. */
export interface Decision {
  write?: string | null;
  next: TitleState;
}

/**
 * Decides a thread's title from its current issue.
 *
 * @param state What Airbender remembers about the thread's title.
 * @param threadTitle The thread's title now (null: none, BB shows its own).
 * @param issueId The thread's current issue, or null.
 * @param desired The title for that issue (its short name); ignored when
 *   `issueId` is null.
 */
export function onIssue(
  state: TitleState,
  threadTitle: string | null,
  issueId: string | null,
  desired: string | null,
): Decision {
  if (issueId !== null && desired !== null) {
    if (state.issueId !== issueId) {
      // A new issue: a rename of the user's applied to the old one only.
      // The title to restore is the one from before the first issue, kept
      // across a switch from one issue to another.
      return {
        write: desired === threadTitle ? undefined : desired,
        next: {
          issueId,
          written: desired,
          before: state.issueId === null ? threadTitle : state.before,
          manual: false,
        },
      };
    }
    if (state.manual) return { next: state };
    if (threadTitle !== state.written) {
      return { next: { ...state, manual: true } };
    }
    if (desired !== state.written) {
      return { write: desired, next: { ...state, written: desired } };
    }
    return { next: state };
  }

  if (state.issueId === null) return { next: state };
  // The issue was cleared. The old title comes back, unless the user named
  // the thread themselves meanwhile: then their name stays, and it is
  // treated as theirs (no summary written over it).
  if (state.manual || threadTitle !== state.written) {
    return {
      next: { issueId: null, written: threadTitle, before: null, manual: true },
    };
  }
  return {
    write: state.before === threadTitle ? undefined : state.before,
    next: { issueId: null, written: state.before, before: null, manual: false },
  };
}

/**
 * Decides whether a thread with no current issue gets a new summary title.
 *
 * @returns `due` true when the model should be asked; `next` is the state to
 *   keep either way (a rename by the user is noted in it).
 */
export function summaryDue(
  state: TitleState,
  threadTitle: string | null,
): { due: boolean; next: TitleState } {
  if (state.issueId !== null || state.manual) return { due: false, next: state };
  // A title Airbender did not write: the user's, unless Airbender never
  // wrote one, in which case it is BB's first automatic title or none, and
  // is taken over.
  if (state.written !== null && threadTitle !== state.written) {
    return { due: false, next: { ...state, manual: true } };
  }
  return { due: true, next: state };
}

/** The settings the titles read, each time they are needed. */
export interface TitleSettings {
  issueTitles: boolean;
  summaryBackend: string;
  summary: Omit<BackendConfig, "backend">;
}

/** What the titles need of an issue. */
type IssueRef = { id: string; title: string; description?: string };

/** An issue's short name, kept with the title it was made from. */
const shortNameSchema = z.object({ source: z.string(), name: z.string() });

type ThreadDto = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

/**
 * Builds the title keeper for this plugin instance.
 *
 * @returns `issueChanged` (after a thread's current issue is stored),
 *   `check` (re-read a thread's issue and title) and `turnEnded` (after a
 *   turn, which may also write a summary).
 */
export function createThreadTitles({
  bb,
  store,
  currentBead,
  readSettings,
  beforeRename = async () => {},
}: {
  bb: BbPluginApi;
  store: Store;
  currentBead: CurrentBead;
  readSettings: () => Promise<TitleSettings>;
  /**
   * Awaited before a thread is renamed: a conversation opened in a work
   * tree has its branch named by BB after its first title, a moment after
   * it is opened, so it is renamed only once that is done.
   */
  beforeRename?: (threadId: string) => Promise<void>;
}) {
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());

  // One piece of work per thread at a time, in order; a check asked for
  // while one is already waiting is not queued twice.
  const queues = new Map<string, Promise<void>>();
  const waitingChecks = new Set<string>();

  function enqueue(threadId: string, work: () => Promise<void>): Promise<void> {
    const before = queues.get(threadId) ?? Promise.resolve();
    const next = before
      .then(work)
      .catch((cause) => {
        bb.log.warn(`title of ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => {
        if (queues.get(threadId) === next) queues.delete(threadId);
      });
    queues.set(threadId, next);
    return next;
  }

  async function readState(threadId: string): Promise<TitleState> {
    const own = (await bb.sdk.threads.getPluginMetadata({ threadId })) as Record<string, unknown>;
    return stateSchema.parse(own[TITLE_KEY] ?? EMPTY_STATE);
  }

  async function saveState(threadId: string, state: TitleState): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [TITLE_KEY]: { ...state } },
    });
  }

  function sameState(a: TitleState, b: TitleState): boolean {
    return (
      a.issueId === b.issueId &&
      a.written === b.written &&
      a.before === b.before &&
      a.manual === b.manual
    );
  }

  /** A thread that is ours to name: visible and not archived. */
  function nameable(thread: ThreadDto): boolean {
    return thread.visibility !== "hidden" && thread.archivedAt === null;
  }

  /**
   * The issue title for a thread's current issue, or null when unknown.
   *
   * @param known Issues already read (a tab's list), to spare a run of bend.
   */
  async function desiredFor(
    threadId: string,
    issueId: string,
    known?: readonly IssueRef[],
  ): Promise<string | null> {
    let issues = known;
    if (issues === undefined) {
      const found = await store.issuesIn({ threadId, projectId: null }, issueId);
      if ("message" in found) return null;
      issues = found.issues;
    }
    const issue = issues.find((candidate) => candidate.id === issueId);
    return issue === undefined ? null : shortNameOf(issue);
  }

  // Asked once per issue title, even by several conversations at once.
  const naming = new Map<string, Promise<string>>();

  /**
   * A few words summing an issue up, for a conversation's title: kept in
   * storage per issue and title, else asked of the summary model, else the
   * issue title cut to the words that fit (not kept).
   */
  function shortNameOf(issue: IssueRef): Promise<string> {
    const key = `${issue.id}\n${issue.title}`;
    const under = naming.get(key);
    if (under !== undefined) return under;
    const asked = (async () => {
      const storeKey = `short-name:${issue.id}`;
      const kept = shortNameSchema.safeParse(await bb.storage.kv.get(storeKey));
      if (kept.success && kept.data.source === issue.title) return kept.data.name;
      const config = await summaryConfig();
      if (config !== null) {
        try {
          const name = await generateShortName(
            config,
            issue.title,
            issue.description ?? "",
            AbortSignal.any([lifetime.signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]),
          );
          if (name !== null) {
            await bb.storage.kv.set(storeKey, { source: issue.title, name });
            return name;
          }
        } catch (cause) {
          bb.log.warn(`no short name for ${issue.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      return fallbackShortName(issue.title);
    })().finally(() => naming.delete(key));
    naming.set(key, asked);
    return asked;
  }

  /** The summary model's settings, or null when none is chosen or ready. */
  async function summaryConfig(): Promise<BackendConfig | null> {
    const settings = await readSettings();
    const backend = settings.summaryBackend;
    if (!(BACKENDS as readonly string[]).includes(backend)) return null;
    const config: BackendConfig = { ...settings.summary, backend: backend as Backend };
    return backendProblem(config) === null ? config : null;
  }

  /** Brings a thread's title in line with its current issue. */
  async function syncIssue(
    threadId: string,
    issueId: string | null,
    known?: readonly IssueRef[],
  ): Promise<TitleState | null> {
    const settings = await readSettings();
    const thread = await bb.sdk.threads.get({ threadId });
    if (!nameable(thread)) return null;
    const state = await readState(threadId);
    // With issue titles turned off nothing is written for an issue, but a
    // title written before is still put back when its issue is cleared.
    if (!settings.issueTitles && issueId !== null) return state;
    const desired = issueId === null ? null : await desiredFor(threadId, issueId, known);
    if (issueId !== null && desired === null) return state;
    const decision = onIssue(state, thread.title, issueId, desired);
    if (decision.write !== undefined) {
      await beforeRename(threadId);
      await bb.sdk.threads.update({ threadId, title: decision.write });
    }
    if (!sameState(state, decision.next)) await saveState(threadId, decision.next);
    return decision.next;
  }

  /** Asks the model for a summary title and writes it, when one is due. */
  async function summarize(
    threadId: string,
    state: TitleState,
    latestAssistantText: string | null,
  ): Promise<void> {
    const config = await summaryConfig();
    if (config === null) return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!nameable(thread)) return;
    const due = summaryDue(state, thread.title);
    if (!sameState(state, due.next)) await saveState(threadId, due.next);
    if (!due.due) return;

    const outline = await bb.sdk.threads.conversationOutline({ threadId });
    const messages = outline.items.map((item) => ({ role: item.role, text: item.preview }));
    if (messages.length === 0 && latestAssistantText === null) return;
    const title = await generateTitle(
      config,
      {
        currentTitle: thread.title ?? thread.titleFallback,
        messages,
        latestAssistantText,
        maxLength: SUMMARY_LENGTH,
      },
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]),
    );
    if (title === null) return;
    // The model may take a while: the user may have renamed the thread, or
    // an issue may have been set, in the meantime.
    const now = await bb.sdk.threads.get({ threadId });
    const latest = await readState(threadId);
    if (now.title !== thread.title || latest.issueId !== null || latest.manual) return;
    if (title !== now.title) await bb.sdk.threads.update({ threadId, title });
    await saveState(threadId, { ...latest, written: title });
  }

  /** After a thread's current issue was stored: name it after the issue. */
  function issueChanged(threadId: string, issueId: string | null): void {
    void enqueue(threadId, async () => {
      await syncIssue(threadId, issueId);
    });
  }

  /**
   * Re-reads a thread's issue and brings its title in line (edits followed).
   *
   * @param known The issues a tab just listed for this thread, so the check
   *   does not run bend a second time; read afresh when left out.
   */
  function check(threadId: string, known?: readonly IssueRef[]): void {
    if (waitingChecks.has(threadId)) return;
    waitingChecks.add(threadId);
    void enqueue(threadId, async () => {
      waitingChecks.delete(threadId);
      await syncIssue(threadId, await currentBead.read(threadId), known);
    });
  }

  /**
   * Checks every visible, unarchived conversation once, one at a time:
   * those whose current issue was set before this version of the plugin
   * loaded (or while it was off) get their title then, not only at the next
   * change. Conversations with no current issue are passed over, so no
   * bend runs for them.
   *
   * Side effects: one list request per page, one metadata read per
   * conversation, and a check for each that has a current issue.
   */
  async function reconcile(): Promise<void> {
    const PAGE = 100;
    // Bounded, like current-bead.ts's heldAmong.
    for (let offset = 0; offset < 20 * PAGE; offset += PAGE) {
      const threads = await bb.sdk.threads.list({ archived: false, limit: PAGE, offset });
      for (const thread of threads) {
        if (lifetime.signal.aborted) return;
        if (thread.visibility === "hidden") continue;
        const issueId = await currentBead.read(thread.id).catch(() => null);
        if (issueId === null) continue;
        check(thread.id);
        await queues.get(thread.id);
      }
      if (threads.length < PAGE) break;
    }
  }

  /** After a turn ended: follow the issue, or write a summary when it has none. */
  function turnEnded(threadId: string, latestAssistantText: string | null): void {
    void enqueue(threadId, async () => {
      const issueId = await currentBead.read(threadId);
      const state = await syncIssue(threadId, issueId);
      if (state !== null && issueId === null) {
        await summarize(threadId, state, latestAssistantText);
      }
    });
  }

  /** Resolves when every queued piece of title work has finished. */
  async function settled(): Promise<void> {
    while (queues.size > 0) await Promise.all([...queues.values()]);
  }

  return { issueChanged, check, turnEnded, reconcile, settled };
}

/** What createThreadTitles returns. */
export type ThreadTitles = ReturnType<typeof createThreadTitles>;
