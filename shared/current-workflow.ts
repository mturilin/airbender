// shared/current-workflow.ts — which workflow issues follow.
//
// What: names the workflow in use.
//
// Why: the tab and the server must follow the same workflow, and neither
// should know its steps by name. Both import `workflow` from here, so
// choosing another workflow, or one day choosing per repository, is a change
// in this one file.

import { standardWorkflow } from "./standard-workflow.ts";
import type { Workflow } from "./workflow.ts";

/** The workflow every issue follows. */
export const workflow: Workflow = standardWorkflow;
