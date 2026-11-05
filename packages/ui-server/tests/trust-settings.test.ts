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
    observe: async (id: string, publish: () => void) => { observations.push(id); publish(); }, ...patch };
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
