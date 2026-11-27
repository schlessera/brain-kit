import { afterEach, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { PI_PIPE_MAX_BYTES, pipeMessages } from "../src/worker-protocol.js";

const chunked = (chunks: readonly (string | Buffer)[]) => Readable.from(chunks.map(chunk => Buffer.from(chunk)));
async function read(chunks: readonly (string | Buffer)[]): Promise<unknown[]> {
  const messages: unknown[] = [];
  for await (const message of pipeMessages(chunked(chunks))) messages.push(message);
  return messages;
}
/** One JSON line of exactly `bytes` bytes before its line feed. */
const lineOf = (bytes: number) => JSON.stringify("x".repeat(bytes - 2));

const spies: { mockRestore(): void }[] = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

test("two messages in one chunk", async () => {
  expect(await read(['{"type":"ready"}\n{"type":"done","cost":0}\n'])).toEqual([{ type: "ready" }, { type: "done", cost: 0 }]);
});

test("one message split across three chunks", async () => {
  expect(await read(['{"type":"sn', 'apshot","entries":[{"id":"ith', 'aca"}]}\n'])).toEqual([{ type: "snapshot", entries: [{ id: "ithaca" }] }]);
});

test("a multi-byte character split across a chunk boundary decodes unchanged", async () => {
  const bytes = Buffer.from(JSON.stringify({ text: "Πηνελόπη" }) + "\n");
  const split = bytes.indexOf(Buffer.from("η")) + 1;
  expect(await read([bytes.subarray(0, split), bytes.subarray(split)])).toEqual([{ text: "Πηνελόπη" }]);
});

test("a line of exactly the bound is accepted and one byte more is refused", async () => {
  const line = lineOf(PI_PIPE_MAX_BYTES);
  expect(Buffer.byteLength(line)).toBe(PI_PIPE_MAX_BYTES);
  const half = PI_PIPE_MAX_BYTES / 2;
  expect(await read([line.slice(0, half), line.slice(half) + "\n"])).toEqual([JSON.parse(line)]);
  const over = lineOf(PI_PIPE_MAX_BYTES + 1);
  await expect(read([over.slice(0, half), over.slice(half) + "\n"])).rejects.toThrow("Pi worker protocol payload exceeds its bound.");
});

test("pending bytes over the bound without a line feed are refused", async () => {
  await expect(read(["x".repeat(PI_PIPE_MAX_BYTES), "x"])).rejects.toThrow("Pi worker protocol payload exceeds its bound.");
});

test("a stream that ends inside a message is refused", async () => {
  await expect(read(['{"type":"ready"}\n{"type":"do'])).rejects.toThrow("Pi worker protocol ended with a partial message.");
});

test("a large line is joined once and each delivered byte is searched once", async () => {
  const value = { type: "snapshot", entries: [{ type: "session", text: "Ithaca ".repeat(12 * 1024 * 1024 / 7) }] };
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  expect(bytes.length).toBeGreaterThan(12 * 1024 * 1024 - 1024);
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += 64 * 1024) chunks.push(bytes.subarray(at, at + 64 * 1024));
  const stream = Readable.from(chunks);
  const concat = spyOn(Buffer, "concat");
  const original = Buffer.prototype.indexOf;
  let searched = 0;
  const search = spyOn(Buffer.prototype, "indexOf").mockImplementation(function (this: Buffer, needle: any, offset?: any, encoding?: any) {
    const found = original.call(this, needle, offset, encoding);
    const from = typeof offset === "number" ? offset < 0 ? Math.max(0, this.length + offset) : offset : 0;
    searched += (found >= 0 ? found + 1 : this.length) - from;
    return found;
  });
  spies.push(concat, search);
  const messages: unknown[] = [];
  for await (const message of pipeMessages(stream)) messages.push(message);
  const joins = concat.mock.calls.length, scanned = searched;
  concat.mockRestore(); search.mockRestore();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual(value);
  expect(joins, "PIPE_JOINS_A_LINE_ONCE").toBeLessThanOrEqual(2);
  expect(scanned, "PIPE_SEARCHES_EACH_BYTE_ONCE").toBeLessThanOrEqual(2 * bytes.length);
});
