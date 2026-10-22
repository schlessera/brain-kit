import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Control only the probe's registered primary deadline; cleanup and child IO stay native. */
export function registeredVersionDeadline(kind: "host" | "maintenance" = "host") {
  const file = kind === "host" ? "version-probe.ts" : "maintenance-worker.ts";
  const source = readFileSync(new URL(`../../src/server/${file}`, import.meta.url), "utf8").split("\n");
  const registration = kind === "host" ? "timer = setTimeout(() => resolve({ timedOut: true }), VERSION_PROBE_TIMEOUT_MS)"
    : "const timer = input.timeoutMs ? setTimeout(kill, input.timeoutMs)";
  const primarySite = source.findIndex(line => line.includes(registration));
  assert(primarySite > 0, "VERSION_PROBE_PRIMARY_SOURCE_EXISTS");
  assert.equal(source.filter(line => line.includes(registration)).length, 1, "VERSION_PROBE_ONE_PRIMARY_OWNER");
  const owner = `${file}:${primarySite + 1}:`;
  const spawnSite = source.findIndex(line => line.includes("const proc = Bun.spawn("));
  if (kind === "host") assert(spawnSite > 0, "VERSION_PROBE_SPAWN_SOURCE_EXISTS");
  const spawnOwner = `version-probe.ts:${spawnSite + 1}:`;
  const descriptors = ([
    [globalThis, "setTimeout"], [globalThis, "clearTimeout"], [Bun, "spawn"],
  ] satisfies [object, PropertyKey][]).map(([object, key]) => [object, key, Object.getOwnPropertyDescriptor(object, key)!] as const);
  const restores: (() => void)[] = [];
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout, nativeSpawn = Bun.spawn;
  let primary: { callback: () => void; handle: ReturnType<typeof setTimeout>; cancelled: boolean } | undefined;
  let target: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let fired = 0, settled = false, stdout = "";
  const pendingReads = [0, 0], eof = [false, false];
  const reads: Promise<unknown>[] = [];
  let work: Promise<unknown> | undefined;
  function replace(object: object, key: PropertyKey, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { ...(descriptor ?? { configurable: true, writable: true }), value });
    restores.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); });
  }
  function restore() {
    for (const undo of restores.splice(0).reverse()) undo();
    for (const [object, key, descriptor] of descriptors) assert.deepEqual(Object.getOwnPropertyDescriptor(object, key as string), descriptor, `VERSION_PROBE_RESTORES_${String(key)}`);
  }
  try {
    replace(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
      const caller = new Error().stack?.match(/\/ui-sdk\/src\/server\/((?:version-probe|maintenance-worker)\.ts:\d+:)/)?.[1];
      if (caller !== owner) return nativeSet(callback, delay, ...args);
      assert.equal(delay, 5_000, "VERSION_PROBE_PRODUCTION_DEADLINE_IS_5000_MS");
      assert.equal(primary, undefined, "VERSION_PROBE_SINGLE_PRIMARY_REGISTRATION");
      primary = { callback: () => callback(...args), handle: {} as ReturnType<typeof setTimeout>, cancelled: false };
      return primary.handle;
    });
    replace(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout>) => {
      if (primary?.handle === handle) primary.cancelled = true;
      else nativeClear(handle);
    });
    if (kind === "host") replace(Bun, "spawn", (...args: Parameters<typeof Bun.spawn>) => {
      const caller = new Error().stack?.match(/\/ui-sdk\/src\/server\/((?:version-probe|exec-wrapper)\.ts:\d+:)/)?.[1];
      const proc = Reflect.apply(nativeSpawn, Bun, args);
      if (caller !== spawnOwner) return proc;
      assert.equal(target, undefined, "VERSION_PROBE_SINGLE_NATIVE_CHILD");
      target = proc;
      for (const [index, stream] of [proc.stdout, proc.stderr].entries()) {
        assert(stream && typeof stream !== "number", "VERSION_PROBE_NATIVE_PIPE");
        const getReader = stream.getReader;
        const decoder = new TextDecoder();
        replace(stream, "getReader", (...readerArgs: unknown[]) => {
          const reader = Reflect.apply(getReader, stream, readerArgs) as ReadableStreamDefaultReader<Uint8Array>;
          const read = reader.read;
          replace(reader, "read", () => {
            pendingReads[index]!++;
            const result = read.call(reader);
            reads.push(result);
            void result.then(chunk => {
              pendingReads[index]!--;
              if (chunk.done) eof[index] = true;
              else if (index === 0) stdout += decoder.decode(chunk.value, { stream: true });
            }, () => { pendingReads[index]!--; });
            return result;
          });
          return reader;
        });
      }
      return proc;
    });
  } catch (error) { restore(); throw error; }
  function advanceTo(milliseconds: number) {
    assert(primary, "VERSION_PROBE_REGISTERED_PRIMARY_CAPTURED");
    if (milliseconds >= 5_000 && !primary.cancelled && fired === 0) { fired++; primary.callback(); }
  }
  return {
    track<T>(promise: Promise<T>): Promise<T> {
      work = promise;
      void promise.then(() => { settled = true; }, () => { settled = true; });
      return promise;
    },
    async expire(output = "", beforeDeadline?: () => void) {
      const until = performance.now() + 2_000;
      while ((!primary || kind === "host" && (!target || !stdout.includes(output) || !pendingReads.every(count => count === 1))) && !settled && performance.now() < until) await Bun.sleep(1);
      if (kind === "host") {
        assert(target, "VERSION_PROBE_NATIVE_CHILD_STARTED");
        assert(stdout.includes(output), "VERSION_PROBE_NATIVE_OUTPUT_DELIVERED");
        assert.deepEqual(pendingReads, [1, 1], "VERSION_PROBE_NATIVE_READS_PENDING");
        assert.deepEqual(eof, [false, false], "VERSION_PROBE_NO_PREMATURE_EOF");
      }
      advanceTo(4_999);
      await Promise.resolve();
      assert.equal(fired, 0, "VERSION_PROBE_NO_DELIVERY_AT_4999");
      assert.equal(settled, false, "VERSION_PROBE_NO_SETTLEMENT_AT_4999");
      beforeDeadline?.();
      advanceTo(5_000);
      assert.equal(fired, 1, "VERSION_PROBE_ONE_DELIVERY_AT_5000");
    },
    assertSettled() {
      assert.equal(settled, true, "VERSION_PROBE_NATIVE_SETTLEMENT_OBSERVED");
      assert.equal(primary?.cancelled, true, "VERSION_PROBE_PRIMARY_CLEARED");
      advanceTo(5_001);
      assert.equal(fired, 1, "VERSION_PROBE_NO_DUPLICATE_DELIVERY");
    },
    restore,
    async dispose() {
      try {
        // Failure cleanup owns only this probe; outcome assertions run before it.
        if (kind === "maintenance" && primary && !primary.cancelled && !fired) advanceTo(5_000);
        if (target) {
          try { process.kill(-target.pid, "SIGKILL"); } catch { /* Unwrapped or already gone. */ }
          if (target.exitCode === null) target.kill("SIGKILL");
          await target.exited;
        }
        await work?.catch(() => {});
        await Promise.allSettled(reads);
        assert.deepEqual(pendingReads, [0, 0], "VERSION_PROBE_NATIVE_READS_SETTLED");
      } finally { restore(); }
    },
  };
}
