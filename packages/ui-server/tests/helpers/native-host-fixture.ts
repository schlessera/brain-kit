/** Explicit copied native inputs for ordinary host contracts; no filesystem qualification. */
import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../../src/brain/host-boundary.js";
import { createHostExecution } from "../../src/brain/host-execution.js";
import { createNativeAppFixture } from "./native-app-fixture.js";
/** Call once in each suite: Bun caches imports, but hooks belong to the calling suite. */
export function installNativeHostFixtures() {
  const cleanup: Array<() => Promise<void>> = [];
  async function close() {
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Native fixture cleanup failed");
  }
  afterEach(close);
  afterAll(close);

  function manager(brainPath: string) {
    const fixture = createNativeAppFixture(brainPath); cleanup.push(fixture.close);
    return createNativeBrainManagerClient(fixture.nativeBrain);
  }
  function statePath() {
    const state = mkdtempSync(join(tmpdir(), "odysseus-host-state-"));
    cleanup.push(async () => { rmSync(state, { recursive: true, force: true }); });
    return join(state, "ui.db");
  }
  function createFixtureHostBoundary(options: Parameters<typeof createHostBoundary>[0]) {
    return createHostBoundary({ ...options, dbPath: options.dbPath ?? statePath(), nativeManager: options.nativeManager ?? manager(options.brainPath) });
  }
  function createFixtureHostExecution(options: Parameters<typeof createHostExecution>[0]) {
    return createHostExecution({ ...options, dbPath: options.dbPath ?? statePath(), nativeManager: options.nativeManager ?? manager(options.brainPath) });
  }
  return { createFixtureHostBoundary, createFixtureHostExecution, close };
}
