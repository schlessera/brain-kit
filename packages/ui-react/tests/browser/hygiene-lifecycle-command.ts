/// <reference types="@vitest/browser-playwright" />
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Route } from "playwright";
import type { BrowserCommand } from "vitest/node";
import { hygieneReviewReadSchema } from "@schlessera/brain-ui-sdk/schemas";
import { closeHygieneContext } from "./hygiene-route-owner.ts";
import { hygieneServer } from "./hygiene-server-command.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const cleanups = new Set<() => Promise<void>>();
function ownCleanup(cleanup: () => Promise<void>) {
  let running: Promise<void> | undefined;
  const run = () => running ??= cleanup();
  cleanups.add(run);
  return async () => { try { await run(); } finally { cleanups.delete(run); } };
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
  for (const cleanup of cleanups) {
    try { await cleanup(); } finally { cleanups.delete(cleanup); }
  }
};
/** Drives the original native fixture and actual Vitest iframe; no HTTP doubles. */
export const hygieneLifecycle: BrowserCommand<[{ duringUnroute?: boolean; failRoute?: boolean; failUnroute?: boolean }], unknown> = async (ctx, options) => {
  const frame = await ctx.frame();
  const releases = [gate(), gate(), gate()];
  const bodies = [gate(), gate(), gate()];
  const unrouteEntered = gate(), fenceInstalled = gate();
  let installingFence = false;
  const owed = new Set<number>();
  const native: Array<{ status?: number; body: string }> = [];
  const responses: Array<Promise<{ status: number; body: string }>> = [];
  const callbacks = new Set<Promise<void>>();
  const routeError = new Error("owned native response failure");
  const unrouteError = new Error("owned unroute failure");
  let originalError: { error: unknown } | undefined;
  let next = 0, unrouteActive = -1, afterUnrouteActive = -1, unrouteFailed = false;
  let stopResult: Promise<{ error?: unknown }> | undefined;
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
  const registered = new Map<(route: Route) => Promise<void>, (route: Route) => Promise<void>>();
  const page = new Proxy(ctx.page, {
    get(target, key) {
      if (key === "route") return async (pattern: string, handler: (route: Route) => Promise<void>) => {
        assert.equal(pattern, "**/api/hygiene/**");
        if (fixture) {
          installingFence = true;
          await target.route(pattern, handler);
          // The close continuation starts its drain before the next Node turn.
          setImmediate(fenceInstalled.release);
          return;
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
        if (!wrapped) return target.unroute(pattern, handler);
        unrouteActive = owed.size;
        unrouteEntered.release();
        if (options.duringUnroute) {
          request();
          await arrived(bodies[0]!.promise, "first native body");
        }
        // Use the actual registered wrapper, not the fixture's inner callback.
        await target.unroute(pattern, wrapped);
        afterUnrouteActive = owed.size;
        if (options.duringUnroute) releases[0]!.release();
        if (options.failUnroute && !unrouteFailed) { unrouteFailed = true; throw unrouteError; }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Page;
  const commandContext = { ...ctx, page };
  const cleanup = ownCleanup(async () => {
    releases.forEach(g => g.release());
    if (stopResult) await stopResult;
    if (fixture) {
      let alive = false;
      try { await fetch(`${fixture.url}/fixture`); alive = true; } catch { /* Expected after native exit. */ }
      if (alive) await hygieneServer(commandContext, { op: "stop", id: fixture.id });
    }
    const settled = await Promise.allSettled(responses);
    await Promise.allSettled(callbacks);
    clearTimeout(timeout);
    const output = resolve("../../tmp/hygiene-proof");
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, `lifecycle-${crypto.randomUUID()}.json`), JSON.stringify({
      options, native, browser: settled, stopPending: callbacks.size, unrouteActive, afterUnrouteActive,
      error: originalError && String(originalError.error), node: process.version,
      browserVersion: ctx.context.browser()!.version(),
    }, null, 2));

  });
  try {
    fixture = await hygieneServer(commandContext, { op: "start" }) as typeof fixture;
    assert.ok(fixture);
    // Independent cancellation safety: a test timeout must release route holds
    // even when Vitest abandons this command's awaiting stack.
    timeout = setTimeout(() => { releases.forEach(g => g.release()); }, 5000);
    if (!options.duringUnroute) {
      request();
      await arrived(bodies[0]!.promise, "first native body");
    }
    const stopping = Promise.resolve(hygieneServer(commandContext, { op: "stop", id: fixture.id })).then(
      (): { error?: unknown } => ({}), (error: unknown): { error?: unknown } => ({ error })
    );
    stopResult = stopping;
    if (!options.duringUnroute) {
      if (installingFence) await arrived(fenceInstalled.promise, "fence registration");
      if (options.failRoute) {
        releases[0]!.release();
      } else {
        // Each later request is admitted after the previous drain began. Three
        // held original bodies distinguish repeated drain from two snapshots.
        request(); await arrived(bodies[1]!.promise, "second native body");
        releases[0]!.release(); await responses[0];
        request(); await arrived(Promise.race([bodies[2]!.promise, unrouteEntered.promise]), "third native body or early unroute");
        if (!native[2]) assert.equal(unrouteActive, 0, "unroute must not overtake a late owned response");
        releases[1]!.release(); await responses[1];
        releases[2]!.release();
      }
    }
    const result = await stopping;
    assert.equal(callbacks.size, 0, "native shutdown must join every admitted callback");
    if (options.failRoute || options.failUnroute) {
      if (options.failRoute && options.failUnroute) {
        assert.ok(result.error instanceof AggregateError);
        assert.deepEqual(result.error.errors, [routeError, unrouteError], "both original failure objects survive cleanup");
      } else assert.equal(result.error, options.failRoute ? routeError : unrouteError, "shutdown preserves original failure identity");
      assert.equal(originalError?.error, options.failRoute ? routeError : undefined);
      await assert.rejects(fetch(`${fixture.url}/fixture`), "shutdown failure still terminates native resources");
      return { identity: true, stopped: true };
    }
    if (result.error) throw result.error;
    if (originalError) throw originalError.error;
    assert.equal(unrouteActive, 0, "unroute begins only after every admitted response settles");
    if (options.duringUnroute) assert.equal(afterUnrouteActive, 1, "real callback remains owned across route-pattern update");
    const browser = await Promise.all(responses);
    assert.equal(browser.length, options.duringUnroute ? 1 : 3);
    for (let i = 0; i < browser.length; i++) {
      assert.equal(native[i]!.status, 200, "original native HTTP response");
      assert.equal(browser[i]!.status, 200, "original browser response must remain 200");
      assert.equal(browser[i]!.body, native[i]!.body, "browser receives the complete original native body");
      const read = hygieneReviewReadSchema.parse(JSON.parse(browser[i]!.body));
      assert.equal(read.review.status, "idle"); assert.equal(read.action, null);
    }
    return { responses: browser.length, stopPending: callbacks.size, unrouteActive, afterUnrouteActive };
  } catch (error) {
    await cleanup();
    if (originalError && !options.failRoute) throw originalError.error;
    throw error;
  } finally {
    await cleanup();
  }
};
declare module "vitest/browser" {
  interface BrowserCommands {
    hygieneLifecycle: (options: { duringUnroute?: boolean; failRoute?: boolean; failUnroute?: boolean }) => Promise<unknown>;
  }
}

/** The two native scene helpers share this context-owned shutdown boundary. */
export const hygieneContextLifecycle: BrowserCommand<[], unknown> = async (ctx) => {
  const fixture = await hygieneServer(ctx, { op: "start" }) as { id: string; url: string };
  const context = await ctx.context.browser()!.newContext();
  const held = gate(), bodyReady = gate();
  let fulfilled = false, error: { value: unknown } | undefined;
  const callbacks = new Set<Promise<void>>();
  let browser: Promise<{ status: number; body: string }> | undefined;
  let closing: Promise<void> | undefined;
  let nativeBody = "";
  const timer = setTimeout(held.release, 5000);
  const cleanup = ownCleanup(async () => {
    held.release();
    await Promise.allSettled([...(closing ? [closing] : []), ...callbacks, ...(browser ? [browser] : [])]);
    try { await context.close(); } finally { await hygieneServer(ctx, { op: "stop", id: fixture.id }); clearTimeout(timer); }

  });
  try {
    const origin = new URL(ctx.page.url()).origin;
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route("**/api/hygiene/**", route => {
      const task = (async () => {
        const response = await fetch(`${fixture.url}/api/hygiene/review`);
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
        assert.equal(hygieneReviewReadSchema.parse(JSON.parse(response.body)).review.status, "idle");
        await context.close();
      },
    });
    // The request is already held when closing starts; no delay decides order.
    held.release();
    await closing;
    if (error) throw error.value;
    assert.equal(callbacks.size, 0, "native context owns handlers through drain");
    return { original200: true, pending: 0 };
  } catch (caught) {
    await cleanup();
    if (error) throw error.value;
    throw caught;
  } finally {
    await cleanup();
  }
};
declare module "vitest/browser" {
  interface BrowserCommands { hygieneContextLifecycle: () => Promise<unknown>; hygieneLifecycleCleanup: () => Promise<void>; }
}
