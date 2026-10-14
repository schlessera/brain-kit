/** Explicit offline broker for app contracts; copied test roots never qualify Btrfs behavior. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MANAGER_MAX_DELTA_BYTES, NATIVE_MANAGER_OPERATION_TIMEOUT_MS } from "@schlessera/brain-ui-sdk/internal";
import { createNativeJournalFixture } from "./native-journal-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "./fixture-native-startup.js";

export function createNativeAppFixture(brainPath: string) {
  const state = mkdtempSync(join(tmpdir(), "odysseus-native-app-")), native = createNativeJournalFixture(brainPath, state);
  const broker = native.serve(), restore = replaceNativeStartupAcquisitionForFixture();
  const leasePath = join(state, "native-leases.sqlite");
  let closed = false;
  return { nativeBrain: { socketPath: broker.socketPath, leasePath, timeoutMs: NATIVE_MANAGER_OPERATION_TIMEOUT_MS, maxDeltaBytes: NATIVE_MANAGER_MAX_DELTA_BYTES },
    env: { BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_UI_NATIVE_BRAIN_LEASE_PATH: leasePath },
    async close() { if (closed) return; closed = true; try { broker.close(); await native.close(); } finally { restore(); rmSync(state, { recursive: true, force: true }); } },
  };
}

const generatedNative = new WeakSet<object>();

/** Real app contracts use a named test-only storage fixture, never a product bypass. */
export async function createFixtureApp(options: import("../../src/app.js").CreateAppOptions = {}) {
  const { createApp } = await import("../../src/app.js");
  const { resolveServerConfig } = await import("../../src/config/env.js");
  const config = options.config ?? resolveServerConfig();
  if (config.nativeBrain && !generatedNative.has(config.nativeBrain)) return createApp(options);
  const native = createNativeAppFixture(config.brainPath);
  generatedNative.add(native.nativeBrain);
  try {
    const app = await createApp({ ...options, config: { ...config, nativeBrain: native.nativeBrain } });
    const close = app.close;
    let closing: Promise<void> | undefined;
    app.close = () => closing ??= (async () => { try { await close(); } finally { await native.close(); } })();
    return app;
  } catch (error) { await native.close(); throw error; }
}
