/**
 * A lost create answer never yields a second sandbox: the retry sends the
 * same `Idempotency-Key` and the same body, and a sandbox carrying the
 * allocation key is found and reused even after Boat's 24-hour key window.
 */

import { describe, expect, test } from "bun:test";

import { MAX_ATTEMPTS } from "../src/client";
import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

describe("ambiguous create", () => {
  test("a lost answer is retried under the same key and body, and yields one sandbox", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    fake.failNext("create", "lose-response");
    const { provider, now } = instantProvider();
    const outcome = await provider.allocate({ key: "job-scheria-1", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    expect(outcome.kind).toBe("ok");
    expect(fake.created()).toBe(1);
    const posts = fake.requests.filter((r) => r.route === "create");
    expect(posts.length).toBe(2);
    expect(new Set(posts.map((r) => r.headers["idempotency-key"])).size).toBe(1);
    expect(new Set(posts.map((r) => r.body)).size).toBe(1);
  });

  test("an answer lost on every attempt is uncertain, and find locates the one sandbox", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    fake.failNext("create", "lose-response", MAX_ATTEMPTS);
    const { provider, now } = instantProvider();
    const lost = await provider.allocate({ key: "job-scheria-2", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    expect(lost.kind).toBe("uncertain");
    const found = await provider.find!("job-scheria-2", contextFor(fake, { now }));
    expect([found.kind, fake.created()]).toEqual(["ok", 1]);
  });

  test("a retried allocation reuses the key, so a sandbox not yet listed is not created twice", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0, listLag: true });
    fake.failNext("create", "lose-response", MAX_ATTEMPTS);
    const { provider, now } = instantProvider();
    const lost = await provider.allocate({ key: "job-scheria-5", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    expect(lost.kind).toBe("uncertain");
    const again = await provider.allocate({ key: "job-scheria-5", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    expect([again.kind, fake.created()]).toEqual(["ok", 1]);
    expect(new Set(fake.requests.filter((r) => r.route === "create").map((r) => r.headers["idempotency-key"])).size).toBe(1);
  });

  test("after the key window, a retried allocation finds the sandbox instead of creating another", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now, advance } = instantProvider();
    const first = await provider.allocate({ key: "job-scheria-3", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    advance(25 * 60 * 60 * 1000);
    fake.forgetIdempotencyKeys();
    const again = await provider.allocate({ key: "job-scheria-3", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    expect(first.kind === "ok" && again.kind === "ok" && again.sandbox.id === first.sandbox.id).toBe(true);
    expect([fake.created(), fake.routes().filter((r) => r === "create").length]).toEqual([1, 1]);
  });

  test("find refuses to guess between two sandboxes carrying one key", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    await provider.allocate({ key: "job-scheria-4", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    fake.forgetIdempotencyKeys();
    const [first] = [...fake.sandboxes.values()];
    fake.sandboxes.set("bx_zzzzzzzz", { ...first!, id: "bx_zzzzzzzz" });
    expect((await provider.find!("job-scheria-4", contextFor(fake, { now }))).kind).toBe("uncertain");
    expect((await provider.allocate({ key: "job-scheria-4", leaseSeconds: 600, retain: false }, contextFor(fake, { now }))).kind).toBe("uncertain");
  });
});
