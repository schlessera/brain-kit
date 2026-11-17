import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativePoolRecord } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceReads } from "../src/brain/reference-read";
import { sourceWrites } from "../src/brain/reference-source-writes";
import { ReferenceSourceError, type ReferenceSourceLease } from "../src/brain/reference-source";
import { githubReferenceRepository } from "../src/brain/github-reference-identity";
import { openSqliteWriter } from "../src/db/write-worker";
import { registerReferenceWrites } from "../src/brain/reference-writes";
import { inputTaintSignals } from "../src/activity/ingestion-taint";
import type { ReferenceBlob } from "../src/brain/reference-blob";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { createReferenceTools } from "../src/brain/reference-tools";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const repository = "https://github.com/odysseus/ithaca", commit = "a".repeat(40), tree = "b".repeat(40);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(worker = false) {
  const directory = mkdtempSync(join(tmpdir(), "odysseus-read-")), path = join(directory, "ui.db"), db = createUiDb(path);
  const writer = worker ? openSqliteWriter(db) : undefined;
  if (writer) registerReferenceWrites(db, writer);
  const principal = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const native: NativePoolRecord = { id: "ithaca-root", purpose: "source", from: null, allowanceBytes: 1048576, state: "sealed",
    root: { rootId: "256", uuid: "c".repeat(32), otransid: "4" }, path: "/sealed/ithaca", ownerBytes: 4096, reason: null,
    view: "ithaca-view", access: null, publicationRevoked: false };
  const writes = sourceWrites(db), at = Date.now();
  writes.sourceView("public", "ithaca-view"); writes.sourceStage(native.id, "public", repository, "main", at);
  writes.sourcePublish("/sealed", "public", repository, "main", `${repository}.git`, "ithaca@main", native.id, commit, "refs/heads/main", null, at,
    { id: "ithaca-acquisition", brain: "ithaca-brain", principalId: principal.id, turnId: "acquiring-turn",
      identity: { ...githubReferenceRepository(repository), repositoryId: "101", ownerId: "201", private: false }, ref: "refs/heads/main",
      commit, tree, root: native.root!, grantId: null, networkBytes: 1500, at });
  const state = { current: true, authorized: true, requests: 0, requested: [] as string[], released: 0, reads: 0, seals: 0,
    bytes: Buffer.from("Odysseus charts Ithaca."), afterRead: () => {}, afterSeal: () => {} };
  const lease: ReferenceSourceLease = { domain: "public", view: "ithaca-view", viewPath: "/sealed", name: "ithaca@main", repository,
    repositoryUrl: `${repository}.git`, revision: "main", commit, rootId: native.id, refreshedAt: at, validatedAt: at,
    stale: false, error: null, readGrantId: null, assertAuthority() {
      if (!state.authorized) throw new ReferenceSourceError("unauthorized", "Read authority was revoked.");
    }, release() { state.released++; } };
  const sources = { async request(input: { repository?: unknown }) { state.requests++; state.requested.push(String(input.repository)); return lease; } };
  const pool = { async poolSeal() { state.seals++; state.afterSeal(); return native; } };
  const transport = { async readBlob(input: { offset: number; maximum: number }) {
    state.reads++;
    const bytes = state.bytes.subarray(input.offset, input.offset + input.maximum);
    const blob: ReferenceBlob = { bytes, blob: "d".repeat(40), mode: "100644", tree, totalBytes: state.bytes.length,
      offset: input.offset, length: bytes.length, digest: sha256(bytes) };
    state.afterRead(); return blob;
  } };
  const reads = createReferenceReads({ db, brain: "ithaca-brain", sources, pool, transport });
  const call = (changes: Record<string, unknown> = {}) => reads.read({ turnId: "reading-turn", principalId: principal.id, toolCallId: "read-1",
    request: { repository, revision: "main", path: "README.md", offset: 9, maximum: 6 },
    acquisition: { turnId: "reading-turn", current: () => state.current, egress: {} as never }, ...changes });
  cleanups.push(async () => { await writer?.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, path, reads, call, state, native, transport, lease, writer, principal };
}

for (const worker of [false, true]) test(`returned content has durable exact-range evidence before delivery; writer=${worker}`, async () => {
  const f = await fixture(worker), result = await f.call();
  expect(result).toMatchObject({ ok: true, read: { repository, commit, path: "README.md", content: "charts", encoding: "utf8", offset: 9, length: 6, totalBytes: 23 } });
  const row = f.db.query("SELECT * FROM reference_reads").get() as { acquisition: string; evidence: string; response_digest: string; delivery: string };
  expect(JSON.parse(row.acquisition)).toMatchObject({ acquisition_id: "ithaca-acquisition", turn_id: "acquiring-turn", native_generation: "4" });
  expect(JSON.parse(row.evidence), "READ_RECEIPT_MATCHES_RETURNED_RANGE").toMatchObject({ path: "README.md", blob: "d".repeat(40), mode: "100644",
    offset: 9, length: 6, digest: sha256(Buffer.from("charts")), trusted: false, trustRevision: "0" });
  expect(row.response_digest).toBe(sha256(Buffer.from(JSON.stringify(result))));
  expect(row.delivery, "PREPARED_IS_NOT_OBSERVED_DELIVERY").toBe("prepared");
  expect(JSON.stringify(result)).not.toContain("acquisition"); expect(JSON.stringify(result)).not.toContain("digest");
  await f.reads.observeResult("other-turn", "read-1", "reference_read", "", true, [JSON.stringify(result)]);
  expect(f.db.query("SELECT delivery FROM reference_reads").get()).toEqual({ delivery: "prepared" });
  await f.reads.observeResult("reading-turn", "read-1", "reference_read", "", true, [JSON.stringify(result)]);
  expect(f.db.query("SELECT delivery FROM reference_reads").get(), "ONLY_EXACT_CALL_RESULT_OBSERVES_DELIVERY").toEqual({ delivery: "observed" });
  expect(f.state.released).toBe(1);
});

test("binary and split UTF-8 ranges preserve bytes instead of inserting replacement characters", async () => {
  const f = await fixture(); f.state.bytes = Buffer.from([0xff, 0x00, 0xe2]);
  const result = await f.call({ request: { repository, revision: "main", path: "chart.bin", offset: 0, maximum: 3 } });
  expect(result).toMatchObject({ ok: true, read: { content: "/wDi", encoding: "base64", length: 3 } });
  const record = f.db.query("SELECT evidence FROM reference_reads").get() as { evidence: string };
  expect(JSON.parse(record.evidence).digest).toBe(sha256(f.state.bytes));
});

test("repository names ending in .git reenter acquisition as an unambiguous clone location", async () => {
  const f = await fixture(), canonical = "https://github.com/odysseus/charts.git";
  f.lease.repository = canonical;
  f.db.query("UPDATE reference_acquisitions SET repository_name = 'charts.git'").run();
  f.db.query("UPDATE reference_sources SET repository = ?").run(canonical);
  f.db.query("UPDATE reference_roots SET repository = ?").run(canonical);
  const result = await f.call({ request: { repository: `${canonical}.git`, revision: "main", path: "README.md", offset: 9, maximum: 6 } });
  expect(result).toMatchObject({ ok: true, read: { repository: canonical, content: "charts" } });
  expect(f.state.requested, "READ_REENTERS_ACQUISITION_WITH_UNAMBIGUOUS_CLONE_URL").toEqual([`${canonical}.git`]);
});

test("missing model identity and invalid paths refuse before acquisition; duplicate identity never reads twice", async () => {
  const f = await fixture();
  await expect(f.call({ toolCallId: undefined }), "READ_REQUIRES_BACKEND_ID").rejects.toMatchObject({ code: "unavailable" });
  for (const path of ["../README.md", "/README.md", ".git/config", "charts/../README.md"])
    await expect(f.call({ request: { repository, revision: "main", path, offset: 0, maximum: 10 } })).rejects.toMatchObject({ code: "invalid" });
  expect(f.state.requests).toBe(0);
  await f.call();
  await expect(f.call()).rejects.toMatchObject({ code: "invalid" });
  expect(f.state.reads).toBe(1);
});

for (const kind of ["revocation", "turn-end", "mapping-loss", "native-generation", "byte-digest"])
  test(`read TOCTOU refuses bytes after ${kind}`, async () => {
    const f = await fixture();
    f.state.afterRead = () => {
      if (kind === "revocation") f.state.authorized = false;
      if (kind === "turn-end") f.state.current = false;
      if (kind === "mapping-loss") f.db.exec("DELETE FROM reference_acquisitions");
      if (kind === "native-generation") f.native.root!.otransid = "5";
      if (kind === "byte-digest") f.state.bytes[9] = 0;
    };
    await expect(f.call(), "READ_EFFECT_FENCES_RETURNED_BYTES").rejects.toBeInstanceOf(Error);
    expect(f.db.query("SELECT COUNT(*) AS n FROM reference_reads").get()).toEqual({ n: 0 });
    expect(f.state.released).toBe(1);
  });

for (const kind of ["missing", "mixed", "changed", "unfinished"])
  test(`unprovable ${kind} output cannot become an observed immutable read`, async () => {
    const f = await fixture(), result = await f.call(), output = JSON.stringify(result);
    const segments = kind === "missing" ? undefined : kind === "mixed" ? [output, "Circe adds a command."] : kind === "changed" ? [output + " "] : [output];
    await f.reads.observeResult("reading-turn", "read-1", "reference_read", output, kind !== "unfinished", segments);
    expect(f.db.query("SELECT delivery FROM reference_reads").get(), "UNPROVEN_RESULT_STAYS_UNKNOWN").toEqual({ delivery: "unknown" });
    await f.reads.observeResult("reading-turn", "read-1", "reference_read", output, true, [output]);
    expect(f.db.query("SELECT delivery FROM reference_reads").get(), "UNKNOWN_DELIVERY_CANNOT_BE_RELABELED").toEqual({ delivery: "unknown" });
  });

test("read facts survive acquisition eviction and restart without replay or inferred delivery", async () => {
  const f = await fixture(), result = await f.call();
  f.db.exec("DELETE FROM reference_sources; DELETE FROM reference_roots;");
  const restored = createUiDb(f.path);
  try {
    const row = restored.query("SELECT acquisition, evidence, delivery FROM reference_reads").get() as { acquisition: string; delivery: string };
    expect(JSON.parse(row.acquisition).acquisition_id).toBe("ithaca-acquisition");
    expect(row.delivery).toBe("prepared");
    expect(result.ok).toBe(true);
  } finally { restored.close(); }
});

test("a failed evidence commit withholds content rather than returning an unrecorded read", async () => {
  const f = await fixture(true);
  f.db.exec("CREATE TRIGGER ithaca_read_failure BEFORE INSERT ON reference_reads BEGIN SELECT RAISE(FAIL, 'read receipt unavailable'); END;");
  await expect(f.call(), "READ_NEVER_RETURNS_WITHOUT_DURABLE_EVIDENCE").rejects.toThrow("read receipt unavailable");
  expect(f.db.query("SELECT COUNT(*) AS n FROM reference_reads").get()).toEqual({ n: 0 });
  await expect(f.call(), "A_FAILED_CALL_ID_CANNOT_BE_REUSED").rejects.toMatchObject({ code: "invalid" });
  expect(f.state.reads).toBe(1);
});

test("the writer rechecks a newer durable authority fence instead of trusting its caller's prior check", async () => {
  const f = await fixture(true);
  f.state.afterRead = () => f.db.query("INSERT INTO reference_authority_fences (domain, repository, revision, generation) VALUES (?, ?, ?, ?)")
    .run("public", repository, "main", "new-ithaca-observation");
  await expect(f.call(), "READ_WRITER_FENCES_A_WAITED_EFFECT").rejects.toThrow("authority changed");
  expect(f.db.query("SELECT COUNT(*) AS n FROM reference_reads").get()).toEqual({ n: 0 });
});

for (const backend of ["claude", "pi"]) test(`the ${backend} collector observes exact read delivery and retains workspace taint`, async () => {
  const f = await fixture(true), writes = createGovernanceWrites(f.db, f.writer), bindingId = crypto.randomUUID();
  await writes.safetyBegin({ turnId: "reading-turn", bindingId, principalId: f.principal.id, sessionId: null, backendId: backend, at: 0 });
  f.db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,?)").run(backend);
  f.db.query("INSERT INTO chat_session_owners(session_id,principal_id,created_at) VALUES('ithaca',?,0)").run(f.principal.id);
  safetyCatalogCreated(f.db, "ithaca", f.principal.id, "reading-turn"); await writes.bind("reading-turn", "ithaca");
  const collector = createSafetyCollector(f.db, writes, { turnId: "reading-turn", bindingId, backendId: backend,
    sessionId: () => "ithaca", shellProxied: () => true, signal: new AbortController().signal, referenceReads: f.reads });
  await collector.ready(backend, 1);
  const tool = backend === "claude" ? "mcp__brain-ui__reference_read" : "reference_read";
  await collector.begin("read-1", tool, { repository, revision: "main", path: "README.md" });
  const result = await f.call(), text = JSON.stringify(result);
  await collector.result("read-1", tool, text, true, [text]);
  expect(f.db.query("SELECT delivery FROM reference_reads").get(), "REAL_COLLECTOR_OBSERVES_THE_READ_RESULT").toEqual({ delivery: "observed" });
  expect(safetyRecords(f.db, "ithaca").filter(record => record.kind === "occurrence"), "READ_RESULT_NEVER_CLEARS_WORKSPACE_TAINT").toHaveLength(1);
});

test("both managed read names remain workspace input; ordinary explicit marks remain independent", () => {
  for (const tool of ["reference_read", "mcp__brain-ui__reference_read"])
    expect(inputTaintSignals(tool, { repository, path: "README.md" }), "MANAGED_READ_IS_NOT_A_TRUST_EXEMPTION")
      .toEqual([{ source: "workspace_read", detector: "tool_file_input", key: "managed_reference" }]);
  expect(inputTaintSignals("Read", { file_path: "workspaces/ithaca/README.md" }, "/brain", () => true).map(v => v.source))
    .toEqual(["workspace_read", "user_marked"]);
});

test("the tool entry withholds a read result when its turn ended while the reader returned", async () => {
  const f = await fixture(), result = await f.call();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tools = createReferenceTools({ sources: { request: async () => f.lease, bindable: async () => ({ public: "/sealed", private: "/private" }) },
    reads: { ...f.reads, async read() { await held; return result; } } });
  await tools.begin("late-turn", { principalId: f.principal.id, posture: "interactive", generation: null });
  const call = tools.call("late-turn", f.principal.id, { tool: "reference_read", toolCallId: "read-late",
    input: { repository, revision: "main", path: "README.md", offset: 0, maximum: 64 } });
  tools.end("late-turn"); release();
  expect(await call, "TOOL_ENTRY_FENCES_LATE_CONTENT").toMatchObject({ ok: false, code: "cancelled" });
});
