/// <reference types="@vitest/browser-playwright" />
import assert from "node:assert/strict";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
import { hygieneContextLifecycle, hygieneLifecycle, hygieneLifecycleCleanup } from "./hygiene-lifecycle-command.ts";
import { hygieneServer, hygieneServerOwners } from "./hygiene-server-command.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function observe<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
}
function originals(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(originals) : [error];
}
function delegate<T extends object>(target: T, override: (key: PropertyKey) => unknown): T {
  return new Proxy(target, { get(target, key) {
    const replacement = override(key);
    if (replacement !== undefined) return replacement;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

type Options = { mode: "context-failure" | "aggregate-primary" | "late-fixture" | "late-context" | "late-first-command" | "multi-error" | "new-owner" };
/** Faults wrap actual public acquisitions/cleanup; native children are never doubled. */
export const hygieneLifecycleFailures: BrowserCommand<[Options], unknown> = async (ctx, { mode }) => {
  const before = new Set(hygieneServerOwners().map(owner => owner.id));
  const browser = ctx.context.browser()!;
  const contexts: BrowserContext[] = [];
  const registrations: Array<Parameters<Page["route"]>> = [];
  const holds: Array<ReturnType<typeof gate>> = [];
  const tasks: Array<Promise<{ value: unknown; error: unknown }>> = [];
  const primary = mode === "aggregate-primary" ? new AggregateError([new Error("original nested acquisition failure")], "original aggregate acquisition failure") : new Error("original context acquisition failure");
  const owned = () => hygieneServerOwners().filter(owner => !before.has(owner.id));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const held = async (entered: ReturnType<typeof gate>, release: ReturnType<typeof gate>) => {
    const timer = setTimeout(release.release, 5000); timers.add(timer);
    entered.release();
    try { await release.promise; } finally { clearTimeout(timer); timers.delete(timer); }
  };
  let hook: ReturnType<typeof observe> | undefined;
  const outcome = await observe((async () => {
    // Independent release safety belongs to this harness before any acquisition.
    if (mode === "new-owner") {
      const start = () => {
        const entered = gate(), release = gate(); holds.push(release);
        const scopedBrowser = delegate(browser, key => key === "newContext" ? async () => {
          const context = await browser.newContext(); contexts.push(context);
          await held(entered, release); return context;
        } : undefined);
        const context = delegate(ctx.context, key => key === "browser" ? () => scopedBrowser : undefined);
        tasks.push(observe(Promise.resolve(hygieneContextLifecycle({ ...ctx, context }))));
        return { entered, release };
      };
      const first = start(); await first.entered.promise;
      hook = observe(Promise.resolve(hygieneLifecycleCleanup(ctx)));
      const second = start(); await second.entered.promise;
      const children = owned(); assert.equal(children.length, 2);
      first.release.release(); await hook; await tasks[0];
      assert.equal(owned().length, 1, "old hook/finally must retain the new owner registration");
      assert.equal((await fetch(`${owned()[0]!.url}/api/hygiene/review`)).status, 200, "new native child is still live");
      let done = false;
      hook = observe(Promise.resolve(hygieneLifecycleCleanup(ctx)));
      void hook.then(() => { done = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      const finishedEarly = done;
      second.release.release(); await hook; await tasks[1];
      assert.equal(finishedEarly, false, "new owner's hook must retain and join its acquisition");
      assert.equal(owned().length, 0);
      for (const child of children) assert.equal(child.process.exitCode, 0);
      for (const context of contexts) assert.equal(browser.contexts().includes(context), false);
      return { identity: true, retired: true };
    }
    if (mode === "multi-error") {
      const failures = [0, 1].map(index => ({
        primary: new Error(`primary ${index}`), close: new Error(`context close ${index}`), stop: new Error(`server stop ${index}`),
        entered: gate(), release: gate(),
      }));
      for (const fault of failures) {
        holds.push(fault.release);
        const scopedBrowser = delegate(browser, key => key === "newContext" ? async () => {
          const context = await browser.newContext(); contexts.push(context);
          return delegate(context, key => {
            if (key === "route") return async (...args: Parameters<BrowserContext["route"]>) => {
              await context.route(...args); throw fault.primary;
            };
            if (key === "close") return async () => {
              await held(fault.entered, fault.release);
              await context.close(); throw fault.close;
            };
          });
        } : undefined);
        const page = delegate(ctx.page, key => key === "unroute" ? async (...args: Parameters<Page["unroute"]>) => {
          await ctx.page.unroute(...args); throw fault.stop;
        } : undefined);
        const context = delegate(ctx.context, key => key === "browser" ? () => scopedBrowser : undefined);
        tasks.push(observe(Promise.resolve(hygieneContextLifecycle({ ...ctx, page, context }))));
      }
      await Promise.all(failures.map(fault => fault.entered.promise));
      const children = owned(); assert.equal(children.length, 2, "both actual native children acquired");
      hook = observe(Promise.resolve(hygieneLifecycleCleanup(ctx)));
      holds.forEach(hold => hold.release());
      const results = await Promise.all(tasks);
      const hookResult = await hook;
      for (let index = 0; index < failures.length; index++) {
        const fault = failures[index]!;
        const actual = originals(results[index]!.error), expected = [fault.primary, fault.close, fault.stop];
        assert.equal(actual.length, expected.length);
        expected.forEach((error, index) => assert.equal(actual[index], error, "primary, context-close and server-stop identities survive"));
      }
      const actual = originals(hookResult.error), expected = failures.flatMap(fault => [fault.close, fault.stop]);
      assert.equal(actual.length, expected.length, "registry attempts every owner after rejection");
      expected.forEach((error, index) => assert.equal(actual[index], error, "registry preserves each original error object"));
      assert.equal(owned().length, 0, "failed cleanup still retires every native owner");
      for (const child of children) { assert.equal(child.process.exitCode, 0); await assert.rejects(fetch(`${child.url}/fixture`)); }
      for (const context of contexts) assert.equal(browser.contexts().includes(context), false, "real context closed despite reported cleanup failure");
      // A late finally must neither retry a failed cleanup nor delete a new owner.
      await hygieneLifecycleCleanup(ctx);
      assert.equal(owned().length, 0);
      return { identities: true, owners: 2, retired: true };
    }
    const entered = gate(), release = gate(); holds.push(release);
    let contextCalls = 0, routeCalls = 0;
    let acquiredChildren: ReturnType<typeof hygieneServerOwners> = [];
    const scopedBrowser = delegate(browser, key => key === "newContext" ? async (...args: Parameters<Browser["newContext"]>) => {
      contextCalls++;
      if (mode === "context-failure" || mode === "aggregate-primary" || mode === "late-fixture") throw primary;
      const context = await browser.newContext(...args); contexts.push(context);
      if (mode === "late-context") await held(entered, release);
      return context;
    } : undefined);
    const page = delegate(ctx.page, key => key === "route" ? async (...args: Parameters<Page["route"]>) => {
      registrations.push(args);
      await ctx.page.route(...args); routeCalls++; acquiredChildren = owned();
      if (mode === "late-fixture" || (mode === "late-first-command" && routeCalls === 2)) { await held(entered, release); }
    } : undefined);
    const context = delegate(ctx.context, key => key === "browser" ? () => scopedBrowser : undefined);
    const command = mode === "late-first-command" ? hygieneLifecycle({ ...ctx, page, context }, {}) : hygieneContextLifecycle({ ...ctx, page, context });
    tasks.push(observe(Promise.resolve(command)));
    if (mode === "context-failure" || mode === "aggregate-primary") {
      const result = await tasks[0]!;
      assert.equal(result.error, primary, "original acquisition error survives cleanup by identity");
      assert.equal(acquiredChildren.length, 1, "context failure follows actual native child acquisition");
      assert.equal(owned().length, 0, "failed context acquisition retires the actual native child");
      for (const child of acquiredChildren) { assert.equal(child.process.exitCode, 0); await assert.rejects(fetch(`${child.url}/fixture`)); }
    } else {
      await entered.promise;
      const children = owned(); assert.equal(children.length, 1, "native child exists before abandonment");
      let hookDone = false;
      hook = observe(Promise.resolve(hygieneLifecycleCleanup(ctx)));
      void hook.then(() => { hookDone = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      const completedBeforeAcquisition = hookDone;
      release.release();
      await hook; await tasks[0];
      assert.equal(completedBeforeAcquisition, false, "hook must join unresolved acquisition before it can finish");
      assert.equal(owned().length, 0, "late fixture acquisition is retired after hook abandonment");
      if (mode === "late-fixture") assert.equal(contextCalls, 0, "abandoned fixture cannot proceed to context acquisition");
      for (const child of children) { assert.equal(child.process.exitCode, 0); await assert.rejects(fetch(`${child.url}/fixture`)); }
      for (const context of contexts) assert.equal(browser.contexts().includes(context), false, "late native context is retired");
      const result = await tasks[0]!;
      assert.ok(result.error, "abandoned command cannot resume using retired resources");
    }
    return { identity: true, retired: true };
  })());
    holds.forEach(hold => hold.release()); timers.forEach(timer => clearTimeout(timer));
    // This independent recovery also retires intentionally broken old-source arms.
    // Preserve every error while attempting every resource; never replace a primary.
    await Promise.allSettled([...(hook ? [hook] : []), ...tasks]);
    const errors: unknown[] = outcome.error === undefined ? [] : originals(outcome.error);
    for (const context of contexts) try { await context.close(); } catch (error) { errors.push(error); }
    for (const child of owned()) try { await hygieneServer(ctx, { op: "stop", id: child.id }); } catch (error) { errors.push(error); }
    try { await hygieneLifecycleCleanup(ctx); } catch (error) { errors.push(error); }
    // Broken old-source/mutation arms may lose the command's registration map.
    // Retire only the exact public handlers this scoped harness registered.
    for (const [pattern, handler] of registrations) try { await ctx.page.unroute(pattern, handler); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "native lifecycle failure and recovery failed");
    return outcome.value;
};
declare module "vitest/browser" {
  interface BrowserCommands { hygieneLifecycleFailures: (options: Options) => Promise<unknown>; }
}
