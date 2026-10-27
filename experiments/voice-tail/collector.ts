/** EVALUATION ONLY. Run explicitly; one bounded output pair, loopback, exact origin. */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
const caps = { "provider.wav": 5_760_044, "mix.wav": 24_000_044, "metadata.json": 2_000_000 } as const;
export function startCollector(directory: string, origin: string, sourceSha: string) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol) || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Exact origin and source SHA required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = realpathSync(directory);
  const repo = resolve(import.meta.dir, "../..");
  if (output === repo || output.startsWith(repo + sep) || output === "/tmp/brain-voice-device-check" || output.startsWith("/tmp/brain-voice-device-check/")) throw new Error("Recordings must be outside the public tree and prior runtime");
  const saved = new Map<string, { bytes: number; sha256: string }>();
  let busy = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: caps["mix.wav"], async fetch(request) {
    const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
    const reply = (text: string, status: number) => new Response(text, { status, headers });
    if (request.headers.get("origin") !== origin) return new Response("Origin refused", { status: 403 });
    if (request.method === "OPTIONS") return reply("", 204);
    const name = new URL(request.url).pathname.slice(1);
    if (request.method !== "POST" || !(name in caps)) return reply("Route refused", 404);
    if (busy || saved.has(name)) return reply("Capture slot already used or busy", 409);
    const limit = caps[name as keyof typeof caps];
    const length = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > limit) return reply("Explicit bounded Content-Length required", 413);
    busy = true;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length !== length || bytes.length > limit) return reply("Size refused", 413);
      if (name === "metadata.json") {
        const metadata = JSON.parse(new TextDecoder().decode(bytes));
        if (metadata.sourceSha !== sourceSha) return reply("Source identity mismatch", 400);
        for (const [file, key] of [["provider.wav", "provider"], ["mix.wav", "mix"]]) {
          if (!saved.has(file!) || saved.get(file!)!.sha256 !== metadata[key!]?.sha256) return reply("Paired file hash mismatch", 400);
        }
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(resolve(output, name), bytes, { flag: "wx", mode: 0o600 });
      saved.set(name, { bytes: bytes.length, sha256 });
      return reply(JSON.stringify({ file: name, bytes: bytes.length, sha256 }), 201);
    } catch { return reply("Capture refused; use a fresh output directory after inspection", 400); }
    finally { busy = false; }
  } });
  return server;
}
if (import.meta.main) {
  const [directory, origin, sha] = process.argv.slice(2);
  if (!directory || !origin || !sha) throw new Error("Usage: bun collector.ts OUTSIDE_REPO_DIRECTORY EXACT_BROWSER_ORIGIN SOURCE_SHA");
  const server = startCollector(directory, origin, sha);
  console.log(`Output-only collector listening at ${server.url.origin}; one pair, no credentials, no provider started.`);
}
