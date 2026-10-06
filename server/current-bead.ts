// server/current-bead.ts — which issue a thread is working on.
//
// What: reads and records a thread's "current bead": the issue the thread's
// agent is working on, which the tab shows in its own highlighted group.
//
// Why: the user wants to see at a glance what each conversation is working
// on, and the tab keeps its workflow buttons to that issue while one is set.
//
// Design notes:
// - It is a note kept by BB on the thread (plugin metadata), not in beads:
//   setting it does not change the issue.
// - "None" is stored as an explicit null rather than by removing the key.
//
// Gotchas:
// - The plugin used to have another id. A thread's choice from that time is
//   stored under the old id and is still read when nothing is stored under
//   the present one, which is what kept the data across the rename, and is
//   why "none" has to be stored and not simply removed.
// - Thread metadata can be written by anything with access to the thread,
//   so a stored value is checked before it is believed.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BEAD_ID_PATTERN, CHANGED_CHANNEL } from "../shared/constants.ts";

/**
 * The id this plugin had before it was renamed to "airbender". BB keeps a
 * plugin's per-thread data under the plugin's id, so each thread's current
 * bead from before the rename is still stored under this one; it is read as
 * a fallback (see `read`) and never written.
 */
const LEGACY_PLUGIN_ID = "beads";

/** Key under which a thread's current bead id is stored in thread metadata. */
const CURRENT_BEAD_KEY = "currentBead";

/**
 * Builds the current-bead operations for this plugin instance.
 *
 * @returns `read`, `store` (record without telling anyone) and `write`
 *   (record and tell every open tab to reload).
 */
export function createCurrentBead(bb: BbPluginApi) {
  /**
   * Reads which issue a thread is working on.
   *
   * @returns The stored id, or null when none is stored or the stored value is
   *   not a plausible id. Thread metadata can be written by anything with
   *   access to the thread, so the value is checked, not trusted.
   */
  async function read(threadId: string | null): Promise<string | null> {
    if (threadId === null) return null;
    const asBeadId = (value: unknown) =>
      typeof value === "string" && BEAD_ID_PATTERN.test(value) ? value : null;
    const own = (await bb.sdk.threads.getPluginMetadata({
      threadId,
    })) as Record<string, unknown>;
    // Anything stored under this plugin's own id decides, including a
    // stored "none" (see store).
    if (CURRENT_BEAD_KEY in own) return asBeadId(own[CURRENT_BEAD_KEY]);
    // Nothing under our own id: the thread may have its choice from before
    // the plugin was renamed, stored under the old id. Reading it here is
    // what keeps that data across the rename. A failure to read it is not
    // worth failing the whole list for.
    const legacy = (await bb.sdk.threads
      .getPluginMetadata({ threadId, pluginId: LEGACY_PLUGIN_ID })
      .catch(() => ({}))) as Record<string, unknown>;
    return asBeadId(legacy[CURRENT_BEAD_KEY]);
  }

  /**
   * Records (or, with null, clears) the issue a thread is working on,
   * without publishing a change. For callers that publish themselves, or
   * that are already answering with the corrected value.
   *
   * Pre-condition: `beadId`, when given, already matches BEAD_ID_PATTERN.
   * Side effects: writes this plugin's metadata on the thread.
   */
  async function store(threadId: string, beadId: string | null): Promise<void> {
    // "None" is stored as an explicit null, not by removing the key: with
    // the key gone, `read` would fall back to what the thread had
    // under the plugin's old id, and a cleared choice would come back.
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { [CURRENT_BEAD_KEY]: beadId },
    });
  }

  /**
   * Records (or, with null, clears) the issue a thread is working on and tells
   * every open tab to reload.
   *
   * Pre-condition: `beadId`, when given, already matches BEAD_ID_PATTERN.
   * Side effects: writes this plugin's metadata on the thread; publishes
   *   CHANGED_CHANNEL. Beads' own database is not touched.
   */
  async function write(threadId: string, beadId: string | null): Promise<void> {
    await store(threadId, beadId);
    bb.realtime.publish(CHANGED_CHANNEL, { threadId });
  }

  /**
   * Which of some issues are the current issue of a conversation, in any
   * conversation of a project that is not archived (bead-bb-ty5.2: an epic
   * is not given a branch while one of its issues is being worked on
   * somewhere).
   *
   * @param ids The issues asked about.
   * @returns Those of them that are current somewhere, each once, in the
   *   order found. A conversation whose note cannot be read is passed over.
   * @throws When BB cannot list the project's conversations.
   * Side effects: one or more list requests, and one read per conversation.
   */
  async function heldAmong(
    projectId: string,
    ids: ReadonlySet<string>,
  ): Promise<string[]> {
    if (ids.size === 0) return [];
    const held = new Set<string>();
    const PAGE = 100;
    // Bounded: a project with more open conversations than this is not
    // read to the end, and the check errs on the side of allowing.
    for (let offset = 0; offset < 20 * PAGE; offset += PAGE) {
      const threads = await bb.sdk.threads.list({ projectId, limit: PAGE, offset });
      const found = await Promise.all(
        threads.map((thread) => read(thread.id).catch(() => null)),
      );
      for (const beadId of found) {
        if (beadId !== null && ids.has(beadId)) held.add(beadId);
      }
      if (threads.length < PAGE) break;
    }
    return [...held];
  }

  return { read, store, write, heldAmong };
}

/** What createCurrentBead returns. */
export type CurrentBead = ReturnType<typeof createCurrentBead>;
