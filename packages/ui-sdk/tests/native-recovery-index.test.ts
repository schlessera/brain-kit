import { expect, spyOn, test } from "bun:test";
import { NativeRecoveryIndex } from "../src/server/native-recovery-index";
import { recordNativeRecoveryFailure } from "../src/server/native-recovery-diagnostics";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

for (const operation of ["remember", "forget"] as const) test(`a failed index ${operation} rebuilds from durable identities in place`, () => {
  const durable = new Set([id(1)]);
  const index = new NativeRecoveryIndex(durable, () => durable);
  try {
    (index as unknown as { db: import("bun:sqlite").Database }).db.exec("PRAGMA query_only = ON");
    if (operation === "remember") durable.add(id(2)); else durable.delete(id(1));
    expect(() => index[operation](operation === "remember" ? id(2) : id(1)), "RECOVERY_INDEX_REBUILDS_FAILED_WRITE").not.toThrow();
    expect(index.page(null)).toEqual([...durable]);
    durable.add(id(3)); index.remember(id(3));
    expect(index.page(null), "RECOVERY_INDEX_NEXT_CHECKPOINT_WORKS").toEqual([...durable]);
  } finally { index.close(); }
});

test("a failed rebuild keeps pages closed and retries on the next admission", () => {
  let unavailable = true;
  const index = new NativeRecoveryIndex([id(1)], () => {
    if (unavailable) throw Error("Odysseus intent directory unavailable");
    return [id(1), id(2)];
  });
  try {
    (index as unknown as { db: import("bun:sqlite").Database }).db.exec("PRAGMA query_only = ON");
    expect(() => index.remember(id(2))).toThrow("intent directory unavailable");
    expect(() => index.page(null), "RECOVERY_INDEX_NO_PARTIAL_PAGE").toThrow("intent directory unavailable");
    unavailable = false;
    expect(index.page(null), "RECOVERY_INDEX_RECOVERS_WITHOUT_RESTART").toEqual([id(1), id(2)]);
  } finally { index.close(); }
});


test("index recovery retains a cause whose diagnostic write initially failed", () => {
  const causes: string[] = []; let fail = true;
  const index = new NativeRecoveryIndex([id(1)], () => [id(1), id(2)], error => {
    if (fail) { fail = false; throw Error("Odysseus diagnostics unavailable"); }
    causes.push(String(error));
  });
  try {
    (index as unknown as { db: import("bun:sqlite").Database }).db.exec("PRAGMA query_only = ON");
    expect(() => index.remember(id(2)), "RECOVERY_INDEX_DIAGNOSTIC_DOES_NOT_BLOCK_REBUILD").not.toThrow();
    expect(index.page(null)).toEqual([id(1), id(2)]);
    expect(causes[0], "RECOVERY_INDEX_ORIGINAL_CAUSE_SURVIVES_REPORT_FAILURE").toContain("readonly");
  } finally { index.close(); }
});

test("the concrete diagnostic writer retries the pending cause after storage recovers", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-cause-")), diagnostics = join(root, "diagnostics");
  writeFileSync(diagnostics, "not a directory");
  const log = spyOn(console, "error").mockImplementation(() => {});
  const index = new NativeRecoveryIndex([id(1)], () => [id(1), id(2)],
    (error, log) => recordNativeRecoveryFailure(diagnostics, "recovery-index", "native-brain-manager.writeIntent", error, log));
  try {
    (index as unknown as { db: import("bun:sqlite").Database }).db.exec("PRAGMA query_only = ON");
    index.remember(id(2));
    expect(index.page(null)).toEqual([id(1), id(2)]);
    unlinkSync(diagnostics);
    index.ensureAvailable();
    expect(readdirSync(root), "RECOVERY_INDEX_RETRIES_CONCRETE_DIAGNOSTIC_WRITE").toContain("diagnostics");
    const files = readdirSync(diagnostics);
    expect(files).toHaveLength(1);
    const cause = JSON.parse(readFileSync(join(diagnostics, files[0]!), "utf8"));
    expect(cause.message).toContain("readonly");
    expect(cause.site).toBe("native-brain-manager.writeIntent");
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); index.close(); rmSync(root, { recursive: true, force: true }); }
});
