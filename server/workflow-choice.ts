// server/workflow-choice.ts — which workflow each repository uses.
//
// What: remembers, per repository, whether it is on the standard workflow
// or the simple one, and answers that at once for any folder.
//
// Why: the user chooses the workflow per repository (bead-bb-8j6), and a
// work tree must follow its repository's choice ("worktrees should continue
// existing flow"), not start again on the default.
//
// Design notes:
// - Kept in the plugin's own storage, on this machine. A file inside the
//   repository was rejected: it would show up in git for what is a personal
//   preference. beads' own settings were rejected too: reading them takes a
//   `bd` call on every look, where this answers from memory.
// - `get` is synchronous: the choices are loaded once at start and kept in
//   memory. It was first needed that way to decide an agent's tools, which
//   cannot wait; the tools are now offered everywhere (bead-bb-8fm), and
//   the quick answer is kept because every list and every move asks.
// - The key is the repository's shared git directory, found by reading
//   git's own files rather than running git, so it needs no waiting. A main
//   checkout has a `.git` directory. A work tree has a `.git` file,
//   "gitdir: <its entry inside the main repository>", and that entry holds
//   a `commondir` file pointing at the shared git directory.
//
// Gotchas:
// - A separate clone of a repository is a different repository on disk and
//   has its own choice.
// - If git's files cannot be read as expected, the folder is its own key:
//   it then behaves like a separate repository, on the default.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_WORKFLOW_ID,
  isWorkflowId,
  workflowFor,
} from "../shared/workflows.ts";
import type { WorkflowId } from "../shared/workflows.ts";
import type { Workflow } from "../shared/workflow.ts";

/** Storage key for the choices, kept across reloads. */
const CHOICES_KEY = "workflowChoices";

/**
 * The key a folder's choice is stored under: its repository's shared git
 * directory, so that every work tree of a repository gives the same key.
 *
 * @param path A folder: a main checkout, a work tree, or neither.
 * @returns An absolute path. The folder itself when it is not a git folder
 *   or its git files cannot be read. Reads files; changes nothing.
 */
export function repositoryKey(path: string): string {
  const dotGit = join(path, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return resolve(dotGit);
    // A work tree: ".git" is a file naming this tree's entry in the
    // repository it belongs to.
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (pointer === null) return resolve(path);
    const entry = pointer[1]!.trim();
    const gitDir = isAbsolute(entry) ? entry : resolve(path, entry);
    // That entry says where the shared directory is, usually "../..".
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    return isAbsolute(common) ? resolve(common) : resolve(gitDir, common);
  } catch {
    return resolve(path);
  }
}

/** What the rest of the server asks about a folder's workflow. */
export interface WorkflowChoice {
  /** The folder's choice; the default when its repository never chose. */
  idFor: (path: string) => WorkflowId;
  /** The state machine for the folder; null on the simple workflow. */
  workflowFor: (path: string) => Workflow | null;
  /**
   * Stores a choice for the folder's repository.
   *
   * @throws When the choice cannot be saved; it is then not changed in
   *   memory either, so what is shown stays what is stored.
   */
  set: (path: string, id: WorkflowId) => Promise<void>;
}

/**
 * Loads the stored choices and builds the lookups.
 *
 * Side effects: one read of the plugin's storage now; one write per `set`.
 */
export async function createWorkflowChoice(
  bb: BbPluginApi,
): Promise<WorkflowChoice> {
  /** Repository key -> choice. Only repositories that chose are in it. */
  const choices = new Map<string, WorkflowId>();
  const saved = await bb.storage.kv
    .get<unknown>(CHOICES_KEY)
    .catch(() => undefined);
  if (typeof saved === "object" && saved !== null) {
    for (const [key, id] of Object.entries(saved)) {
      if (isWorkflowId(id)) choices.set(key, id);
    }
  }
  const idFor = (path: string) =>
    choices.get(repositoryKey(path)) ?? DEFAULT_WORKFLOW_ID;
  return {
    idFor,
    workflowFor: (path) => workflowFor(idFor(path)),
    set: async (path, id) => {
      const next = new Map(choices).set(repositoryKey(path), id);
      await bb.storage.kv.set(CHOICES_KEY, Object.fromEntries(next));
      choices.set(repositoryKey(path), id);
    },
  };
}
