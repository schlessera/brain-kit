/** CLI contract fixtures retain real maintenance execution with test-only copied inputs. */
import { afterAll, afterEach } from "bun:test";
import { dirname, join } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../../src/brain/host-boundary.js";
import { createBrainClient, probeBrainCliVersion } from "../../src/brain/client.js";
import { ambientExecConfig } from "../../src/config/env.js";
import { createNativeAppFixture } from "./native-app-fixture.js";

/** Call once in each suite: Bun caches imports, but hooks belong to the calling suite. */
export function installNativeBrainClientFixtures() {
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

  function boundary(brainPath: string, exec: import("@schlessera/brain-ui-sdk/server").ExecWrapperConfig) {
    const native = createNativeAppFixture(brainPath); cleanup.push(native.close);
    return createHostBoundary({ brainPath, exec, dbPath: join(dirname(native.nativeBrain.leasePath), "ui.db"), nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
  }
  function createFixtureBrainClient(options: Parameters<typeof createBrainClient>[0]) {
    const exec = options.exec ?? ambientExecConfig();
    return createBrainClient({ ...options, exec, boundary: options.boundary ?? boundary(options.brainPath, exec) });
  }
  function probeFixtureBrainCliVersion(brainPath: string, log: Parameters<typeof probeBrainCliVersion>[1], options: Parameters<typeof probeBrainCliVersion>[2]) {
    return probeBrainCliVersion(brainPath, log, { ...options, boundary: options.boundary ?? boundary(brainPath, options.exec) });
  }
  return { createFixtureBrainClient, probeFixtureBrainCliVersion, close };
}
