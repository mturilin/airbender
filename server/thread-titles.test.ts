// server/thread-titles.test.ts — tests for naming conversations after their issue.
//
// What: checks the rules that decide a conversation's title: the issue's
// short id and title, the old title back when the issue is cleared, a rename
// of the user's kept until the issue changes, and when a summary is due.
//
// Why: these are the user's rules (bead-bb-du7). Getting one wrong either
// writes over a name the user chose or leaves a stale issue in the sidebar.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CurrentBead } from "./current-bead.ts";
import type { Store } from "./store.ts";
import {
  EMPTY_STATE,
  createThreadTitles,
  type TitleSettings,
  onIssue,
  summaryDue,
  type TitleState,
} from "./thread-titles.ts";

const A = "Issue dates";
const B = "Conversation names";

test("setting an issue names the thread and remembers the old title", () => {
  const d = onIssue(EMPTY_STATE, "Old name", "bead-bb-tj4", A);
  assert.equal(d.write, A);
  assert.deepEqual(d.next, { issueId: "bead-bb-tj4", written: A, before: "Old name", manual: false });
});

test("clearing the issue puts the old title back", () => {
  const set = onIssue(EMPTY_STATE, "Old name", "bead-bb-tj4", A).next;
  const d = onIssue(set, A, null, null);
  assert.equal(d.write, "Old name");
  assert.deepEqual(d.next, { issueId: null, written: "Old name", before: null, manual: false });
});

test("clearing restores no title at all when the thread had none", () => {
  const set = onIssue(EMPTY_STATE, null, "bead-bb-tj4", A).next;
  const d = onIssue(set, A, null, null);
  assert.equal(d.write, null);
});

test("switching issues keeps the title from before the first one", () => {
  const first = onIssue(EMPTY_STATE, "Old name", "bead-bb-tj4", A).next;
  const d = onIssue(first, A, "bead-bb-du7", B);
  assert.equal(d.write, B);
  assert.equal(d.next.before, "Old name");
  assert.equal(onIssue(d.next, B, null, null).write, "Old name");
});

test("an edited issue title is followed", () => {
  const set = onIssue(EMPTY_STATE, null, "bead-bb-tj4", A).next;
  const edited = "Created and changed dates";
  const d = onIssue(set, A, "bead-bb-tj4", edited);
  assert.equal(d.write, edited);
  assert.equal(d.next.written, edited);
  assert.equal(onIssue(d.next, edited, "bead-bb-tj4", edited).write, undefined);
});

test("a rename by the user wins until the issue changes", () => {
  const set = onIssue(EMPTY_STATE, null, "bead-bb-tj4", A).next;
  const renamed = onIssue(set, "My name", "bead-bb-tj4", A);
  assert.equal(renamed.write, undefined);
  assert.equal(renamed.next.manual, true);
  // Still kept on later checks, even when the issue's title is edited.
  const edited = "Edited";
  assert.equal(onIssue(renamed.next, "My name", "bead-bb-tj4", edited).write, undefined);
  // A new issue takes over again.
  const next = onIssue(renamed.next, "My name", "bead-bb-du7", B);
  assert.equal(next.write, B);
  assert.equal(next.next.manual, false);
});

test("clearing after a rename keeps the user's name and no summary is written over it", () => {
  const set = onIssue(EMPTY_STATE, "Old", "bead-bb-tj4", A).next;
  const d = onIssue(set, "My name", null, null);
  assert.equal(d.write, undefined);
  assert.equal(d.next.manual, true);
  assert.equal(summaryDue(d.next, "My name").due, false);
});

test("nothing happens with no issue before or now", () => {
  const d = onIssue(EMPTY_STATE, "Whatever", null, null);
  assert.equal(d.write, undefined);
  assert.equal(d.next, EMPTY_STATE);
});

test("a summary is due on a thread Airbender has not named, or named itself", () => {
  assert.equal(summaryDue(EMPTY_STATE, null).due, true);
  assert.equal(summaryDue(EMPTY_STATE, "BB's first title").due, true);
  const own: TitleState = { ...EMPTY_STATE, written: "Summary" };
  assert.equal(summaryDue(own, "Summary").due, true);
});

test("no summary on a thread with an issue, or one the user renamed", () => {
  const withIssue = onIssue(EMPTY_STATE, null, "bead-bb-tj4", A).next;
  assert.equal(summaryDue(withIssue, A).due, false);
  const own: TitleState = { ...EMPTY_STATE, written: "Summary" };
  const renamed = summaryDue(own, "Mine");
  assert.equal(renamed.due, false);
  assert.equal(renamed.next.manual, true);
});

// --- The keeper against a fake BB -------------------------------------------
//
// Drives createThreadTitles the way server.ts does: a current issue stored,
// a tab listing, a turn ending. The summary uses the real command backend
// with `echo`, so the prompt goes through a real child process.


function fakeWorld(issues: { id: string; title: string }[]) {
  const thread = {
    id: "thr_1",
    title: "Old name" as string | null,
    titleFallback: "first message",
    visibility: "visible",
    archivedAt: null,
  };
  const metadata: Record<string, unknown> = {};
  let current: string | null = null;
  const writes: (string | null)[] = [];
  const kv = new Map<string, unknown>();
  const bb = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onDispose() {},
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
          kv.set(key, structuredClone(value));
        },
      },
    },
    sdk: {
      threads: {
        get: async () => ({ ...thread }),
        list: async () => [{ ...thread }],
        update: async ({ title }: { title: string | null }) => {
          thread.title = title;
          writes.push(title);
        },
        getPluginMetadata: async () => structuredClone(metadata),
        updatePluginMetadata: async ({ set }: { set: Record<string, unknown> }) => {
          Object.assign(metadata, structuredClone(set));
        },
        conversationOutline: async () => ({
          items: [{ id: "m1", role: "user", preview: "fix the login flow", attachmentSummary: null }],
          maxSeq: 1,
        }),
      },
    },
  } as unknown as BbPluginApi;
  const store = {
    issuesIn: async (_: unknown, id: string) =>
      issues.some((issue) => issue.id === id)
        ? { path: "/repo", issues }
        : { message: `${id} is not in the list` },
  } as unknown as Store;
  const currentBead = { read: async () => current } as unknown as CurrentBead;
  const settings: TitleSettings = {
    issueTitles: true,
    summaryBackend: "command",
    summary: {
      geminiApiKey: "",
      geminiModel: "",
      openaiBaseUrl: "",
      openaiApiKey: "",
      openaiModel: "",
      // Issue prompts get "Short <issue title>"; conversation prompts a summary.
      command:
        "p=$(cat); case \"$p\" in *'<issue-title>'*) printf '%s\\n' \"$p\" | sed -n 's/.*<issue-title>\\(.*\\)<\\/issue-title>.*/Short \\1/p';; *) echo '\"Fix the login flow.\"';; esac",
    },
  };
  const titles = createThreadTitles({ bb, store, currentBead, readSettings: async () => settings });
  return {
    thread,
    writes,
    kv,
    settings,
    titles,
    setCurrent(id: string | null) {
      current = id;
      titles.issueChanged("thr_1", id);
    },
    /** Sets the current issue the way it was before an update: unheard. */
    setCurrentQuietly(id: string | null) {
      current = id;
    },
  };
}

test("keeper: set, edit, rename, clear and summarise, end to end", async () => {
  const issues = [{ id: "bead-bb-tj4", title: "Show created date" }];
  const world = fakeWorld(issues);

  world.setCurrent("bead-bb-tj4");
  await world.titles.settled();
  assert.equal(world.thread.title, "Short Show created date");

  // The issue's title is edited; a tab listing notices.
  issues[0] = { id: "bead-bb-tj4", title: "Show both dates" };
  world.titles.check("thr_1");
  await world.titles.settled();
  assert.equal(world.thread.title, "Short Show both dates");

  // A turn ends with an issue: no summary is written.
  world.titles.turnEnded("thr_1", "done");
  await world.titles.settled();
  assert.equal(world.thread.title, "Short Show both dates");

  // Cleared: the old name comes back.
  world.setCurrent(null);
  await world.titles.settled();
  assert.equal(world.thread.title, "Old name");

  // No issue: a turn ends and the model names it.
  world.titles.turnEnded("thr_1", "I fixed the login redirect.");
  await world.titles.settled();
  assert.equal(world.thread.title, "Fix the login flow");

  // The user renames it: no more summaries.
  world.thread.title = "My own name";
  world.titles.turnEnded("thr_1", "more work");
  await world.titles.settled();
  assert.equal(world.thread.title, "My own name");

  // A new issue takes over, and clearing it brings back the user's name.
  world.setCurrent("bead-bb-tj4");
  await world.titles.settled();
  assert.equal(world.thread.title, "Short Show both dates");
  world.setCurrent(null);
  await world.titles.settled();
  assert.equal(world.thread.title, "My own name");
});

test("keeper: issue titles turned off leave the name alone", async () => {
  const world = fakeWorld([{ id: "bead-bb-tj4", title: "Anything" }]);
  world.settings.issueTitles = false;
  world.setCurrent("bead-bb-tj4");
  await world.titles.settled();
  assert.equal(world.thread.title, "Old name");
  assert.deepEqual(world.writes, []);
});

test("keeper: an unknown issue changes nothing", async () => {
  const world = fakeWorld([]);
  world.setCurrent("bead-bb-zzz");
  await world.titles.settled();
  assert.equal(world.thread.title, "Old name");
});

test("keeper: an issue set before the plugin loaded is caught up at load", async () => {
  const world = fakeWorld([{ id: "bead-bb-tj4", title: "Show dates" }]);
  world.setCurrentQuietly("bead-bb-tj4");
  await world.titles.reconcile();
  await world.titles.settled();
  assert.equal(world.thread.title, "Short Show dates");
});

test("keeper: catching up passes over a conversation with no issue", async () => {
  const world = fakeWorld([]);
  await world.titles.reconcile();
  await world.titles.settled();
  assert.deepEqual(world.writes, []);
});

test("keeper: without a model the issue title is cut to a short name", async () => {
  const world = fakeWorld([
    { id: "litedraft-axi", title: "Mac: the app asks for the Accessibility permission itself" },
  ]);
  world.settings.summaryBackend = "off";
  world.setCurrent("litedraft-axi");
  await world.titles.settled();
  assert.equal(world.thread.title, "the app asks for the…");
  // Not kept: a model chosen later replaces it.
  assert.equal(world.kv.size, 0);
});

test("keeper: an issue's short name is asked once and kept per issue title", async () => {
  const world = fakeWorld([{ id: "bead-bb-tj4", title: "Show dates" }]);
  world.setCurrent("bead-bb-tj4");
  await world.titles.settled();
  assert.deepEqual(world.kv.get("short-name:bead-bb-tj4"), {
    source: "Show dates",
    name: "Short Show dates",
  });
  // A kept name is used without asking: change what the model would say.
  world.settings.summary.command = "cat >/dev/null; echo Other";
  world.setCurrent(null);
  await world.titles.settled();
  world.setCurrent("bead-bb-tj4");
  await world.titles.settled();
  assert.equal(world.thread.title, "Short Show dates");
});
