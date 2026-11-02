/**
 * Cleanup is reported as it happened: a blocked deletion, a failing stop, an
 * unconfirmed deletion or a lost answer is never `released`, and a later
 * release that succeeds is.
 */

import { describe, expect, test } from "bun:test";

import { MAX_ATTEMPTS } from "../src/client";
import { fakeBoat, type FakeBoatOptions } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

async function allocated(opts: Partial<FakeBoatOptions> = {}, retain = false) {
  const fakeOpts: FakeBoatOptions = { apiKey: KEY, readyAfterGets: 0, ...opts };
  const fake = fakeBoat(fakeOpts);
  const { provider, now } = instantProvider();
  const outcome = await provider.allocate({ key: "job-aeolus", leaseSeconds: 600, retain }, contextFor(fake, { now }));
  if (outcome.kind !== "ok") throw new Error(outcome.kind);
  return { fake, fakeOpts, provider, now, sandbox: outcome.sandbox };
}

describe("cleanup failures", () => {
  test("a blocked deletion fails; the next release is idempotent and released", async () => {
    const { fake, provider, now, sandbox } = await allocated({ deletionBlocked: true });
    const first = await provider.release(sandbox, "discard", contextFor(fake, { now }));
    expect(first.kind).toBe("failed");
    const second = await provider.release(sandbox, "discard", contextFor(fake, { now }));
    expect(second.kind).toBe("released");
  });

  test("a stop that cannot save the disk fails, never retained; once Boat archives, the release retains", async () => {
    const { fake, fakeOpts, provider, now, sandbox } = await allocated({ stopFailing: true }, true);
    expect((await provider.release(sandbox, "retain", contextFor(fake, { now }))).kind).toBe("failed");
    expect(fake.sandboxes.get(sandbox.id)!.state).toBe("ready");
    fakeOpts.stopFailing = false;
    fake.sandboxes.get(sandbox.id)!.stop!.status = "pending";
    expect((await provider.release(sandbox, "retain", contextFor(fake, { now }))).kind).toBe("retained");
  });

  test("a deletion whose answer is lost on every attempt is uncertain", async () => {
    const { fake, provider, now, sandbox } = await allocated();
    fake.failNext("delete", "lose-response", MAX_ATTEMPTS);
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("uncertain");
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("released");
  });

  test("a deletion not confirmed before the deadline is uncertain", async () => {
    const { fake, provider, now, sandbox } = await allocated();
    fake.failNext("deletion-op", { status: 500, code: "http_500" }, MAX_ATTEMPTS);
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("uncertain");
  });

  test("a sandbox already gone is released, twice", async () => {
    const { fake, provider, now, sandbox } = await allocated();
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("released");
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("released");
    const deletes = fake.requests.filter((r) => r.route === "delete");
    expect(deletes.every((r) => r.headers["x-ascii-confirm-delete"] === sandbox.id)).toBe(true);
  });
});
