/**
 * A lost create answer never yields a second sandbox: the retry sends the
 * same `Idempotency-Key` and the same body, and a sandbox carrying the
 * allocation key is found and reused even after Boat's 24-hour key window.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComputeService } from "@schlessera/brain/internal";

import { MAX_ATTEMPTS } from "../src/client";
import { createBoatProvider } from "../src/provider";
import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
    if (first.kind !== "ok") throw new Error(first.kind);
    expect(again.kind === "ok" && again.sandbox.id).toBe(first.sandbox.id);
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

  test("a reused key Boat refuses for a different body is looked up again before it is called uncertain", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    fake.failNext("create", "lose-response", MAX_ATTEMPTS);
    const lost = await provider.allocate({ key: "job-scheria-6", leaseSeconds: 300, remoteExpirySeconds: 420, retain: false }, contextFor(fake, { now }));
    expect(lost.kind).toBe("uncertain");
    // The listing has not caught up when the retry looks first, and the retry's body differs.
    fake.missNextLists(1);
    const again = await provider.allocate({ key: "job-scheria-6", leaseSeconds: 300, remoteExpirySeconds: 375, retain: false }, contextFor(fake, { now }));
    expect(fake.requests.filter((r) => r.route === "create").at(-1)?.body).toContain('"ttlSeconds":375');
    expect([again.kind, fake.created()]).toEqual(["ok", 1]);
  });

  test("core's retry after time has passed sends Boat the same create body, so the lost create is adopted", async () => {
    let t = Date.parse("2026-07-12T09:00:00Z");
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0, listLag: true, now: () => t });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "brain-boat-idem-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "brain-boat-idem-state-")));
    dirs.push(root, stateDir);
    const provider = createBoatProvider({ now: () => t, sleep: async (ms) => void (t += ms) });
    const svc = createComputeService({
      root,
      stateDir,
      env: { BOAT_KEY: KEY },
      fetch: fake.fetch,
      clock: { now: () => t },
      config: { compute: { providers: { "boat-small": { provider, apiKeyEnv: "BOAT_KEY", lease: { maxSeconds: 600 } } } } },
    });
    const caller = { kind: "cli", principal: "penelope" } as const;
    fake.failNext("create", "lose-response", MAX_ATTEMPTS);
    const run = await svc.run(caller, { instance: "boat-small", argv: ["sleep", "60"], leaseSeconds: 300 });
    if (!run.ok) throw new Error(run.code);
    expect(run.job.state).toBe("uncertain");
    t += 45_500;
    const status = await svc.status(caller, run.job.id);
    if (!status.ok) throw new Error(status.code);
    const bodies = fake.requests.filter((r) => r.route === "create").map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
    expect([status.job.state, fake.created()]).toEqual(["running", 1]);
  });
});
