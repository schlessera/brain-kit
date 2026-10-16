/** CLI contract fixtures retain real maintenance execution with test-only copied inputs. */
import { afterEach } from "bun:test";
import { dirname, join } from "node:path";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../../src/brain/host-boundary.js";
import { createBrainClient, probeBrainCliVersion } from "../../src/brain/client.js";
import { ambientExecConfig } from "../../src/config/env.js";
import { createNativeAppFixture } from "./native-app-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function boundary(brainPath: string, exec: import("@schlessera/brain-ui-sdk/server").ExecWrapperConfig) {
  const native = createNativeAppFixture(brainPath); cleanup.push(native.close);
  return createHostBoundary({ brainPath, exec, dbPath: join(dirname(native.nativeBrain.leasePath), "ui.db"), nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
}
export function createFixtureBrainClient(options: Parameters<typeof createBrainClient>[0]) {
  const exec = options.exec ?? ambientExecConfig();
  return createBrainClient({ ...options, exec, boundary: options.boundary ?? boundary(options.brainPath, exec) });
}
export function probeFixtureBrainCliVersion(brainPath: string, log: Parameters<typeof probeBrainCliVersion>[1], options: Parameters<typeof probeBrainCliVersion>[2]) {
  return probeBrainCliVersion(brainPath, log, { ...options, boundary: options.boundary ?? boundary(brainPath, options.exec) });
}
