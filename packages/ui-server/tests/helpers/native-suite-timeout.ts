/** Real runner-timeout control, registered only in an isolated child suite. */
import { beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as native from "./native-app-fixture.js";
import * as startup from "../../../ui-sdk/src/server/worker-startup-view.js";
import * as output from "../../../ui-sdk/src/server/worker-native-output.js";
import { installNativeHostFixtures } from "./native-host-fixture.js";
import { installNativeBrainClientFixtures } from "./native-brain-client-fixture.js";
import { installRegressionScopes, ownClose, ownInvocation } from "./native-suite-cleanup.js";
import { resolveServerConfig } from "../../src/config/env.js";
import { createStaticBackendRegistry } from "../../src/agent/backend.js";
import { makeFakeBackend } from "./fake-backend.js";

export function registerTimeoutControl(directory: string) {
  const hosts = installNativeHostFixtures();
  const clients = installNativeBrainClientFixtures();
  const scopeForTest = installRegressionScopes();
  const scope = scopeForTest();
  const brain = mkdtempSync(join(tmpdir(), "odysseus-timeout-owner-"));
  const originalStartup = Object.getOwnPropertyDescriptor(startup, "prepareNativeWorkerStartupView")!;
  const originalOutput = Object.getOwnPropertyDescriptor(output, "prepareNativeWorkerOutput")!;
  const originalCreate = Object.getOwnPropertyDescriptor(native, "createNativeAppFixture")!;
  const owners: ReturnType<typeof native.createNativeAppFixture>[] = [];
  const apps: Awaited<ReturnType<typeof native.createFixtureApp>>[] = [];
  let descendant = 0, detachedGroup = 0;
  let release!: () => void, finallyDone!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const finalized = new Promise<void>(resolve => { finallyDone = resolve; });
  let removed = false;
  const alive = (pid: number) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
  };
  // This is deliberately the first acquisition, hence the last disposer.
  scope.defer(() => {
    try {
      expect(descendant, "HELD_DESCENDANT_REACHED_CHECKPOINT").toBeGreaterThan(0);
      expect(alive(descendant), "INVOCATION_DESCENDANT_STOPPED_BEFORE_ROOT_DELETE").toBe(false);
      const liveGroup = readdirSync("/proc").filter(name => /^\d+$/.test(name)).filter(name => {
        try {
          const stat = readFileSync(`/proc/${name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return !["Z", "X"].includes(fields[0]!) && Number(fields[2]) === detachedGroup;
        } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
      });
      expect(detachedGroup, "NESTED_WRAPPER_GROUP_ACKNOWLEDGED").toBeGreaterThan(0);
      expect(liveGroup, "DETACHED_INVOCATION_GROUP_JOINED_BEFORE_ROOT_DELETE").toEqual([]);
      expect(owners.length, "ALL_TIMEOUT_NATIVE_OWNERS_ACQUIRED").toBe(3);
      expect(owners.map(owner => existsSync(dirname(owner.nativeBrain.leasePath))), "ALL_TIMEOUT_NATIVE_OWNERS_CLOSED_BEFORE_ROOT_DELETE").toEqual([false, false, false]);
      expect(apps, "BOTH_TIMEOUT_APPS_ACQUIRED").toHaveLength(2);
      for (const app of apps) expect(() => app.db.query("SELECT 1").get(), "TIMEOUT_APP_DB_CLOSED_BEFORE_ROOT_DELETE").toThrow();
      expect(Object.getOwnPropertyDescriptor(native, "createNativeAppFixture"), "OBSERVER_DESCRIPTOR_RESTORED_BEFORE_ROOT_DELETE").toEqual(originalCreate);
      expect(Object.getOwnPropertyDescriptor(startup, "prepareNativeWorkerStartupView"), "STARTUP_DESCRIPTOR_RESTORED_BEFORE_ROOT_DELETE").toEqual(originalStartup);
      expect(Object.getOwnPropertyDescriptor(output, "prepareNativeWorkerOutput"), "OUTPUT_DESCRIPTOR_RESTORED_BEFORE_ROOT_DELETE").toEqual(originalOutput);
      console.log("TIMEOUT_RESOURCES_CLOSED_BEFORE_ROOT_DELETE");
    } finally { rmSync(brain, { recursive: true, force: true }); removed = true; }
  });
  // Setup has its own unchanged 30s ceiling: the 100ms test starts only after
  // all native/app/child acquisition checkpoints, including actual Git setup.
  beforeAll(async () => {
    const unrelated = ownClose(scope, native.createNativeAppFixture(brain));
    owners.push(unrelated);
    const create = native.createNativeAppFixture;
    const observer = spyOn(native, "createNativeAppFixture").mockImplementation(path => {
      const owner = ownClose(scope, create(path)); owners.push(owner); return owner;
    });
    scope.defer(() => { observer.mockRestore(); });
    hosts.createFixtureHostBoundary({ brainPath: brain, exec: {} });
    clients.createFixtureBrainClient({ brainPath: brain, exec: {} });
    observer.mockRestore();
    const backend = makeFakeBackend({ id: "fake" });
    const registry = createStaticBackendRegistry([backend], backend.id);
    const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_PATH: brain, DB_PATH: ":memory:", BRAIN_UI_PRICING_DISCOVERY: "0" });
    for (let index = 0; index < 2; index++) {
      const pending = native.createFixtureApp({ config, registry });
      scope.defer(async () => { await (await pending).close(); });
      apps.push(await pending);
    }
    // Keep an observer installed at expiry; teardown must restore its complete
    // descriptor even though Bun does not unwind the timed-out callback.
    const timedObserver = spyOn(native, "createNativeAppFixture").mockImplementation(create);
    scope.defer(() => { timedObserver.mockRestore(); });
    // The ordinary wrapper launches a second detached invocation group. Its
    // child inherits pipes and ignores TERM; stopping just the wrapper cannot
    // satisfy the live-group and EOF witnesses below.
    const checkpoint = join(directory, "descendant.json");
    const heldTest = join(directory, "held.test.ts");
    const descendantSource = `
      process.on("SIGTERM", () => {});
      const fs = require("node:fs");
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      fs.writeFileSync(${JSON.stringify(checkpoint)}, JSON.stringify({ pid: process.pid, group }));
      setInterval(() => {}, 60000);
    `;
    writeFileSync(heldTest, `
      import { test } from "bun:test";
      test("held native descendant", async () => {
        Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantSource)}], { stdout: "inherit", stderr: "inherit" });
        await new Promise(() => {});
      });
    `);
    const invocation = ownInvocation(scope, [process.execPath, resolve(import.meta.dir, "../../../../scripts/test.ts"), "--timeout", "30000", heldTest]);
    await invocation.child.ready;
    const end = performance.now() + 5_000;
    while (!existsSync(checkpoint) && performance.now() < end) await Bun.sleep(10);
    expect(existsSync(checkpoint), "HELD_CHILD_SETUP_CHECKPOINT").toBe(true);
    const receipt = JSON.parse(readFileSync(checkpoint, "utf8"));
    descendant = receipt.pid; detachedGroup = receipt.group;
    expect(alive(descendant), "REAL_DESCENDANT_LIVE_BEFORE_TIMEOUT").toBe(true);
    console.log("TIMEOUT_RESOURCES_READY");
  });
  test("intentional runner timeout after resource setup", async () => {
    try { await held; }
    finally { try { await scope.close(); } finally { finallyDone(); } }
  }, 100);
  test("following case observes cleanup and late finally cannot restore over its owner", async () => {
    expect(removed, "HOOK_REMOVED_ROOT_BEFORE_NEXT_CASE").toBe(true);
    expect(existsSync(brain)).toBe(false);
    const nextScope = scopeForTest();
    const nextRoot = mkdtempSync(join(tmpdir(), "odysseus-next-owner-"));
    nextScope.defer(() => { rmSync(nextRoot, { recursive: true, force: true }); });
    const nextOwner = ownClose(nextScope, native.createNativeAppFixture(nextRoot));
    const nextStartup = startup.prepareNativeWorkerStartupView, nextOutput = output.prepareNativeWorkerOutput;
    release();
    await finalized;
    expect(startup.prepareNativeWorkerStartupView, "LATE_FINALLY_PRESERVES_NEXT_STARTUP").toBe(nextStartup);
    expect(output.prepareNativeWorkerOutput, "LATE_FINALLY_PRESERVES_NEXT_OUTPUT").toBe(nextOutput);
    expect(existsSync(dirname(nextOwner.nativeBrain.leasePath)), "NEXT_OWNER_STILL_LIVE").toBe(true);
    console.log("LATE_FINALLY_PRESERVED_NEXT_OWNER");
    await nextScope.close();
  });
}
