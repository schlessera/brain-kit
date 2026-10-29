import { afterEach, expect, test } from "vitest";
import { commands } from "vitest/browser";

afterEach(async () => { await commands.hygieneLifecycleCleanup(); });

test("native hygiene closes admission before drain under continued requests", async () => {
  expect(await commands.hygieneLifecycle({})).toMatchObject({ responses: 3, stopPending: 0, unrouteActive: 1 });
});
test("native hygiene shutdown owns a callback admitted during unroute", async () => {
  expect(await commands.hygieneLifecycle({ duringUnroute: true })).toMatchObject({ responses: 1, stopPending: 0, afterUnrouteActive: 1 });
});
test("native hygiene route failure retains identity and cleans native resources", async () => {
  expect(await commands.hygieneLifecycle({ failRoute: true })).toEqual({ identity: true, stopped: true });
});
test("native hygiene unroute failure retains identity and cleans native resources", async () => {
  expect(await commands.hygieneLifecycle({ failUnroute: true })).toEqual({ identity: true, stopped: true });
});

test("native hygiene route and cleanup failures retain both identities", async () => {
  expect(await commands.hygieneLifecycle({ failRoute: true, failUnroute: true })).toEqual({ identity: true, stopped: true });
});
test("native hygiene scene context joins its original response before close", async () => {
  expect(await commands.hygieneContextLifecycle()).toEqual({ original200: true, pending: 0 });
});

for (const mode of ["context-failure", "aggregate-primary", "late-fixture", "late-context", "late-first-command", "new-owner"] as const) {
  test(`native hygiene acquisition cleanup: ${mode}`, async () => {
    expect(await commands.hygieneLifecycleFailures({ mode })).toEqual({ identity: true, retired: true });
  });
}
test("native hygiene cleanup attempts all owners and retains every original error", async () => {
  expect(await commands.hygieneLifecycleFailures({ mode: "multi-error" })).toEqual({ identities: true, owners: 2, retired: true });
});
