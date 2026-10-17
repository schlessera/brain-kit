import { expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installDbRepeatObservation, repeatWarmIndex } from "./fixtures/db-repeat-observation";
import { dbRepeatStageVariant } from "../../../scripts/native-proof/db-repeat-variant";
const source = readFileSync(resolve(import.meta.dir, "../src/server/worker-native-output.ts"), "utf8");
const key = Symbol.for("brain-kit.fixture.db-repeat-stage");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-db-repeat-"));
  const variant = dbRepeatStageVariant(source);
  const run = new Function("info", "stage", "native", "createHash", new Bun.Transpiler({ loader: "ts" }).transformSync(variant.substitution.after));
  const fds: number[] = [];
  const physical = (ordinal: 1 | 2, options: { omit?: boolean; sameStage?: boolean; sameCheckpoint?: boolean; sameStageBinding?: boolean; sameStageId?: boolean; sameKeeper?: boolean } = {}) => {
    const stageOrdinal = options.sameStage ? 1 : ordinal, checkpointOrdinal = options.sameCheckpoint ? 1 : ordinal;
    const bindingOrdinal = options.sameStageBinding || options.sameStageId ? 1 : ordinal, keeperOrdinal = options.sameKeeper ? 1 : ordinal;
    const directory = join(root, String(stageOrdinal)); mkdirSync(directory, { recursive: true });
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(fd);
    const info = fstatSync(fd, { bigint: true });
    const stage = { id: `00000000-0000-4000-8000-00000000000${bindingOrdinal}`, rootDevice: String(info.dev), rootInode: String(info.ino), checkpointUuid: `3000000000004000800000000000000${options.sameStageBinding ? 1 : checkpointOrdinal}`, namespacePid: process.pid + keeperOrdinal, namespaceStart: String(keeperOrdinal) };
    const checkpoint = { id: `10000000-0000-4000-8000-00000000000${ordinal}`, fsid: "20000000-0000-4000-8000-000000000001",
      uuid: `3000000000004000800000000000000${checkpointOrdinal}`, rootId: String(256 + checkpointOrdinal), transaction: "1" };
    if (!options.omit) run(info, stage, { checkpoint }, createHash);
    return { command: ["/usr/local/bin/bun", "/repo/packages/core/src/cli/brain.ts", "index"],
      startupView: { root: `/brain-fixture/.brain-native/checkpoints/${checkpoint.id}` }, maintenance: { credentials: false,
        output: { target: "/tmp/brain-maintenance-output", storage: { mount: `/brain-fixture/.brain-native/stages/${stage.id}`, namespacePid: stage.namespacePid, namespaceStart: stage.namespaceStart } } } };
  };
  return { physical, cleanup() { try { for (const fd of fds) closeSync(fd); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

test("fixture receives actual ordinary held-FD metadata and refuses missing or wrong-owner correlation", () => {
  const f = fixture(), observation = installDbRepeatObservation();
  try {
    observation.begin(1);
    const payload = f.physical(1);
    expect(() => observation.observe(payload), "DB_REPEAT_REAL_HELD_FD_RECEIPT_AVAILABLE").not.toThrow();
    const wrong = structuredClone(payload); wrong.maintenance.output.storage.namespacePid++;
    expect(() => observation.observe(wrong), "DB_REPEAT_WRONG_OWNER_REFUSES").toThrow("DB_REPEAT_STAGE_OWNER_MISMATCH");
    observation.published(1, 200, { success: true });
    observation.begin(2);
    expect(() => observation.observe(f.physical(2, { omit: true }))).toThrow("DB_REPEAT_PHYSICAL_STAGE_RECEIPT_REQUIRED");
    expect(() => observation.published(2, 200, { success: true })).toThrow("DB_REPEAT_ACTUAL_INDEX_PAYLOAD_REQUIRED");
  } finally { try { observation.restore(); } finally { f.cleanup(); } }
});

test("real second loopback HTTP request follows first publication and retains distinct physical evidence", async () => {
  const f = fixture(), observation = installDbRepeatObservation(); let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/brain/index"); expect(request.method).toBe("POST");
    expect(request.headers.get("cookie")).toBe("odysseus-fixture-cookie"); expect(await request.json()).toEqual({});
    requests++; observation.observe(f.physical(requests as 1 | 2)); return Response.json({ success: true });
  } });
  try {
    await expect(repeatWarmIndex(observation, server.port!, "odysseus-fixture-cookie")).rejects.toThrow("DB_REPEAT_PUBLICATION_ORDER");
    expect(requests).toBe(0);
    observation.begin(1);
    const first = await fetch(`http://127.0.0.1:${server.port}/api/brain/index`, { method: "POST", headers: { cookie: "odysseus-fixture-cookie", "content-type": "application/json" }, body: "{}" });
    observation.published(1, first.status, await first.json());
    let result: Awaited<ReturnType<typeof repeatWarmIndex>> | undefined, failure: unknown;
    try { result = await repeatWarmIndex(observation, server.port!, "odysseus-fixture-cookie"); } catch (error) { failure = error; }
    expect(requests, "DB_REPEAT_TWO_REAL_HTTP_REQUESTS").toBe(2);
    expect(failure).toBeUndefined(); expect(result?.status).toBe(200); expect(result?.body).toEqual({ success: true });
    expect(result!.physicalStages[0]!.checkpointPhysical).not.toBe(result!.physicalStages[1]!.checkpointPhysical);
    expect(result!.physicalStages[0]!.stagePhysical).not.toBe(result!.physicalStages[1]!.stagePhysical);
    expect(JSON.stringify(result!.physicalStages)).not.toContain("/proc/"); expect(JSON.stringify(result!.physicalStages)).not.toContain("namespacePid");
  } finally { try { server.stop(true); } finally { try { observation.restore(); } finally { f.cleanup(); } } }
});

test("distinct keeper and stage bindings are both required even when numeric mount identities recycle", () => {
  for (const reused of ["sameCheckpoint", "sameStageBinding", "sameStageId", "sameKeeper", "samePhysicalOwnerOnly"] as const) {
    const f = fixture(), observation = installDbRepeatObservation();
    const logDescriptor = Object.getOwnPropertyDescriptor(console, "log")!, diagnostic: string[] = [];
    try {
      Object.defineProperty(console, "log", { ...logDescriptor, value: (line: string) => { diagnostic.push(line); } });
      observation.begin(1); observation.observe(f.physical(1)); observation.published(1, 200, { success: true });
      observation.begin(2); observation.observe(f.physical(2, reused === "samePhysicalOwnerOnly" ? { sameStage: true, sameStageBinding: true } : { [reused]: true })); observation.published(2, 200, { success: true });
      expect(() => observation.complete(), `DB_REPEAT_${reused}_REFUSES`).toThrow("DB_REPEAT_DISTINCT_ATTESTED_IDENTITIES_REQUIRED");
      expect(diagnostic.length, "DB_REPEAT_FAILURE_OBSERVATIONS_RETAINED").toBe(1);
      const receipt = JSON.parse(diagnostic[0]!).dbRepeatPhysicalObservation;
      expect(receipt.physicalStages).toHaveLength(2);
      expect(receipt.checkpointEqual).toBe(reused === "sameCheckpoint");
      expect(receipt.stageEqual).toBe(reused === "samePhysicalOwnerOnly");
      expect(receipt.stageIdentityEqual).toBe(reused === "sameStageBinding" || reused === "sameStageId" || reused === "samePhysicalOwnerOnly");
      expect(receipt.stageBindingEqual).toBe(reused === "sameStageBinding" || reused === "samePhysicalOwnerOnly");
      expect(receipt.keeperGenerationEqual).toBe(reused === "sameKeeper");
      expect(JSON.stringify(receipt)).not.toContain("namespacePid"); expect(JSON.stringify(receipt)).not.toContain("/proc/");
    } finally { try { Object.defineProperty(console, "log", logDescriptor); } finally { try { observation.restore(); } finally { f.cleanup(); } } }
  }
});

test("released numeric stage identity can recur only with independent attested stage and keeper generations", () => {
  const f = fixture(), observation = installDbRepeatObservation();
  try {
    observation.begin(1); observation.observe(f.physical(1)); observation.published(1, 200, { success: true });
    observation.begin(2); observation.observe(f.physical(2, { sameStage: true })); observation.published(2, 200, { success: true });
    const result = observation.complete();
    expect(result[0]!.stagePhysical).toBe(result[1]!.stagePhysical);
    expect(result[0]!.checkpointPhysical).not.toBe(result[1]!.checkpointPhysical);
    expect(result[0]!.stageKey).not.toBe(result[1]!.stageKey);
    expect(result[0]!.stageBinding).not.toBe(result[1]!.stageBinding);
    expect(result[0]!.keeperGeneration).not.toBe(result[1]!.keeperGeneration);
  } finally { try { observation.restore(); } finally { f.cleanup(); } }
});

test("fixed stage transform refuses drift/duplicate anchors and observation restores its exact slot", () => {
  const variant = dbRepeatStageVariant(source), original = Object.getOwnPropertyDescriptor(globalThis, key);
  expect(() => dbRepeatStageVariant(source.replace(variant.substitution.before, ""))).toThrow();
  expect(() => dbRepeatStageVariant(source + "\n" + variant.substitution.before)).toThrow();
  try {
    Object.defineProperty(globalThis, key, { value: undefined, configurable: true, enumerable: true, writable: false });
    const previous = Object.getOwnPropertyDescriptor(globalThis, key), observation = installDbRepeatObservation();
    observation.restore(); expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(previous);
    Object.defineProperty(globalThis, key, { value: "Odysseus occupied", configurable: true });
    expect(() => installDbRepeatObservation()).toThrow("DB_REPEAT_SLOT_NOT_EMPTY");
  } finally { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); }
});
