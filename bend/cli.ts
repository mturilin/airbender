// bend/cli.ts — starts `bend` as a real program.
//
// What: connects the command in main.ts to the process: its arguments,
// standard input and output, the current folder and the exit status.
//
// Why: main.ts takes its surroundings as an argument so it can be tested;
// this file is the one place that hands it the real ones.
//
// Gotchas:
// - The exit status is set and the process left to end by itself, so that
//   everything printed is flushed first.

import { readFileSync } from "node:fs";
import { run } from "./main.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  // File descriptor 0 is standard input; read whole, as text.
  stdin: () => readFileSync(0, "utf8"),
  cwd: process.cwd(),
});
