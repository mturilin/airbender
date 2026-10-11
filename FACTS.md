<!-- airbender: the facts saved in beads were reviewed -->
# Facts

Standing facts about this project, for every session: how to build and run
it, its conventions, lasting preferences of its owner. One line per fact,
under a short key, like the ones below. Keep it short: this file is read at
the start of every session.

- **build-and-reload** — Build and reload the BB plugin from the repository root: npx tsc --noEmit && bb plugin build && bb plugin reload airbender. Tests: npm test. The plugin's id is 'airbender'. bb commands need to reach the local BB server, which an agent sandbox may block. To move a local plugin, 'bb plugin install <new path>' (keeps settings); do not 'bb plugin remove' (deletes settings).
- **work-trees** — Git worktrees for this user go in <repo>/.worktrees/<tree> (the user's convention, 2026-10-05), not in a sibling folder. .worktrees/ is ignored through .git/info/exclude. From inside a worktree, bd needs to write its lock in the main checkout's .beads, which an agent sandbox may block.
- **monospace-ids** — An issue id is shown in the monospace font. Wherever it stands on a line with other text, put the id and that text together in one row aligned on the baseline (items-baseline), never centred box against box (a Button centres its content, so wrap the text parts in an inner baseline row and leave the icon outside). Leave it exactly on the baseline: it can look as if it rides high, which is an illusion of the monospace letters; a one-pixel nudge down was tried and the user took it back (bead-bb-fmg). To check an alignment complaint, measure the screenshot's pixel rows before changing anything.
