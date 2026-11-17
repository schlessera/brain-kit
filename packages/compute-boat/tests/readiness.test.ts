/**
 * Readiness is Boat's sandbox state, not setup completion: a `ready` sandbox
 * whose setup still runs takes commands, and a provisioned one whose setup is
 * done does not. Long commands run detached, and the remote auto-stop is
 * always finite.
 */

import { describe, expect, test } from "bun:test";

import { MAX_TTL_SECONDS } from "../src/provider";
import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

describe("readiness and long commands", () => {
  test("a ready sandbox whose setup is still running takes the command", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 2, setupStatus: "running" });
    const { provider, now } = instantProvider();
    const allocated = await provider.allocate({ key: "job-telemachus-1", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const started = await provider.exec(allocated.sandbox, { argv: ["exit", "0"], env: {} }, contextFor(fake, { now }));
    expect(started.kind).toBe("ok");
    const sandbox = fake.sandboxes.get(allocated.sandbox.id)!;
    expect([sandbox.state, sandbox.setupStatus]).toEqual(["ready", "running"]);
  });

  test("a provisioned sandbox whose setup is done is waited for, and nothing runs before the deadline", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: Infinity, setupStatus: "done" });
    const { provider, now, waits } = instantProvider();
    const allocated = await provider.allocate({ key: "job-telemachus-2", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const started = await provider.exec(allocated.sandbox, { argv: ["exit", "0"], env: {} }, contextFor(fake, { now, deadlineMs: 20_000 }));
    expect(started.kind).toBe("failed");
    expect(started.kind === "failed" && started.reason).toContain("provisioned");
    expect(fake.routes().filter((r) => r === "exec")).toEqual([]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(20_000);
  });

  test("a long command starts detached, with no synchronous timeout, and polls as running", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    const allocated = await provider.allocate({ key: "job-telemachus-3", leaseSeconds: 7200, retain: false }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const started = await provider.exec(allocated.sandbox, { argv: ["sleep", "3600"], env: {} }, contextFor(fake, { now }));
    if (started.kind !== "ok") throw new Error(started.kind);
    const body = JSON.parse(fake.requests.find((r) => r.route === "exec")!.body);
    expect([body.detached, body.timeoutSeconds]).toEqual([true, undefined]);
    expect((await provider.poll(started.handle, contextFor(fake, { now }))).kind).toBe("running");
  });

  test("the remote auto-stop is the host's backstop, finite and within Boat's ceiling", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    await provider.allocate({ key: "job-a", leaseSeconds: 600, remoteExpirySeconds: 720, retain: false }, contextFor(fake, { now }));
    await provider.allocate({ key: "job-b", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    await provider.allocate({ key: "job-c", leaseSeconds: 600, remoteExpirySeconds: 10 * MAX_TTL_SECONDS, retain: false }, contextFor(fake, { now }));
    const ttls = fake.requests.filter((r) => r.route === "create").map((r) => JSON.parse(r.body).ttlSeconds);
    expect(ttls).toEqual([720, 600, MAX_TTL_SECONDS]);
  });
});
