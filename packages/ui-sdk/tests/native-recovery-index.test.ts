import { expect, test } from "bun:test";
import { NativeRecoveryIndex } from "../src/server/native-recovery-index";

const id = (n: number) => `17920000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("recovery index seeks ordered bounded pages across historical identities", () => {
  const index = new NativeRecoveryIndex(Array.from({ length: 10000 }, (_, i) => id(10000 - i)));
  try {
    const first = index.page(null);
    expect(first.length, "NATIVE_RECOVERY_SQL_BOUNDED_LOOKAHEAD").toBe(65);
    expect(first).toEqual(Array.from({ length: 65 }, (_, i) => id(i + 1)));
    expect(index.page(id(9950))).toEqual(Array.from({ length: 50 }, (_, i) => id(9951 + i)));
    expect(index.page(id(10000))).toEqual([]);
    index.remember(id(10001)); index.remember(id(10001));
    expect(index.page(id(10000))).toEqual([id(10001)]);
    // A key inserted below a consumed cursor is not repeated or a snapshot promise.
    index.remember(id(0)); expect(index.page(id(10000))).toEqual([id(10001)]);
  } finally { index.close(); }
});

test("unindexed durable identity uncertainty refuses pages until restart rebuild", () => {
  const index = new NativeRecoveryIndex([id(1)]);
  try {
    expect(() => index.remember("../unknown")).toThrow();
    expect(() => index.page(null), "NATIVE_RECOVERY_NO_PARTIAL_INDEX_AS_COMPLETE").toThrow("restart");
  } finally { index.close(); }
  const rebuilt = new NativeRecoveryIndex([id(1), id(2)]);
  try { expect(rebuilt.page(null)).toEqual([id(1), id(2)]); }
  finally { rebuilt.close(); }
});
