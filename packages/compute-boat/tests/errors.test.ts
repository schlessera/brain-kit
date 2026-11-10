/**
 * Boat's error table mapped to the generic outcomes, with bounded retries:
 * at most MAX_ATTEMPTS requests per call, waits taken from the answer, capped
 * and never past the call deadline. A detached command is sent again only
 * when Boat says it provably did not run.
 */

import { describe, expect, test } from "bun:test";

import type { AllocateOutcome } from "@schlessera/brain";

import { MAX_ATTEMPTS, MAX_WAIT_MS } from "../src/client";
import { fakeBoat, type Fault } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY } from "./helpers/context";

const shape = (o: AllocateOutcome) => (o.kind === "refused" ? `refused ${o.code}` : o.kind);

async function allocateWith(faults: Fault[], deadlineMs = 120_000) {
  const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
  for (const fault of faults) fake.failNext("create", fault);
  const { provider, now, waits } = instantProvider();
  const outcome = await provider.allocate({ key: "job-ithaca", leaseSeconds: 600, retain: false }, contextFor(fake, { now, deadlineMs }));
  return { outcome: shape(outcome), creates: fake.routes().filter((r) => r === "create").length, waits, fake };
}

describe("allocation errors", () => {
  const refusals: [number, string, string][] = [
    [401, "unauthorized", "refused provider_unavailable"],
    [403, "api_key_expired", "refused provider_unavailable"],
    [403, "api_key_action_forbidden", "refused provider_unavailable"],
    [403, "api_key_sandbox_forbidden", "refused provider_unavailable"],
    [403, "environment_forbidden", "refused provider_unavailable"],
    [403, "machine_class_plan_required", "refused provider_unavailable"],
    [403, "trial_machine_class_not_allowed", "refused provider_unavailable"],
    [403, "org_suspended", "refused provider_unavailable"],
    [402, "billing_required", "refused provider_unavailable"],
    [402, "team_member_cap_reached", "refused provider_unavailable"],
    [404, "snapshot_not_found", "refused provider_unavailable"],
    [409, "snapshot_data_expired", "refused provider_unavailable"],
    [400, "unknown_environment", "refused provider_unavailable"],
    [429, "limit_reached", "refused concurrency_exhausted"],
    [429, "member_limit_reached", "refused concurrency_exhausted"],
    [409, "idempotency_key_reused", "uncertain"],
    [400, "invalid_json", "failed"],
  ];
  for (const [status, code, expected] of refusals) {
    test(`${status} ${code} -> ${expected}, sent once`, async () => {
      const r = await allocateWith([{ status, code }]);
      expect([r.outcome, r.creates]).toEqual([expected, 1]);
    });
  }

  test("a start limit on the hour or day window refuses at once; the minute window is retried once", async () => {
    const hour = await allocateWith([{ status: 429, code: "rate_limited", extra: { window: "hour" } }]);
    expect([hour.outcome, hour.creates]).toEqual(["refused provider_unavailable", 1]);
    const minute = await allocateWith(Array(MAX_ATTEMPTS).fill({ status: 429, code: "rate_limited", extra: { window: "minute", retryAfterSeconds: 12 } }));
    expect([minute.outcome, minute.creates, minute.waits]).toEqual(["refused provider_unavailable", 2, [12_000]]);
    const cleared = await allocateWith([{ status: 429, code: "rate_limited", extra: { window: "minute" } }]);
    expect([cleared.outcome, cleared.creates]).toEqual(["ok", 2]);
  });

  test("the IP limit and capacity are retried, waiting what Boat says, at most MAX_ATTEMPTS times", async () => {
    const ip = await allocateWith(Array(5).fill({ status: 429, code: "IP_RATE_LIMIT_EXCEEDED", extra: { retryAfter: 4 } }));
    expect([ip.outcome, ip.creates, ip.waits]).toEqual(["refused provider_unavailable", MAX_ATTEMPTS, [4000, 4000]]);
    const header = await allocateWith([{ status: 429, code: "IP_RATE_LIMIT_EXCEEDED", headers: { "Retry-After": "7" } }]);
    expect([header.outcome, header.waits]).toEqual(["ok", [7000]]);
    const capacity = await allocateWith(Array(5).fill({ status: 503, code: "no_ready_machine", extra: { retryAfterSeconds: 3600 } }));
    expect([capacity.outcome, capacity.creates, capacity.waits]).toEqual(["refused provider_unavailable", MAX_ATTEMPTS, [MAX_WAIT_MS, MAX_WAIT_MS]]);
    const outOfCapacity = await allocateWith([{ status: 503, code: "out_of_capacity", extra: { retryAfterSeconds: 2 } }]);
    expect([outOfCapacity.outcome, outOfCapacity.creates]).toEqual(["ok", 2]);
  });

  test("no wait runs past the call deadline", async () => {
    const r = await allocateWith(Array(5).fill({ status: 503, code: "no_ready_machine", extra: { retryAfterSeconds: 20 } }), 15_000);
    expect([r.outcome, r.creates, r.waits]).toEqual(["refused provider_unavailable", 1, []]);
  });

  test("an in-progress key is retried under the same key, then left uncertain", async () => {
    const r = await allocateWith(Array(5).fill({ status: 409, code: "idempotency_in_progress" }));
    expect([r.outcome, r.creates]).toEqual(["uncertain", MAX_ATTEMPTS]);
    const keys = new Set(r.fake.requests.filter((q) => q.route === "create").map((q) => q.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
  });

  test("a timeout, a 5xx or a lost connection is retried under the same key, then uncertain", async () => {
    for (const fault of ["network", { status: 500, code: "http_500" }, { status: 504, code: "gateway_timeout" }] as Fault[]) {
      const r = await allocateWith(Array(5).fill(fault));
      expect([r.outcome, r.creates]).toEqual(["uncertain", MAX_ATTEMPTS]);
    }
    const recovered = await allocateWith(["network"]);
    expect([recovered.outcome, recovered.creates, recovered.fake.created()]).toEqual(["ok", 2, 1]);
  });

  test("a refusal after an attempt that may have created a sandbox is uncertain, not refused", async () => {
    const r = await allocateWith([{ status: 500, code: "http_500" }, { status: 429, code: "limit_reached" }]);
    expect(r.outcome).toBe("uncertain");
  });

  test("an aborted call sends nothing", async () => {
    const fake = fakeBoat({ apiKey: KEY });
    const controller = new AbortController();
    controller.abort();
    const { provider, now } = instantProvider();
    const outcome = await provider.allocate({ key: "job-x", leaseSeconds: 600, retain: false }, contextFor(fake, { now, signal: controller.signal }));
    expect([outcome.kind, fake.requests.length]).toEqual(["failed", 0]);
  });
});

describe("command and file errors", () => {
  async function ready() {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now, waits } = instantProvider();
    const allocated = await provider.allocate({ key: "job-pylos", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const exec = async (fault?: Fault, times = 1) => {
      if (fault) fake.failNext("exec", fault, times);
      const before = fake.routes().filter((r) => r === "exec").length;
      const outcome = await provider.exec(allocated.sandbox, { argv: ["exit", "0"], env: {} }, contextFor(fake, { now }));
      return { kind: outcome.kind, sent: fake.routes().filter((r) => r === "exec").length - before };
    };
    return { fake, provider, now, waits, sandbox: allocated.sandbox, exec };
  }

  test("a 502 that may have run the command is uncertain and never sent again", async () => {
    const { exec } = await ready();
    expect(await exec({ status: 502, code: "sandbox_direct_failed", details: { retryable: false } })).toEqual({ kind: "uncertain", sent: 1 });
    expect(await exec({ status: 502, code: "boat_direct_failed", details: { retryable: true, message: "something_else" } })).toEqual({ kind: "uncertain", sent: 1 });
    expect(await exec({ status: 500, code: "http_500" })).toEqual({ kind: "uncertain", sent: 1 });
    expect(await exec("network")).toEqual({ kind: "uncertain", sent: 1 });
  });

  test("a command Boat says did not run is sent again", async () => {
    const { exec } = await ready();
    expect(await exec({ status: 502, code: "sandbox_direct_failed", details: { retryable: true, message: "sandbox_restoring" } })).toEqual({ kind: "ok", sent: 2 });
    expect(await exec({ status: 409, code: "boat_starting" })).toEqual({ kind: "ok", sent: 2 });
    expect(await exec({ status: 409, code: "sandbox_starting" })).toEqual({ kind: "ok", sent: 2 });
    expect(await exec({ status: 409, code: "sandbox_starting" }, 5)).toEqual({ kind: "failed", sent: MAX_ATTEMPTS });
  });

  test("a sandbox that cannot take commands, or an expired key, fails without a retry", async () => {
    const { exec } = await ready();
    expect(await exec({ status: 409, code: "sandbox_not_ready" })).toEqual({ kind: "failed", sent: 1 });
    expect(await exec({ status: 403, code: "api_key_expired" })).toEqual({ kind: "failed", sent: 1 });
    expect(await exec({ status: 401, code: "unauthorized" })).toEqual({ kind: "failed", sent: 1 });
  });

  test("file transfers are repeatable and are retried", async () => {
    const { fake, provider, now, sandbox } = await ready();
    fake.failNext("upload-url", { status: 502, code: "sandbox_direct_failed", details: { retryable: true } });
    fake.failNext("signed-put", "network");
    const data = new TextEncoder().encode("# Ithaca\n");
    const sha = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    const staged = await provider.stage!(sandbox, { files: [{ path: "notes/voyage.md", sha256: sha, bytes: data.byteLength, read: async () => data }], hash: sha }, contextFor(fake, { now }));
    expect(staged.kind).toBe("ok");
    expect(fake.routes().filter((r) => r === "upload-url" || r === "signed-put")).toEqual(["upload-url", "upload-url", "signed-put", "signed-put"]);
  });

  test("the extract command is never sent again on an unknown outcome: a lost answer is uncertain after one send", async () => {
    const { fake, provider, now, sandbox } = await ready();
    const data = new TextEncoder().encode("# Ithaca\n");
    const sha = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    const bundle = { files: [{ path: "notes/voyage.md", sha256: sha, bytes: data.byteLength, read: async () => data }], hash: sha };
    fake.failNext("exec", "lose-response");
    const lost = await provider.stage!(sandbox, bundle, contextFor(fake, { now }));
    expect([lost.kind, fake.routes().filter((r) => r === "exec").length]).toEqual(["uncertain", 1]);
    fake.failNext("exec", { status: 502, code: "boat_direct_failed" });
    const failed = await provider.stage!(sandbox, bundle, contextFor(fake, { now }));
    expect([failed.kind, fake.routes().filter((r) => r === "exec").length]).toEqual(["uncertain", 2]);
    // The host repeats the whole stage; the extract is safe to run again.
    expect((await provider.stage!(sandbox, bundle, contextFor(fake, { now }))).kind).toBe("ok");
    expect(new TextDecoder().decode(fake.sandboxes.get(sandbox.id)!.files.get("/home/user/work/notes/voyage.md"))).toBe("# Ithaca\n");
  });

  test("the extract command keeps the uploaded archive and extracts into a fresh directory, so a run still in flight is never disturbed", async () => {
    const { fake, provider, now, sandbox } = await ready();
    const data = new TextEncoder().encode("# Ithaca\n");
    const sha = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    await provider.stage!(sandbox, { files: [{ path: "notes/voyage.md", sha256: sha, bytes: data.byteLength, read: async () => data }], hash: sha }, contextFor(fake, { now }));
    const command = String(JSON.parse(fake.requests.filter((r) => r.route === "exec").at(-1)!.body).command);
    const tar = /tar -xf '([^']+)'/.exec(command)?.[1];
    // Named by the bundle hash, so a run still in flight and its repeat read the same archive.
    expect(tar).toBe(`/tmp/brain-kit/${sha}.tar`);
    expect(command).not.toContain(`rm -f '${tar}'`);
    expect(command).toContain("mktemp -d");
    expect(command).not.toMatch(/-C work\b/);
    expect([...fake.sandboxes.get(sandbox.id)!.files.keys()]).toContain(tar!);
  });

  test("a lost process Boat's probe still finds running is running, never exited; one it finds ended is a provider error", async () => {
    const { fake, provider, now, sandbox } = await ready();
    const started = await provider.exec(sandbox, { argv: ["sleep", "3600"], env: {} }, contextFor(fake, { now }));
    if (started.kind !== "ok") throw new Error(started.kind);
    const proc = fake.sandboxes.get(sandbox.id)!.procs.get(Number(started.handle.id))!;
    proc.status = "lost";
    proc.probeRunning = true;
    expect((await provider.poll(started.handle, contextFor(fake, { now }))).kind).toBe("running");
    proc.probeRunning = false;
    const ended = await provider.poll(started.handle, contextFor(fake, { now }));
    expect(ended.kind === "exited" && ended.reason).toBe("provider_error");
  });

  test("file info and artifact downloads name the absolute path under /home/user/work", async () => {
    const { fake, provider, now, sandbox } = await ready();
    const started = await provider.exec(sandbox, { argv: ["write", "out/log.txt", "twenty trees"], env: {} }, contextFor(fake, { now }));
    expect(started.kind).toBe("ok");
    const got = await provider.collect!(sandbox, { paths: [{ path: "out/log.txt", maxBytes: 1024 }] }, contextFor(fake, { now }));
    expect(got.kind === "ok" && got.artifacts[0]!.status).toBe("collected");
    const paths = fake.requests.filter((r) => r.route === "file-info" || r.route === "artifact").map((r) => new URL(r.url).searchParams.get("path"));
    expect(paths).toEqual(["/home/user/work/out/log.txt", "/home/user/work/out/log.txt"]);
  });

  test("an expired key on poll, kill and release is a failure the host can retry, never success", async () => {
    const { fake, provider, now, sandbox } = await ready();
    const started = await provider.exec(sandbox, { argv: ["sleep", "60"], env: {} }, contextFor(fake, { now }));
    if (started.kind !== "ok") throw new Error(started.kind);
    fake.failNext("command-status", { status: 403, code: "api_key_expired" });
    expect((await provider.poll(started.handle, contextFor(fake, { now }))).kind).toBe("failed");
    fake.failNext("command-kill", { status: 403, code: "api_key_expired" });
    expect((await provider.kill(started.handle, contextFor(fake, { now }))).kind).toBe("failed");
    fake.failNext("usage", { status: 403, code: "api_key_expired" });
    fake.failNext("delete", { status: 403, code: "api_key_expired" });
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("failed");
    expect((await provider.release(sandbox, "discard", contextFor(fake, { now }))).kind).toBe("released");
  });
});
