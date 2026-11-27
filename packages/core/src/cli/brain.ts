#!/usr/bin/env bun
/**
 * brain — the CLI bin entry. The CLI itself is `runBrainCli` (main.ts); this
 * file owns the process around it: the stream-backed console, stdio
 * completion and the exit code.
 */

import { Console } from "node:console";

import { runBrainCli } from "./main.js";

// Bun's native console can bypass the stream's pending-write accounting after
// process.stdout is initialized. Use the stream-backed Console so its writes,
// including command/library diagnostics, join direct stdout/stderr writes.
const streamConsole = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
  ignoreErrors: false,
});
Object.assign(console, {
  log: streamConsole.log,
  error: streamConsole.error,
  warn: streamConsole.warn,
  info: streamConsole.info,
  debug: streamConsole.debug,
});

let outputError = false;
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => { outputError = true; });
}

async function finish(code: number): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((resolve) => {
      if (stream.destroyed) return resolve();
      const done = () => {
        stream.off("error", done);
        resolve();
      };
      stream.once("error", done);
      stream.end(done);
    })
  ));
  // Only stdio completion delays exit; provider sockets/timers cannot keep a
  // finished command alive. An output failure is an internal failure.
  process.exit(outputError ? 2 : code);
}

runBrainCli(process.argv.slice(2)).then(finish);
