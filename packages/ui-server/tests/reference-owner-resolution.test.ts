import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { startEgressProxy } from "@schlessera/brain-ui-sdk/internal";
import type { TrustRule } from "@schlessera/brain-common/internal/governance-policy";
import { createUiDb } from "../src/db/client";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGitHubReferenceAccess } from "../src/brain/github-reference-access";
import { createTrustGitHubIdentity } from "../src/brain/trust-github-identity";
import { createTrustSettings } from "../src/brain/trust-settings";
import { createReferenceSources } from "../src/brain/reference-source";
import { createReferenceReads } from "../src/brain/reference-read";
import { registerReferenceWrites } from "../src/brain/reference-writes";
import { captureReferenceOwnerRoot, resolveReferenceOwners, type ReferenceOwnerResolution } from "../src/brain/reference-owner-resolution";
import type { ReferenceIdentityObservation } from "../src/brain/reference-acquisition";
import { heldWriter } from "./helpers/held-writer";
import type { ReferenceTransport } from "../src/brain/reference-transport";
import { referencePoolDouble } from "./helpers/reference-pool-double";
import { fixtureTls } from "./fixtures/fixture-tls";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const brain = "ithaca-brain", commit = "a".repeat(40), tree = "b".repeat(40);
const repositoryRule: TrustRule = { id: "ithaca", label: "Ithaca", incomingContent: true, recipientWhileRestricted: false,
  selector: { kind: "github_repository", host: "github.com", owner: "odysseus", repository: "ithaca", repositoryId: "101" } };
const ownerRule: TrustRule = { ...repositoryRule, id: "odysseus", selector: { kind: "github_owner", host: "github.com", owner: "odysseus", ownerId: "201" } };

async function fixture(worker = false) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-owner-resolution-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const policyPath = join(root, "context/policies/governance.md"); mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(policyPath, "---\nschema_version: 1\n---\nThe voyage policy.\n");
  const db = createUiDb(join(root, "ui.db")), writer = worker ? openSqliteWriter(db) : undefined;
  if (writer) registerReferenceWrites(db, writer);
  cleanup.push(async () => { await writer?.close(); db.close(); });
  const owner = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const other = createPrincipal(db, { authMethod: "password", label: "Telemachus", ttlSeconds: 3600 });
  const state = { owner: "odysseus", repository: "ithaca", ownerId: "201", repositoryId: "101", status: 200, private: false,
    afterBlob: async () => {}, current: true };
  const tls = fixtureTls(join(root, "tls"), ["api.github.com"]);
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    if (state.status !== 200) return new Response(null, { status: state.status });
    if (path.startsWith("/users/")) return Response.json({ id: state.ownerId, login: state.owner, type: "User",
      url: `https://api.github.com/users/${state.owner}`, html_url: `https://github.com/${state.owner}` });
    if (state.private && request.headers.get("authorization") !== "Bearer odysseus-fixture-token") return new Response(null, { status: 404 });
    return Response.json({ id: state.repositoryId, owner: { id: state.ownerId, login: state.owner }, name: state.repository,
      full_name: `${state.owner}/${state.repository}`, clone_url: `https://github.com/${state.owner}/${state.repository}.git`,
      url: `https://api.github.com/repos/${state.owner}/${state.repository}`, private: state.private });
  } }); cleanup.push(() => server.stop(true));
  const bytes = Buffer.from("Odysseus charts Ithaca on 2026-07-12.\n");
  const transport: ReferenceTransport = {
    async resolve() { return { ok: true, commit, ref: "refs/heads/main" }; },
    async fetch(input) { writeFileSync(join(input.root, "README.md"), bytes); writeFileSync(join(input.root, ".reference-commit"), commit); return { commit }; },
    async checkout() {}, async tree() { return tree; },
    async readBlob(input) { const range = bytes.subarray(input.offset, input.offset + input.maximum); await state.afterBlob();
      return { bytes: range, blob: "c".repeat(40), mode: "100644", tree, offset: input.offset, length: range.length,
        totalBytes: bytes.length, digest: createHash("sha256").update(range).digest("hex") }; },
  };
  const access = createGitHubReferenceAccess({ db, brain, credentials: { GITHUB_TOKEN: "odysseus-fixture-token" }, transport,
    wireTransport: { ca: readFileSync(tls.ca, "utf8"), lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (() => connect({ host: "127.0.0.1", port: server.port! })) as typeof connect } });
  const settingsOptions = { root, db, writer, lock: createKeyedLock(), github: createTrustGitHubIdentity({ root, access }),
    authority: (id: string) => id === owner.id ? "owner-epoch" : null, observe: async (_id: string, publish: () => void | Promise<void>) => { await publish(); } };
  const settings = createTrustSettings(settingsOptions);
  const change = async (change: unknown) => {
    const p = await settings.list(owner.id);
    return settings.prepare(owner.id, { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change });
  };
  const save = (draft: Awaited<ReturnType<typeof change>>) => settings.commit(owner.id, { version: 1, requestId: draft.receipt.requestId,
    reviewId: draft.review.reviewId, reviewedBytesHash: draft.review.reviewedBytesHash });
  const approve = async (rule = repositoryRule) => {
    const result = await save(await change({ action: "create", rule })); expect(result.receipt.publication).toBe("proved"); return result;
  };
  const pool = referencePoolDouble(join(root, "pool")), sources = createReferenceSources({ db, brain, pool, transport, github: access, credentials: { GITHUB_TOKEN: "odysseus-fixture-token" } });
  cleanup.push(() => sources.close());
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 16 * 1048576, observe() {} }); cleanup.push(() => egress.stop());
  const reads = createReferenceReads({ db, brain, brainPath: root, pool, sources, transport });
  let call = 0;
  const read = async (principalId = other.id) => {
    const toolCallId = `read-${++call}`;
    const result = await reads.read({ principalId, turnId: "reading-turn", toolCallId,
      request: { repository: `https://github.com/${state.owner}/${state.repository}.git`, revision: "main", path: "README.md", offset: 9, maximum: 13 },
      acquisition: { turnId: "reading-turn", egress, current: () => state.current } });
    const row = db.query("SELECT evidence,acquisition FROM reference_reads WHERE tool_call_id=?").get(toolCallId) as { evidence: string; acquisition: string };
    return { result, row, evidence: JSON.parse(row.evidence) as { trusted: false; ownerResolution: ReferenceOwnerResolution; identityObservation: ReferenceIdentityObservation } };
  };
  return { root, db, writer, owner, other, state, settings, settingsOptions, change, save, approve, read, reads, requests, policyPath, sources };
}

for (const worker of [false, true]) test(`protected publication binds an actual fresh managed read; writer=${worker}`, async () => {
  const f = await fixture(worker); await f.approve();
  const r = await f.read();
  expect(r.evidence.ownerResolution, "READ_BINDS_PUBLISHED_APPROVED_OWNER").toMatchObject({ version: 1, state: "available",
    operationId: r.evidence.identityObservation.operationId, bindings: [{ ruleId: "ithaca", selector: repositoryRule.selector,
      approvedOwnerId: "201", sameOwnerRenameRevalidated: false }] });
  expect(r.evidence.ownerResolution.bindings[0]!.publicationProofHash).toMatch(/^[a-f0-9]{64}$/);
  expect(r.evidence.trusted).toBe(false);
  expect(JSON.stringify(r.result)).not.toContain("ownerResolution");
});

for (const scenario of ["rename", "transfer", "name-reuse", "namespace-reuse"]) test(`fresh metadata handles ${scenario} under the approved owner`, async () => {
  const f = await fixture(); await f.approve(); const original = await f.read();
  if (scenario === "rename") f.state.repository = "nostos";
  if (scenario === "transfer") { f.state.owner = "circe"; f.state.ownerId = "202"; }
  if (scenario === "name-reuse") f.state.repositoryId = "102";
  if (scenario === "namespace-reuse") f.state.ownerId = "202";
  const r = await f.read();
  expect(r.evidence.ownerResolution.state, "APPROVED_OWNER_FENCES_TRANSFER_AND_REUSE").toBe(scenario === "rename" ? "available" : "unavailable");
  expect(r.evidence.ownerResolution.bindings).toHaveLength(scenario === "rename" ? 1 : 0);
  if (scenario === "rename") expect(r.evidence.ownerResolution.bindings[0]!.sameOwnerRenameRevalidated).toBe(true);
  expect(JSON.parse(original.row.evidence).ownerResolution.bindings[0].selector).toEqual(repositoryRule.selector);
});

test("owner approval includes future repositories only in the same current namespace and stable owner", async () => {
  const f = await fixture(); await f.approve(ownerRule);
  f.state.repository = "fleet"; f.state.repositoryId = "103";
  expect((await f.read()).evidence.ownerResolution.bindings[0]!.ruleId).toBe("odysseus");
  f.state.ownerId = "202";
  expect((await f.read()).evidence.ownerResolution.bindings).toEqual([]);
});

test("equal bytes and prepared metadata cannot create approved-owner evidence", async () => {
  const f = await fixture(), draft = await f.change({ action: "create", rule: repositoryRule });
  writeFileSync(f.policyPath, draft.review.proposed); await f.settings.snapshot();
  expect((await f.read()).evidence.ownerResolution.bindings, "PREPARED_IDENTITY_IS_NOT_OWNER_APPROVAL").toEqual([]);
});

for (const failure of ["missing", "malformed", "wrong-brain", "changed-identity", "future-revision"]) test(`a ${failure} publication proof stays unavailable`, async () => {
  const f = await fixture(); await f.approve();
  const row = f.db.query("SELECT proof FROM trust_settings_github_boundaries").get() as { proof: string };
  const proof = JSON.parse(row.proof);
  if (failure === "missing") f.db.exec("DELETE FROM trust_settings_github_boundaries");
  else {
    if (failure === "wrong-brain") proof.brain = "a".repeat(64);
    if (failure === "changed-identity") proof.githubIdentity.ownerId = "202";
    if (failure === "future-revision") { proof.expectedTrustRevision = "99"; proof.publishedTrustRevision = "100"; }
    f.db.query("UPDATE trust_settings_github_boundaries SET proof=?").run(failure === "malformed" ? "{}" : JSON.stringify(proof));
  }
  expect((await f.read()).evidence.ownerResolution.bindings, "UNPROVED_OWNER_BOUNDARY_NEVER_QUALIFIES").toEqual([]);
});

test("receipt pruning and a fresh settings reader preserve durable approval; removal affects only later reads", async () => {
  const f = await fixture(true); await f.approve(); const earlier = await f.read();
  f.db.exec("DELETE FROM trust_settings_operations");
  const restarted = createTrustSettings(f.settingsOptions); await restarted.snapshot();
  expect((await f.read()).evidence.ownerResolution.bindings).toHaveLength(1);
  await f.save(await f.change({ action: "remove", ruleId: "ithaca" }));
  expect((await f.read()).evidence.ownerResolution.bindings).toEqual([]);
  const historical = f.db.query("SELECT evidence FROM reference_reads WHERE tool_call_id='read-1'").get() as { evidence: string };
  expect(JSON.parse(historical.evidence).ownerResolution).toEqual(earlier.evidence.ownerResolution);
});

test("a policy removal while the blob reader waits cannot retain owner qualification", async () => {
  const f = await fixture(true); await f.approve();
  f.state.afterBlob = async () => { await f.save(await f.change({ action: "remove", ruleId: "ithaca" })); };
  const r = await f.read();
  expect(r.result.ok).toBe(true);
  expect(r.evidence.ownerResolution.bindings, "OWNER_RESOLUTION_RECHECKS_AFTER_READ_WAITS").toEqual([]);
});

test("failed fresh metadata withholds new reads rather than borrowing approved cached identity", async () => {
  const f = await fixture(); await f.approve(); await f.read();
  f.state.status = 500;
  await expect(f.read()).rejects.toBeInstanceOf(Error);
  expect(f.db.query("SELECT count(*) n FROM reference_reads").get()).toEqual({ n: 1 });
});


test("independent owner and repository publications retain both bounded bindings after other policy edits", async () => {
  const f = await fixture(); await f.approve(); const first = await f.read(); await f.approve(ownerRule);
  const r = await f.read();
  expect(r.evidence.ownerResolution.bindings.map(b => b.ruleId).sort()).toEqual(["ithaca", "odysseus"]);
  expect(r.evidence.ownerResolution.policyHash).not.toBe(first.evidence.ownerResolution.policyHash);
  expect(r.evidence.ownerResolution.bindings.find(b => b.ruleId === "ithaca")!.publicationProofHash)
    .toBe(first.evidence.ownerResolution.bindings[0]!.publicationProofHash);
});

for (const change of ["invalid", "symlink", "selector", "projection"]) test(`a ${change} policy boundary cannot qualify reads`, async () => {
  const f = await fixture(); await f.approve();
  const previous = readFileSync(f.policyPath, "utf8");
  if (change === "invalid") writeFileSync(f.policyPath, "---\nschema_version: 9000\n---\n");
  if (change === "selector") { writeFileSync(f.policyPath, previous.replace('"repositoryId":"101"', '"repositoryId":"102"')); await f.settings.snapshot(); }
  if (change === "projection") f.db.query("UPDATE trust_settings_projection SET rules='[]'").run();
  if (change === "symlink") {
    renameSync(f.policyPath, f.policyPath + ".saved");
    const { symlinkSync } = await import("node:fs"); symlinkSync(f.policyPath + ".saved", f.policyPath);
  }
  expect((await f.read()).evidence.ownerResolution.state, "POLICY_BOUNDARY_UNKNOWN_NEVER_QUALIFIES").toBe("unavailable");
});

test("replacing the configured policy root cannot borrow the previous directory's approval", async () => {
  const f = await fixture(); await f.approve(); const r = await f.read(), bound = captureReferenceOwnerRoot(f.root)!;
  const policy = readFileSync(f.policyPath), backup = f.root + "-old";
  renameSync(f.root, backup);
  try {
    mkdirSync(join(f.root, "context/policies"), { recursive: true }); writeFileSync(f.policyPath, policy);
    expect(resolveReferenceOwners(f.db, bound, r.evidence.identityObservation).bindings, "OWNER_APPROVAL_IS_BOUND_TO_HOST_BRAIN_ROOT").toEqual([]);
  } finally { rmSync(f.root, { recursive: true, force: true }); renameSync(backup, f.root); }
});

test("a queued writer resolves current approval rather than a pre-wait snapshot", async () => {
  const f = await fixture(true); await f.approve();
  const control = await heldWriter(f.writer!, join(f.root, "ui.db"));
  let observed = false;
  f.state.afterBlob = async () => { await control.hold(); observed = true; };
  const posted = control.posted("referenceReadPrepare"), pending = f.read();
  try {
    await posted; expect(observed).toBe(true);
    // Simulate the already committed projection/boundary side of a concurrent
    // protected removal while this writer waits. The policy changes too.
    const current = readFileSync(f.policyPath, "utf8");
    const removed = current.replace(/"trusted_sources":\s*\[[^\n]*\]/u, '"trusted_sources":[]');
    writeFileSync(f.policyPath, removed);
    control.elsewhere(db => { db.exec("DELETE FROM trust_settings_github_boundaries"); });
    control.release();
    expect((await pending).evidence.ownerResolution.bindings, "OWNER_APPROVAL_RECHECKS_IN_ACQUIRED_WRITER").toEqual([]);
  } finally { await control.close(); await pending.catch(() => {}); }
});


test("a reviewed label edit retains approval and approval does not depend on a retained owner login", async () => {
  const f = await fixture(); await f.approve();
  await f.save(await f.change({ action: "edit", rule: { ...repositoryRule, label: "The home harbor" } }));
  f.db.query("DELETE FROM principals WHERE id=?").run(f.owner.id);
  expect((await f.read()).evidence.ownerResolution.bindings).toHaveLength(1);
});

test("a reopened database reconstructs qualification from retained boundary evidence", async () => {
  const f = await fixture(); await f.approve(); const observed = await f.read();
  f.db.exec("DELETE FROM trust_settings_operations");
  const reopened = createUiDb(join(f.root, "ui.db"));
  try {
    const resolved = resolveReferenceOwners(reopened, captureReferenceOwnerRoot(f.root), observed.evidence.identityObservation);
    expect(resolved, "OWNER_RESOLUTION_SURVIVES_DATABASE_REOPEN").toEqual(observed.evidence.ownerResolution);
    const history = reopened.query("SELECT evidence FROM reference_reads").get() as { evidence: string };
    expect(JSON.parse(history.evidence).ownerResolution).toEqual(resolved);
  } finally { reopened.close(); }
});


test("approved ownership grants no private access and cannot outlive private-grant revocation", async () => {
  const f = await fixture(true); await f.approve(); await f.read();
  f.state.private = true;
  const denied = await f.read().then(() => null, error => error);
  expect(denied, "OWNER_APPROVAL_NEVER_GRANTS_PRIVATE_CREDENTIAL_ACCESS").toBeInstanceOf(Error);
  const grant = createReferenceGrant(f.db, { brain, principalId: f.other.id, createdBy: f.owner.id,
    repositoryPrefix: "https://github.com/odysseus/ithaca", credential: "GITHUB_TOKEN",
    metadataCredentialRecipient: "https://api.github.com", now: Date.now() });
  expect((await f.read()).evidence.ownerResolution.bindings).toHaveLength(1);
  f.state.afterBlob = async () => { revokeReferenceGrant(f.db, { brain, principalId: f.other.id, id: grant.id, now: Date.now() }); };
  const revoked = await f.read().then(() => null, error => error);
  expect(revoked, "OWNER_APPROVAL_CANNOT_OVERRIDE_LIVE_PRIVATE_REVOCATION").toBeInstanceOf(Error);
  expect(f.db.query("SELECT count(*) n FROM reference_reads").get()).toEqual({ n: 2 });
});
