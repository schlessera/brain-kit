import { describe, expect, test } from "bun:test";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { InboxSnapshot, ServerActivitySnapshot } from "@schlessera/brain-ui-sdk/protocol";

const snapshots = [
  { type: "inbox_snapshot", view: "queue", threads: [], items: [], cursor: 9 },
  { type: "activity_snapshot", view: "index", spans: [], events: [] },
] satisfies [Omit<InboxSnapshot, "highWaterSeq">, Omit<ServerActivitySnapshot, "highWaterSeq">];
const keys = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "ithaca"];

describe("server snapshot sequence maps", () => {
  for (const snapshot of snapshots) {
    test(`${snapshot.type} preserves every own sequence entry through text and binary frames`, () => {
      const entries = keys.map((key, i): [string, number] => [key, i + 7]);
      const highWaterSeq = Object.fromEntries(entries);
      expect(Object.entries(highWaterSeq)).toEqual(entries);
      expect(Object.hasOwn(highWaterSeq, "__proto__")).toBe(true);
      const text = JSON.stringify({ ...snapshot, highWaterSeq });
      expect(Object.entries(JSON.parse(text).highWaterSeq)).toEqual(entries);
      const bytes = new TextEncoder().encode(text);
      for (const raw of [text, bytes, bytes.buffer]) {
        const result = parseServerMessage(raw);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        if (result.message.type !== "inbox_snapshot" && result.message.type !== "activity_snapshot") {
          throw new Error("Expected the snapshot under test");
        }
        const output = result.message.highWaterSeq;
        expect(Object.hasOwn(output, "__proto__")).toBe(true);
        for (const [key, value] of entries) {
          expect(Object.hasOwn(output, key), key).toBe(true);
          expect(output[key], key).toBe(value);
        }
        expect(Object.keys(output).sort()).toEqual(keys.toSorted());
        expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(output, "__proto__")).toEqual({
          value: 7, enumerable: true, writable: true, configurable: true,
        });
      }
    });

    test(`${snapshot.type} rejects invalid values even on the skipped prototype key`, () => {
      for (const key of ["__proto__", "constructor", "ithaca"]) {
        for (const value of [null, "7", true, [], { polluted: true }]) {
          const highWaterSeq = Object.fromEntries([[key, value], ["ordinary", 9]]);
          expect(Object.hasOwn(highWaterSeq, key)).toBe(true);
          const result = parseServerMessage(JSON.stringify({ ...snapshot, highWaterSeq }));
          expect(result.ok, `${key}: ${JSON.stringify(value)}`).toBe(false);
          if (!result.ok) expect(result.error).toContain(`highWaterSeq.${key}`);
        }
      }
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    });

    test(`${snapshot.type} rejects malformed maps and accepts an empty map`, () => {
      for (const highWaterSeq of [null, [], "map", 7]) {
        expect(parseServerMessage(JSON.stringify({ ...snapshot, highWaterSeq })).ok).toBe(false);
      }
      expect(parseServerMessage(JSON.stringify({ ...snapshot, highWaterSeq: {} }))).toEqual({
        ok: true, message: { ...snapshot, highWaterSeq: {} },
      });
    });
  }

  test("Inbox retains safe nonnegative integer validation for every key", () => {
    for (const key of ["__proto__", "constructor", "ithaca"]) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const result = parseServerMessage(JSON.stringify({ ...snapshots[0], highWaterSeq: Object.fromEntries([[key, value]]) }));
        expect(result.ok, `${key}: ${value}`).toBe(false);
      }
      for (const value of [0, Number.MAX_SAFE_INTEGER]) {
        expect(parseServerMessage(JSON.stringify({ ...snapshots[0], highWaterSeq: Object.fromEntries([[key, value]]) })).ok).toBe(true);
      }
    }
  });

  test("Activity retains its existing finite-number policy without tightening it", () => {
    for (const key of ["__proto__", "constructor", "ithaca"]) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const frame = { ...snapshots[1], highWaterSeq: Object.fromEntries([[key, value]]) };
        expect(parseServerMessage(JSON.stringify(frame))).toEqual({ ok: true, message: frame });
      }
      // JSON can encode an overflowing number even though JSON.stringify(Infinity) emits null.
      expect(parseServerMessage(`{"type":"activity_snapshot","view":"index","spans":[],"events":[],"highWaterSeq":{"${key}":1e400}}`).ok).toBe(false);
    }
  });
});
