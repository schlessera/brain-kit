/**
 * A fake gog for tests (plan §11, "Fake gog"): a Bun-shebang executable
 * named `gog` in a fresh directory, driven by a scenario file and recording
 * every call. Hand `fake.binary` to `createGogTransport`; that parameter is
 * the only way in, and it skips the pin. It is registered with the offline
 * test guard (scripts/test-network-guard.ts), which refuses to spawn any
 * other executable named `gog`, and refuses this one too once its file no
 * longer holds the shim the guard expects.
 *
 *   const fake = createFakeGog({ "gmail.labels.list": { stdout: labels } });
 *   const transport = createGogTransport({ binary: fake.binary, account: "ithaca", environment: fake.environment });
 *   …
 *   fake.dispose();
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGogShim, registerFakeGog } from "../../../../scripts/test-network-guard";
import type { GogBinary, GogEnvironmentConfig } from "../../src/google/gog/index.ts";
import type { FakeGogCall, FakeGogScenario } from "./fake-gog-child.ts";

export type { FakeGogAnswer, FakeGogCall, FakeGogScenario } from "./fake-gog-child.ts";

export interface FakeGog {
  /** The fake's absolute path, named `gog`. */
  executable: string;
  binary: GogBinary;
  /** An environment config whose home is the fake's own empty directory. */
  environment: GogEnvironmentConfig;
  dir: string;
  setScenario(scenario: FakeGogScenario): void;
  /** Every call so far, in start order. */
  calls(): FakeGogCall[];
  /** Calls of one command key. */
  callsOf(command: string): FakeGogCall[];
  /** A path under the fake's directory, for `wait_for` gates. */
  path(name: string): string;
  dispose(): void;
}

export function createFakeGog(scenario: FakeGogScenario = {}): FakeGog {
  const dir = mkdtempSync(join(tmpdir(), "fake-gog-"));
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  const home = join(dir, "home");
  for (const path of [bin, calls, home]) mkdirSync(path, { mode: 0o700 });
  const scenarioPath = join(dir, "scenario.json");
  const executable = join(bin, "gog");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  // The guard's own shim: Bun running fake-gog-child.ts with this directory's scenario and call log.
  writeFileSync(executable, fakeGogShim(executable));
  chmodSync(executable, 0o700);
  const unregister = registerFakeGog(executable);
  const all = (): FakeGogCall[] => readdirSync(calls).filter(name => name.endsWith(".json")).flatMap(name => {
    const text = readFileSync(join(calls, name), "utf8");
    return text ? [JSON.parse(text) as FakeGogCall] : [];
  }).sort((a, b) => a.started_at - b.started_at || a.ordinal - b.ordinal);
  return {
    executable,
    binary: { kind: "fake", path: executable },
    environment: { home, keyringPassword: "penelope-weaves-by-day" },
    dir,
    setScenario: next => writeFileSync(scenarioPath, JSON.stringify(next)),
    calls: all,
    callsOf: command => all().filter(call => call.command === command),
    path: name => join(dir, name),
    dispose: () => {
      unregister();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
