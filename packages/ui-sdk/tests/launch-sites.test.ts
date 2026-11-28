/**
 * #4301 A6: every way a sandbox is built, pinned. A new builder or a new
 * caller of the launch bootstrap fails here until it is classified in the
 * launch envelope table (docs/decisions/worker-writable-areas.md), and every
 * caller-command launch function reaches the namespace qualification before
 * it releases its start gate.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const sources = [...new Bun.Glob("packages/*/src/**/*.ts").scanSync({ cwd: ROOT })].sort();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** Calls, not declarations or comments. */
const calls = (name: string) => sources.flatMap(path => read(path).split("\n").flatMap((line, index) =>
  new RegExp(`(?<![\\w.])${name}\\(`).test(line) && !/^\s*(\/\/|\*)/.test(line) && !new RegExp(`function\\*?\\s+${name}\\(`).test(line)
    ? [`${path}:${enclosing(path, index)}`] : []));
/** The nearest enclosing named function of a line. */
function enclosing(path: string, line: number): string {
  const lines = read(path).split("\n");
  for (let at = line; at >= 0; at--) {
    const match = /^(?:export )?(?:async )?function\*? ?(\w+)\(/.exec(lines[at]!);
    if (match) return match[1]!;
  }
  return "<module>";
}
function body(path: string, name: string): string {
  const text = read(path), start = text.search(new RegExp(`^export function\\*? ${name}\\(`, "m"));
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("\n}\n", start));
}

describe("launch sites (#4301 A6)", () => {
  test("bubblewrap argv is built in exactly two files: the worker launcher and the web executor (L7, not qualified)", () => {
    const builders = sources.filter(path => /["']--unshare-(user|pid|net|ipc)["']/.test(read(path)));
    expect(builders, "SANDBOX_BUILDERS_CLASSIFIED").toEqual(["packages/ui-backend-pi/src/web-executor.ts", "packages/ui-sdk/src/server/worker-launcher.ts"]);
  });
  test("workerCommand feeds only the bootstrap; the bootstrap has exactly the classified callers", () => {
    expect(calls("workerCommand"), "WORKER_COMMAND_CALLERS").toEqual(["packages/ui-sdk/src/server/worker-launcher.ts:workerBootstrap"]);
    expect(calls("workerBootstrap"), "WORKER_BOOTSTRAP_CALLERS").toEqual([
      // L3: synchronous maintenance on spawnSync, not qualified; it walks (#4301 path O5, #5026).
      "packages/ui-sdk/src/server/maintenance-worker.ts:runMaintenanceWorkerSteps",
      "packages/ui-sdk/src/server/worker-launcher.ts:spawnQualifiedSteps",
      "packages/ui-sdk/src/server/worker-launcher.ts:launchAgentWorkerSteps",
      "packages/ui-sdk/src/server/worker-launcher.ts:probeWorkerHostSteps",
    ]);
    expect(calls("spawnQualifiedSteps").map(site => relative("packages", site)).sort(), "DIRECT_SPAWN_CALLERS").toEqual([
      "ui-sdk/src/server/maintenance-worker.ts:launchMaintenanceWorkerSteps",
    ]);
  });
  test("both caller-command launch functions qualify the namespace before they release the gate", () => {
    const launcher = "packages/ui-sdk/src/server/worker-launcher.ts";
    for (const [name, release] of [["spawnQualifiedSteps", "status.release()"], ["launchAgentWorkerSteps", "else status!.release()"]] as const) {
      const text = body(launcher, name);
      const qualify = text.indexOf("yield* qualifyWorkerNamespaceSteps("), released = text.indexOf(release);
      expect(qualify, `${name}_QUALIFIES`).toBeGreaterThan(0);
      expect(qualify, `${name}_QUALIFIES_BEFORE_RELEASE`).toBeLessThan(released);
      // Unconditional: not inside the governed-only folder check.
      expect(text.slice(text.lastIndexOf("\n", qualify), qualify).trim(), `${name}_UNCONDITIONAL`).toBe("");
    }
  });
});
