import { expect, test } from "bun:test";
import { newPressure, observePressure, ownerWrite } from "../src/storage/pressure.js";
import type { CapacityEvidence, WindowEvidence } from "../src/storage/history-evidence.js";
import { hashScope, HOUR, RECENT } from "../src/storage/history-model.js";
const at = Date.UTC(2026, 6, 12, 9, 41), identity = hashScope("Odysseus volume"), rootScope = hashScope("Odysseus stores"), target = hashScope("Odysseus attachment");
const unavailable: WindowEvidence = { state: "unavailable", reason: "insufficient-count", start: null, end: null, samples: 0, depletionPerDay: null, days: null };
const finite = (days: number): WindowEvidence => ({ state: "finite", reason: null, start: at - 2 * 24 * HOUR, end: at, samples: 9, depletionPerDay: 100, days });
const nondepleting: WindowEvidence = { ...finite(0), state: "non-depleting", days: null };
const evidence = (time: number, available: number, short = unavailable, long = unavailable): CapacityEvidence => ({ identity, rootScope, at: time, total: 100_000, available, fresh: true, short, long, appLogical: null, appAllocated: null, availableChange: null });

test("capacity exact entry/recovery boundaries require two additional observations after downgrade", () => {
  let value = newPressure(identity, rootScope);
  value = observePressure(value, evidence(at, 10_001), at); expect(value.severity).toBe("observed");
  value = observePressure(value, evidence(at + 1, 10_000), at + 1); expect(value.severity).toBe("low");
  value = observePressure(value, evidence(at + 2, 5000), at + 2); expect(value.severity).toBe("critical");
  const episode = value.episode; expect(episode).toBeTruthy();
  value = observePressure(value, evidence(at + 60_002, 7000), at + 60_002); expect(value.recoveryAt).toBeNull();
  value = observePressure(value, evidence(at + 120_002, 7001), at + 120_002); expect(value.severity).toBe("critical");
  value = observePressure(value, evidence(at + 180_001, 7001), at + 180_001); expect(value.severity).toBe("critical");
  value = observePressure(value, evidence(at + 180_002, 7001), at + 180_002); expect(value.severity, "STORAGE_PRESSURE_TWO_FRESH_OBSERVATIONS").toBe("low");
  expect(value.resolvedEpisode).toBe(episode); expect(value.episode).toBeNull();
  value = observePressure(value, evidence(at + 240_002, 12000), at + 240_002); expect(value.recoveryAt).toBeNull();
  value = observePressure(value, evidence(at + 300_002, 12001), at + 300_002); expect(value.severity).toBe("low");
  value = observePressure(value, evidence(at + 360_002, 12001), at + 360_002); expect(value.severity).toBe("observed");
});
test("forecast entry keeps either/both distinction and missing evidence cannot recover active causes", () => {
  let value = observePressure(newPressure(identity, rootScope), evidence(at, 50000, finite(7), unavailable), at);
  expect(value.severity).toBe("low");
  value = observePressure(value, evidence(at + 60_000, 50000, finite(7), finite(7)), at + 60_000); expect(value.severity).toBe("critical");
  for (let index = 2; index < 5; index++) value = observePressure(value, evidence(at + index * 60_000, 50000), at + index * 60_000);
  expect(value.severity, "STORAGE_PRESSURE_UNKNOWN_NEVER_RECOVERS").toBe("critical");
  value = observePressure(value, evidence(at + 5 * 60_000, 50000, finite(10), unavailable), at + 5 * 60_000); expect(value.recoveryAt).toBeNull();
  value = observePressure(value, evidence(at + 6 * 60_000, 50000, finite(10.00001), unavailable), at + 6 * 60_000);
  value = observePressure(value, evidence(at + 7 * 60_000, 50000, nondepleting, unavailable), at + 7 * 60_000); expect(value.severity).toBe("low");
  value = observePressure(value, evidence(at + 8 * 60_000, 50000, finite(50), unavailable), at + 8 * 60_000); expect(value.recoveryAt).toBeNull();
  value = observePressure(value, evidence(at + 9 * 60_000, 50000, finite(45.001), nondepleting), at + 9 * 60_000);
  value = observePressure(value, evidence(at + 10 * 60_000, 50000, finite(45.001), nondepleting), at + 10 * 60_000); expect(value.severity).toBe("observed");
});
test("every active cause must recover; stale, reversal, failed and incompatible observations reset pairs", () => {
  let value = observePressure(newPressure(identity, rootScope), evidence(at, 5000, finite(7), finite(7)), at);
  value = observePressure(value, evidence(at + 60_000, 13000), at + 60_000); expect(value.recoveryAt).toBeNull();
  const good = (time: number) => evidence(time, 13000, nondepleting, nondepleting);
  value = observePressure(value, good(at + 120_000), at + 120_000); expect(value.recoveryAt).not.toBeNull();
  value = observePressure(value, null, at + 130_000); expect(value.recoveryAt).toBeNull();
  value = observePressure(value, good(at + 180_000), at + 180_000); expect(value.severity).toBe("critical");
  value = observePressure(value, good(at + 170_000), at + 180_000); expect(value.recoveryAt).toBeNull();
  value = observePressure(value, { ...good(at + 240_000), rootScope: hashScope("Troy stores") }, at + 240_000); expect(value.scopeChanged).toBe(true); expect(value.supportAt).toBeNull();
  value = observePressure(value, good(at + 300_000), at + 300_000);
  value = observePressure(value, good(at + 300_000), at + 300_000 + RECENT + 1); expect(value.recoveryAt).toBeNull(); expect(value.severity).toBe("critical");
});
test("owner refusal requires matching target/resource success and the fresh capacity recovery pair", () => {
  let value = ownerWrite(newPressure(identity, rootScope), { target, resource: "bytes", at, outcome: "no-space" }, at);
  const good = (time: number) => evidence(time, 50000);
  for (let index = 1; index <= 3; index++) value = observePressure(value, good(at + index * 60_000), at + index * 60_000);
  expect(value.severity).toBe("critical");
  value = ownerWrite(value, { target: hashScope("Troy attachment"), resource: "bytes", at: at + 240_000, outcome: "success" }, at + 240_000);
  expect(value.refusals[0]?.successAt).toBeNull();
  value = ownerWrite(value, { target, resource: "quota", at: at + 300_000, outcome: "success" }, at + 300_000); expect(value.refusals[0]?.successAt).toBeNull();
  value = ownerWrite(value, { target, resource: "bytes", at: at + 360_000, outcome: "success" }, at + 360_000);
  value = observePressure(value, good(at + 420_000), at + 420_000);
  value = observePressure(value, good(at + 480_000), at + 480_000); expect(value.severity, "STORAGE_REFUSAL_MATCHING_SUCCESS").toBe("low");
  expect(value.refusals).toHaveLength(0); expect(value.capacity).toBe(true);
});

test("a later byte refusal cannot replace unresolved quota or another target's refusal", () => {
  let value = ownerWrite(newPressure(identity, rootScope), { target, resource: "quota", at, outcome: "no-space" }, at);
  const other = hashScope("Troy attachment");
  value = ownerWrite(value, { target: other, resource: "bytes", at: at + 1, outcome: "no-space" }, at + 1);
  value = ownerWrite(value, { target: other, resource: "bytes", at: at + 2, outcome: "success" }, at + 2);
  value = observePressure(value, evidence(at + 60_002, 50000), at + 60_002);
  value = observePressure(value, evidence(at + 120_002, 50000), at + 120_002);
  expect(value.severity, "STORAGE_REFUSALS_REMAIN_INDEPENDENT").toBe("critical");
  expect(value.refusals).toHaveLength(2);
  expect(value.refusals[0]?.resource).toBe("quota");
});
