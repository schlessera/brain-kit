/** Cleanup owned only by the native-suite regression and its timeout child. */
import { afterAll, afterEach } from "bun:test";
import { invocationChild } from "../../../../scripts/test-invocation-child.js";

export function cleanupScope() {
  const disposers: Array<() => void | Promise<void>> = [];
  let closing: Promise<void> | undefined;
  return {
    defer(dispose: () => void | Promise<void>) {
      if (closing) throw new Error("Cannot acquire resources in a closed regression scope");
      disposers.push(dispose);
    },
    close() {
      return closing ??= (async () => {
        const errors: unknown[] = [];
        for (const dispose of disposers.splice(0).reverse()) {
          try { await dispose(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "Regression cleanup failed");
      })();
    },
  };
}

/** A fixture's boolean idempotence alone does not join an in-flight close. */
export function ownClose<T extends { close: () => Promise<void> }>(scope: ReturnType<typeof cleanupScope>, resource: T): T {
  const close = resource.close.bind(resource);
  let closing: Promise<void> | undefined;
  resource.close = () => closing ??= close();
  scope.defer(resource.close);
  return resource;
}

export function installRegressionScopes() {
  const scopes: ReturnType<typeof cleanupScope>[] = [];
  const close = async () => {
    const errors: unknown[] = [];
    for (const scope of scopes.splice(0).reverse()) {
      try { await scope.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Regression scope cleanup failed");
  };
  afterEach(close);
  afterAll(close);
  return () => { const scope = cleanupScope(); scopes.push(scope); return scope; };
}

/** The repo anchor owns cancellation of its group, including inherited pipes.
 * A nested test wrapper handles its own detached group on TERM/IPC disconnect.
 * Join both EOFs and exit after stopping, before a scope may remove its root.
 */
export function ownInvocation(scope: ReturnType<typeof cleanupScope>, argv: string[]) {
  const child = invocationChild(argv, { cwd: new URL("../../../..", import.meta.url).pathname });
  scope.defer(async () => {
    const errors: unknown[] = [];
    try { await child.stop("SIGTERM"); } catch (error) { errors.push(error); }
    try { await child.finish(); } catch (error) { errors.push(error); }
    for (const item of await joined) if (item.status === "rejected") errors.push(item.reason);
    if (errors.length) throw new AggregateError(errors, "Regression invocation cleanup failed");
  });
  const joined = Promise.allSettled([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()] as const);
  return {
    child,
    async result() {
      const results = await joined;
      const errors = results.flatMap(item => item.status === "rejected" ? [item.reason] : []);
      try { await child.finish(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Regression invocation failed");
      return results.map(item => (item as PromiseFulfilledResult<unknown>).value) as [number, string, string];
    },
  };
}
