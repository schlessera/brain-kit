import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** The native fixture's append-only, newline-committed JSONL observations. */
export class NativeEventLog {
  private pendingSaved = false;
  private failureSaved = false;
  constructor(private readonly path: string, private readonly artifacts: string) {}

  read(phase: string, final = false): Record<string, any>[] {
    const before = statSync(this.path);
    const bytes = readFileSync(this.path);
    const after = statSync(this.path);
    const completeBytes = bytes.lastIndexOf(10) + 1;
    const save = (kind: "pending" | "failure", recordStart: number, recordEnd: number, error?: unknown) => {
      if (kind === "failure" && this.failureSaved) return;
      const prefix = join(this.artifacts, `event-observation-${kind}`);
      writeFileSync(`${prefix}.bin`, bytes);
      writeFileSync(`${prefix}.json`, JSON.stringify({
        phase, final, readerPid: process.pid, observedAt: performance.now(),
        snapshotBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        completeBytes, pendingBytes: bytes.length - completeBytes, recordStart, recordEnd,
        before: { size: before.size, ino: before.ino, mtimeMs: before.mtimeMs },
        after: { size: after.size, ino: after.ino, mtimeMs: after.mtimeMs },
        ...(error === undefined ? {} : { error: String(error) }),
      }, null, 2));
      if (kind === "failure") this.failureSaved = true;
    };
    const events: Record<string, any>[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let start = 0; start < completeBytes;) {
      const end = bytes.indexOf(10, start);
      try {
        const row = JSON.parse(decoder.decode(bytes.subarray(start, end)));
        if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.kind !== "string") throw Error("Native event must be an object with a kind");
        events.push(row);
      } catch (error) {
        save("failure", start, end, error);
        throw Error(`NATIVE_EVENT_LOG_INVALID_RECORD (${phase}, bytes ${start}-${end}): ${String(error)}`);
      }
      start = end + 1;
    }
    if (completeBytes < bytes.length) {
      if (final) {
        save("failure", completeBytes, bytes.length, "Unterminated record after writer shutdown");
        throw Error(`NATIVE_EVENT_LOG_INCOMPLETE_FINAL (${phase}, byte ${completeBytes})`);
      }
      if (!this.pendingSaved) { save("pending", completeBytes, bytes.length); this.pendingSaved = true; }
    }
    return events;
  }
}
