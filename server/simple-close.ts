// simple-close.ts — durable delivery and completion of Simple closes.
//
// What: previews a close, sends an explicitly requested commit to the working
// conversation, then closes through bend after a verified completion report.
// Why: an agent owns selecting changes; neither an arbitrary HEAD change nor
// a sentence in chat proves that its requested commit was made (bead-bb-o6j).
// Design notes: injected boundaries keep this testable without BB or a live
// tracker. Each request is persisted before delivery and serialized per issue.
// Gotchas: persistence can fail after a tracker write. Retrying uses the same
// request id and closing options, and the tracker deduplicates the close note.

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ENDINGS, GIT_CHOICES } from "../shared/closing.ts";
import type { ClosingOptions, Ending, GitChoice } from "../shared/closing.ts";
import { descendantsOf } from "../shared/tree.ts";
import type { Issue } from "./contract.ts";
import { folderOfKey } from "./machine.ts";

export interface CloseScope { threadId: string | null; projectId: string | null; beadId: string }
/** `path` here is always a folderKey (server/machine.ts): the folder may be
 * on another machine than BB's (bead-bb-fyv), and stored requests keep it. */
export interface CloseContext { path: string; repository: string; projectId: string; issue: Issue; issues: Issue[]; simple: boolean }
export interface WorkingConversation { threadId: string; path: string }
export interface CloseGitState { repository: string; branch: string | null; head: string | null; changes: boolean }

const requestSchema = z.object({
  id: z.string(), index: z.string(), scope: z.object({ threadId: z.string().nullable(), projectId: z.string().nullable(), beadId: z.string() }),
  path: z.string(), repository: z.string(), branch: z.string(), baseline: z.string().nullable(),
  threadId: z.string(), title: z.string(), ending: z.enum(ENDINGS), git: z.enum(GIT_CHOICES),
  duplicateOf: z.string().nullable(), delivered: z.boolean(), completed: z.string().nullable(),
});
export type CloseRequest = z.infer<typeof requestSchema>;

export interface SimpleCloseDependencies {
  load(scope: CloseScope): Promise<CloseContext>;
  working(context: CloseContext, scope: CloseScope): Promise<WorkingConversation | { reason: string }>;
  git(path: string): Promise<CloseGitState | null>;
  verify(request: CloseRequest, commit: string): Promise<string | null>;
  send(threadId: string, message: string): Promise<void>;
  close(scope: CloseScope, options: ClosingOptions): Promise<{ message: string | null }>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  released(threadId: string, beadId: string): Promise<void>;
  id?(): string;
}

/** Describes the server-checked options without creating a pending request. */
export interface ClosePreview {
  message: string | null; changes: boolean; conversationId: string | null;
  unavailableReason: string | null; blocked: string | null; pending: boolean;
}

/** Checks the parent rule independently of which ending/Git choice was picked. */
export function closeBlocked(context: CloseContext): string | null {
  return descendantsOf(context.issue.id, context.issues).some((issue) => issue.status !== "closed")
    ? "This issue has open sub-issues. Close them first." : null;
}

/** Builds the close operations. Only request/complete can write or send. */
export function createSimpleClose(deps: SimpleCloseDependencies) {
  const locks = new Map<string, Promise<unknown>>();
  /** Serializes one issue's requests and completions, including failures. */
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }
  /** Uses a bounded storage key even when repository paths are long. */
  const indexFor = (context: CloseContext) => "simple-close:index:" + createHash("sha256").update(context.repository + "\0" + context.issue.id).digest("hex");
  /** Reads and validates persisted data; malformed data is never acted on. */
  async function read(id: string): Promise<CloseRequest | null> {
    const parsed = requestSchema.safeParse(await deps.get("simple-close:request:" + id));
    return parsed.success ? parsed.data : null;
  }
  /** Persists a complete request before its corresponding external action. */
  const save = (request: CloseRequest) => deps.set("simple-close:request:" + request.id, request);
  /** Refuses workflow changes and missing/closed issues before dispatch. */
  function check(context: CloseContext, open = true): void {
    if (!context.simple) throw new Error("Use the Standard workflow's close controls in this repository.");
    if (open && context.issue.status === "closed") throw new Error("This issue is already closed.");
    const blocked = closeBlocked(context); if (blocked !== null) throw new Error(blocked);
  }
  /** Turns expected errors into the same plain-language response as other actions. */
  const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

  /** A conversation lookup failure disables committing, not a direct close.
   * No issue is changed here; callers still validate the tracker and Git. */
  async function findWorking(context: CloseContext, scope: CloseScope) {
    try { return await deps.working(context, scope); }
    catch (error) { return { reason: `Could not identify the working conversation: ${reason(error)}` }; }
  }

  /** Reads current options; a failed read never silently permits a commit. */
  async function preview(scope: CloseScope): Promise<ClosePreview> {
    const empty: ClosePreview = { message: null, changes: false, conversationId: null, unavailableReason: null, blocked: null, pending: false };
    try {
      const context = await deps.load(scope); check(context);
      const working = await findWorking(context, scope);
      const path = "reason" in working ? context.path : working.path;
      const state = await deps.git(path);
      const index = await deps.get(indexFor(context));
      const pending = typeof index === "string" ? await read(index) : null;
      return { ...empty, changes: state?.changes ?? false,
        conversationId: "reason" in working ? null : working.threadId,
        unavailableReason: "reason" in working ? working.reason : state?.branch == null ? "A checked-out Git branch is needed to commit." : null,
        pending: pending !== null && pending.completed === null };
    } catch (error) { return { ...empty, message: reason(error), blocked: reason(error) }; }
  }

  /** Saves and sends the agent instruction; failure leaves it retryable. */
  async function deliver(pending: CloseRequest): Promise<{ message: string | null; openThreadId?: string }> {
    if (pending.delivered) return { message: "The close request is already with the working agent.", openThreadId: pending.threadId };
    const command = `bb airbender finish-close --request ${pending.id} --commit <full-commit-sha>`;
    const push = pending.git === "push"
      ? "Push the commit on this branch. Report a push failure without making another commit. Include --push-result success or --push-result 'failed: <reason>' in the completion command."
      : "Make no explicit push. Do not disable the repository's hooks; if a hook's push fails, report it and include --push-result 'failed: <reason>' in the completion command.";
    await deps.send(pending.threadId, `The user chose to close issue ${pending.scope.beadId}: ${JSON.stringify(pending.title)} as ${pending.ending}, with ${pending.git === "push" ? "Commit & push" : "Commit only"}. Work in ${JSON.stringify(folderOfKey(pending.path).path)} on branch ${JSON.stringify(pending.branch)}. Review this conversation and the diff, then commit only this issue's changes, selecting portions of shared files when needed. Follow the repository's commit rules and use the issue's id and title in the subject. If the changes cannot be identified confidently, ask the user and leave the issue open. If the commit fails, leave it open. Do not discard, merge or include unrelated work. ${push} After the commit is made, run ${command}. This command records the chosen ending and closes through bend; do not call the Standard workflow tool or close the issue another way.`);
    pending.delivered = true; await save(pending);
    return { message: null, openThreadId: pending.threadId };
  }

  /** Revalidates the dialog and either closes directly or queues agent work. */
  async function request(input: CloseScope & { ending: Ending; git: GitChoice; duplicateOf: string | null }) {
    try {
      if (!ENDINGS.includes(input.ending) || !GIT_CHOICES.includes(input.git)) throw new Error("Unknown ending or Git choice.");
      const first = await deps.load(input);
      return await exclusive(indexFor(first), async () => {
        const context = await deps.load(input); check(context);
        if (input.duplicateOf !== null && (input.ending !== "duplicate" || input.duplicateOf === input.beadId || !context.issues.some((issue) => issue.id === input.duplicateOf))) throw new Error("Choose another existing issue as the duplicate target.");
        if (input.git === "none") {
          const result = await deps.close(input, { ending: input.ending, duplicateOf: input.duplicateOf ?? undefined });
          if (result.message === null) {
            const working = await findWorking(context, input);
            if (!("reason" in working)) await deps.released(working.threadId, input.beadId);
            // Invalidate an older request: closing without a commit supersedes it.
            await deps.set(indexFor(context), null);
          }
          return result;
        }
        const working = await findWorking(context, input);
        if ("reason" in working) throw new Error(working.reason);
        const state = await deps.git(working.path);
        if (state === null || state.branch === null) throw new Error("A checked-out Git branch is needed to commit.");
        if (!state.changes) throw new Error("There are no changes to commit. Close without a commit instead.");
        const index = indexFor(context);
        const priorId = await deps.get(index);
        const prior = typeof priorId === "string" ? await read(priorId) : null;
        if (prior !== null && prior.completed === null) {
          if (prior.ending !== input.ending || prior.git !== input.git || prior.duplicateOf !== input.duplicateOf || prior.threadId !== working.threadId || prior.path !== working.path || prior.branch !== state.branch) throw new Error("A different close request is pending. Resolve it in the working conversation or close without a commit first.");
          return deliver(prior);
        }
        const pending: CloseRequest = { id: (deps.id ?? randomUUID)(), index, scope: { ...input, threadId: working.threadId, projectId: context.projectId },
          path: working.path, repository: state.repository, branch: state.branch, baseline: state.head,
          threadId: working.threadId, title: context.issue.title, ending: input.ending, git: input.git,
          duplicateOf: input.duplicateOf, delivered: false, completed: null };
        await save(pending); await deps.set(index, pending.id);
        return deliver(pending);
      });
    } catch (error) { return { message: reason(error) }; }
  }

  /** Completes only the persisted request, from its working thread. All Git
   * checks are read-only; the tracker is changed only after they pass. */
  async function complete(id: string, commit: string, threadId: string | null, pushResult?: string) {
    try {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(id) || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Give the request id and the full commit SHA.");
      const first = await read(id); if (first === null) throw new Error("No pending close request with that id.");
      return await exclusive(first.index, async () => {
        const pending = await read(id); if (pending === null) throw new Error("The close request no longer exists.");
        if (threadId !== pending.threadId) throw new Error("Only the working conversation can complete this close request.");
        if (pending.completed !== null) {
          if (pending.completed !== commit) throw new Error("This request was completed with a different commit.");
          return { message: null };
        }
        if (await deps.get(pending.index) !== id) throw new Error("This close request was superseded.");
        const context = await deps.load(pending.scope); check(context, false);
        const state = await deps.git(pending.path);
        if (context.path !== pending.path || state === null || state.repository !== pending.repository || state.branch !== pending.branch) throw new Error("The working repository or branch changed. The issue was left open.");
        const problem = await deps.verify(pending, commit); if (problem !== null) throw new Error(problem);
        if (pending.git === "push" && !/^(success|failed: .+)$/s.test(pushResult?.trim() ?? "")) throw new Error("Report --push-result success or --push-result 'failed: <reason>' before completing this close.");
        const result = await deps.close(pending.scope, { ending: pending.ending, commit, duplicateOf: pending.duplicateOf ?? undefined, requestId: pending.id, pushResult });
        if (result.message !== null) return result;
        pending.completed = commit; await save(pending);
        await deps.released(pending.threadId, pending.scope.beadId);
        return { message: null };
      });
    } catch (error) { return { message: reason(error) }; }
  }
  return { preview, request, complete };
}
