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
    }).finally(() => { pending.delete(task); });
    pending.add(task);
    return task;
  };
  const drain = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  return {
    handler,
    async close(page: Pick<Page, "route" | "unroute">, pattern: string) {
      // Keep interception enabled while removing this handler closes admission.
      // Disabling the last pattern can release paused requests before fulfill.
      // This temporary route delegates normally; it supplies no fixture response.
      const fence = (route: Route) => route.fallback();
      const cleanup: unknown[] = [];
      try {
        await page.route(pattern, fence);
        await drain();
        await page.unroute(pattern, handler);
      } catch (error) {
        cleanup.push(error);
      } finally {
        // A callback can enter during the pattern update. It still owes its
        // original response, even though new requests no longer reach handler.
        await drain();
        try { await page.unroute(pattern, fence); } catch (error) { cleanup.push(error); }
      }
      const errors = [...(failure ? [failure.error] : []), ...cleanup];
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "fixture route shutdown failed");
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
