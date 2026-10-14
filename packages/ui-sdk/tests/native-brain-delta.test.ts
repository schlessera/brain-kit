import { expect, test } from "bun:test";
import { NativeBrainDeltaError, parseNativeBrainDelta, type NativeBrainDeltaCandidate } from "../src/server/native-brain-delta.js";

const BEFORE = { uuid: "11".repeat(16), transaction: 7n };
const AFTER = { uuid: "22".repeat(16), transaction: 9n };
const u64 = (n: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(n); return bytes; };
const bytes = (value: string) => Buffer.from(value, "utf8");
// Fixture encoder uses a lookup table; product verification uses bitwise CRC.
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let bit = 0; bit < 8; bit++) index = index & 1 ? (index >>> 1) ^ 0x82f63b78 : index >>> 1;
  return index >>> 0;
});
function command(kind: number, attrs: [number, Uint8Array][] = []): Buffer {
  const payload = Buffer.concat(attrs.map(([type, value]) => {
    const header = Buffer.alloc(4); header.writeUInt16LE(type); header.writeUInt16LE(value.length, 2);
    return Buffer.concat([header, value]);
  }));
  const header = Buffer.alloc(10); header.writeUInt32LE(payload.length); header.writeUInt16LE(kind, 4);
  const record = Buffer.concat([header, payload]); let crc = 0;
  for (const byte of record) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8);
  record.writeUInt32LE(crc >>> 0, 6); return record;
}
const start = () => command(2, [[15, bytes("odysseus-after")], [1, Buffer.from(AFTER.uuid, "hex")], [2, u64(AFTER.transaction)], [20, Buffer.from(BEFORE.uuid, "hex")], [21, u64(BEFORE.transaction)]]);
function stream(...commands: Uint8Array[]): Buffer {
  return Buffer.concat([bytes("btrfs-stream\0"), Buffer.from([1, 0, 0, 0]), start(), ...commands, command(21)]);
}
async function* chunks(value: Uint8Array, size = 31) { for (let offset = 0; offset < value.length; offset += size) yield value.subarray(offset, offset + size); }
async function collect(value: Uint8Array, roots = { before: BEFORE, after: AFTER }, size = 31) {
  const rows: NativeBrainDeltaCandidate[] = [];
  for await (const row of parseNativeBrainDelta(chunks(value, size), roots)) rows.push(row);
  return rows;
}

test("incremental v1 no-data paths include rename, hardlink and admitted clone source without interpreting link text", async () => {
  const data = stream(
    command(9, [[15, bytes("old")], [16, bytes("new")]]),
    command(10, [[15, bytes("notes/alias.md")], [17, bytes("notes/odysseus.md")]]),
    command(8, [[15, bytes("notes/link")], [3, u64(300n)], [17, bytes("../../outside")]]),
    command(16, [[15, bytes("notes/copied.md")], [18, u64(0n)], [24, u64(16n)], [20, Buffer.from(BEFORE.uuid, "hex")], [21, u64(BEFORE.transaction)], [22, bytes("notes/source.md")], [23, u64(0n)]]),
  );
  expect(await collect(data, undefined, 1)).toEqual([
    { paths: ["old", "new"], rename: { from: "old", to: "new" } },
    { paths: ["notes/alias.md", "notes/odysseus.md"] },
    { paths: ["notes/link"] }, { paths: ["notes/copied.md", "notes/source.md"] },
  ]);
});

test("root and parent timestamps request no recursive expansion", async () => {
  const timestamp = Buffer.alloc(12);
  const data = stream(...["", "notes"].map(path => command(20, [[15, bytes(path)], [11, timestamp], [10, timestamp], [9, timestamp]])));
  expect(await collect(data)).toEqual([{ paths: ["notes"] }]);
  expect(await collect(stream())).toEqual([]);
});

test("command corruption is refused by the real CRC guard", async () => {
  const data = stream(command(11, [[15, bytes("notes/odysseus.md")]]));
  data[data.length - 11] ^= 1;
  let failure: unknown;
  try { await collect(data); } catch (error) { failure = error; }
  expect(failure, "NATIVE_DELTA_CRC_REJECTS_CORRUPTION").toBeInstanceOf(NativeBrainDeltaError);
  expect((failure as Error).message).toContain("checksum");
});

test("truncated headers, attributes, missing END and trailing bytes never complete", async () => {
  const complete = stream(command(11, [[15, bytes("notes/odysseus.md")]]));
  for (const size of [0, 12, 16, 18, complete.length - 11, complete.length - 1, complete.length - 10]) {
    await expect(collect(complete.subarray(0, size))).rejects.toBeInstanceOf(NativeBrainDeltaError);
  }
  await expect(collect(Buffer.concat([complete, Buffer.from([0])]))).rejects.toBeInstanceOf(NativeBrainDeltaError);
  const broken = command(11, [[15, bytes("notes/odysseus.md")]]).subarray(10);
  broken.writeUInt16LE(65535, 2);
  // Re-encode checksum while preserving intentionally malformed TLV bytes.
  const header = Buffer.alloc(10); header.writeUInt32LE(broken.length); header.writeUInt16LE(11, 4);
  const record = Buffer.concat([header, broken]); let crc = 0;
  for (const byte of record) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8);
  record.writeUInt32LE(crc >>> 0, 6);
  await expect(collect(stream(record))).rejects.toThrow("truncated attribute");
});

test("paths cannot escape or normalize into a different native name; invalid UTF-8 is explicit", async () => {
  for (const path of ["", "/notes/a", "../a", "a/../b", "a/./b", "a//b", "a/", "a\0b"]) {
    await expect(collect(stream(command(11, [[15, bytes(path)]]))), "NATIVE_DELTA_PATH_CONTAINMENT").rejects.toThrow("relative path");
  }
  await expect(collect(stream(command(11, [[15, Buffer.from([0xc3, 0x28])]])))).rejects.toThrow("non-UTF-8");
  // No normalization or URI decoding: these are literal valid Linux names.
  expect(await collect(stream(command(11, [[15, bytes("notes/%2e%2e/Πηνελόπη.md")]])))).toEqual([{ paths: ["notes/%2e%2e/Πηνελόπη.md"] }]);
});

test("rename, hardlink and clone source paths use the same containment guard", async () => {
  const clone = (path: Uint8Array) => command(16, [[15, bytes("notes/a")], [18, u64(0n)], [24, u64(1n)], [20, Buffer.from(BEFORE.uuid, "hex")], [21, u64(BEFORE.transaction)], [22, path], [23, u64(0n)]]);
  for (const path of [bytes("../outside"), Buffer.from([0xc3, 0x28])]) {
    for (const record of [command(9, [[15, bytes("notes/a")], [16, path]]), command(10, [[15, bytes("notes/a")], [17, path]]), clone(path)]) {
      await expect(collect(stream(record))).rejects.toBeInstanceOf(NativeBrainDeltaError);
    }
  }
  expect(await collect(stream(command(8, [[15, bytes("notes/link")], [3, u64(300n)], [17, bytes("/outside")]])))).toEqual([{ paths: ["notes/link"] }]);
  for (const target of [bytes(""), bytes("a\0b"), Buffer.from([0xc3, 0x28])]) {
    await expect(collect(stream(command(8, [[15, bytes("notes/link")], [3, u64(300n)], [17, target]])))).rejects.toBeInstanceOf(NativeBrainDeltaError);
  }
});

test("unknown commands/attributes, duplicate fields, full streams and file-data commands fail closed", async () => {
  for (const record of [command(0), command(1, [[15, bytes("full")], [1, Buffer.alloc(16)], [2, u64(1n)]]), command(23),
    command(15, [[15, bytes("notes/a")], [18, u64(0n)], [19, bytes("data")]]),
    command(11, [[15, bytes("notes/a")], [25, Buffer.alloc(4)]]),
    command(11, [[15, bytes("notes/a")], [15, bytes("notes/b")]]), command(11),
    command(17, [[15, bytes("notes/a")], [4, Buffer.alloc(1)]])]) {
    await expect(collect(stream(record))).rejects.toBeInstanceOf(NativeBrainDeltaError);
  }
  const version = stream(); version.writeUInt32LE(2, 13);
  await expect(collect(version)).rejects.toThrow("v1");
  await expect(collect(stream(start()))).rejects.toThrow("multiple snapshots");
  await expect(collect(stream(), { before: BEFORE, after: { ...AFTER, transaction: 10n } })).rejects.toThrow("root pair");
  const clone = command(16, [[15, bytes("notes/a")], [18, u64(0n)], [24, u64(1n)], [20, Buffer.alloc(16, 3)], [21, u64(1n)], [22, bytes("notes/source")], [23, u64(0n)]]);
  await expect(collect(stream(clone))).rejects.toThrow("unadmitted clone root");
});

test("oversized advertised commands are refused before requesting their payload", async () => {
  let reads = 0;
  const header = Buffer.alloc(10); header.writeUInt32LE(0xffffffff); header.writeUInt16LE(11, 4);
  const input: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { reads++; yield Buffer.concat([bytes("btrfs-stream\0"), Buffer.from([1, 0, 0, 0]), header]); reads++; throw new Error("Payload must not be read"); } };
  await expect((async () => { for await (const _ of parseNativeBrainDelta(input, { before: BEFORE, after: AFTER })) {} })()).rejects.toThrow("v1 bound");
  expect(reads, "NATIVE_DELTA_BOUNDED_BEFORE_PAYLOAD").toBe(1);
});

test("transport chunks and root identities are bounded before parsing", async () => {
  for (const value of [new Uint8Array(), new Uint8Array(65537)]) {
    const input = { async *[Symbol.asyncIterator]() { yield value; } };
    await expect((async () => { for await (const _ of parseNativeBrainDelta(input, { before: BEFORE, after: AFTER })) {} })()).rejects.toThrow("input chunk");
  }
  for (const transaction of [-1n, 1n << 64n]) {
    await expect(collect(stream(), { before: { ...BEFORE, transaction }, after: AFTER })).rejects.toThrow("expected native root");
  }
});

test("abort interrupts a pending stream read and closes its iterator", async () => {
  let returned = false;
  const signal = new AbortController();
  const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true, value: undefined }; } }; } };
  const next = parseNativeBrainDelta(input, { before: BEFORE, after: AFTER, signal: signal.signal }).next();
  signal.abort(new Error("Odysseus stopped the turn"));
  await expect(next).rejects.toThrow("Odysseus stopped");
  expect(returned).toBe(true);
});

test("END cannot complete before natural EOF", async () => {
  const signal = new AbortController(); let reads = 0;
  const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return {
    next: async () => { if (reads++ === 0) return { done: false, value: stream() }; return new Promise(() => {}); },
    return: async () => ({ done: true, value: undefined }),
  }; } };
  let completed = false;
  const next = parseNativeBrainDelta(input, { before: BEFORE, after: AFTER, signal: signal.signal }).next().then(result => { completed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(completed, "NATIVE_DELTA_END_REQUIRES_NATURAL_EOF").toBe(false);
  signal.abort(new Error("Odysseus stopped the stream"));
  await expect(next).rejects.toThrow("Odysseus stopped");
});

// Real kernel v1 --no-data streams from the bounded offline native qualification
// on 2026-10-14. Sealed inventories below are evidence, not a replay model.
const nativeCases = [
  {
    "name": "directory-cycle-child-changes",
    "stream": "YnRyZnMtc3RyZWFtAAEAAABnAAAAAgBMwB0hDwAjAGRpcmVjdG9yeS1jeWNsZS1jaGlsZC1jaGFuZ2VzLWFmdGVyAQAQAA1iQUAqXw1Csy3heD+9rAYCAAgACAAAAAAAAAAUABAAzHfpd/unDU2ofDYLjsa/jhUACAAHAAAAAAAAABEAAAAJAPR5z/QPAAEAYhAACABvMjYxLTctMAoAAAAJAE0pXhAPAAEAYRAAAQBiFgAAAAkAPpypwA8ABwBiL2NoaWxkEAAHAGIvb3RoZXIWAAAACwBdqV+uDwASAGIvb3RoZXIvZGVsZXRlZC5tZC8AAAAWADDsJkwPABMAYi9vdGhlci9tb2RpZmllZC5tZBIACAAAAAAAAAAAAAQACAAdAAAAAAAAACMAAAARAHvppQAPABMAYi9vdGhlci9tb2RpZmllZC5tZAQACAAdAAAAAAAAAEcAAAAUAKPagL4PABMAYi9vdGhlci9tb2RpZmllZC5tZAsADABkws5qAAAAAIMr2QAKAAwAZMLOagAAAAAeL3ABCQAMAGTCzmoAAAAAHi9wAREAAAAJAIOSaf4PAAgAbzI2MS03LTAQAAEAYTUAAAAUANUuYgIPAAEAYQsADABkws5qAAAAAP3B2gAKAAwAZMLOagAAAAD9wdoACQAMAGTCzmoAAAAA9KskATQAAAAUAAzjXGoPAAAACwAMAGTCzmoAAAAA2Q6HAAoADABkws5qAAAAAPSrJAEJAAwAZMLOagAAAAD0qyQBOwAAABQAcbPbQQ8ABwBiL290aGVyCwAMAGTCzmoAAAAA2Q6HAAoADABkws5qAAAAAPSrJAEJAAwAZMLOagAAAAAeL3ABNQAAABQAxxrkyQ8AAQBiCwAMAGTCzmoAAAAA2Q6HAAoADABkws5qAAAAAB4vcAEJAAwAZMLOagAAAAAeL3ABAAAAABUAUGzJnQ==",
    "beforeRoot": {
      "uuid": "cc77e977fba70d4da87c360b8ec6bf8e",
      "transaction": "7"
    },
    "afterRoot": {
      "uuid": "0d6241402a5f0d42b32de1783fbdac06",
      "transaction": "8"
    },
    "before": [
      {
        "path": "a",
        "ino": 257,
        "mode": 493,
        "size": 10,
        "kind": "directory"
      },
      {
        "path": "b",
        "ino": 261,
        "mode": 493,
        "size": 14,
        "kind": "directory"
      },
      {
        "path": "a/child",
        "ino": 258,
        "mode": 493,
        "size": 42,
        "kind": "directory"
      },
      {
        "path": "a/child/deleted.md",
        "ino": 259,
        "mode": 420,
        "size": 39,
        "kind": "file",
        "sha256": "39e8b914b7e4d263e734b62a35ecd673fb5d27a1447ee4d384644d4dab2960b2"
      },
      {
        "path": "a/child/modified.md",
        "ino": 260,
        "mode": 420,
        "size": 30,
        "kind": "file",
        "sha256": "f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"
      },
      {
        "path": "b/note.md",
        "ino": 262,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"
      }
    ],
    "after": [
      {
        "path": "a",
        "ino": 261,
        "mode": 493,
        "size": 14,
        "kind": "directory"
      },
      {
        "path": "b",
        "ino": 257,
        "mode": 493,
        "size": 10,
        "kind": "directory"
      },
      {
        "path": "a/note.md",
        "ino": 262,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"
      },
      {
        "path": "b/other",
        "ino": 258,
        "mode": 493,
        "size": 22,
        "kind": "directory"
      },
      {
        "path": "b/other/modified.md",
        "ino": 260,
        "mode": 420,
        "size": 29,
        "kind": "file",
        "sha256": "8eb260c92a5278b53d72e3ac8880e6fb8dd413df324fb2eaabd1293939831119"
      }
    ]
  },
  {
    "name": "synthetic-parent-child-edits",
    "stream": "YnRyZnMtc3RyZWFtAAEAAABmAAAAAgAo4ws2DwAiAHN5bnRoZXRpYy1wYXJlbnQtY2hpbGQtZWRpdHMtYWZ0ZXIBABAAYfZZySBRdkKROKmKwLMd0wIACAAKAAAAAAAAABQAEAAHIBqECQbHQosfOWOwx26FFQAIAAkAAAAAAAAAEQAAAAkAJrEvHQ8AAQBiEAAIAG8yNjEtOS0wCgAAAAkATSleEA8AAQBhEAABAGIdAAAACwC/p5qoDwAZAG8yNjEtOS0wL2Vhcmx5LWRlbGV0ZWQubWQ2AAAAFgDsjkHYDwAaAG8yNjEtOS0wL2Vhcmx5LW1vZGlmaWVkLm1kEgAIAAAAAAAAAAAABAAIADYAAAAAAAAATgAAABQAeEz6OQ8AGgBvMjYxLTktMC9lYXJseS1tb2RpZmllZC5tZAsADABkws5qAAAAAEEELQIKAAwAZMLOagAAAACOxr0CCQAMAGTCzmoAAAAAjsa9AhEAAAAJAHruNw8PAAgAbzI2MS05LTAQAAEAYTUAAAAUAJ57WboPAAEAYQsADABkws5qAAAAAN6ULgIKAAwAZMLOagAAAAAFXm8CCQAMAGTCzmoAAAAABV5vAjQAAAAUANN9t34PAAAACwAMAGTCzmoAAAAAfWkfAgoADABkws5qAAAAAAVebwIJAAwAZMLOagAAAAAFXm8CNQAAABQAqxt7rg8AAQBiCwAMAGTCzmoAAAAAfWkfAgoADABkws5qAAAAAAi7LQIJAAwAZMLOagAAAAAFXm8CAAAAABUAUGzJnQ==",
    "beforeRoot": {
      "uuid": "07201a840906c7428b1f3963b0c76e85",
      "transaction": "9"
    },
    "afterRoot": {
      "uuid": "61f659c9205176429138a98ac0b31dd3",
      "transaction": "10"
    },
    "before": [
      {
        "path": "a",
        "ino": 257,
        "mode": 493,
        "size": 18,
        "kind": "directory"
      },
      {
        "path": "b",
        "ino": 261,
        "mode": 493,
        "size": 84,
        "kind": "directory"
      },
      {
        "path": "a/stable.md",
        "ino": 260,
        "mode": 420,
        "size": 30,
        "kind": "file",
        "sha256": "f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"
      },
      {
        "path": "b/early-deleted.md",
        "ino": 258,
        "mode": 420,
        "size": 46,
        "kind": "file",
        "sha256": "04cd1ac8380a5637d330cfaac248d806be85ee50b2907d456c7962566c734175"
      },
      {
        "path": "b/early-modified.md",
        "ino": 259,
        "mode": 420,
        "size": 44,
        "kind": "file",
        "sha256": "27f646f05cb1f1e331d4ea6b2734d3f570d68df970f62ad8de2ea168e6956c23"
      },
      {
        "path": "b/stable.md",
        "ino": 262,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"
      }
    ],
    "after": [
      {
        "path": "a",
        "ino": 261,
        "mode": 493,
        "size": 52,
        "kind": "directory"
      },
      {
        "path": "b",
        "ino": 257,
        "mode": 493,
        "size": 18,
        "kind": "directory"
      },
      {
        "path": "a/early-modified.md",
        "ino": 259,
        "mode": 420,
        "size": 54,
        "kind": "file",
        "sha256": "e7b2bc8eb6b4a64ee13e5d8f867dcada3bdfe546ae9cc2800556e9d42227b884"
      },
      {
        "path": "a/stable.md",
        "ino": 262,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"
      },
      {
        "path": "b/stable.md",
        "ino": 260,
        "mode": 420,
        "size": 30,
        "kind": "file",
        "sha256": "f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"
      }
    ]
  },
  {
    "name": "directory-parent-child-reversal",
    "stream": "YnRyZnMtc3RyZWFtAAEAAABpAAAAAgB873fGDwAlAGRpcmVjdG9yeS1wYXJlbnQtY2hpbGQtcmV2ZXJzYWwtYWZ0ZXIBABAA7gXctc71hkGEQxx+q9AB2AIACAAMAAAAAAAAABQAEADzibY+sLllSJgKFSiAugM9FQAIAAsAAAAAAAAAFAAAAAsAgBJ0MA8AEABhL2IvYy9kZWxldGVkLm1kLQAAABYAtQSLaA8AEQBhL2IvYy9tb2RpZmllZC5tZBIACAAAAAAAAAAAAAQACAAcAAAAAAAAACEAAAARAMj5EsAPABEAYS9iL2MvbW9kaWZpZWQubWQEAAgAHAAAAAAAAABFAAAAFAA1xppyDwARAGEvYi9jL21vZGlmaWVkLm1kCwAMAGTCzmoAAAAAkdlRAwoADABkws5qAAAAAOOs4gMJAAwAZMLOagAAAADjrOIDGAAAAAkAXRlqGA8ABwBhL2IvYy9kEAAJAGEvYi9jMi9kMhkAAAAJAGPmHvkPAAUAYS9iL2MQAAwAYS9iL2MyL2QyL2NjOgAAABQAad3+NA8ABgBhL2IvYzILAAwAZMLOagAAAACqOFMDCgAMAGTCzmoAAAAAgI+gAwkADABkws5qAAAAAICPoAM9AAAAFADpC7peDwAJAGEvYi9jMi9kMgsADABkws5qAAAAANWbUgMKAAwAZMLOagAAAACAj6ADCQAMAGTCzmoAAAAAgI+gAzcAAAAUAOJUY9IPAAMAYS9iCwAMAGTCzmoAAAAAMNBEAwoADABkws5qAAAAAICPoAMJAAwAZMLOagAAAACAj6ADQAAAABQAXlIDfA8ADABhL2IvYzIvZDIvY2MLAAwAZMLOagAAAAAw0EQDCgAMAGTCzmoAAAAAgI+gAwkADABkws5qAAAAAICPoAMAAAAAFQBQbMmd",
    "beforeRoot": {
      "uuid": "f389b63eb0b96548980a152880ba033d",
      "transaction": "11"
    },
    "afterRoot": {
      "uuid": "ee05dcb5cef5864184431c7eabd001d8",
      "transaction": "12"
    },
    "before": [
      {
        "path": "a",
        "ino": 257,
        "mode": 493,
        "size": 2,
        "kind": "directory"
      },
      {
        "path": "a/b",
        "ino": 258,
        "mode": 493,
        "size": 6,
        "kind": "directory"
      },
      {
        "path": "a/b/c",
        "ino": 259,
        "mode": 493,
        "size": 44,
        "kind": "directory"
      },
      {
        "path": "a/b/c2",
        "ino": 264,
        "mode": 493,
        "size": 0,
        "kind": "directory"
      },
      {
        "path": "a/b/c/d",
        "ino": 262,
        "mode": 493,
        "size": 14,
        "kind": "directory"
      },
      {
        "path": "a/b/c/deleted.md",
        "ino": 260,
        "mode": 420,
        "size": 39,
        "kind": "file",
        "sha256": "39e8b914b7e4d263e734b62a35ecd673fb5d27a1447ee4d384644d4dab2960b2"
      },
      {
        "path": "a/b/c/modified.md",
        "ino": 261,
        "mode": 420,
        "size": 30,
        "kind": "file",
        "sha256": "f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"
      },
      {
        "path": "a/b/c/d/note.md",
        "ino": 263,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"
      }
    ],
    "after": [
      {
        "path": "a",
        "ino": 257,
        "mode": 493,
        "size": 2,
        "kind": "directory"
      },
      {
        "path": "a/b",
        "ino": 258,
        "mode": 493,
        "size": 4,
        "kind": "directory"
      },
      {
        "path": "a/b/c2",
        "ino": 264,
        "mode": 493,
        "size": 4,
        "kind": "directory"
      },
      {
        "path": "a/b/c2/d2",
        "ino": 262,
        "mode": 493,
        "size": 18,
        "kind": "directory"
      },
      {
        "path": "a/b/c2/d2/cc",
        "ino": 259,
        "mode": 493,
        "size": 22,
        "kind": "directory"
      },
      {
        "path": "a/b/c2/d2/note.md",
        "ino": 263,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"
      },
      {
        "path": "a/b/c2/d2/cc/modified.md",
        "ino": 261,
        "mode": 420,
        "size": 28,
        "kind": "file",
        "sha256": "d89592c7e7770d6a5baecafd87f90dcc1ecb08f505abd840e0d2aeb3998ac373"
      }
    ]
  },
  {
    "name": "preexisting-hardlink-content-update",
    "stream": "YnRyZnMtc3RyZWFtAAEAAABtAAAAAgCU2vcpDwApAHByZWV4aXN0aW5nLWhhcmRsaW5rLWNvbnRlbnQtdXBkYXRlLWFmdGVyAQAQACQg4N+IqvVCsk+N1UvM7ogCAAgADgAAAAAAAAAUABAABVnMXe2GS0+fg0xQzOT+whUACAANAAAAAAAAACwAAAAWAIAUQdsPABAAY29udGVudC9maXJzdC5tZBIACAAAAAAAAAAAAAQACAAmAAAAAAAAAEQAAAAUAHxm+/EPABAAY29udGVudC9maXJzdC5tZAsADABkws5qAAAAAHHxcgQKAAwAZMLOagAAAACGl04FCQAMAGTCzmoAAAAAhpdOBQAAAAAVAFBsyZ0=",
    "beforeRoot": {
      "uuid": "0559cc5ded864b4f9f834c50cce4fec2",
      "transaction": "13"
    },
    "afterRoot": {
      "uuid": "2420e0df88aaf542b24f8dd54bccee88",
      "transaction": "14"
    },
    "before": [
      {
        "path": "content",
        "ino": 257,
        "mode": 493,
        "size": 16,
        "kind": "directory"
      },
      {
        "path": "linked",
        "ino": 259,
        "mode": 493,
        "size": 8,
        "kind": "directory"
      },
      {
        "path": "content/first.md",
        "ino": 258,
        "mode": 420,
        "size": 30,
        "kind": "file",
        "sha256": "f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"
      },
      {
        "path": "linked/deep",
        "ino": 260,
        "mode": 493,
        "size": 16,
        "kind": "directory"
      },
      {
        "path": "linked/deep/alias.md",
        "ino": 258,
        "mode": 420,
        "size": 30,
        "kind": "file",
        "sha256": "f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"
      }
    ],
    "after": [
      {
        "path": "content",
        "ino": 257,
        "mode": 493,
        "size": 16,
        "kind": "directory"
      },
      {
        "path": "linked",
        "ino": 259,
        "mode": 493,
        "size": 8,
        "kind": "directory"
      },
      {
        "path": "content/first.md",
        "ino": 258,
        "mode": 420,
        "size": 38,
        "kind": "file",
        "sha256": "e663a303fbfb608ba49ad9ff7faaaadceb694f3bdd75587a015f413ede3a45ad"
      },
      {
        "path": "linked/deep",
        "ino": 260,
        "mode": 493,
        "size": 16,
        "kind": "directory"
      },
      {
        "path": "linked/deep/alias.md",
        "ino": 258,
        "mode": 420,
        "size": 38,
        "kind": "file",
        "sha256": "e663a303fbfb608ba49ad9ff7faaaadceb694f3bdd75587a015f413ede3a45ad"
      }
    ]
  }
];

type Entry = { path: string; ino: number; kind: string; mode: number; size: number; sha256?: string };
function expandSealedCandidates(rows: NativeBrainDeltaCandidate[], before: Entry[], after: Entry[]): Set<string> {
  const paths = new Set(rows.flatMap(row => row.paths));
  for (const row of rows) if (row.rename) for (const prefix of [row.rename.from, row.rename.to]) {
    for (const root of [before, after]) if (root.some(entry => entry.path === prefix && entry.kind === "directory")) {
      for (const entry of root) if (entry.path.startsWith(`${prefix}/`)) paths.add(entry.path);
    }
  }
  // Model the maintained per-root inode index lookup required of the owner.
  for (const root of [before, after]) {
    const inodes = new Set(root.filter(entry => paths.has(entry.path)).map(entry => entry.ino));
    for (const entry of root) if (inodes.has(entry.ino)) paths.add(entry.path);
  }
  return paths;
}
for (const fixture of nativeCases) test(`real sealed native stream candidates cover ${fixture.name}`, async () => {
  const rows = await collect(Buffer.from(fixture.stream, "base64"), {
    before: { ...fixture.beforeRoot, transaction: BigInt(fixture.beforeRoot.transaction) },
    after: { ...fixture.afterRoot, transaction: BigInt(fixture.afterRoot.transaction) },
  }, 7);
  const covered = expandSealedCandidates(rows, fixture.before, fixture.after);
  const signature = (entry: Entry | undefined) => entry?.kind === "file" ? JSON.stringify([entry.mode, entry.size, entry.sha256]) : null;
  for (const path of new Set([...fixture.before, ...fixture.after].filter(entry => entry.kind === "file").map(entry => entry.path))) {
    if (signature(fixture.before.find(entry => entry.path === path)) !== signature(fixture.after.find(entry => entry.path === path))) {
      expect(covered.has(path), `NATIVE_DELTA_SEALED_CHANGED_PATH_COVERED ${fixture.name} ${path}`).toBe(true);
    }
  }
  if (fixture.name === "preexisting-hardlink-content-update") {
    expect(rows.flatMap(row => row.paths)).not.toContain("linked/deep/alias.md");
    expect(covered.has("linked/deep/alias.md"), "NATIVE_DELTA_INODE_ALIAS_EXPANSION_REQUIRED").toBe(true);
  }
});
