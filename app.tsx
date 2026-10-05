// bb-plugin-airbender — frontend entry.
//
// Where things are: this file only registers the plugin's surfaces with BB.
// The tab is app/panel.tsx (BeadsPanel) and the files it draws on: rows in
// app/issue-row.tsx, an opened issue in app/issue-details.tsx, the status
// groups in app/section-block.tsx, the new-issue field in
// app/create-issue.tsx, the Group and Filter menus in app/menus.tsx, setup in
// app/setup.tsx. The message-box controls are app/composer.tsx. Logic with no
// React in it (grouping, blocking, search ranking, quick tags) is in
// app/issue-model.ts and app/quick-tags.ts, where it can be tested. The
// notes below describe the frontend as a whole.
//
// What: the "Beads" tab in BB's right-hand panel. It lists the beads issues of
// the folder a thread works in, grouped by what you can do about them. Also
// three small controls in a thread's message box: a pill for the current
// issue and two quick-reply buttons (see the registration at the end).
//
// Why: issues are most useful beside the agent doing the work, so the tab
// lives next to a thread (and on the New thread screen, to pick what to start).
//
// Design notes:
// - Three bands. Pinned at the top: Current (the bead this thread works on)
//   and a toolbar with the folder and refresh. In the middle,
//   scrolling: the issues grouped by status. Pinned at the bottom: the field
//   for a new issue. The tab therefore asks BB for the "flush" layout and
//   does its own scrolling.
// - An opened issue shows its description, then one folded heading for each
//   other thing beads holds about it: acceptance criteria, design, notes,
//   close reason, comments. Each opens on its own chevron; empty ones are
//   left out. Comments are fetched only when their heading is opened.
// - Every issue is a collapsed row that opens on its chevron, so a long
//   description never pushes the rest of the tab away; the Current row's
//   opened text is additionally capped in height because it is pinned.
// - Issues can sit inside other issues, to any depth. A sub-issue is drawn
//   indented under its parent, whatever its status, and only one level is
//   drawn; a details button on any issue with sub-issues opens a window on
//   it, and the same button inside the window goes deeper. Dragging a row
//   onto another nests it; dragging it onto anything that is not a row
//   moves it out to the top level.
// - Every issue can have one category, shown and changed on its row like
//   type and priority. The list of categories is simply the ones in use.
// - The Ready group can be divided into collapsible sub-groups by priority,
//   type or category (the Group menu on the Ready heading, with the Filter
//   menu beside it; Ready is therefore always shown). Grouping arranges;
//   it is separate from filtering, which hides.
// - Filters (types, priorities, categories) hide rows; they never regroup and never hide
//   Current. They are remembered per folder in the browser.
// - The Closed group's heading is always shown, last in the list, with its
//   count and a Show/Hide button; its issues start hidden every time the
//   tab opens.
// - The tab can create, close and reopen issues, change an issue's type
//   and priority in place, edit its title and description from inside the
//   opened issue, and mark which bead a thread is working on (a note kept
//   in BB, not in beads). It cannot delete an issue or edit its design,
//   acceptance criteria, notes or comments.
// - "Define" starts a background agent for the job and marks the row
//   while it is busy; the thread the user is in is not touched.
// - One component, two entry points: a thread tab passes its thread id, the
//   New thread screen passes the selected project id. server.ts turns either
//   into a folder.
// - The list is refreshed when the tab opens, when the Refresh button is
//   pressed, when the BB window regains focus, and when server.ts signals a
//   change: one made through this plugin, or one made outside it (an agent or
//   a terminal running bd), which server.ts notices by watching a file that
//   beads rewrites on every write. There is deliberately no
//   timer: beads keeps its database in a single local store, and polling it
//   would compete with an agent that is writing issues at the same moment.
//
// Gotchas:
// - Only TYPES may be imported from the backend (server.ts, server/*).
//   Importing a value would pull the backend (and Node's child_process) into
//   the browser bundle. Values both sides need live in shared/constants.ts,
//   which has no imports and is safe to bundle on either side.
// - Compiled by `bb plugin build`; React and the SDK come from BB at load
//   time, so this file only runs inside BB.
// - Colors come from BB's theme tokens (text-muted-foreground, border-border
//   and so on), never fixed colors, so the tab follows the selected theme.

import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ComposerCurrentIssue, QuickReplyButton } from "./app/composer.tsx";
import { BeadsPanel } from "./app/panel.tsx";

// Two registrations of the same tab: BB offers a different slot for an
// existing thread than for the New thread screen, and each hands the tab a
// different id to work from.
export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "issues",
    title: "Airbender",
    icon: "ListTodo",
    // "flush": the tab does its own scrolling so its top and bottom stay put.
    layout: "flush",
    component: ({ threadId }) => (
      <BeadsPanel scope={{ threadId, projectId: null }} />
    ),
  });
  app.slots.experimental_newThreadPanelAction({
    id: "issues",
    title: "Airbender",
    icon: "ListTodo",
    layout: "flush",
    component: ({ projectId }) => (
      <BeadsPanel scope={{ threadId: null, projectId }} />
    ),
  });
  // The main window's message box (bead-bb-3l4): the current-issue pill and
  // the two quick-reply buttons, in its row of controls. Threads only: on
  // the New thread screen there is no agent to answer and no current issue.
  // BB does not draw plugin controls here in its compact layout.
  app.composer.customize({
    id: "main-window",
    scopes: ["thread"],
    actions: [
      { id: "current-issue", component: ComposerCurrentIssue },
      {
        id: "reply-go",
        component: () => <QuickReplyButton kind="go" label="Go" icon="ArrowRight" />,
      },
      {
        id: "reply-agree",
        component: () => (
          <QuickReplyButton kind="agree" label="Agree & go" icon="Check" />
        ),
      },
    ],
  });
});
