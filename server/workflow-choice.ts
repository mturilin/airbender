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
//   git's own files rather than running git. A main checkout has a `.git`
//   directory. A work tree has a `.git` file, "gitdir: <its entry inside
//   the main repository>", and that entry holds a `commondir` file pointing
//   at the shared git directory.
// - The folder may be on another machine (bead-bb-fyv), so those files are
//   read there, which takes waiting: `readRepositoryKey` reads them when a
//   request finds its folder (folders.folderFor) and keeps the answer, and
//   `repositoryKey` answers from what is kept. The key includes the machine
//   for a folder that is not on the BB machine (folderKey): each machine's
//   copy of a repository is its own, with its own choice.
//
// Gotchas:
// - A separate clone of a repository is a different repository on disk and
//   has its own choice.
// - If git's files cannot be read as expected, the folder is its own key:
//   it then behaves like a separate repository, on the default.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isAbsolute, join, resolve } from "node:path";
import { folderKey, machineOf, onSameMachine } from "./machine.ts";
import type { Folder } from "./machine.ts";
import {
  DEFAULT_WORKFLOW_ID,
  isWorkflowId,
  workflowFor,
} from "../shared/workflows.ts";
import type { WorkflowId } from "../shared/workflows.ts";
import type { Workflow } from "../shared/workflow.ts";

/** Storage key for the choices, kept across reloads. */
const CHOICES_KEY = "workflowChoices";

/** Each folder's repository key (by folderKey), as last read. */
const repositoryKeys = new Map<string, string>();

/**
 * Reads the key a folder's choice is stored under, on the folder's
 * machine: its repository's shared git directory, so that every work tree
 * of a repository gives the same key; and keeps it for `repositoryKey`.
 *
 * @param folder A folder: a main checkout, a work tree, or neither.
 * @returns The folderKey of that directory; of the folder itself when it
 *   is not a git folder or its git files cannot be read. Reads files;
 *   changes nothing.
 */
export async function readRepositoryKey(folder: Folder): Promise<string> {
  const key = folderKey(onSameMachine(folder, await sharedGitDir(folder)));
  repositoryKeys.set(folderKey(folder), key);
  return key;
}

/** The repository's shared git directory, or the folder itself. */
async function sharedGitDir(folder: Folder): Promise<string> {
  const machine = machineOf(folder);
  const { path } = folder;
  const dotGit = join(path, ".git");
  const found = await machine.stat(dotGit);
  if (found === null) return resolve(path);
  if (found.kind === "directory") return resolve(dotGit);
  // A work tree: ".git" is a file naming this tree's entry in the
  // repository it belongs to.
  const pointer = /^gitdir:\s*(.+)$/m.exec((await machine.read(dotGit)) ?? "");
  if (pointer === null) return resolve(path);
  const entry = pointer[1]!.trim();
  const gitDir = isAbsolute(entry) ? entry : resolve(path, entry);
  // That entry says where the shared directory is, usually "../..".
  const common = (await machine.read(join(gitDir, "commondir")))?.trim();
  if (common === undefined || common === "") return resolve(path);
  return isAbsolute(common) ? resolve(common) : resolve(gitDir, common);
}

/**
 * The key a folder's choice is stored under, as last read
 * (`readRepositoryKey`); the folder's own key when it was never read.
 */
export function repositoryKey(folder: Folder): string {
  return repositoryKeys.get(folderKey(folder)) ?? folderKey(folder);
}

/** What the rest of the server asks about a folder's workflow. */
export interface WorkflowChoice {
  /** The folder's choice; the default when its repository never chose. */
  idFor: (folder: Folder) => WorkflowId;
  /** The state machine for the folder; null on the simple workflow. */
  workflowFor: (folder: Folder) => Workflow | null;
  /**
   * Stores a choice for the folder's repository.
   *
   * @throws When the choice cannot be saved; it is then not changed in
   *   memory either, so what is shown stays what is stored.
   */
  set: (folder: Folder, id: WorkflowId) => Promise<void>;
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
  const idFor = (folder: Folder) =>
    choices.get(repositoryKey(folder)) ?? DEFAULT_WORKFLOW_ID;
  return {
    idFor,
    workflowFor: (folder) => workflowFor(idFor(folder)),
    set: async (folder, id) => {
      const next = new Map(choices).set(repositoryKey(folder), id);
      await bb.storage.kv.set(CHOICES_KEY, Object.fromEntries(next));
      choices.set(repositoryKey(folder), id);
    },
  };
}
