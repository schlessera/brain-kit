import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createTranscriptStore, TranscriptCorruptionError, TranscriptRecoveryError,
} from "../src/server/transcript-store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-kit-transcripts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("createTranscriptStore", () => {
  test("a truncated session does not abort healthy enumeration", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const damaged = store.create({ title: "Raft planning" });
    const healthy = store.create({ title: "Ithaca arrival" });
    store.append(damaged, { role: "user", content: "Build the raft", toolCalls: [] });
    store.append(healthy, { role: "user", content: "Reach Ithaca", toolCalls: [] });
    appendFileSync(join(dir, `${damaged}.jsonl`), '{"kind":"message"');
    expect(store.list().map((session) => session.id)).toEqual([healthy]);
    expect(store.history(healthy)).toHaveLength(1);
  });
  test("create → append → history round-trip", () => {
    const store = createTranscriptStore(tempDir());
    const id = store.create({ title: "Raft planning" });

    store.append(id, { role: "user", content: "hello", toolCalls: [] });
    store.append(
      id,
      {
        role: "assistant",
        content: "hi!",
        toolCalls: [{ id: "t1", name: "brain_search", input: { q: "x" }, output: "[]" }],
        parts: [
          { kind: "text", text: "hi!" },
          { kind: "tool", toolIndex: 0 },
        ],
      },
      { costUsd: 0.012 }
    );

    const history = store.history(id);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].toolCalls[0].name).toBe("brain_search");
    expect(history[1].parts?.[1]).toEqual({ kind: "tool", toolIndex: 0 });
  });

  test("list aggregates turns, cost, and recency ordering", () => {
    const store = createTranscriptStore(tempDir());
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });

    store.append(a, { role: "user", content: "1", toolCalls: [] }, { costUsd: 0.01 });
    store.append(a, { role: "assistant", content: "r", toolCalls: [] }, { costUsd: 0.02 });
    store.append(b, { role: "user", content: "2", toolCalls: [] });

    const sessions = store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(b); // most recently active first
    const sessionA = sessions.find((s) => s.id === a)!;
    expect(sessionA.title).toBe("A");
    expect(sessionA.numTurns).toBe(1); // user messages count as turns
    expect(sessionA.totalCostUsd).toBeCloseTo(0.03);
  });

  test("append to unknown session throws", () => {
    const store = createTranscriptStore(tempDir());
    expect(() =>
      store.append("nope", { role: "user", content: "x", toolCalls: [] })
    ).toThrow(/Unknown transcript session/);
  });

  test("empty store lists nothing; unknown history is empty", () => {
    const store = createTranscriptStore(tempDir());
    expect(store.list()).toEqual([]);
    expect(store.history("missing")).toEqual([]);
  });

  for (const suffix of ['{"kind":"message"', '{broken}\n', 'null\n', '{"kind":"message","ts":1,"message":{}}\n']) {
    test(`quarantine diagnostic preserves the contiguous prefix for ${suffix}`, () => {
      const dir = tempDir();
      const store = createTranscriptStore(dir);
      const id = store.create({ title: "Raft planning" });
      store.append(id, { role: "user", content: "Build the raft — safely", toolCalls: [] });
      const path = join(dir, `${id}.jsonl`);
      const prefix = readFileSync(path);
      appendFileSync(path, suffix);
      const original = readFileSync(path);
      const diagnostic = store.diagnose(id);
      expect(diagnostic).toMatchObject({
        sessionId: id, status: "quarantined", complete: false, prefixBytes: prefix.length,
        failure: { line: 3, byteOffset: prefix.length, position: "final" },
      });
      if (diagnostic.status === "missing") throw new Error("Missing fixture");
      expect(diagnostic.records).toHaveLength(2);
      expect(diagnostic.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(store.quarantined()).toEqual([diagnostic]);
      expect(() => store.history(id)).toThrow(TranscriptCorruptionError);
      expect(() => store.append(id, { role: "assistant", content: "Ready", toolCalls: [] }))
        .toThrow(TranscriptCorruptionError);
      expect(readFileSync(path)).toEqual(original);
    });
  }

  test("interior corruption never admits later valid records; recovery preserves message bytes", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create({ title: "Raft planning" });
    const path = join(dir, `${id}.jsonl`);
    // Deliberately noncanonical spacing, Unicode and unknown additive data.
    const line = ' {"kind":"message", "ts":1, "message":{"role":"user","content":"Build — raft","toolCalls":[],"future":"retained"},"costUsd":0.25}\n';
    appendFileSync(path, line);
    const prefix = readFileSync(path);
    appendFileSync(path, '{broken}\n{"kind":"message","ts":2,"message":{"role":"user","content":"Do not recover","toolCalls":[]}}\n');
    const original = readFileSync(path);
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    expect(diagnostic.failure).toEqual({ line: 3, byteOffset: prefix.length, position: "interior", reason: "invalid-json" });
    const recoveredId = store.recover(id, { sourceVersion: diagnostic.sourceVersion });
    expect(recoveredId).not.toBe(id);
    expect(readFileSync(path)).toEqual(original);
    expect(readFileSync(join(dir, `${recoveredId}.jsonl`), "utf8").split("\n").slice(1).join("\n")).toBe(line);
    const reloaded = createTranscriptStore(dir);
    expect(reloaded.list()).toMatchObject([{ id: recoveredId, title: "Recovered: Raft planning", numTurns: 1, totalCostUsd: 0.25 }]);
    expect(reloaded.history(recoveredId)).toEqual([JSON.parse(line).message]);
    expect(reloaded.diagnose(recoveredId)).toMatchObject({
      status: "healthy", complete: true, records: [{
        id: recoveredId, recovery: {
          sourceSessionId: id, sourceVersion: diagnostic.sourceVersion,
          prefixBytes: prefix.length, prefixRecords: 2, failure: diagnostic.failure,
        },
      }, {}],
    });
    reloaded.append(recoveredId, { role: "assistant", content: "Raft ready", toolCalls: [] });
    expect(reloaded.history(recoveredId)).toHaveLength(2);
    expect(reloaded.recover(id, { sourceVersion: diagnostic.sourceVersion })).toBe(recoveredId);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].title).toBe("Recovered: Raft planning");
    expect(() => reloaded.append(id, { role: "user", content: "Refuse", toolCalls: [] })).toThrow(TranscriptCorruptionError);
    expect(readFileSync(path)).toEqual(original);
  });

  test("valid final JSON without newline remains readable and append separates records", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    store.append(id, { role: "user", content: "Reach Ithaca", toolCalls: [] });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, readFileSync(path).subarray(0, -1));
    expect(store.diagnose(id)).toMatchObject({ status: "healthy", complete: true });
    expect(store.history(id)).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    store.append(id, { role: "assistant", content: "Arrived", toolCalls: [] });
    expect(store.history(id)).toHaveLength(2);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("invalid metadata, duplicate metadata and invalid UTF-8 are quarantined honestly", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    for (const text of ['', '{}\n', 'null\n', '{"kind":"meta","id":"wrong","title":null,"createdAt":1}\n']) {
      const id = store.create();
      const path = join(dir, `${id}.jsonl`);
      writeFileSync(path, text);
      const diagnostic = store.diagnose(id);
      if (diagnostic.status === "missing") throw new Error("Missing fixture");
      expect(diagnostic).toMatchObject({ status: "quarantined", complete: false, records: [] });
      expect(() => store.recover(id, { sourceVersion: diagnostic.sourceVersion })).toThrow(TranscriptRecoveryError);
      expect(readFileSync(path, "utf8")).toBe(text);
    }
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    const meta = readFileSync(path);
    appendFileSync(path, meta);
    expect(store.diagnose(id)).toMatchObject({ status: "quarantined", failure: { reason: "invalid-record", line: 2 } });
    writeFileSync(path, Buffer.concat([meta, Buffer.from([0xff])]));
    expect(store.diagnose(id)).toMatchObject({ status: "quarantined", failure: { reason: "invalid-utf8", line: 2 } });
    expect(store.list()).toEqual([]);
    expect(store.diagnose("missing")).toEqual({ sessionId: "missing", status: "missing" });
  });

  test("stale diagnostic and source edits during staging refuse recovery without publication", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    appendFileSync(path, '{broken}');
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    appendFileSync(path, "changed");
    expect(() => store.recover(id, { sourceVersion: diagnostic.sourceVersion })).toThrow(/SOURCE_CHANGED/);
    const fresh = store.diagnose(id);
    if (fresh.status === "missing") throw new Error("Missing fixture");
    const originalSync = fs.fsyncSync;
    const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      originalSync(fd);
      appendFileSync(path, "concurrent change");
    });
    try {
      expect(() => store.recover(id, { sourceVersion: fresh.sourceVersion })).toThrow(/SOURCE_CHANGED/);
    } finally { spy.mockRestore(); }
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${id}.jsonl`]);
  });

  test("failed staging write publishes no session and retry converges across store instances", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    appendFileSync(path, '{broken}');
    const original = readFileSync(path);
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    const originalWrite = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (typeof file === "number") {
        originalWrite(file, '{"kind":');
        throw new Error("Interrupted write");
      }
      return originalWrite(file, data, options);
    });
    try {
      expect(() => store.recover(id, { sourceVersion: diagnostic.sourceVersion })).toThrow("Interrupted write");
    } finally { spy.mockRestore(); }
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${id}.jsonl`]);
    const recovered = store.recover(id, { sourceVersion: diagnostic.sourceVersion });
    expect(createTranscriptStore(dir).recover(id, { sourceVersion: diagnostic.sourceVersion })).toBe(recovered);
    expect(readFileSync(path)).toEqual(original);
    expect(store.list()).toHaveLength(1);
  });

  test("a source change at publication refuses and removes only the new recovery", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    appendFileSync(path, '{broken}');
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    const originalLink = fs.linkSync;
    const spy = spyOn(fs, "linkSync").mockImplementation((source, target) => {
      appendFileSync(path, "changed");
      originalLink(source, target);
    });
    try {
      expect(() => store.recover(id, { sourceVersion: diagnostic.sourceVersion })).toThrow(/SOURCE_CHANGED/);
    } finally { spy.mockRestore(); }
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([`${id}.jsonl`]);
    expect(readFileSync(path, "utf8")).toEndWith("{broken}changed");
  });

  test("retry after directory sync failure uses the already complete recovery", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    appendFileSync(path, '{broken}');
    const original = readFileSync(path);
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    const originalSync = fs.fsyncSync;
    let syncs = 0;
    const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++syncs === 2) throw new Error("Interrupted directory sync");
      originalSync(fd);
    });
    try {
      expect(() => store.recover(id, { sourceVersion: diagnostic.sourceVersion })).toThrow("Interrupted directory sync");
    } finally { spy.mockRestore(); }
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toStartWith("Recovered: ");
    expect(store.recover(id, { sourceVersion: diagnostic.sourceVersion })).toBe(sessions[0].id);
    expect(readFileSync(path)).toEqual(original);
  });

  test("a concurrent publisher wins without overwrite or a second recovery", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    appendFileSync(path, '{broken}');
    const original = readFileSync(path);
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    const originalLink = fs.linkSync;
    let winner: string | undefined;
    let competing = false;
    const spy = spyOn(fs, "linkSync").mockImplementation((source, target) => {
      if (!competing) {
        competing = true;
        const other = createTranscriptStore(dir);
        winner = other.recover(id, { sourceVersion: diagnostic.sourceVersion });
        other.append(winner, { role: "user", content: "Sail home", toolCalls: [] });
      }
      originalLink(source, target);
    });
    let recovered: string;
    try { recovered = store.recover(id, { sourceVersion: diagnostic.sourceVersion }); }
    finally { spy.mockRestore(); }
    expect(recovered).toBe(winner!);
    expect(store.list()).toHaveLength(1);
    expect(store.history(recovered!)).toEqual([{ role: "user", content: "Sail home", toolCalls: [] }]);
    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(dir).filter((name) => name.endsWith(".pending"))).toEqual([]);
  });

  test("a process interrupted before publication leaves only hidden staging and retry is idempotent", () => {
    const dir = tempDir();
    const store = createTranscriptStore(dir);
    const id = store.create();
    const path = join(dir, `${id}.jsonl`);
    appendFileSync(path, '{broken}');
    const original = readFileSync(path);
    const diagnostic = store.diagnose(id);
    if (diagnostic.status === "missing") throw new Error("Missing fixture");
    const modulePath = new URL("../src/server/transcript-store.ts", import.meta.url).pathname;
    const script = `import * as fs from "node:fs";
      import {spyOn} from "bun:test";
      import {createTranscriptStore} from ${JSON.stringify(modulePath)};
      spyOn(fs, "fsyncSync").mockImplementation(() => process.exit(73));
      createTranscriptStore(${JSON.stringify(dir)}).recover(${JSON.stringify(id)}, {sourceVersion:${JSON.stringify(diagnostic.sourceVersion)}});`;
    const child = Bun.spawnSync([process.execPath, "-e", script]);
    expect(child.exitCode).toBe(73);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir).filter((name) => name.endsWith(".pending"))).toHaveLength(1);
    const recovered = store.recover(id, { sourceVersion: diagnostic.sourceVersion });
    expect(createTranscriptStore(dir).recover(id, { sourceVersion: diagnostic.sourceVersion })).toBe(recovered);
    expect(store.list()).toHaveLength(1);
    expect(readFileSync(path)).toEqual(original);
  });
});
