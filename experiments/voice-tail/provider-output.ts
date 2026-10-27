/** Optional parent-installed pre-browser output tap. No WebSocket creation or input capture. */
import { createHash } from "node:crypto";
import { openSync, writeSync, closeSync, realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
/** Call only with validated output PCM, after provider event validation and BEFORE emit/filter.
 * raw-provider-wire means validated session.output_audio.delta bytes, not browser frames.
 * adapter-received means actual provider.events audio callback, before host/browser filtering.
 */
export function openProviderOutputTap(path: string, sourceSha: string, provenance: "raw-provider-wire" | "adapter-received") {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Exact source identity required");
  const directory = realpathSync(dirname(resolve(path)));
  const repo = resolve(import.meta.dir, "../..");
  if (directory === repo || directory.startsWith(repo + sep) || directory === "/tmp/brain-voice-device-check" || directory.startsWith("/tmp/brain-voice-device-check/")) throw new Error("Raw output must remain outside the public tree and prior runtime");
  const fd = openSync(path, "wx", 0o600); const hash = createHash("sha256");
  const started = performance.now(); const utc = new Date().toISOString();
  const chunks: { sequence: number; wallMs: number; offset: number; bytes: number }[] = [];
  let size = 0; let complete = true; let closed = false;
  return {
    receive(pcm: Uint8Array) {
      if (closed) throw new Error("Tap closed");
      if (!pcm.length || pcm.length % 2 || pcm.length > 65536 || size + pcm.length > 5_760_000 || chunks.length >= 16384 || performance.now() - started > 120000) { complete = false; return false; }
      // Synchronous writes retain arrival order; a short write is explicit loss.
      const written = writeSync(fd, pcm); if (written !== pcm.length) { complete = false; throw new Error("Short output capture write"); }
      hash.update(pcm); chunks.push({ sequence: chunks.length, wallMs: performance.now()-started, offset: size, bytes: pcm.length }); size += pcm.length; return true;
    },
    close() {
      if (closed) throw new Error("Tap closed"); closed = true; closeSync(fd);
      return { version: "evaluation-only-1", sourceSha, provenance, utc, complete, encoding: "pcm16le", channels: 1, sampleRate: 24000, bytes: size, sha256: hash.digest("hex"), chunks };
    },
  };
}
