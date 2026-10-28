import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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
import { installRegressionScopes, ownClose, ownInvocation } from "./helpers/native-suite-cleanup.js";

const hosts = installNativeHostFixtures();
const clients = installNativeBrainClientFixtures();
const scopeForTest = installRegressionScopes();
function root(scope: ReturnType<typeof scopeForTest>) {
  const path = mkdtempSync(join(tmpdir(), "odysseus-suite-owner-"));
  scope.defer(() => { rmSync(path, { recursive: true, force: true }); });
  return path;
}

test("cached native helpers register cleanup in each importing suite", async () => {
  const scope = scopeForTest();
  const directory = root(scope);
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
    import { afterAll, test } from "bun:test";
    import { released, observer } from "./observe.ts";
    afterAll(() => { observer.mockRestore(); });
    test("both cached suites released their own real native owners", () => { released(4); });
  `);
  const invocation = ownInvocation(scope, [process.execPath, resolve(import.meta.dir, "../../../scripts/test.ts"), "--timeout", "30000", ...["first", "late", "verify"].map(name => join(directory, `${name}.test.ts`))]);
  const [code, stdout, stderr] = await invocation.result();
  expect(code, stdout + stderr).toBe(0);
  expect(stderr, "ALL_THREE_CHILD_SUITES_EXECUTED").toContain("3 pass");
  await scope.close();
});

for (const [name, fixtures, acquire] of [
  ["host", hosts, (brainPath: string) => hosts.createFixtureHostBoundary({ brainPath, exec: {} })],
  ["client", clients, (brainPath: string) => clients.createFixtureBrainClient({ brainPath, exec: {} })],
] as const) {
  test(`${name} suite drains two real owners after errors and preserves an unrelated owner`, async () => {
    const originalStartup = startup.prepareNativeWorkerStartupView;
    const originalOutput = output.prepareNativeWorkerOutput;
    const scope = scopeForTest();
    const brainPath = root(scope);
    const unrelated = ownClose(scope, native.createNativeAppFixture(brainPath));
    const sharedStartup = startup.prepareNativeWorkerStartupView;
    const sharedOutput = output.prepareNativeWorkerOutput;
    const create = native.createNativeAppFixture;
    const owners: ReturnType<typeof create>[] = [];
    const firstError = new Error("first native cleanup receipt");
    const secondError = new Error("second native cleanup receipt");
    const hostStates: string[] = [];
    const closeOrder: boolean[] = [];
    const mkdtemp = fs.mkdtempSync;
    const observeState: typeof mkdtemp = (prefix: string, options?: fs.EncodingOption | fs.BufferEncodingOption) => {
      const state = Reflect.apply(mkdtemp, fs, [prefix, options]);
      if (prefix.startsWith(join(tmpdir(), "odysseus-host-state-"))) hostStates.push(String(state));
      return state;
    };
    const stateObserver = spyOn(fs, "mkdtempSync").mockImplementation(observeState);
    scope.defer(() => { stateObserver.mockRestore(); });
    const observer = spyOn(native, "createNativeAppFixture").mockImplementation(path => {
      const owner = ownClose(scope, create(path));
      const close = owner.close;
      const state = hostStates.at(-1);
      const error = owners.length === 0 ? firstError : secondError;
      owner.close = async () => {
        const stateExistsDuringClose = state === undefined || existsSync(state);
        closeOrder.push(stateExistsDuringClose);
        await close();
        expect(stateExistsDuringClose, "NATIVE_CLOSE_PRECEDES_HOST_STATE_REMOVAL").toBe(true);
        throw error;
      };
      owners.push(owner);
      return owner;
    });
    scope.defer(() => { observer.mockRestore(); });
    {
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
      expect(closeOrder, "NATIVE_CLOSE_PRECEDES_HOST_STATE_REMOVAL").toEqual([true, true]);
      expect(failure, "ALL_NATIVE_CLEANUP_ERRORS_RETAINED_IN_ORDER").toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors;
      expect(errors, "EXACT_NATIVE_CLEANUP_ERROR_COUNT").toHaveLength(2);
      expect(errors[0], "EXACT_NATIVE_CLEANUP_ERROR_0_IDENTITY").toBe(secondError);
      expect(errors[1], "EXACT_NATIVE_CLEANUP_ERROR_1_IDENTITY").toBe(firstError);
      if (name === "host") {
        expect(hostStates, "BOTH_HOST_STATES_OBSERVED").toHaveLength(2);
        expect(hostStates.map(state => existsSync(state)), "HOST_STATES_REMOVED_AFTER_NATIVE_CLOSE").toEqual([false, false]);
      }
      expect(existsSync(dirname(unrelated.nativeBrain.leasePath)), "UNRELATED_NATIVE_OWNER_STAYS_LIVE").toBe(true);
      expect(startup.prepareNativeWorkerStartupView, "SHARED_STARTUP_OWNER_RETAINED").toBe(sharedStartup);
      expect(output.prepareNativeWorkerOutput, "SHARED_OUTPUT_OWNER_RETAINED").toBe(sharedOutput);
      await fixtures.close();
    }
    await scope.close();
    expect(startup.prepareNativeWorkerStartupView, "ONLY_FINAL_OWNER_RESTORES_STARTUP").toBe(originalStartup);
    expect(output.prepareNativeWorkerOutput, "ONLY_FINAL_OWNER_RESTORES_OUTPUT").toBe(originalOutput);
  });
}

test("failed host and client construction retains owners for awaited suite cleanup", async () => {
  const scope = scopeForTest();
  const brainPath = root(scope);
  const originalStartup = startup.prepareNativeWorkerStartupView;
  const originalOutput = output.prepareNativeWorkerOutput;
  const create = native.createNativeAppFixture;
  const owners: ReturnType<typeof create>[] = [];
  const observer = spyOn(native, "createNativeAppFixture").mockImplementation(path => {
    const owner = ownClose(scope, create(path)); owners.push(owner); return owner;
  });
  scope.defer(() => { observer.mockRestore(); });
  {
    expect(() => hosts.createFixtureHostBoundary({ brainPath, credentialDomain: { directory: brainPath } })).toThrow("Host credential state must be separate");
    expect(() => hosts.createFixtureHostExecution({ brainPath, dbPath: join(brainPath, "ui.db") })).toThrow("outside");
    expect(() => clients.createFixtureBrainClient({ brainPath, exec: {}, searchTimeoutMs: 0 })).toThrow("searchTimeoutMs must be a positive finite number");
    expect(owners, "FAILED_CONSTRUCTORS_ACQUIRED_REAL_OWNERS").toHaveLength(3);
    await hosts.close();
    await clients.close();
    expect(owners.map(owner => existsSync(dirname(owner.nativeBrain.leasePath))), "FAILED_CONSTRUCTOR_OWNERS_RELEASED").toEqual([false, false, false]);
    expect(startup.prepareNativeWorkerStartupView).toBe(originalStartup);
    expect(output.prepareNativeWorkerOutput).toBe(originalOutput);
  }
  await scope.close();
});

test("two generated apps close real databases while a legitimate native owner remains live", async () => {
  const originalStartup = startup.prepareNativeWorkerStartupView;
  const originalOutput = output.prepareNativeWorkerOutput;
  const scope = scopeForTest();
  const brainPath = root(scope);
  const unrelated = ownClose(scope, native.createNativeAppFixture(brainPath));
  const sharedStartup = startup.prepareNativeWorkerStartupView;
  const sharedOutput = output.prepareNativeWorkerOutput;
  const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_PATH: brainPath, DB_PATH: ":memory:", BRAIN_UI_PRICING_DISCOVERY: "0" });
  const backend = makeFakeBackend({ id: "fake" });
  const registry = createStaticBackendRegistry([backend], backend.id);
  const apps: Awaited<ReturnType<typeof native.createFixtureApp>>[] = [];
  {
    for (let index = 0; index < 2; index++) {
      const pending = native.createFixtureApp({ config, registry });
      // Own the pending acquisition before awaiting it: timeout cleanup joins it.
      scope.defer(async () => { await (await pending).close(); });
      apps.push(await pending);
    }
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
  }
  await scope.close();
  expect(startup.prepareNativeWorkerStartupView, "LEGITIMATE_OWNER_RELEASE_RESTORES_ORIGINAL_STARTUP").toBe(originalStartup);
  expect(output.prepareNativeWorkerOutput, "LEGITIMATE_OWNER_RELEASE_RESTORES_ORIGINAL_OUTPUT").toBe(originalOutput);
});

test("real Bun timeout drains regression resources before root removal and a late finally preserves the next owner", async () => {
  const scope = scopeForTest();
  const directory = root(scope);
  writeFileSync(join(directory, "timeout.test.ts"), `
    import { registerTimeoutControl } from ${JSON.stringify(resolve(import.meta.dir, "helpers/native-suite-timeout.ts"))};
    registerTimeoutControl(${JSON.stringify(directory)});
  `);
  const invocation = ownInvocation(scope, [process.execPath, resolve(import.meta.dir, "../../../scripts/test.ts"), "--timeout", "30000", join(directory, "timeout.test.ts")]);
  const [code, stdout, stderr] = await invocation.result();
  console.log(JSON.stringify({ kind: "native-suite-timeout-control", code, stdout, stderr }));
  expect(code, stdout + stderr).toBe(1);
  expect(stderr, "REAL_BUN_TIMEOUT_NOT_SETUP_FAILURE").toMatch(/timed out after 100ms/);
  expect(stderr, "FOLLOWING_CASE_EXECUTED_AFTER_TIMEOUT").toContain("1 pass");
  expect(stderr, "ONLY_THE_INTENTIONAL_TIMEOUT_FAILED").toContain("1 fail");
  expect(stdout, "BOUNDED_SETUP_COMPLETED_BEFORE_TIMEOUT").toContain("TIMEOUT_RESOURCES_READY");
  expect(stdout, "HOOK_CLEANUP_COMPLETED_BEFORE_ROOT_DELETE").toContain("TIMEOUT_RESOURCES_CLOSED_BEFORE_ROOT_DELETE");
  expect(stdout, "DELAYED_FINALLY_PRESERVES_NEW_OWNER").toContain("LATE_FINALLY_PRESERVED_NEXT_OWNER");
  await scope.close();
});
