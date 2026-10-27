import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCollector } from "./collector";
import { openProviderOutputTap } from "./provider-output";

test("real loopback collector restricts origin, paths, bytes, overwrite and paired source/hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-output-"));
  const origin = "http://localhost:3456", sha = "a".repeat(40);
  const server = startCollector(dir, origin, sha);
  const post = (name: string, body: string | Uint8Array, from = origin) => fetch(new URL(name, server.url), { method: "POST", headers: { origin: from }, body: typeof body === "string" ? body : new Uint8Array(body).buffer });
  try {
    expect((await fetch(server.url, { method: "OPTIONS", headers: { origin } })).status).toBe(204);
    expect((await post("provider.wav", "fixture", "http://localhost:3457")).status).toBe(403);
    expect((await post("input.wav", "microphone route forbidden")).status).toBe(404);
    expect((await post("provider.wav", new Uint8Array(5_760_045))).status).toBe(413);
    const provider = new Uint8Array([0, 0, 1, 0]); const mix = new Uint8Array([0, 0, 0, 0]);
    expect((await post("provider.wav", provider)).status).toBe(201);
    expect((await post("provider.wav", provider)).status).toBe(409);
    expect((await post("mix.wav", mix)).status).toBe(201);
    expect((await post("metadata.json", JSON.stringify({ sourceSha: sha, provider: {}, mix: {} }))).status).toBe(400);
    const hash = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
    const metadata = { sourceSha: sha, provider: { sha256: hash(provider) }, mix: { sha256: hash(mix) } };
    expect((await post("metadata.json", JSON.stringify(metadata))).status).toBe(201);
    expect(new Uint8Array(readFileSync(join(dir, "provider.wav")))).toEqual(provider);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("pre-browser provider tap retains raw output unchanged, bounded, no network or microphone", () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-provider-"));
  try {
    const file = join(dir, "provider.pcm");
    const tap = openProviderOutputTap(file, "a".repeat(40), "raw-provider-wire");
    const bytes = new Uint8Array([1, 0, 255, 255]);
    expect(tap.receive(bytes)).toBe(true);
    expect(tap.receive(new Uint8Array(3))).toBe(false);
    const metadata = tap.close();
    expect(metadata.complete).toBe(false);
    expect(metadata.provenance).toBe("raw-provider-wire");
    expect(metadata.bytes).toBe(4);
    expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
    expect(() => tap.receive(bytes)).toThrow("Tap closed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
