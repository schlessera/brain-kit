import type { BrowserContext, Page, Route } from "playwright";

/** Test fixture callbacks belong to fixture shutdown, including their failures. */
export function hygieneRouteOwner(forward: (route: Route) => Promise<void>) {
  const pending = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const handler = (route: Route): Promise<void> => {
    // Register before the callback can yield or throw. Completed requests are
    // discarded; only the first failure survives until its command boundary.
    const task = Promise.resolve().then(() => forward(route)).catch(error => {
      failure ??= { error };
      // Preserve Playwright's original rejection as well as the stop failure.
      throw error;
    }).finally(() => { pending.delete(task); });
    pending.add(task);
    return task;
  };
  const drain = async (tasks: Set<Promise<void>>) => {
    while (tasks.size) await Promise.allSettled([...tasks]);
  };
  let closing: Promise<void> | undefined;
  return {
    handler,
    close(page: Pick<Page, "route" | "unroute">, pattern: string) {
      return closing ??= (async () => {
        // Retain interception for owed responses while removing the original
        // registration closes admission. The temporary route delegates normally.
        const fencePending = new Set<Promise<void>>();
        let fenceFailure: { error: unknown } | undefined;
        const fence = (route: Route) => {
          const task = Promise.resolve().then(() => route.fallback()).catch(error => {
            fenceFailure ??= { error };
            throw error;
          }).finally(() => { fencePending.delete(task); });
          fencePending.add(task);
          return task;
        };
        const cleanup: unknown[] = [];
        try { await page.route(pattern, fence); } catch (error) { cleanup.push(error); }
        // Attempt removal even if the fence update failed; one cleanup failure
        // must not leave the forwarder admitting requests during the join.
        try { await page.unroute(pattern, handler); } catch (error) { cleanup.push(error); }
        // Callbacks may enter during the real route update. Admission is now
        // closed, so this join has finite owned work even with continued traffic.
        await drain(pending);
        try { await page.unroute(pattern, fence); } catch (error) { cleanup.push(error); }
        // The fence has its own closed admission boundary. Continued arrivals
        // must never keep either owned join open.
        await drain(fencePending);
        const errors = [...new Set([...(failure ? [failure.error] : []), ...(fenceFailure ? [fenceFailure.error] : []), ...cleanup])];
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "fixture route shutdown failed");
      })();
    },
  };
}

/** These native scene contexts own every route registration they remove. */
export async function closeHygieneContext(context: Pick<BrowserContext, "unrouteAll" | "close">) {
  let failure: { error: unknown } | undefined;
  try { await context.unrouteAll({ behavior: "wait" }); } catch (error) { failure = { error }; }
  try { await context.close(); } catch (error) {
    if (failure) throw new AggregateError([failure.error, error], "fixture routing and context cleanup failed");
    throw error;
  }
  if (failure) throw failure.error;
}
