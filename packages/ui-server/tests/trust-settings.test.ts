import { createGovernancePolicyReader } from "../src/brain/governance-policy.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createKeyedLock, BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { createTrustSettings } from "../src/brain/trust-settings.js";
import { createTrustSettingsRoutes } from "../src/routes/trust-settings.js";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { authGuard, authRoutes, type AuthRuntime } from "../src/middleware/auth.js";
import { resolveServerConfig } from "../src/config/env.js";
import { resolvePrincipal, isUsablePrincipal } from "../src/db/principals.js";
import type { AppEnv } from "../src/app-env.js";
import { connect } from "node:net";
import { fixtureTls } from "./fixtures/fixture-tls.js";
import { createGitHubReferenceAccess } from "../src/brain/github-reference-access.js";
import { createTrustGitHubIdentity } from "../src/brain/trust-github-identity.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const initial = "---\nschema_version: 1\n# Keep ordinary configuration\nprofiles: {interactive: governed}\nbudgets: {turn: {block_usd: 17}}\n---\nThe voyage policy.\n";
const rule = { id: "ithaca", label: "Ithaca", incomingContent: true, recipientWhileRestricted: false,
  selector: { kind: "web_origin" as const, scheme: "https" as const, host: "example.org", port: 443 } };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(patch: Partial<Parameters<typeof createTrustSettings>[0]> = {}) {
  const scratch = join(import.meta.dir, "../../../tmp/trust-settings-tests"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context/policies"), { recursive: true }); const path = join(root, "context/policies/governance.md"); writeFileSync(path, initial);
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db); cleanup.push(async () => { await writer.close(); db.close(); });
  const lock = createKeyedLock(); let auth: string | null = "owner-epoch"; const observations: string[] = [];
  const options = { root, db, writer, lock, authority: (id: string) => id === "odysseus" ? auth : null,
    observe: async (id: string, publish: () => void | Promise<void>) => { observations.push(id); await publish(); }, ...patch };
  const settings = createTrustSettings(options);
  const prepare = async (change: unknown = { action: "create", rule }) => { const p = await settings.list("odysseus");
    return settings.prepare("odysseus", { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change }); };
  const commit = (p: Awaited<ReturnType<typeof prepare>>, change = {}) => settings.commit("odysseus", { version: 1, requestId: p.receipt.requestId,
    reviewId: p.review.reviewId, reviewedBytesHash: p.review.reviewedBytesHash, ...change });
  return { root, path, db, writer, lock, settings, options, prepare, commit, observations, revoke: () => { auth = null; } };
}
test("real descriptor CRUD is exact, durable and creates no agent turn; readback reflects another device removal", async () => {
  const f = await fixture(), draft = await f.prepare();
  expect(draft.review.base).toBe(initial); expect(draft.review.proposed).toContain("# Keep ordinary configuration");
  const saved = await f.commit(draft); expect(saved.receipt.publication).toBe("proved"); expect(saved.receipt.enforcement).toBe("unavailable");
  expect(saved.receipt.currentRule).toBe("present"); expect(readFileSync(f.path, "utf8")).toBe(draft.review.proposed);
  const edit = await f.prepare({ action: "edit", rule: { ...rule, label: "The home harbor", recipientWhileRestricted: true } }); await f.commit(edit);
  expect((await f.settings.list("odysseus")).origins[0]!.recipientWhileRestricted).toBe(true);
  const remove = await f.prepare({ action: "remove", ruleId: rule.id }); await f.commit(remove);
  expect((await f.settings.read("odysseus", draft.receipt.requestId)).receipt.currentRule).toBe("removed");
  expect((await f.commit(draft)).receipt.currentRule).toBe("removed"); expect(f.observations).toHaveLength(3);
  expect(f.db.query("SELECT count(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) n FROM policy_proposals").get()).toEqual({ n: 0 });
  expect((await f.settings.list("odysseus")).capabilities.repositoryRules).toBe(false);
});
for (const stage of ["writing", "file_published"]) test(`readback waiting on a ${stage} commit returns its completed durable receipt`, async () => {
  let ready!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ checkpoint: async value => { if (value === stage) { ready(); await held; } } }), draft = await f.prepare();
  const pendingCommit = f.commit(draft);
  try {
    await reached;
    const pendingRead = f.settings.read("odysseus", draft.receipt.requestId);
    release();
    const [read, committed] = await Promise.all([pendingRead, pendingCommit]);
    expect(read.receipt, "SETTINGS_READ_AFTER_LOCK_USES_COMPLETED_DURABLE_RECEIPT").toEqual(committed.receipt);
    expect(read.receipt.publication).toBe("proved");
  } finally { release(); await pendingCommit.catch(() => {}); }
});

test("changed request, foreign principal, arbitrary handles and expired reviews cannot replay", async () => {
  let now = 1000; const f = await fixture({ now: () => now }), draft = await f.prepare();
  await expect(f.commit(draft, { reviewedBytesHash: "a".repeat(64) })).rejects.toThrow("request_conflict");
  await expect(f.settings.read("telemachus", draft.receipt.requestId)).rejects.toThrow("unauthorized");
  await expect(f.commit(draft, { requestId: "forged" })).rejects.toThrow("unavailable");
  now += 900001; await expect(f.commit(draft)).rejects.toThrow("request_expired");
  expect((await f.settings.read("odysseus", draft.receipt.requestId)).review.proposed).toBe(draft.review.proposed);
  expect(readFileSync(f.path, "utf8")).toBe(initial);
});
for (const race of ["bytes", "symlink", "ancestor", "inode", "revoke"] as const) test(`last publication check refuses ${race} after an async observation wait`, async () => {
  let mutate = () => {}; const f = await fixture({ observe: async (_id, publish) => { await Promise.resolve(); mutate(); publish(); } });
  const draft = await f.prepare(); let held: number | undefined;
  mutate = () => {
    if (race === "revoke") f.revoke();
    else if (race === "bytes") writeFileSync(f.path, initial + "Other tab.\n");
    else if (race === "ancestor") { renameSync(join(f.root, "context"), join(f.root, "previous")); symlinkSync(join(f.root, "previous"), join(f.root, "context")); }
    else { held = openSync(f.path, constants.O_RDONLY); renameSync(f.path, join(f.root, "previous.md"));
      if (race === "symlink") symlinkSync(join(f.root, "previous.md"), f.path); else writeFileSync(f.path, initial); }
  };
  try { const result = race === "revoke" ? await f.commit(draft).catch(e => e) : await f.commit(draft);
    if (race !== "revoke") expect(result.receipt.publication).toBe("not_published");
    else expect(result.message).toBe("unauthorized");
    expect(readFileSync(f.path, "utf8")).toBe(race === "bytes" ? initial + "Other tab.\n" : initial);
  } finally { if (held !== undefined) closeSync(held); }
});
test("lock waits recheck authority and base; competing drafts retain exact diffs", async () => {
  const f = await fixture(), a = await f.prepare(), b = await f.prepare({ action: "create", rule: { ...rule, id: "troy", selector: { ...rule.selector, host: "example.net" } } });
  const release = await f.lock.acquire(BRAIN_LOCK_KEY); const pending = f.commit(a); writeFileSync(f.path, initial + "Outside edit.\n"); release();
  expect((await pending).receipt.reason).toBe("stale_base"); expect((await f.commit(b)).receipt.publication).toBe("not_published");
  expect((await f.settings.read("odysseus", b.receipt.requestId)).review.proposed).toBe(b.review.proposed);
});
test("only trust revision is live; ordinary policy and invalid last-valid trust remain honest", async () => {
  const f = await fixture(), reader = createGovernancePolicyReader(f.root), ordinary = reader.load(), admitted = structuredClone(await f.settings.snapshot()), draft = await f.prepare(); await f.commit(draft);
  const next = await f.settings.snapshot(); expect(next.revision).not.toBe(admitted.revision); expect(admitted.rules).toEqual([]);
  writeFileSync(f.path, readFileSync(f.path, "utf8").replace("block_usd: 17", "block_usd: 19"));
  expect((await f.settings.snapshot()).revision).toBe(next.revision);
  expect(ordinary.policy.budgets.turn.block_usd).toBe(17); expect(reader.load().policy.budgets.turn.block_usd).toBe(19);
  writeFileSync(f.path, "invalid"); const invalid = await f.settings.snapshot(); expect(invalid.rules).toEqual(next.rules); expect(invalid.error).toBe("policy_unavailable");
});
test("exhausted trust revisions refuse new reviews before reserving or publishing policy", async () => {
  const f = await fixture(); await f.settings.snapshot();
  f.db.exec("UPDATE trust_settings_projection SET revision='18446744073709551615'");
  let error: unknown; try { await f.prepare(); } catch (caught) { error = caught; }
  expect((error as Error)?.message, "TRUST_REVISION_EXHAUSTION_BEFORE_REVIEW").toBe("capacity");
  expect(f.db.query("SELECT count(*) n FROM trust_settings_operations").get()).toEqual({ n: 0 });
  expect(f.observations).toEqual([]); expect(readFileSync(f.path, "utf8")).toBe(initial);
});
test("a previously prepared exhausted-revision review cannot publish before failing capacity", async () => {
  const f = await fixture(), draft = await f.prepare();
  const row = f.db.query("SELECT payload FROM trust_settings_operations WHERE request_id=?").get(draft.receipt.requestId) as { payload: string };
  const payload = JSON.parse(row.payload); payload.input.expectedTrustRevision = "18446744073709551615";
  f.db.query("UPDATE trust_settings_operations SET payload=? WHERE request_id=?").run(JSON.stringify(payload), draft.receipt.requestId);
  f.db.exec("UPDATE trust_settings_projection SET revision='18446744073709551615'");
  const result = await f.commit(draft).catch(error => ({ error }));
  expect(readFileSync(f.path, "utf8"), "TRUST_REVISION_EXHAUSTION_BEFORE_PUBLICATION").toBe(initial);
  expect(f.observations).toEqual([]);
  expect("receipt" in result && result.receipt.publication).toBe("not_published");
  expect("receipt" in result && result.receipt.reason).toBe("capacity");
});
for (const stage of ["writing", "renamed", "file_published", "committed"]) test(`real process death at ${stage} never guesses publication or republishes`, async () => {
  const f = await fixture(), draft = await f.prepare(); await Bun.write(join(f.root, "request.json"), JSON.stringify(draft.review));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/trust-settings-crash.ts"), f.root, stage, draft.receipt.requestId], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect({ code, stderr }).toEqual({ code: 77, stderr: "" });
  const recovered = createTrustSettings(f.options), result = await recovered.read("odysseus", draft.receipt.requestId);
  expect(result.receipt.publication).toBe(["writing", "renamed"].includes(stage) ? "unknown" : "proved");
  // Equal bytes planted after a pre-publication death cannot establish its proof.
  writeFileSync(f.path, draft.review.proposed);
  const replay = await recovered.commit("odysseus", { version: 1, requestId: draft.receipt.requestId, reviewId: draft.review.reviewId, reviewedBytesHash: draft.review.reviewedBytesHash });
  expect(replay.receipt.publication).toBe(result.receipt.publication); expect(f.observations).toHaveLength(0);
});
test("prepare and terminal write failures publish nothing or retain unknown, never replay", async () => {
  const f = await fixture(); f.db.exec("CREATE TRIGGER reject_prepare BEFORE INSERT ON trust_settings_operations BEGIN SELECT RAISE(ABORT,'write failed'); END");
  await expect(f.prepare()).rejects.toThrow("write failed"); expect(readFileSync(f.path, "utf8")).toBe(initial);
  f.db.exec("DROP TRIGGER reject_prepare"); const draft = await f.prepare();
  f.db.exec("CREATE TRIGGER reject_proof BEFORE UPDATE ON trust_settings_operations WHEN NEW.proof IS NOT NULL BEGIN SELECT RAISE(ABORT,'proof failed'); END");
  expect((await f.commit(draft)).receipt.publication).toBe("unknown"); expect((await f.commit(draft)).receipt.publication).toBe("unknown"); expect(f.observations).toHaveLength(1);
});
test("outstanding capacity and unsupported repository identities refuse before publication", async () => {
  const f = await fixture();
  for (let n = 0; n < 32; n++) await f.prepare();
  let capacity: unknown; try { await f.prepare(); } catch (error) { capacity = error; } expect((capacity as Error)?.message).toBe("capacity"); expect(f.observations).toEqual([]);
  let unavailable: unknown; try { await f.prepare({ action: "create", rule: { ...rule, selector: { kind: "github_owner", host: "github.com", owner: "odysseus", ownerId: "1" } } }); } catch (error) { unavailable = error; }
  expect((unavailable as Error)?.message).toBe("repository_identity_unavailable");
});
test("real HTTP login/owner/CSRF boundary rejects ambient, agent, forged-card and revoked commits", async () => {
  const f = await fixture(), password = "ithaca-harbor-test", secret = "fictional-cookie-secret-for-ithaca-tests";
  const config = resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password), COOKIE_SECRET: secret });
  const auth: AuthRuntime = { ...config.auth, host: "127.0.0.1" };
  let mode: "password" | "none" = "password";
  const settings = createTrustSettings({ ...f.options, authority: id => {
    const p = resolvePrincipal(f.db, id);
    return mode === "password" && p?.kind === "owner" && isUsablePrincipal(p, Date.now()) ? JSON.stringify([p.id, p.createdAt, p.expiresAt]) : null;
  } });
  const app = new Hono<AppEnv>(); app.route("/api", authRoutes("password", auth, { db: f.db, revoker: { revokePrincipals() {} } }));
  app.use("/api/*", async (c, next) => authGuard(mode, auth, f.db)(c, next));
  app.route("/api", createTrustSettingsRoutes({ settings, trustProxy: false }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }); cleanup.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  expect(response.status).toBe(200); const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const request = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/trust-settings${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json", origin: base, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const p = await (await request("")).json() as { revision: string; policyHash: string | null };
  const body = { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change: { action: "create", rule } };
  expect((await request("/prepare", body, { origin: "" })).status).toBe(403);
  expect((await request("/prepare", body, { origin: "https://example.net", "sec-fetch-site": "same-origin" })).status).toBe(403);
  expect((await request("/prepare", { ...body, principalId: "odysseus", channel: "card" })).status).toBe(400);
  const preparedResponse = await request("/prepare", body); expect(preparedResponse.status).toBe(200);
  const draft = await preparedResponse.json() as Awaited<ReturnType<typeof f.prepare>>;
  const commit = { version: 1, requestId: draft.receipt.requestId, reviewId: draft.review.reviewId, reviewedBytesHash: draft.review.reviewedBytesHash };
  mode = "none"; expect((await request("/commit", commit)).status).toBe(403); mode = "password";
  f.db.exec("UPDATE principals SET kind='agent'"); expect((await request("/commit", commit)).status).toBe(403);
  f.db.exec("UPDATE principals SET kind='owner',revoked_at=1"); expect((await request("/commit", commit)).status).toBe(401);
  expect(readFileSync(f.path, "utf8")).toBe(initial); expect(p.policyHash).toBe(hash(initial));
});
test("real journal observes a Settings operation as user policy without fabricating a turn", async () => {
  const f = await fixture(), objects = mkdtempSync(join(f.root, "../objects-")); cleanup.push(() => rmSync(objects, { recursive: true, force: true }));
  const native = createNativeJournalFixture(f.root, objects); cleanup.push(() => native.close());
  const journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: f.root, dbPath: join(f.root, "ui.db"), objectsRoot: objects }); cleanup.push(() => journal.close());
  const settings = createTrustSettings({ ...f.options, observe: (id, write) => journal.observeSettingsPolicy(id, write) });
  const p = await settings.list("odysseus");
  const draft = await settings.prepare("odysseus", { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change: { action: "create", rule } });
  const saved = await settings.commit("odysseus", { version: 1, requestId: draft.receipt.requestId, reviewId: draft.review.reviewId, reviewedBytesHash: draft.review.reviewedBytesHash });
  expect(saved.receipt.publication).toBe("proved");
  expect(f.db.query("SELECT count(*) n FROM turn_journal_turns").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) n FROM policy_proposals").get()).toEqual({ n: 0 });
});
test("empty defaults prepare without side effects and publish missing policy ancestors", async () => {
  const f = await fixture(); rmSync(join(f.root, "context"), { recursive: true });
  const p = await f.settings.list("odysseus"); expect(p.rules).toEqual([]); expect(p.policyHash).toBeNull();
  const draft = await f.prepare(); expect(draft.review.base).toBeNull();
  expect(() => readFileSync(f.path)).toThrow();
  const recovered = createTrustSettings(f.options); expect((await recovered.read("odysseus", draft.receipt.requestId)).receipt.stage).toBe("prepared");
  expect((await f.commit(draft)).receipt.publication).toBe("proved");
});

test("real process death after prepared commit retains a readable draft and no file effect", async () => {
  const f = await fixture(), p = await f.settings.list("odysseus");
  await Bun.write(join(f.root, "request.json"), JSON.stringify({ input: { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change: { action: "create", rule } } }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/trust-settings-crash.ts"), f.root, "prepared", "unused"], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect({ code, stderr }).toEqual({ code: 77, stderr: "" });
  const row = f.db.query("SELECT request_id FROM trust_settings_operations").get() as { request_id: string };
  expect((await f.settings.read("odysseus", row.request_id)).receipt.stage).toBe("prepared");
  expect(readFileSync(f.path, "utf8")).toBe(initial);
});

const repositoryRule = { ...rule, id: "ithaca-source", selector: { kind: "github_repository" as const, host: "github.com" as const,
  owner: "odysseus", repository: "ithaca", repositoryId: "101" } };
const ownerRule = { ...rule, id: "ithaca-owner", selector: { kind: "github_owner" as const, host: "github.com" as const, owner: "odysseus", ownerId: "201" } };

async function githubFixture(patch: Partial<Parameters<typeof createTrustSettings>[0]> = {}) {
  const f = await fixture(), owner = createPrincipal(f.db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  const state = { owner: "odysseus", ownerId: "201", repository: "ithaca", repositoryId: "101", private: false, status: 200 };
  const requests: { path: string; authorization: string | null }[] = [];
  const tls = fixtureTls(join(f.root, "tls"), ["api.github.com"]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch(request) {
    const path = new URL(request.url).pathname, authorization = request.headers.get("authorization");
    requests.push({ path, authorization });
    if (state.status !== 200) return new Response(null, { status: state.status });
    if (path.startsWith("/users/")) return Response.json({ id: state.ownerId, login: state.owner, type: "User",
      url: `https://api.github.com/users/${state.owner}`, html_url: `https://github.com/${state.owner}` });
    if (state.private && !authorization) return new Response(null, { status: 404 });
    return Response.json({ id: state.repositoryId, owner: { id: state.ownerId, login: state.owner }, name: state.repository,
      full_name: `${state.owner}/${state.repository}`, clone_url: `https://github.com/${state.owner}/${state.repository}.git`,
      url: `https://api.github.com/repos/${state.owner}/${state.repository}`, private: state.private });
  } });
  cleanup.push(() => server.stop(true));
  const access = createGitHubReferenceAccess({ db: f.db, brain: "ithaca-brain", credentials: { GITHUB_TOKEN: "odysseus-fixture-token" },
    transport: { async resolve() { throw new Error("Settings cannot discover Git refs"); }, async fetch() { throw new Error("Settings cannot fetch Git"); },
      async checkout() { throw new Error("Settings cannot check out source"); } },
    wireTransport: { ca: readFileSync(tls.ca, "utf8"), lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: (() => connect({ host: "127.0.0.1", port: server.port! })) as typeof connect } });
  const github = createTrustGitHubIdentity({ root: f.root, access });
  const options = { ...f.options, github, authority: (id: string) => {
    const p = resolvePrincipal(f.db, id);
    return id === owner.id && p?.kind === "owner" && isUsablePrincipal(p, Date.now()) ? "owner-epoch" : null;
  }, ...patch };
  const settings = createTrustSettings(options);
  const prepare = async (change: unknown = { action: "create", rule: repositoryRule }) => {
    const p = await settings.list(owner.id);
    return settings.prepare(owner.id, { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change });
  };
  const commit = (draft: Awaited<ReturnType<typeof prepare>>) => settings.commit(owner.id, { version: 1, requestId: draft.receipt.requestId,
    reviewId: draft.review.reviewId, reviewedBytesHash: draft.review.reviewedBytesHash });
  const grant = () => createReferenceGrant(f.db, { brain: "ithaca-brain", principalId: owner.id, createdBy: owner.id,
    repositoryPrefix: "https://github.com/odysseus", credential: "GITHUB_TOKEN", metadataCredentialRecipient: "https://api.github.com", now: Date.now() });
  return { ...f, owner, options, settings, github, state, requests, prepare, commit, grant,
    childMetadata: { principalId: owner.id, port: server.port!, ca: tls.ca } };
}

for (const selected of [repositoryRule, ownerRule]) test(`actual TLS metadata and protected publication support ${selected.selector.kind} CRUD without a turn`, async () => {
  const f = await githubFixture();
  const pending = f.prepare({ action: "create", rule: selected }).then(draft => f.commit(draft));
  await expect(pending, "SETTINGS_GITHUB_CRUD_USES_HOST_METADATA_AND_REAL_PUBLICATION").resolves.toMatchObject({ receipt: { publication: "proved", currentRule: "present", enforcement: "unavailable" } });
  const saved = await pending, approval = await f.settings.repositoryApproval(selected.id);
  expect(approval, "SETTINGS_APPROVED_OWNER_COMES_FROM_PROVED_PUBLICATION").toMatchObject({
    identity: { selector: selected.selector, ownerId: "201" }, proof: { reviewedBytesHash: saved.review.reviewedBytesHash, principal: f.owner.id } });
  expect(saved.review.includesFutureRepositories).toBe(selected.selector.kind === "github_owner");
  expect(f.requests).toHaveLength(2); expect(f.requests.every(request => request.authorization === null)).toBe(true);
  const edited = await f.prepare({ action: "edit", rule: { ...selected, label: "The home harbor" } });
  expect((await f.commit(edited)).receipt.publication).toBe("proved");
  expect((await f.settings.read(f.owner.id, saved.receipt.requestId)).receipt.currentRule).toBe("changed");
  const observed = f.requests.length; f.state.status = 500;
  await f.commit(await f.prepare({ action: "remove", ruleId: selected.id }));
  expect(f.requests).toHaveLength(observed); expect(await f.settings.repositoryApproval(selected.id)).toBeNull();
  expect((await f.settings.read(f.owner.id, saved.receipt.requestId)).receipt.currentRule).toBe("removed");
  expect(f.db.query("SELECT count(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) n FROM policy_proposals").get()).toEqual({ n: 0 });
});

for (const change of ["repository_id", "owner_id", "rename", "transfer", "unavailable"] as const)
  test(`a reviewed repository cannot publish after ${change} metadata changes`, async () => {
    const f = await githubFixture(), draft = await f.prepare();
    expect(await f.settings.repositoryApproval(repositoryRule.id)).toBeNull();
    if (change === "repository_id") f.state.repositoryId = "102";
    else if (change === "owner_id") f.state.ownerId = "202";
    else if (change === "rename") f.state.repository = "fleet";
    else if (change === "transfer") f.state.owner = "penelope";
    else f.state.status = 500;
    const result = await f.commit(draft);
    expect(result.receipt.publication, "SETTINGS_METADATA_CHANGE_CANNOT_INHERIT_REVIEW").toBe("not_published");
    expect(readFileSync(f.path, "utf8")).toBe(initial); expect(await f.settings.repositoryApproval(repositoryRule.id)).toBeNull();
    expect(result.review.proposed).toBe(draft.review.proposed);
  });

test("a private Settings publication retains the actual selected grant through its final fence", async () => {
  const f = await githubFixture(); f.state.private = true; const grant = f.grant();
  const draft = await f.prepare();
  const settings = createTrustSettings({ ...f.options, github: { async resolve(input) {
    const observed = await f.github.resolve(input);
    revokeReferenceGrant(f.db, { brain: "ithaca-brain", principalId: f.owner.id, id: grant.id, now: Date.now() });
    return observed;
  } } });
  const result = await settings.commit(f.owner.id, { version: 1, requestId: draft.receipt.requestId, reviewId: draft.review.reviewId,
    reviewedBytesHash: draft.review.reviewedBytesHash });
  expect(result.receipt.publication, "SETTINGS_FINAL_GRANT_FENCE_PRECEDES_PROTECTED_PUBLICATION").toBe("not_published");
  expect(readFileSync(f.path, "utf8")).toBe(initial); expect(await f.settings.repositoryApproval(repositoryRule.id)).toBeNull();
  expect(f.requests.map(request => request.authorization)).toEqual([null, "Bearer odysseus-fixture-token", null, "Bearer odysseus-fixture-token"]);
});

test("equal policy bytes and prepared metadata are not approved-owner publication evidence", async () => {
  const f = await githubFixture(), draft = await f.prepare();
  writeFileSync(f.path, draft.review.proposed);
  expect((await f.settings.snapshot()).rules).toEqual([repositoryRule]);
  expect(await f.settings.repositoryApproval(repositoryRule.id), "SETTINGS_EQUAL_BYTES_DO_NOT_PROVE_OWNER_APPROVAL").toBeNull();
  expect((await f.commit(draft)).receipt.publication).toBe("not_published");
});

test("publication proof and owner-boundary recording commit atomically and survive operation pruning", async () => {
  const f = await githubFixture(), draft = await f.prepare();
  f.db.exec("CREATE TRIGGER reject_boundary BEFORE INSERT ON trust_settings_github_boundaries BEGIN SELECT RAISE(ABORT,'boundary failed'); END");
  const result = await f.commit(draft);
  expect(result.receipt.publication, "SETTINGS_BOUNDARY_FAILURE_RETAINS_UNKNOWN_PUBLICATION").toBe("unknown");
  expect(await f.settings.repositoryApproval(repositoryRule.id)).toBeNull();
  expect((await f.commit(draft)).receipt.publication).toBe("unknown");
  f.db.exec("DROP TRIGGER reject_boundary");
  const corrected = await f.prepare({ action: "edit", rule: { ...repositoryRule, label: "The home harbor" } });
  expect((await f.commit(corrected)).receipt.publication).toBe("proved");
  const before = await f.settings.repositoryApproval(repositoryRule.id); expect(before).not.toBeNull();
  f.db.exec("DELETE FROM trust_settings_operations");
  const restarted = createTrustSettings(f.options);
  expect(await restarted.repositoryApproval(repositoryRule.id), "SETTINGS_OWNER_APPROVAL_SURVIVES_BOUNDED_RECEIPT_PRUNING").toEqual(before);
});

test("an observer that never invokes its publication callback cannot manufacture proof", async () => {
  const f = await fixture({ observe: async () => {} }), draft = await f.prepare();
  expect((await f.commit(draft)).receipt.publication, "SETTINGS_MISSING_PUBLICATION_CALLBACK_IS_NOT_PROOF").toBe("not_published");
  expect(readFileSync(f.path, "utf8")).toBe(initial);
});

for (const stage of ["writing", "renamed", "file_published", "committed"])
  test(`GitHub owner-boundary recovery after real process death at ${stage} uses durable publication proof`, async () => {
    const f = await githubFixture(), draft = await f.prepare();
    writeFileSync(join(f.root, "request.json"), JSON.stringify(draft.review));
    writeFileSync(join(f.root, "github-fixture.json"), JSON.stringify(f.childMetadata));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/trust-settings-crash.ts"), f.root, stage, draft.receipt.requestId], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 77, stderr: "" });
    const recovered = createTrustSettings(f.options), result = await recovered.read(f.owner.id, draft.receipt.requestId);
    const proved = stage === "file_published" || stage === "committed";
    expect(result.receipt.publication).toBe(proved ? "proved" : "unknown");
    const approval = await recovered.repositoryApproval(repositoryRule.id);
    expect(approval !== null, "SETTINGS_CRASH_OWNER_APPROVAL_REQUIRES_DURABLE_PROOF").toBe(proved);
    if (proved) expect(approval).toMatchObject({ identity: { ownerId: "201", selector: repositoryRule.selector },
      proof: { reviewedBytesHash: draft.review.reviewedBytesHash, principal: f.owner.id } });
    const count = f.requests.length;
    expect((await f.commit(draft)).receipt.publication).toBe(result.receipt.publication);
    expect(f.requests, "SETTINGS_CRASH_REPLAY_NEVER_REPEATS_METADATA_OR_PUBLICATION").toHaveLength(count);
  });

test("metadata after a journal wait rechecks the live owner before touching the policy", async () => {
  let ready!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = await githubFixture({ observe: async (_id, publish) => { ready(); await held; await publish(); } }), draft = await f.prepare();
  const pending = f.commit(draft);
  try {
    await reached; revokePrincipal(f.db, f.owner.id, Date.now()); release();
    const rejected = await pending.then(() => null, error => error);
    expect(rejected, "SETTINGS_REVOKED_OWNER_AFTER_JOURNAL_WAIT_CANNOT_PUBLISH").toMatchObject({ message: "unauthorized" });
    expect(f.requests).toHaveLength(1); expect(readFileSync(f.path, "utf8")).toBe(initial);
    expect(f.db.query("SELECT count(*) n FROM trust_settings_github_boundaries").get()).toEqual({ n: 0 });
  } finally { release(); await pending.catch(() => {}); }
});

test("real HTTP GitHub Settings CRUD compares browser IDs with fresh host metadata", async () => {
  const f = await githubFixture(), password = "ithaca-settings-test", secret = "fictional-cookie-secret-for-ithaca-tests";
  const config = resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash(password), COOKIE_SECRET: secret });
  const auth: AuthRuntime = { ...config.auth, host: "127.0.0.1" };
  const settings = createTrustSettings({ ...f.options, authority: id => {
    const p = resolvePrincipal(f.db, id);
    return p?.kind === "owner" && isUsablePrincipal(p, Date.now()) ? "owner-epoch" : null;
  } });
  const app = new Hono<AppEnv>(); app.route("/api", authRoutes("password", auth, { db: f.db, revoker: { revokePrincipals() {} } }));
  app.use("/api/*", authGuard("password", auth, f.db));
  app.route("/api", createTrustSettingsRoutes({ settings, trustProxy: false }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }); cleanup.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  expect(login.status).toBe(200); const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const request = (path: string, body?: unknown) => fetch(`${base}/api/trust-settings${path}`, { method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json", origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const p = await (await request("")).json() as { revision: string; policyHash: string | null };
  const body = { version: 1, expectedTrustRevision: p.revision, expectedPolicyHash: p.policyHash, change: { action: "create", rule: repositoryRule } };
  const forged = await request("/prepare", { ...body, change: { action: "create", rule: { ...repositoryRule, selector: { ...repositoryRule.selector, repositoryId: "999" } } } });
  expect(forged.status, "SETTINGS_HTTP_BROWSER_ID_CANNOT_SELF_VERIFY").toBe(503);
  const prepared = await request("/prepare", body); expect(prepared.status).toBe(200);
  const draft = await prepared.json() as Awaited<ReturnType<typeof f.prepare>>;
  expect(draft.review.repositoryIdentity).toMatchObject({ ownerId: "201", selector: repositoryRule.selector });
  const committed = await request("/commit", { version: 1, requestId: draft.receipt.requestId, reviewId: draft.review.reviewId, reviewedBytesHash: draft.review.reviewedBytesHash });
  expect(committed.status).toBe(200); expect((await committed.json() as typeof draft).receipt.publication).toBe("proved");
  expect(f.requests).toHaveLength(3);
});

test("the actual journal retains its Settings window through asynchronous publication", async () => {
  const f = await fixture(), objects = mkdtempSync(join(f.root, "../objects-")); cleanup.push(() => rmSync(objects, { recursive: true, force: true }));
  const native = createNativeJournalFixture(f.root, objects); cleanup.push(() => native.close());
  const journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: f.root, dbPath: join(f.root, "ui.db"), objectsRoot: objects }); cleanup.push(() => journal.close());
  let ready!: () => void, release!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const first = journal.observeSettingsPolicy("ithaca-first", async () => { ready(); await held; });
  await reached;
  const second = journal.observeSettingsPolicy("ithaca-second", () => {});
  try {
    const result = await Promise.race([second.then(() => "advanced"), new Promise<string>(resolve => { timer = setTimeout(() => resolve("held"), 1000); })]);
    expect(result, "SETTINGS_JOURNAL_WINDOW_INCLUDES_ASYNC_PUBLICATION").toBe("held");
  } finally { if (timer) clearTimeout(timer); release(); await Promise.allSettled([first, second]); }
});

test("Settings HTTP admission bounds queued lock waiters and recovers when requests finish", async () => {
  const f = await githubFixture(), app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("principal", f.owner); await next(); });
  app.route("/api", createTrustSettingsRoutes({ settings: f.settings, trustProxy: false }));
  const release = await f.lock.acquire(BRAIN_LOCK_KEY);
  const pending = Array.from({ length: 32 }, () => app.request("http://localhost/api/trust-settings"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const excess = app.request("http://localhost/api/trust-settings");
  try {
    const result = await Promise.race([Promise.resolve(excess).then(response => response.status), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
    expect(result, "SETTINGS_HTTP_QUEUE_REFUSES_BEFORE_ANOTHER_LOCK_WAIT").toBe(503);
    expect(await (await excess).json()).toMatchObject({ code: "busy", retryable: true });
  } finally { if (timer) clearTimeout(timer); release(); await Promise.allSettled([...pending, excess]); }
  expect((await app.request("http://localhost/api/trust-settings")).status, "SETTINGS_HTTP_BUSY_CLEARS_WHEN_WAITERS_DRAIN").toBe(200);
  expect(f.requests).toEqual([]);
});
