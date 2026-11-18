---
name: simple-close
description: Complete an Airbender Simple close when the user has chosen Commit only or Commit & push and the working conversation received a pending close request. Use its request id after committing; do not use for Standard workflow reports or ordinary Git work.
---

# Complete a Simple close

The Close dialog sends the working conversation its chosen ending, Git action,
repository, branch, request id and completion command. It leaves the issue open.
This is an explicit request from the user to commit that issue's changes.

1. Read the issue with `bend show <id>` and `bend comments <id>`. Review this
   conversation and the diff to identify its changes. Follow the repository's
   commit rules. Select only this issue's changes, including portions of shared
   files where needed. If ownership is uncertain, ask the user and leave it open.
2. Commit on the requested branch with the issue's id and title in the
   subject, for example `<id>: <title>`, following repository conventions.
   A failed commit leaves the issue open. Do not discard,
   merge, create branches or include unrelated work.
3. Push only for Commit & push. Commit only makes no explicit push; preserve
   repository hooks, including automatic push hooks. Report any push failure.
4. After a successful commit, run from the requested working conversation:

   ```sh
   bb airbender finish-close --request <request-id> --commit <full-commit-sha>
   ```

   For Commit & push, include `--push-result success` or
   `--push-result 'failed: <reason>'`. A push failure does not undo the commit
   or require another one. For an automatic hook's push failure, include its
   failed result too.

The command changes no Git state. It verifies the persisted request, caller,
repository, branch and supplied commit, then closes through bend with the chosen
ending and closing note. Open descendants prevent closure. Unrelated changes
can remain. Repeating the same completion is safe. Report a refusal and leave
the issue open; do not bypass it with `bend close` or a Standard workflow move.
