/**
 * A Boat stop archives the disk and ends every process. A retained release
 * reports its retention deadline; a command on a stopped sandbox reads as
 * ended by the provider, never as still running, and the adapter never
 * resumes a sandbox.
 */

import { describe, expect, test } from "bun:test";

import { RETENTION_SECONDS } from "../src/provider";
import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

describe("stop is never a pause", () => {
  test("after a retained release the running command reads provider_error, and nothing resumes", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    const ctx = () => contextFor(fake, { now });
    const allocated = await provider.allocate({ key: "job-argos-1", leaseSeconds: 600, retain: true }, ctx());
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const started = await provider.exec(allocated.sandbox, { argv: ["sleep", "3600"], env: {} }, ctx());
    if (started.kind !== "ok") throw new Error(started.kind);
    expect((await provider.poll(started.handle, ctx())).kind).toBe("running");

    const released = await provider.release(allocated.sandbox, "retain", ctx());
    const stoppedAt = fake.sandboxes.get(allocated.sandbox.id)!.stoppedAt!;
    expect(released).toEqual({ kind: "retained", until: stoppedAt + RETENTION_SECONDS * 1000 });

    const after = await provider.poll(started.handle, ctx());
    expect(after.kind === "exited" && [after.reason, after.code]).toEqual(["provider_error", null]);
    expect(fake.routes()).not.toContain("resume");
    const stop = fake.requests.find((r) => r.route === "stop")!;
    expect(JSON.parse(stop.body).force).toBeUndefined();
  });

  test("a retained sandbox whose data Boat already deleted reports released", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    const allocated = await provider.allocate({ key: "job-argos-2", leaseSeconds: 600, retain: true }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    expect((await provider.release(allocated.sandbox, "retain", contextFor(fake, { now }))).kind).toBe("retained");
    fake.sandboxes.get(allocated.sandbox.id)!.dataExpiredAt = now();
    expect((await provider.release(allocated.sandbox, "retain", contextFor(fake, { now }))).kind).toBe("released");
  });
});
