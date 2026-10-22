import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerIdentityHelper } from "@schlessera/brain-ui-sdk/internal";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";
import * as maintenanceOutput from "../src/brain/maintenance-output.js";
import * as maintenanceWorker from "../../ui-sdk/src/server/maintenance-worker.js";
import { CLI_LOG, httpContractApp } from "./helpers/http-contract-app.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("admitted metadata drains its real worker, publication and cleanup within the close grace period", async () => {
  const fixture = await httpContractApp();
  const symbol = Symbol.for("@schlessera/brain-ui-server/maintenance-output-lock");
  const lock = (globalThis as unknown as Record<symbol, KeyedLock>)[symbol]!;
  const key = realpathSync(fixture.brainPath);
  const launched = deferred(), inputRelease = deferred(), publishing = deferred(), publishRelease = deferred();
  const cleaning = deferred(), cleanupRelease = deferred();
  const events: string[] = [];
  let pending: Promise<Response> | undefined, closing: Promise<void> | undefined;
  let pid = 0, start = "";
  const originalLaunch = maintenanceWorker.launchMaintenanceWorker;
  const launch = spyOn(maintenanceWorker, "launchMaintenanceWorker").mockImplementation(input => {
    expect(workerIdentityHelper(), "ACTIVE_CONTROL_USES_ORDINARY_NATIVE_LAUNCHER").toBeUndefined();
    const worker = originalLaunch(input);
    pid = worker.pid;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    events.push("launched");
    const eof = (name: string) => new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { controller.enqueue(chunk); }, flush() { events.push(name); },
    });
    launched.resolve();
    return { ...worker,
      stdout: worker.stdout.pipeThrough(eof("stdout EOF")),
      stderr: worker.stderr.pipeThrough(eof("stderr EOF")),
      exited: worker.exited.then(code => { events.push(`exit ${code}`); return code; }),
      async input(data) { await inputRelease.promise; await worker.input(data); events.push("stdin complete"); },
    };
  });
  const originalOutput = maintenanceOutput.prepareMaintenanceOutput;
  const output = spyOn(maintenanceOutput, "prepareMaintenanceOutput").mockImplementation(async (...args) => {
    const prepared = await originalOutput(...args);
    return { ...prepared,
      async publish() {
        events.push("publication entered"); publishing.resolve(); await publishRelease.promise;
        await prepared.publish(); events.push("published");
      },
      async cleanup() {
        events.push("cleanup entered"); cleaning.resolve(); await cleanupRelease.promise;
        await prepared.cleanup(); events.push("cleaned");
      },
    };
  });
  try {
    pending = Promise.resolve(fixture.fetch("/api/status"));
    await launched.promise;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0), "ORDINARY_NATIVE_WORKER_EXISTS_AT_CLOSE").not.toThrow();
    expect(events).not.toContain("stdin complete");
    closing = fixture.app.close();
    expect(lock.heldKeys, "ACTIVE_OWNER_RETAINS_OUTPUT_LOCK").toContain(key);
    expect(() => fixture.app.db.query("SELECT 1").get()).not.toThrow();
    inputRelease.resolve();
    const publishes = await Promise.race([publishing.promise.then(() => true), cleaning.promise.then(() => false)]);
    expect(publishes, "ADMITTED_METADATA_REACHES_PUBLICATION_AFTER_CLOSE").toBe(true);
    for (const event of ["exit 0", "stdout EOF", "stderr EOF", "stdin complete"]) expect(events).toContain(event);
    expect(lock.heldKeys, "LOCK_HELD_THROUGH_PUBLICATION").toContain(key);
    expect(() => fixture.app.db.query("SELECT 1").get()).not.toThrow();
    expect(existsSync(join(fixture.brainPath, CLI_LOG))).toBe(false);
    publishRelease.resolve();
    await cleaning.promise;
    expect(readFileSync(join(fixture.brainPath, CLI_LOG), "utf8")).toContain('"module","list"');
    expect(lock.heldKeys, "LOCK_HELD_THROUGH_CLEANUP").toContain(key);
    expect(() => fixture.app.db.query("SELECT 1").get()).not.toThrow();
    cleanupRelease.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("contentRenderers", []);
    await closing;
    expect(events).toContain("cleaned");
    expect(lock.heldKeys).not.toContain(key);
    expect(() => fixture.app.db.query("SELECT 1").get()).toThrow();
    console.info("METADATA_ACTIVE_OWNER", JSON.stringify({ pid, start, events }));
  } finally {
    inputRelease.resolve(); publishRelease.resolve(); cleanupRelease.resolve();
    await pending?.catch(() => {}); await closing?.catch(() => {});
    launch.mockRestore(); output.mockRestore();
    await fixture.close();
  }
});

for (const path of ["/api/status", "/api/modules"] as const) {
for (const trigger of ["caller abort", "app close", "loopback abort", "pre-aborted"] as const) {
  test(`queued metadata ${path} cancels before output-lock release on ${trigger}`, async () => {
    const state = mkdtempSync(join(tmpdir(), "odysseus-metadata-cancel-"));
    let fixture: Awaited<ReturnType<typeof httpContractApp>> | undefined;
    let release: (() => void) | undefined;
    let restore: (() => void) | undefined;
    let pending: Promise<Response> | undefined, closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let network: Promise<unknown> | undefined;
    const disconnected = deferred();
    let serverAborted = false;
    const arrived = deferred(), caller = new AbortController();
    let bodyEntries = 0, holderReleased = false;
    try {
      fixture = await httpContractApp({ env: { DB_PATH: join(state, "ui.sqlite") } });
      const key = realpathSync(fixture.brainPath);
      const symbol = Symbol.for("@schlessera/brain-ui-server/maintenance-output-lock");
      const lock = (globalThis as unknown as Record<symbol, KeyedLock>)[symbol]!;
      expect(lock).toBeDefined();
      release = await lock.acquire(key);
      const descriptor = Object.getOwnPropertyDescriptor(lock, "withLock")!;
      const original = lock.withLock;
      lock.withLock = function<T>(target: string, fn: () => T | Promise<T>, opts?: Parameters<KeyedLock["acquire"]>[1]) {
        const result = original.call(this, target, target === key ? () => {
          bodyEntries++;
          return fn();
        } : fn, opts) as Promise<T>;
        if (target === key) {
          console.info("METADATA_LOCK_ARRIVAL", JSON.stringify({ path, trigger, signal: Boolean(opts?.signal), aborted: opts?.signal?.aborted ?? false }));
          arrived.resolve();
        }
        return result;
      };
      restore = () => Object.defineProperty(lock, "withLock", descriptor);
      if (trigger === "pre-aborted") caller.abort();
      if (trigger === "loopback abort") {
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
          request.signal.addEventListener("abort", () => { serverAborted = true; disconnected.resolve(); }, { once: true });
          pending = Promise.resolve(fixture!.app.fetch(request));
          return pending;
        } });
        network = fetch(`http://127.0.0.1:${server.port}${path}`, { signal: caller.signal }).then(
          () => { throw Error("Cancelled loopback request unexpectedly completed"); },
          error => { expect(error.name).toBe("AbortError"); },
        );
      } else pending = Promise.resolve(fixture.fetch(path, { signal: caller.signal }));
      if (trigger !== "pre-aborted") await arrived.promise;
      expect(bodyEntries, "QUEUED_STATUS_HAS_NOT_ENTERED_OUTPUT_BODY").toBe(0);
      expect(() => fixture!.app.db.query("SELECT 1").get(), "HTTP_OWNER_ALIVE_UNTIL_HANDLER_SETTLES").not.toThrow();
      if (trigger === "caller abort" || trigger === "loopback abort") caller.abort();
      else if (trigger === "app close") {
        closing = fixture.app.close();
        expect((await fixture.fetch("/api/health")).status, "CLOSING_APP_REFUSES_NEW_HTTP_DISPATCH").toBe(503);
      }
      const outcome = await Promise.race([
        pending!.then(response => response.status),
        new Promise<"still queued">((resolve) => { timer = setTimeout(() => resolve("still queued"), 1500); }),
      ]);
      clearTimeout(timer);
      console.info("METADATA_QUEUE_ORACLE", JSON.stringify({ path, trigger, outcome, holderReleased, bodyEntries }));
      expect(outcome, "QUEUED_STATUS_SETTLES_BEFORE_OUTPUT_LOCK_RELEASE").not.toBe("still queued");
      expect(outcome).toBe(path === "/api/status" ? 200 : 500);
      if (trigger === "loopback abort") {
        expect(serverAborted, "ACTUAL_BUN_SERVER_REQUEST_ABORT_OBSERVED").toBe(true);
        await disconnected.promise;
      }
      expect(holderReleased).toBe(false);
      expect(lock.heldKeys).toContain(key);
      expect(bodyEntries).toBe(0);
      release(); holderReleased = true;
      // A FIFO sentinel proves no abandoned operation can start behind us.
      await original.call(lock, key, () => {});
      await pending;
      await closing;
      expect(bodyEntries, "CANCELLED_STATUS_NEVER_STARTS_AFTER_LOCK_RELEASE").toBe(0);
      const log = join(fixture.brainPath, CLI_LOG);
      const commands = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(commands).not.toContain('"module","list"');
    } finally {
      clearTimeout(timer);
      release?.(); holderReleased = true;
      await pending?.catch(() => {});
      await closing?.catch(() => {});
      await network;
      server?.stop(true);
      restore?.();
      await fixture?.close();
      rmSync(state, { recursive: true, force: true });
      console.info("METADATA_QUEUE_CLEANUP_JOINED", trigger);
    }
  });
}

}
