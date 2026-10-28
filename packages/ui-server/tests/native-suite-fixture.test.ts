import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import * as output from "../../ui-sdk/src/server/worker-native-output.js";
import * as native from "./helpers/native-app-fixture.js";
import { installNativeHostFixtures } from "./helpers/native-host-fixture.js";
import { installNativeBrainClientFixtures } from "./helpers/native-brain-client-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

const hosts = installNativeHostFixtures();
const clients = installNativeBrainClientFixtures();
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "odysseus-suite-owner-"));
  roots.push(path);
  return path;
}
afterAll(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }); });

test("cached native helpers register cleanup in each importing suite", async () => {
  const directory = root();
  const helperRoot = resolve(import.meta.dir, "helpers");
  // Separate real Bun suites share one cached module. No global mock restoration
  // or cleanup hook in the observer can conceal an unreleased fixture owner.
  writeFileSync(join(directory, "observe.ts"), `
    import { expect, spyOn } from "bun:test";
    import { existsSync } from "node:fs";
    import { dirname } from "node:path";
    import * as startup from ${JSON.stringify(resolve(import.meta.dir, "../../ui-sdk/src/server/worker-startup-view.ts"))};
    import * as output from ${JSON.stringify(resolve(import.meta.dir, "../../ui-sdk/src/server/worker-native-output.ts"))};
    import * as native from ${JSON.stringify(join(helperRoot, "native-app-fixture.ts"))};
    const originalStartup = startup.prepareNativeWorkerStartupView;
    const originalOutput = output.prepareNativeWorkerOutput;
    const create = native.createNativeAppFixture;
    export const owners: ReturnType<typeof create>[] = [];
    export const observer = spyOn(native, "createNativeAppFixture").mockImplementation((brain) => {
      const owner = create(brain); owners.push(owner); return owner;
    });
    export function released(count: number) {
      expect(owners.length, "EXACT_REAL_NATIVE_OWNER_COUNT").toBe(count);
      owners.forEach((owner, index) => expect(existsSync(dirname(owner.nativeBrain.leasePath)), "REAL_NATIVE_OWNER_" + index + "_RELEASED").toBe(false));
      expect(startup.prepareNativeWorkerStartupView, "SUITE_RESTORES_CANONICAL_STARTUP").toBe(originalStartup);
      expect(output.prepareNativeWorkerOutput, "SUITE_RESTORES_CANONICAL_OUTPUT").toBe(originalOutput);
    }
  `);
  for (const [name, prior] of [["first", 0], ["late", 2]] as const) {
    writeFileSync(join(directory, `${name}.test.ts`), `
      import { test, expect } from "bun:test";
      import { owners, released } from "./observe.ts";
      import { installNativeHostFixtures } from ${JSON.stringify(join(helperRoot, "native-host-fixture.ts"))};
      import { installNativeBrainClientFixtures } from ${JSON.stringify(join(helperRoot, "native-brain-client-fixture.ts"))};
      const hosts = installNativeHostFixtures();
      const clients = installNativeBrainClientFixtures();
      test(${JSON.stringify(name + " suite owns host and client fixtures")}, () => {
        released(${prior});
        hosts.createFixtureHostBoundary({ brainPath: ${JSON.stringify(directory)}, exec: {} });
        clients.createFixtureBrainClient({ brainPath: ${JSON.stringify(directory)}, exec: {} });
        expect(owners.length).toBe(${prior + 2});
      });
    `);
  }
  writeFileSync(join(directory, "verify.test.ts"), `
    import { test } from "bun:test";
    import { released, observer } from "./observe.ts";
    test("both cached suites released their own real native owners", () => { try { released(4); } finally { observer.mockRestore(); } });
  `);
  const child = Bun.spawn([process.execPath, "run", "test", ...["first", "late", "verify"].map(name => join(directory, `${name}.test.ts`))], {
    cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stdout + stderr).toBe(0);
  expect(stderr, "ALL_THREE_CHILD_SUITES_EXECUTED").toContain("3 pass");
});

for (const [name, fixtures, acquire] of [
  ["host", hosts, (brainPath: string) => hosts.createFixtureHostBoundary({ brainPath, exec: {} })],
  ["client", clients, (brainPath: string) => clients.createFixtureBrainClient({ brainPath, exec: {} })],
] as const) {
  test(`${name} suite drains two real owners after errors and preserves an unrelated owner`, async () => {
    const originalStartup = startup.prepareNativeWorkerStartupView;
    const originalOutput = output.prepareNativeWorkerOutput;
    const brainPath = root();
    const unrelated = native.createNativeAppFixture(brainPath);
    const sharedStartup = startup.prepareNativeWorkerStartupView;
    const sharedOutput = output.prepareNativeWorkerOutput;
    const create = native.createNativeAppFixture;
    const owners: ReturnType<typeof create>[] = [];
    const firstError = new Error("first native cleanup receipt");
    const secondError = new Error("second native cleanup receipt");
    const observer = spyOn(native, "createNativeAppFixture").mockImplementation(path => {
      const owner = create(path);
      const close = owner.close;
      const error = owners.length === 0 ? firstError : secondError;
      owner.close = async () => { await close(); throw error; };
      owners.push(owner);
      return owner;
    });
    try {
      acquire(brainPath);
      acquire(brainPath);
      expect(owners).toHaveLength(2);
      owners.forEach(owner => expect(existsSync(dirname(owner.nativeBrain.leasePath)), "REAL_NATIVE_OWNER_ACQUIRED").toBe(true));
      let failure: unknown;
      try { await fixtures.close(); } catch (error) { failure = error; }
      // Collect both independent resource checks before throwing, so a mutation
      // omitting both closes reports both surviving real owners.
      const remaining = owners.map(owner => existsSync(dirname(owner.nativeBrain.leasePath)));
      expect(remaining, "BOTH_REAL_NATIVE_OWNERS_RELEASED").toEqual([false, false]);
      expect(failure, "ALL_NATIVE_CLEANUP_ERRORS_RETAINED_IN_ORDER").toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors, "EXACT_NATIVE_CLEANUP_ERRORS").toEqual([secondError, firstError]);
      expect(existsSync(dirname(unrelated.nativeBrain.leasePath)), "UNRELATED_NATIVE_OWNER_STAYS_LIVE").toBe(true);
      expect(startup.prepareNativeWorkerStartupView, "SHARED_STARTUP_OWNER_RETAINED").toBe(sharedStartup);
      expect(output.prepareNativeWorkerOutput, "SHARED_OUTPUT_OWNER_RETAINED").toBe(sharedOutput);
      await fixtures.close();
    } finally {
      observer.mockRestore();
      await Promise.allSettled(owners.map(owner => owner.close()));
      await unrelated.close();
    }
    expect(startup.prepareNativeWorkerStartupView, "ONLY_FINAL_OWNER_RESTORES_STARTUP").toBe(originalStartup);
    expect(output.prepareNativeWorkerOutput, "ONLY_FINAL_OWNER_RESTORES_OUTPUT").toBe(originalOutput);
  });
}

test("failed host and client construction retains owners for awaited suite cleanup", async () => {
  const brainPath = root();
  const originalStartup = startup.prepareNativeWorkerStartupView;
  const originalOutput = output.prepareNativeWorkerOutput;
  const create = native.createNativeAppFixture;
  const owners: ReturnType<typeof create>[] = [];
  const observer = spyOn(native, "createNativeAppFixture").mockImplementation(path => {
    const owner = create(path); owners.push(owner); return owner;
  });
  try {
    expect(() => hosts.createFixtureHostBoundary({ brainPath, credentialDomain: { directory: brainPath } })).toThrow("Host credential state must be separate");
    expect(() => hosts.createFixtureHostExecution({ brainPath, dbPath: join(brainPath, "ui.db") })).toThrow("outside");
    expect(() => clients.createFixtureBrainClient({ brainPath, exec: {}, searchTimeoutMs: 0 })).toThrow("searchTimeoutMs must be a positive finite number");
    expect(owners, "FAILED_CONSTRUCTORS_ACQUIRED_REAL_OWNERS").toHaveLength(3);
    await hosts.close();
    await clients.close();
    expect(owners.map(owner => existsSync(dirname(owner.nativeBrain.leasePath))), "FAILED_CONSTRUCTOR_OWNERS_RELEASED").toEqual([false, false, false]);
    expect(startup.prepareNativeWorkerStartupView).toBe(originalStartup);
    expect(output.prepareNativeWorkerOutput).toBe(originalOutput);
  } finally {
    observer.mockRestore();
    await Promise.allSettled([hosts.close(), clients.close(), ...owners.map(owner => owner.close())]);
  }
});

test("two generated apps close real databases while a legitimate native owner remains live", async () => {
  const originalStartup = startup.prepareNativeWorkerStartupView;
  const originalOutput = output.prepareNativeWorkerOutput;
  const brainPath = root();
  const unrelated = native.createNativeAppFixture(brainPath);
  const sharedStartup = startup.prepareNativeWorkerStartupView;
  const sharedOutput = output.prepareNativeWorkerOutput;
  const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_PATH: brainPath, DB_PATH: ":memory:", BRAIN_UI_PRICING_DISCOVERY: "0" });
  const backend = makeFakeBackend({ id: "fake" });
  const registry = createStaticBackendRegistry([backend], backend.id);
  const apps: Awaited<ReturnType<typeof native.createFixtureApp>>[] = [];
  try {
    apps.push(await native.createFixtureApp({ config, registry }));
    apps.push(await native.createFixtureApp({ config, registry }));
    expect(apps.every(app => app.config.nativeBrain !== undefined && app.config.nativeBrain !== unrelated.nativeBrain), "BOTH_APPS_GENERATE_THEIR_OWN_NATIVE_FIXTURES").toBe(true);
    // A shared spy's function identity is stable during legitimate overlap.
    // The exclusive-baseline assertions in app-wiring remain unchanged.
    expect(startup.prepareNativeWorkerStartupView).toBe(sharedStartup);
    expect(output.prepareNativeWorkerOutput).toBe(sharedOutput);
    for (const app of [...apps].reverse()) await app.close();
    for (const app of apps) expect(() => app.db.query("SELECT 1").get(), "OVERLAPPING_APP_DATABASE_CLOSED").toThrow();
    expect(existsSync(dirname(unrelated.nativeBrain.leasePath)), "LEGITIMATE_OWNER_SURVIVES_APP_CLOSES").toBe(true);
    expect(startup.prepareNativeWorkerStartupView).toBe(sharedStartup);
    expect(output.prepareNativeWorkerOutput).toBe(sharedOutput);
  } finally {
    await Promise.allSettled(apps.map(app => app.close()));
    await unrelated.close();
  }
  expect(startup.prepareNativeWorkerStartupView, "LEGITIMATE_OWNER_RELEASE_RESTORES_ORIGINAL_STARTUP").toBe(originalStartup);
  expect(output.prepareNativeWorkerOutput, "LEGITIMATE_OWNER_RELEASE_RESTORES_ORIGINAL_OUTPUT").toBe(originalOutput);
});
