/**
 * The guard against new app-connection writes (#3004). Every hosted-path
 * `ui.db` write commits on the write worker; once an app is serving, an
 * app-connection write is a regression of #2850. The guard records each one
 * whose nearest package frame is server code (a test fixture's own direct
 * write is not a hosted path) and `assertClean()` names them.
 */
import type { Database } from "bun:sqlite";
import { observeAppWrites } from "../../src/db/write-worker.js";

const PACKAGE_FRAME = /packages\/[^/]+\/(?:src|tests)\/[^:)]+:\d+/;

export function guardAppWrites(db: Database) {
  const violations: string[] = [];
  observeAppWrites(db, write => {
    if (write.phase !== "serving") return;
    const frames = write.stack.split("\n").slice(1).map(line => line.match(PACKAGE_FRAME)?.[0])
      .filter((frame): frame is string => !!frame && !frame.includes("/src/db/write-worker.ts"));
    const nearest = frames[0];
    if (!nearest || nearest.includes("/tests/")) return;
    violations.push(`${nearest} (${write.rows} row${write.rows === 1 ? "" : "s"})${frames[1] ? ` <- ${frames[1]}` : ""}`);
  });
  return {
    violations,
    stop() { observeAppWrites(db, undefined); },
    assertClean() {
      observeAppWrites(db, undefined);
      if (violations.length) throw new Error(`APP_CONNECTION_WRITE_WHILE_SERVING: ${[...new Set(violations)].join("; ")}`);
    },
  };
}
