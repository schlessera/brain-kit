/// <reference types="@vitest/browser-playwright" />
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page, Route } from "playwright";
import type { BrowserCommand } from "vitest/node";
import { closeHygieneContext } from "./hygiene-route-owner.ts";
import { hygieneServer, hygieneServerOwners } from "./hygiene-server-command.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
// Each owner has a fixed set of steps. Retain original error objects once,
// including a primary failure, rather than replacing them from finally.
function failure(errors: unknown[], message: string): void {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length) throw new AggregateError(unique, message);
}
async function attempt(errors: unknown[], step: () => unknown) {
  try { await step(); } catch (error) { errors.push(error); }
}
const cleanups = new Set<() => Promise<void>>();
function ownCleanup(cleanup: () => Promise<void>, release: () => void = () => {}) {
  let running: Promise<void> | undefined;
  let closing = false;
  const acquisitions = new Set<Promise<unknown>>();
  const run = () => {
    if (!running) {
      closing = true;
      // Release holds synchronously, even while acquisition is still pending.
      running = (async () => {
        const errors: unknown[] = [];
        await attempt(errors, release);
        const acquired = await Promise.allSettled([...acquisitions]);
        for (const result of acquired) if (result.status === "rejected") errors.push(result.reason);
        await attempt(errors, cleanup);
        failure(errors, "fixture owner cleanup failed");
      })();
      // Hook cleanup may run before the abandoned command resumes its stack.
      void running.catch(() => {});
    }
    return running;
  };
  cleanups.add(run);
  const close = async () => { try { await run(); } finally { cleanups.delete(run); } };
  return Object.assign(close, {
    async acquire<T>(start: () => Promise<T>): Promise<T> {
      assert.equal(closing, false, "abandoned owner cannot acquire another resource");
      const task = Promise.resolve().then(start);
      acquisitions.add(task);
      // Observe immediately; the caller still receives the original rejection.
      void task.then(() => { acquisitions.delete(task); }, () => { acquisitions.delete(task); });
      const value = await task;
      assert.equal(closing, false, "late acquisition must retire before command resumes");
      return value;
    },
  });
}
async function complete<T>(cleanup: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  const errors: unknown[] = [];
  let result: T | undefined;
  try { result = await body(); } catch (error) { errors.push(error); }
  await attempt(errors, cleanup);
  failure(errors, "fixture command and cleanup failed");
  return result as T;
}
async function arrived(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture gate timeout: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
export const hygieneLifecycleCleanup: BrowserCommand<[], void> = async () => {
  const errors: unknown[] = [];
  // Snapshot ownership: an old finally can only remove its own registration.
  for (const cleanup of [...cleanups]) {
    try { await attempt(errors, cleanup); } finally { cleanups.delete(cleanup); }
  }
  failure(errors, "fixture registry cleanup failed");
};
/** Drives the original native fixture and actual Vitest iframe; no HTTP doubles. */
export const hygieneLifecycle: BrowserCommand<[{ duringUnroute?: boolean; failRoute?: boolean; failUnroute?: boolean }], unknown> = async (ctx, options) => {
  const frame = await ctx.frame();
  const releases = [gate(), gate(), gate()];
  const bodies = [gate(), gate(), gate()];
  const admissionClosed = gate(), fenceHeld = gate(), fenceRemoved = gate(), releaseFence = gate();
  let holdNextFence = false, stopSettled = false, fenceOutstanding = false, killedWithFencePending = false;
  let restoreKill: (() => void) | undefined;
  let foreignCalls = 0, producing = false, exerciseUnroute = false;
  let producer: Promise<void> | undefined;
  const foreign = async (route: Route) => { foreignCalls++; await route.fallback(); };
  const owed = new Set<number>();
  const native: Array<{ status?: number; body: string }> = [];
  const responses: Array<Promise<{ status: number; body: string }>> = [];
  const callbacks = new Set<Promise<void>>();
  const routeError = new Error("owned native response failure");
  const unrouteError = new Error("owned unroute failure");
  let originalError: { error: unknown } | undefined;
  let next = 0, unrouteActive = -1, afterUnrouteActive = -1, unrouteFailed = false;
  let stopResult: Promise<{ error?: unknown }> | undefined;
  let validatedStopFailure: unknown, validatedBrowserFailure: unknown, validatedRouteFailure: unknown;
  let fixture: { id: string; url: string } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    const result = frame.evaluate(async () => {
      const response = await fetch("/api/hygiene/review");
      return { status: response.status, body: await response.text() };
    });
    // Ownership is immediate, including failures during cleanup.
    void result.catch(error => { originalError ??= { error }; });
    responses.push(result);
    return result;
  };
  const fences = new Map<(route: Route) => Promise<void>, (route: Route) => Promise<void>>();
  const registered = new Map<(route: Route) => Promise<void>, (route: Route) => Promise<void>>();
  const page = new Proxy(ctx.page, {
    get(target, key) {
      if (key === "route") return async (pattern: string, handler: (route: Route) => Promise<void>) => {
        assert.equal(pattern, "**/api/hygiene/**");
        if (fixture) {
          const wrappedFence = (route: Route) => {
            if (!holdNextFence) return handler(route);
            holdNextFence = false;
            return handler(new Proxy(route, { get(target, key) {
              if (key === "fallback") return async () => {
                await target.fallback(); fenceOutstanding = true; fenceHeld.release();
                try { await releaseFence.promise; } finally { fenceOutstanding = false; }
              };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            } }));
          };
          fences.set(handler, wrappedFence);
          return target.route(pattern, wrappedFence);
        }
        const wrappedHandler = (route: Route) => {
          const index = next++;
          const wrapped = new Proxy(route, {
            get(target, key) {
              if (key === "fulfill") return async (response: Parameters<Route["fulfill"]>[0]) => {
                owed.add(index);
                native[index] = { status: response!.status, body: String(response!.body) };
                bodies[index]!.release();
                await releases[index]!.promise;
                try {
                  if (options.failRoute) { originalError ??= { error: routeError }; await target.abort("failed"); throw routeError; }
                  await target.fulfill(response);
                } catch (error) {
                  originalError ??= { error };
                  throw error;
                } finally { owed.delete(index); }
              };
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const task = handler(wrapped).catch(error => { originalError ??= { error }; });
          callbacks.add(task);
          return task.finally(() => { callbacks.delete(task); });
        };
        registered.set(handler, wrappedHandler);
        return target.route(pattern, wrappedHandler);
      };
      if (key === "unroute") return async (pattern: string, handler: (route: Route) => Promise<void>) => {
        const wrapped = registered.get(handler);
        if (!wrapped) {
          await target.unroute(pattern, fences.get(handler) ?? handler);
          fenceRemoved.release(); return;
        }
        unrouteActive = owed.size;
        if (exerciseUnroute && !options.failRoute) {
          const indices = options.duringUnroute ? [0] : [1, 2];
          for (const index of indices) {
            request();
            await arrived(bodies[index]!.promise, "native response during route update");
          }
        }
        // Real callbacks enter while the route update is in progress. The
        // temporary delegating pattern must keep their interception alive.
        await target.unroute(pattern, wrapped);
        afterUnrouteActive = owed.size;
        admissionClosed.release();
        if (options.failUnroute && !unrouteFailed) { unrouteFailed = true; throw unrouteError; }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Page;
  const commandContext = { ...ctx, page };
  const cleanup = ownCleanup(async () => {
    producing = false;
    const errors: unknown[] = [];
    if (producer) await attempt(errors, () => producer);
    if (stopResult) await attempt(errors, async () => { const result = await stopResult!; if (result.error) throw result.error; });
    if (fixture) {
      let alive = false;
      try { await fetch(`${fixture.url}/fixture`); alive = true; } catch { /* Expected after native exit. */ }
      if (alive) await attempt(errors, () => hygieneServer(commandContext, { op: "stop", id: fixture!.id }));
    }
    const settled = await Promise.allSettled(responses);
    const joined = await Promise.allSettled(callbacks);
    for (const result of [...settled, ...joined]) if (result.status === "rejected") errors.push(result.reason);
    if (originalError) errors.unshift(originalError.error);
    await attempt(errors, () => ctx.page.unroute("**/api/hygiene/**", foreign));
    clearTimeout(timeout);
    await attempt(errors, () => {
    const output = resolve("../../tmp/hygiene-proof");
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, `lifecycle-${crypto.randomUUID()}.json`), JSON.stringify({
      options, native, browser: settled, stopPending: callbacks.size, unrouteActive, afterUnrouteActive,
      error: originalError && String(originalError.error), node: process.version,
      browserVersion: ctx.context.browser()!.version(),
    }, null, 2));
    });

    // Expected injected stop failures were asserted in the command body.
    failure(errors.filter(error => error !== validatedStopFailure && error !== validatedBrowserFailure && error !== validatedRouteFailure), "native lifecycle cleanup failed");
  }, () => { releases.forEach(g => g.release()); releaseFence.release(); restoreKill?.(); clearTimeout(timeout); });
  return complete(cleanup, async () => {
    if (!options.duringUnroute) await cleanup.acquire(() => ctx.page.route("**/api/hygiene/**", foreign));
    await cleanup.acquire(async () => { fixture = await hygieneServer(commandContext, { op: "start" }) as typeof fixture; });
    assert.ok(fixture);
    const child = hygieneServerOwners().find(owner => owner.id === fixture!.id)!.process;
    const descriptor = Object.getOwnPropertyDescriptor(child, "kill"), kill = child.kill.bind(child);
    child.kill = signal => { killedWithFencePending ||= fenceOutstanding; return kill(signal); };
    restoreKill = () => { if (descriptor) Object.defineProperty(child, "kill", descriptor); else Reflect.deleteProperty(child, "kill"); };
    // Independent cancellation safety: a test timeout must release route holds
    // even when Vitest abandons this command's awaiting stack.
    timeout = setTimeout(() => { releases.forEach(g => g.release()); releaseFence.release(); }, 5000);
    if (!options.duringUnroute) {
      request();
      await arrived(bodies[0]!.promise, "first native body");
    }
    exerciseUnroute = true;
    const stopping = Promise.resolve(hygieneServer(commandContext, { op: "stop", id: fixture.id })).then(
      (): { error?: unknown } => ({}), (error: unknown): { error?: unknown } => ({ error })
    );
    stopResult = stopping;
    void stopping.then(() => { stopSettled = true; });
    if (options.failRoute) releases[0]!.release();
    await arrived(admissionClosed.promise, "close admission before waiting for held native responses");
    if (!options.failRoute) assert.equal(unrouteActive, options.duringUnroute ? 0 : 1, "admission closes while the original response is still owed");
    if (!options.failRoute) assert.equal(afterUnrouteActive, options.duringUnroute ? 1 : 3, "route update retains every admitted native response");
    if (!options.failRoute) {
      // Keep generating requests until stop completes. None may re-enter the
      // removed forwarder, even while older original native 200s remain held.
      const continued = gate();
      producing = true;
      producer = (async () => {
        let count = 0;
        while (producing) {
          await frame.evaluate(async () => { const r = await fetch("/api/hygiene/review"); await r.text(); });
          if (++count === 3) continued.release();
        }
      })();
      void producer.catch(error => { originalError ??= { error }; continued.release(); });
      await arrived(continued.promise, "continued foreign fallback requests");
      assert.equal(next, options.duringUnroute ? 1 : 3, "post-boundary requests cannot re-enter the old forwarder");
      if (!options.duringUnroute) assert.ok(foreignCalls >= 3, "foreign fallback chain remains registered");
      holdNextFence = true;
      await arrived(fenceHeld.promise, "real delegating fence callback");
      releases.forEach(g => g.release());
      await arrived(fenceRemoved.promise, "fence admission closed");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(stopSettled, false, "shutdown must join its removed fence callback");
      assert.equal(killedWithFencePending, false, "native termination must join its removed fence callback");
      releaseFence.release();
    }
    const result = await stopping;
    producing = false;
    if (producer) await producer;
    assert.equal(callbacks.size, 0, "native shutdown must join every admitted callback");
    if (options.failRoute || options.failUnroute) {
      if (options.failRoute && options.failUnroute) {
        assert.ok(result.error instanceof AggregateError);
        assert.equal(result.error.errors.length, 2);
        assert.equal(result.error.errors[0], routeError, "original route failure identity survives");
        assert.equal(result.error.errors[1], unrouteError, "original unroute failure identity survives");
      } else assert.equal(result.error, options.failRoute ? routeError : unrouteError, "shutdown preserves original failure identity");
      assert.equal(originalError?.error, options.failRoute ? routeError : undefined);
      if (options.failRoute) {
        const response = (await Promise.allSettled(responses))[0]!;
        assert.equal(response.status, "rejected", "deliberately aborted failure-path request rejects");
        if (response.status === "rejected") validatedBrowserFailure = response.reason;
      }
      validatedRouteFailure = options.failRoute ? routeError : undefined;
      validatedStopFailure = result.error;
      await assert.rejects(fetch(`${fixture.url}/fixture`), "shutdown failure still terminates native resources");
      return { identity: true, stopped: true };
    }
    if (result.error) throw result.error;
    if (originalError) throw originalError.error;
    assert.equal(next, options.duringUnroute ? 1 : 3, "continued arrival cannot keep the closing forwarder alive");
    if (options.duringUnroute) assert.equal(afterUnrouteActive, 1, "real callback remains owned across route-pattern update");
    const browser = await Promise.all(responses);
    assert.equal(browser.length, options.duringUnroute ? 1 : 3);
    // Config discovery runs before workspace builds; load the real schema only
    // when this native command validates its responses through ordinary exports.
    const { hygieneReviewReadSchema } = await import("@schlessera/brain-ui-sdk/schemas");
    for (let i = 0; i < browser.length; i++) {
      assert.equal(native[i]!.status, 200, "original native HTTP response");
      assert.equal(browser[i]!.status, 200, "original browser response must remain 200");
      assert.equal(browser[i]!.body, native[i]!.body, "browser receives the complete original native body");
      const read = hygieneReviewReadSchema.parse(JSON.parse(browser[i]!.body));
      assert.equal(read.review.status, "idle"); assert.equal(read.action, null);
    }
    return { responses: browser.length, stopPending: callbacks.size, unrouteActive, afterUnrouteActive };
  });
};
declare module "vitest/browser" {
  interface BrowserCommands {
    hygieneLifecycle: (options: { duringUnroute?: boolean; failRoute?: boolean; failUnroute?: boolean }) => Promise<unknown>;
  }
}

/** The two native scene helpers share this context-owned shutdown boundary. */
export const hygieneContextLifecycle: BrowserCommand<[], unknown> = async (ctx) => {
  let fixture: { id: string; url: string } | undefined;
  let context: BrowserContext | undefined;
  const held = gate(), bodyReady = gate();
  let fulfilled = false, error: { value: unknown } | undefined;
  const callbacks = new Set<Promise<void>>();
  let browser: Promise<{ status: number; body: string }> | undefined;
  let closing: Promise<void> | undefined;
  let nativeBody = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = ownCleanup(async () => {
    const errors: unknown[] = [];
    const joined = await Promise.allSettled([...(closing ? [closing] : []), ...callbacks, ...(browser ? [browser] : [])]);
    for (const result of joined) if (result.status === "rejected") errors.push(result.reason);
    if (context) await attempt(errors, () => context!.close());
    if (fixture) await attempt(errors, () => hygieneServer(ctx, { op: "stop", id: fixture!.id }));
    clearTimeout(timer);
    if (error) errors.unshift(error.value);
    failure(errors, "native context lifecycle cleanup failed");
  }, () => { held.release(); clearTimeout(timer); });
  return complete(cleanup, async () => {
    await cleanup.acquire(async () => { fixture = await hygieneServer(ctx, { op: "start" }) as { id: string; url: string }; });
    await cleanup.acquire(async () => { context = await ctx.context.browser()!.newContext(); });
    assert.ok(context); assert.ok(fixture);
    timer = setTimeout(held.release, 5000);
    const origin = new URL(ctx.page.url()).origin;
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route("**/api/hygiene/**", route => {
      const task = (async () => {
        const response = await fetch(`${fixture!.url}/api/hygiene/review`);
        assert.equal(response.status, 200, "original native context response");
        nativeBody = await response.text(); bodyReady.release();
        await held.promise;
        await route.fulfill({ status: response.status, contentType: "application/json", body: nativeBody });
        fulfilled = true;
      })().catch(value => { error ??= { value }; });
      callbacks.add(task);
      return task.finally(() => { callbacks.delete(task); });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/hygiene-lifecycle-native`);
    browser = page.evaluate(async () => {
      const response = await fetch("/api/hygiene/review");
      return { status: response.status, body: await response.text() };
    });
    void browser.catch(value => { error ??= { value }; });
    await arrived(bodyReady.promise, "native context body");
    closing = closeHygieneContext({
      unrouteAll: context.unrouteAll.bind(context),
      async close() {
        assert.equal(fulfilled, true, "context close must follow its original native fulfill");
        const response = await browser!;
        assert.equal(response.status, 200, "native context browser response remains 200");
        assert.equal(response.body, nativeBody, "native context browser retains original body");
        const { hygieneReviewReadSchema } = await import("@schlessera/brain-ui-sdk/schemas");
        assert.equal(hygieneReviewReadSchema.parse(JSON.parse(response.body)).review.status, "idle");
        await context!.close();
      },
    });
    // The request is already held when closing starts; no delay decides order.
    held.release();
    await closing;
    if (error) throw error.value;
    assert.equal(callbacks.size, 0, "native context owns handlers through drain");
    return { original200: true, pending: 0 };
  });
};
declare module "vitest/browser" {
  interface BrowserCommands { hygieneContextLifecycle: () => Promise<unknown>; hygieneLifecycleCleanup: () => Promise<void>; }
}
