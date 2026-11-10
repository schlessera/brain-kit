/**
 * The scoped key appears in exactly one place: the Authorization header of
 * requests to Boat's API origin. Signed file URLs are treated as secrets too.
 * Neither reaches a request URL or body, a signed-URL request, an outcome, a
 * log line, a sandbox or a collected artifact.
 */

import { describe, expect, test } from "bun:test";

import { fakeBoat } from "./helpers/fake-boat";
import { contextFor, instantProvider, KEY, type LogLine } from "./helpers/context";

describe("the key and signed URLs stay out of everything but the API header", () => {
  test("a full job leaks neither", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 1 });
    const { provider, now } = instantProvider();
    const log: LogLine[] = [];
    const ctx = () => contextFor(fake, { now, log });
    const seen: unknown[] = [];

    const allocated = await provider.allocate({ key: "job-calypso", leaseSeconds: 600, retain: false }, ctx());
    seen.push(allocated);
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const data = new TextEncoder().encode("# Ogygia\n");
    const sha = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    seen.push(await provider.stage!(allocated.sandbox, { files: [{ path: "notes/ogygia.md", sha256: sha, bytes: data.byteLength, read: async () => data }], hash: sha }, ctx()));
    const started = await provider.exec(allocated.sandbox, { argv: ["printenv"], env: { VOYAGE: "ithaca" } }, ctx());
    seen.push(started);
    if (started.kind !== "ok") throw new Error(started.kind);
    seen.push(await provider.poll(started.handle, ctx()));
    await provider.exec(allocated.sandbox, { argv: ["write", "raft.txt", "seven years"], env: {} }, ctx());
    const collected = await provider.collect!(allocated.sandbox, { paths: [{ path: "raft.txt", maxBytes: 1024 }, { path: "notes/ogygia.md", maxBytes: 1024 }] }, ctx());
    seen.push(collected);
    seen.push(await provider.usage!(allocated.sandbox, ctx()));
    seen.push(await provider.release(allocated.sandbox, "discard", ctx()));

    // Failures whose vendor messages echo the key and a signed URL.
    const signedUrls = fake.requests.filter((r) => r.route === "signed-put").map((r) => r.url);
    expect(signedUrls.length).toBe(1);
    fake.failNext("create", { status: 400, code: "invalid_json", details: { message: `bad bearer ${KEY} for ${signedUrls[0]}` } });
    const refused = await provider.allocate({ key: "job-calypso-2", leaseSeconds: 600, retain: false }, ctx());
    seen.push(refused);
    expect(refused.kind).toBe("failed");

    // A transport failure whose message echoes the signed URL and the key.
    const second = await provider.allocate({ key: "job-calypso-3", leaseSeconds: 600, retain: false }, ctx());
    if (second.kind !== "ok") throw new Error(second.kind);
    const echoed: string[] = [];
    fake.failNext("signed-put", { network: (url) => (echoed.push(url), `connect ECONNRESET ${url} with Bearer ${KEY}`) }, 3);
    const failedStage = await provider.stage!(second.sandbox, { files: [{ path: "notes/ogygia.md", sha256: sha, bytes: data.byteLength, read: async () => data }], hash: sha }, ctx());
    seen.push(failedStage);
    expect([failedStage.kind, echoed.length]).toEqual(["uncertain", 3]);
    signedUrls.push(...echoed);
    seen.push(await provider.release(second.sandbox, "discard", ctx()));

    const outcomes = JSON.stringify(seen);
    const logs = JSON.stringify(log);
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [KEY, ...signedUrls, ...signedUrls.map((u) => new URL(u).search)]) {
      expect([secret.slice(0, 12), outcomes.includes(secret), logs.includes(secret)]).toEqual([secret.slice(0, 12), false, false]);
    }
    for (const request of fake.requests) {
      const api = request.url.startsWith("https://boat.dev/api/v1/");
      expect([request.route, request.url.includes(KEY), request.body.includes(KEY)]).toEqual([request.route, false, false]);
      expect([request.route, request.headers.authorization ?? "none"]).toEqual([request.route, api ? `Bearer ${KEY}` : "none"]);
      const others = Object.entries(request.headers).filter(([name, value]) => name !== "authorization" && value.includes(KEY));
      expect(others).toEqual([]);
    }
    if (collected.kind !== "ok") throw new Error(collected.kind);
    expect(collected.artifacts.map((artifact) => artifact.status)).toEqual(["collected", "collected"]);
    for (const artifact of collected.artifacts) {
      if (artifact.status === "collected") expect(new TextDecoder().decode(artifact.data)).not.toContain(KEY);
    }
    expect(JSON.stringify(seen[3])).toContain("VOYAGE=ithaca");
  });

  test("the fake refuses a signed-URL request that carries an Authorization header, as a stray key must never reach one", async () => {
    const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
    const { provider, now } = instantProvider();
    const allocated = await provider.allocate({ key: "job-calypso-url", leaseSeconds: 600, retain: false }, contextFor(fake, { now }));
    if (allocated.kind !== "ok") throw new Error(allocated.kind);
    const issued = await fake.fetch(`https://boat.dev/api/v1/sandboxes/${allocated.sandbox.id}/files/upload-url`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/brain-kit/x.tar" }),
    });
    const url = ((await issued.json()) as { url: string }).url;
    const withKey = await fake.fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${KEY}` }, body: new Uint8Array([1]) });
    const without = await fake.fetch(url, { method: "PUT", body: new Uint8Array([1]) });
    expect([withKey.status, without.status]).toEqual([403, 200]);
  });
});
