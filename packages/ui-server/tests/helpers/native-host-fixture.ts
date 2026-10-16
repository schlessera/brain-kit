/** Explicit copied native inputs for ordinary host contracts; no filesystem qualification. */
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../../src/brain/host-boundary.js";
import { createHostExecution } from "../../src/brain/host-execution.js";
import { createNativeAppFixture } from "./native-app-fixture.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function manager(brainPath: string) {
  const fixture = createNativeAppFixture(brainPath); cleanup.push(fixture.close);
  return createNativeBrainManagerClient(fixture.nativeBrain);
}
function statePath() {
  const state = mkdtempSync(join(tmpdir(), "odysseus-host-state-"));
  cleanup.push(async () => { rmSync(state, { recursive: true, force: true }); });
  return join(state, "ui.db");
}
export function createFixtureHostBoundary(options: Parameters<typeof createHostBoundary>[0]) {
  return createHostBoundary({ ...options, dbPath: options.dbPath ?? statePath(), nativeManager: options.nativeManager ?? manager(options.brainPath) });
}
export function createFixtureHostExecution(options: Parameters<typeof createHostExecution>[0]) {
  return createHostExecution({ ...options, dbPath: options.dbPath ?? statePath(), nativeManager: options.nativeManager ?? manager(options.brainPath) });
}
