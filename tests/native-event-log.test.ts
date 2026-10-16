import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeEventLog } from "../scripts/native-proof/event-log.js";

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "native-event-log-")); owned.push(dir);
  const path = join(dir, "events.jsonl"), artifacts = join(dir, "evidence"); mkdirSync(artifacts);
  writeFileSync(path, "");
  return { path, artifacts, log: new NativeEventLog(path, artifacts) };
}

test("NATIVE_EVENT_FRAME_BOUNDARY: a partial live record cannot abort or satisfy queued refresh", () => {
  const f = fixture();
  const start = { kind: "automatic_index_started", ordinal: 2, at: 10 };
  const finish = { kind: "automatic_index_finished", ordinal: 2, at: 11.5 };
  const row = JSON.stringify(finish);
  appendFileSync(f.path, JSON.stringify(start) + "\n" + row.slice(0, -2));
  let events: Record<string, any>[] = [];
  expect(() => { events = f.log.read("queued-refresh"); }, "unterminated live bytes are pending evidence, not a complete record").not.toThrow();
  expect(events).toEqual([start]);
  appendFileSync(f.path, row.slice(-2));
  expect(f.log.read("queued-refresh"), "valid JSON without its newline is still pending").toEqual([start]);
  appendFileSync(f.path, "\n");
  expect(f.log.read("queued-refresh")).toEqual([start, finish]);
  expect(f.log.read("shutdown", true)).toEqual([start, finish]);
});

test("NATIVE_EVENT_PENDING_EVIDENCE: retain exact first snapshot and byte boundaries without unbounded artifacts", () => {
  const f = fixture(), prefix = Buffer.from('{"kind":"worker_exit","attempt":2}\n');
  const tail = Buffer.from('{"kind":"automatic_index_finished","at":11.');
  const bytes = Buffer.concat([prefix, tail]); writeFileSync(f.path, bytes);
  expect(f.log.read("queued-refresh")).toEqual([{ kind: "worker_exit", attempt: 2 }]);
  const saved = readFileSync(join(f.artifacts, "event-observation-pending.bin"));
  const receipt = JSON.parse(readFileSync(join(f.artifacts, "event-observation-pending.json"), "utf8"));
  expect(saved).toEqual(bytes);
  expect(receipt).toMatchObject({ phase: "queued-refresh", final: false, snapshotBytes: bytes.length,
    completeBytes: prefix.length, pendingBytes: tail.length, recordStart: prefix.length, recordEnd: bytes.length,
    before: { size: bytes.length }, after: { size: bytes.length } });
  appendFileSync(f.path, '5}'); f.log.read("later-observation");
  expect(readFileSync(join(f.artifacts, "event-observation-pending.bin"))).toEqual(saved);
});

for (const bad of ['{"kind":', '', 'null', '[]', '42', '{}']) test(`NATIVE_EVENT_MALFORMED_COMPLETE: reject complete ${JSON.stringify(bad)} before trusting a matching event`, () => {
  const f = fixture(), first = '{"kind":"automatic_index_finished","ordinal":2}\n';
  const bytes = Buffer.from(first + bad + "\n" + '{"kind":"unfinished'); writeFileSync(f.path, bytes);
  expect(() => f.log.read("queued-refresh")).toThrow("NATIVE_EVENT_LOG_INVALID_RECORD");
  expect(readFileSync(join(f.artifacts, "event-observation-failure.bin"))).toEqual(bytes);
  expect(JSON.parse(readFileSync(join(f.artifacts, "event-observation-failure.json"), "utf8")))
    .toMatchObject({ phase: "queued-refresh", final: false, recordStart: Buffer.byteLength(first), recordEnd: Buffer.byteLength(first + bad) });
});

test("NATIVE_EVENT_UTF8_COMPLETE: malformed complete UTF-8 cannot be silently replaced inside valid JSON", () => {
  const f = fixture(); writeFileSync(f.path, Buffer.concat([Buffer.from('{"kind":"worker_exit","note":"'), Buffer.from([0xc3]), Buffer.from('"}\n')]));
  expect(() => f.log.read("authority")).toThrow("NATIVE_EVENT_LOG_INVALID_RECORD");
});

for (const tail of ['{"kind":"worker_exit"}', '{"kind":', ' ']) test(`NATIVE_EVENT_FINAL_TAIL: writer shutdown requires the newline for ${JSON.stringify(tail)}`, () => {
  const f = fixture(); writeFileSync(f.path, tail);
  expect(f.log.read("live")).toEqual([]);
  expect(() => f.log.read("shutdown", true)).toThrow("NATIVE_EVENT_LOG_INCOMPLETE_FINAL");
  expect(readFileSync(join(f.artifacts, "event-observation-failure.bin"), "utf8")).toBe(tail);
  expect(JSON.parse(readFileSync(join(f.artifacts, "event-observation-failure.json"), "utf8"))).toMatchObject({ final: true, phase: "shutdown", pendingBytes: Buffer.byteLength(tail) });
});

test("NATIVE_EVENT_EMPTY: an empty live or completed stream provides no event evidence", () => {
  const f = fixture(); expect(f.log.read("boot")).toEqual([]); expect(f.log.read("shutdown", true)).toEqual([]);
});

test("NATIVE_EVENT_CHILD_APPEND: real child fragments stay pending until the newline, including split UTF-8", async () => {
  const f = fixture(), dir = join(f.path, ".."), phase = join(dir, "phase"), script = join(dir, "writer.ts");
  writeFileSync(script, `import {appendFileSync,writeFileSync} from 'node:fs';
const [path,phase]=process.argv.slice(2); const row=Buffer.from(JSON.stringify({kind:'automatic_index_finished',ordinal:2,note:'Odysseus \\u03b1'})+'\\n');
const split=row.indexOf(Buffer.from('\\u03b1'))+1; const input=Bun.stdin.stream().getReader();
appendFileSync(path!,row.subarray(0,split));writeFileSync(phase!,'partial');await input.read();
appendFileSync(path!,row.subarray(split,-1));writeFileSync(phase!,'json');await input.read();
appendFileSync(path!,row.subarray(-1));input.releaseLock();`);
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../scripts/test-network-child-preload.ts"), script, f.path, phase],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test" } });
  const stderr = new Response(child.stderr).text(), stdout = new Response(child.stdout).text();
  const wait = async (value: string) => {
    const deadline = performance.now() + 5000;
    while (true) {
      try { if (readFileSync(phase, "utf8") === value) return; } catch {}
      if (performance.now() > deadline) throw Error(`Child append phase missing: ${value}`);
      await Bun.sleep(1);
    }
  };
  try {
    await wait("partial"); expect(f.log.read("queued-refresh")).toEqual([]);
    child.stdin.write("continue\n"); await wait("json");
    expect(f.log.read("queued-refresh"), "a complete JSON object is not committed before its newline").toEqual([]);
    child.stdin.write("commit\n"); child.stdin.end(); expect(await child.exited, await stderr).toBe(0);
    expect(f.log.read("queued-refresh")).toEqual([{ kind: "automatic_index_finished", ordinal: 2, note: "Odysseus \u03b1" }]);
    expect(f.log.read("shutdown", true)).toEqual(f.log.read("queued-refresh"));
  } finally { child.kill(); await child.exited; await Promise.all([stdout, stderr]); }
});

test("NATIVE_EVENT_FIRST_FAILURE: shutdown cannot overwrite the original malformed live read", () => {
  const f = fixture(), first = Buffer.from('{"kind":"automatic_index_finished"}\n{"kind":bad}\n');
  writeFileSync(f.path, first);
  expect(() => f.log.read("queued-refresh")).toThrow("NATIVE_EVENT_LOG_INVALID_RECORD");
  appendFileSync(f.path, '{"kind":"closed"}\n');
  expect(() => f.log.read("shutdown", true)).toThrow("NATIVE_EVENT_LOG_INVALID_RECORD");
  expect(readFileSync(join(f.artifacts, "event-observation-failure.bin")), "the failed live observation survives the later shutdown read").toEqual(first);
  expect(JSON.parse(readFileSync(join(f.artifacts, "event-observation-failure.json"), "utf8"))).toMatchObject({ phase: "queued-refresh", final: false, snapshotBytes: first.length });
});
