/**
 * The owner's Apify settings (#3163): the read Settings renders, and policy
 * edits through the existing policy-change review. A real governance file, a
 * real policy writer and a loopback fake of the fixed Apify API; tokens are
 * synthetic sentinels and nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { ApifySettingsRead } from "@schlessera/brain-ui-sdk/protocol";
import { parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import {
  createApifyAuthority, governanceApifyPolicy, type ApifyAuthority, type ApifyLedger, type ApifyRunRow,
} from "@schlessera/brain-common/internal/apify";
import type { AppEnv } from "../src/app-env.js";
import type { Principal } from "../src/db/principals.js";
import { createUiDb } from "../src/db/client.js";
import { createPolicyProposals } from "../src/brain/policy-proposal.js";
import { createApifyRoutes } from "../src/routes/apify.js";
import {
  ApifySettingsError, createApifyPolicyEdits, editApifyPolicy, readApifySpend, type ApifySettingsJournal,
} from "../src/apify/settings.js";

const SENTINEL = "apify_api_ODYSSEUS_SENTINEL_settings_4b3a";
const SUITORS = "apify_api_ODYSSEUS_SENTINEL_suitors_settings_1f2e";
const ACCOUNTS: Record<string, { id: string; username: string }> = {
  [SENTINEL]: { id: "IthacaHousehold01", username: "penelope" },
  [SUITORS]: { id: "SuitorsHall02", username: "antinous" },
};
const GRANT = {
  account_id: "IthacaHousehold01", actor_id: "HarborNotices01", build_number: "1.4.12", profile_id: "ithaca.harbor-notices@3",
  schema_sha256: "a".repeat(64), pricing_sha256: "b".repeat(64), origins: ["https://harbor.ithaca.example"],
  expires_at: "2026-08-12T00:00:00.000Z", max_run_usd: 0.8,
};
const OLD_GRANT = { ...GRANT, actor_id: "SeaCharts01", build_number: "2.0.1", expires_at: "2026-07-01T00:00:00.000Z" };
const POLICY = `---
schema_version: 1
# Odysseus keeps the household budget tight.
budgets:
  turn: { warn_usd: 2, block_usd: 4 }
apify:
  enabled: true
  discovery: ask
  actors: ask
  actor_grants:
    - account_id: IthacaHousehold01
      actor_id: HarborNotices01
      build_number: "1.4.12"
      profile_id: ithaca.harbor-notices@3
      schema_sha256: "${"a".repeat(64)}"
      pricing_sha256: "${"b".repeat(64)}"
      origins: ["https://harbor.ithaca.example"]
      expires_at: 2026-08-12T00:00:00Z
      max_run_usd: 0.8
    - account_id: IthacaHousehold01
      actor_id: SeaCharts01
      build_number: "2.0.1"
      profile_id: ithaca.harbor-notices@3
      schema_sha256: "${"a".repeat(64)}"
      pricing_sha256: "${"b".repeat(64)}"
      origins: ["https://harbor.ithaca.example"]
      expires_at: 2026-07-01T00:00:00Z
      max_run_usd: 0.8

# Providers stay with the household.
providers: []
---
Odysseus decides what leaves Ithaca.
`;
const NOW = Date.parse("2026-07-12T09:00:00Z");

let brain: string;
let path: string;
let token: string | undefined;
let stored: unknown;
let fake: { origin: string; seen: string[]; stop(): void };
const cleanup: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  brain = mkdtempSync(join(tmpdir(), "apify-settings-"));
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  path = join(brain, "context/policies/governance.md");
  writeFileSync(path, POLICY);
  token = SENTINEL; stored = undefined;
  const seen: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(new URL(request.url).pathname);
    const account = ACCOUNTS[request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""];
    if (!account) return Response.json({ error: { type: "token-not-valid" } }, { status: 401 });
    return Response.json({ data: { ...account, email: "penelope@ithaca.example" } });
  } });
  fake = { origin: `http://127.0.0.1:${server.port}`, seen, stop: () => { void server.stop(true); } };
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  fake.stop();
  rmSync(brain, { recursive: true, force: true });
});

function authority(): ApifyAuthority {
  return createApifyAuthority({ policy: governanceApifyPolicy(brain), token: () => token, origin: fake.origin,
    store: { read: () => stored === undefined ? null : structuredClone(stored), write: record => { stored = structuredClone(record); } } });
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The real policy writer, with a journal that admits a write only inside a begun user window, as the real one does. */
function writer(authorized: () => boolean = () => true) {
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  const windows: string[] = [], active = new Set<string>(), finished: string[] = [];
  const journal: ApifySettingsJournal = {
    async begin(turnId, metadata) { expect(metadata.actor).toBe("user"); active.add(turnId); windows.push(turnId); },
    async finish(turnId) { active.delete(turnId); finished.push(turnId); },
  };
  const proposals = createPolicyProposals({ root: brain, db, lock: createKeyedLock(),
    observeUserPolicy: (turnId, write) => {
      if (!active.has(turnId)) throw new Error("approved policy write requires an active complete observation window");
      write();
    },
    recordEvent: () => undefined });
  const edits = createApifyPolicyEdits({ root: brain, proposals, journal, authorized: () => authorized() });
  cleanup.push(() => edits.close());
  return { edits, proposals, windows, finished };
}

describe("editing the apify block", () => {
  test("replaces only the apify lines; every other byte, comment and the body stay", () => {
    const next = editApifyPolicy(POLICY, { discovery: "allow" });
    const [before, after] = [POLICY.split("apify:")[0], next.split("apify:")[0]];
    expect(after).toBe(before);
    expect(next).toContain("# Providers stay with the household.\nproviders: []\n---\nOdysseus decides what leaves Ithaca.\n");
    const parsed = parseGovernancePolicy(Buffer.from(next));
    expect(parsed.ok).toBe(true);
    expect(parsed.effective.apify.discovery).toBe("allow");
    expect(parsed.effective.apify.actors).toBe("ask");
    expect(parsed.effective.apify.actor_grants).toHaveLength(2);
    expect(parsed.effective.budgets.turn.block_usd).toBe(4);
  });

  test("adds a block to a policy without one, and creates a minimal policy when none exists", () => {
    const bare = "---\nschema_version: 1\n---\nBody.\n";
    expect(editApifyPolicy(bare, { enabled: true })).toBe("---\nschema_version: 1\napify:\n  enabled: true\n---\nBody.\n");
    const created = editApifyPolicy(null, { enabled: true });
    expect(parseGovernancePolicy(Buffer.from(created)).effective.apify.enabled).toBe(true);
  });

  test("revoking removes exactly the named grant", () => {
    const next = editApifyPolicy(POLICY, { remove_grant: { account_id: OLD_GRANT.account_id, actor_id: OLD_GRANT.actor_id,
      build_number: OLD_GRANT.build_number, profile_id: OLD_GRANT.profile_id, expires_at: OLD_GRANT.expires_at } });
    const grants = parseGovernancePolicy(Buffer.from(next)).effective.apify.actor_grants;
    expect(grants.map(grant => grant.actor_id)).toEqual(["HarborNotices01"]);
    expect(() => editApifyPolicy(POLICY, { remove_grant: { ...GRANT, build_number: "1.4.13", account_id: GRANT.account_id, actor_id: GRANT.actor_id,
      profile_id: GRANT.profile_id, expires_at: GRANT.expires_at } })).toThrow("no longer in the policy");
  });

  test("a layout it cannot rewrite exactly proposes nothing", () => {
    const flow = "---\nschema_version: 1\napify: &a { enabled: true }\nother: *a\n---\n";
    expect(() => editApifyPolicy(flow, { enabled: false })).toThrow(ApifySettingsError);
    expect(() => editApifyPolicy(POLICY, { actors: "ask" })).toThrow("already says this");
  });
});

describe("policy edits through the existing review", () => {
  test("a control proposes the exact review; nothing is written until the owner approves it (APIFY_SETTINGS_NO_EARLY_APPLY)", async () => {
    const { edits, windows, finished } = writer();
    const proposal = await edits.propose("p-penelope", { discovery: "allow" }, sha(POLICY));
    expect(proposal.review.state).toBe("pending");
    expect(proposal.review.sections).toEqual(["apify.discovery"]);
    expect(proposal.review.frontmatterDiff).toContain("+   discovery: allow");
    expect(proposal.review.rationale).toBe("Settings: set Apify catalog search to Allow.");
    expect(readFileSync(path, "utf8"), "APIFY_SETTINGS_NO_EARLY_APPLY").toBe(POLICY);
    expect(windows).toEqual([]);

    const updated = await edits.decide("p-penelope", proposal.turn_id, proposal.request_id, true);
    expect(updated.state).toBe("updated");
    expect(parseGovernancePolicy(readFileSync(path)).effective.apify.discovery).toBe("allow");
    expect(windows).toEqual([proposal.turn_id]);
    expect(finished).toEqual([proposal.turn_id]);
    // A repeated or late answer reads the recorded outcome and never writes again.
    const before = readFileSync(path, "utf8");
    expect((await edits.decide("p-penelope", proposal.turn_id, proposal.request_id, true)).state).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a declined review writes nothing; another owner cannot answer it", async () => {
    const { edits } = writer();
    const proposal = await edits.propose("p-penelope", { actors: "deny" }, sha(POLICY));
    await expect(edits.decide("p-telemachus", proposal.turn_id, proposal.request_id, true)).rejects.toThrow("No policy review is open");
    const declined = await edits.decide("p-penelope", proposal.turn_id, proposal.request_id, false);
    expect(declined.state).toBe("declined");
    expect(readFileSync(path, "utf8")).toBe(POLICY);
  });

  test("a proposal against an older policy version refuses before any review", async () => {
    const { edits } = writer();
    await expect(edits.propose("p-penelope", { enabled: false }, sha("older"))).rejects.toThrow("changed since Settings read it");
    // An edit outside Settings while the review waits is stale at publication; the owner's approval writes nothing.
    const proposal = await edits.propose("p-penelope", { enabled: false }, sha(POLICY));
    writeFileSync(path, POLICY.replace("Odysseus decides", "Penelope decides"));
    expect((await edits.decide("p-penelope", proposal.turn_id, proposal.request_id, true)).state).toBe("stale");
    expect(readFileSync(path, "utf8")).toContain("Penelope decides");
  });

  test("losing owner authority refuses the approved write", async () => {
    let live = true;
    const { edits } = writer(() => live);
    const proposal = await edits.propose("p-penelope", { enabled: false }, sha(POLICY));
    live = false;
    expect((await edits.decide("p-penelope", proposal.turn_id, proposal.request_id, true)).state).toBe("refused");
    expect(readFileSync(path, "utf8")).toBe(POLICY);
  });
});

describe("settings routes", () => {
  const owner = { id: "p-penelope", kind: "owner" } as Principal;
  const agent = { id: "p-athena", kind: "agent" } as Principal;
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" } });
  function app(principal: Principal, spend?: Parameters<typeof createApifyRoutes>[0]["spend"], extra: Partial<Parameters<typeof createApifyRoutes>[0]> = {}) {
    const { edits } = writer();
    const routes = new Hono<AppEnv>().use("*", async (c, next) => { c.set("principal", principal); await next(); });
    return routes.route("/api", createApifyRoutes({ authority: authority(), authorized: id => id === owner.id, brainPath: brain, edits, now: () => NOW, ...(spend ? { spend } : {}), ...extra }));
  }

  test("agents reach neither the read nor a policy change (APIFY_SETTINGS_AGENT_REFUSED)", async () => {
    const routes = app(agent);
    expect((await routes.request("/api/apify")).status).toBe(403);
    expect((await routes.request("/api/apify/policy", post({ change: { actors: "allow" }, base_hash: sha(POLICY) }))).status, "APIFY_SETTINGS_AGENT_REFUSED").toBe(403);
    expect(readFileSync(path, "utf8")).toBe(POLICY);
  });

  test("only the owner can list and revoke remembered Actors, with strict input", async () => {
    let actors = [{ actor_id: "SeaCharts01", actor: "odysseus/sea-charts", approved_at: NOW }];
    const calls: string[] = [];
    const extra = { actorApprovals: async (principal: string) => { calls.push(principal); return actors; },
      revokeActor: async (principal: string, id: string) => { calls.push(principal); actors = actors.filter(a => a.actor_id !== id); } };
    const routes = app(owner, undefined, extra);
    expect((await (await routes.request("/api/apify")).json() as ApifySettingsRead).actor_approvals).toEqual(actors);
    expect((await routes.request("/api/apify/actors/revoke", post({ actor_id: "SeaCharts01", always: true }))).status).toBe(400);
    expect((await app(agent, undefined, extra).request("/api/apify/actors/revoke", post({ actor_id: "SeaCharts01" }))).status).toBe(403);
    expect(actors).toHaveLength(1);
    expect(await (await routes.request("/api/apify/actors/revoke", post({ actor_id: "SeaCharts01" }))).json()).toEqual({ revoked: true });
    expect((await (await routes.request("/api/apify")).json() as ApifySettingsRead).actor_approvals).toEqual([]);
    expect(calls).toEqual([owner.id, owner.id, owner.id]);
  });

  test("the owner's read carries policy, grant applicability and spend, and never the token", async () => {
    const routes = app(owner);
    const response = await routes.request("/api/apify");
    const text = await response.text();
    expect(text).not.toContain(SENTINEL);
    const read = JSON.parse(text) as ApifySettingsRead;
    expect(read).toMatchObject({ state: "configured", account: { id: "IthacaHousehold01" },
      policy: { valid: true, enabled: true, discovery: "ask", actors: "ask", hash: sha(POLICY), limits: null, budgets: { turn_usd: 4 } },
      spend: { ledger: "absent", day: null, unresolved: [] } });
    expect(read.policy.grants.map(grant => grant.status)).toEqual(["active", "expired"]);

    token = SUITORS;
    const changed = await (await app(owner).request("/api/apify")).json() as ApifySettingsRead;
    expect(changed.reason).toBe("account_changed");
    expect(changed.policy.grants.map(grant => grant.status), "old-account grants never apply").toEqual(["other_account", "expired"]);
  });

  test("a disabled policy still lists its grants for revocation and contacts nothing", async () => {
    writeFileSync(path, POLICY.replace("enabled: true", "enabled: false"));
    const read = await (await app(owner).request("/api/apify")).json() as ApifySettingsRead;
    expect(read.state).toBe("disabled");
    expect(read.policy.grants).toHaveLength(2);
    expect(fake.seen).toEqual([]);
  });

  test("policy changes validate their body and go through propose then answer", async () => {
    const routes = app(owner);
    expect((await routes.request("/api/apify/policy", post({ change: { actors: "always" }, base_hash: sha(POLICY) }))).status).toBe(400);
    expect((await routes.request("/api/apify/policy", post({ change: { actors: "allow", discovery: "allow" }, base_hash: sha(POLICY) }))).status).toBe(400);
    const stale = await routes.request("/api/apify/policy", post({ change: { actors: "allow" }, base_hash: sha("older") }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale" });
    const proposed = await routes.request("/api/apify/policy", post({ change: { actors: "allow" }, base_hash: sha(POLICY) }));
    expect(proposed.status).toBe(200);
    const { turn_id, request_id, review } = await proposed.json() as { turn_id: string; request_id: string; review: { state: string } };
    expect(review.state).toBe("pending");
    expect(readFileSync(path, "utf8")).toBe(POLICY);
    const answered = await routes.request(`/api/apify/policy/${turn_id}/${request_id}`, post({ approve: true }));
    expect(await answered.json()).toMatchObject({ state: "updated" });
    expect(parseGovernancePolicy(readFileSync(path)).effective.apify.actors).toBe("allow");
  });

  test("spend reads unknown, never zero, when the ledger cannot be read (APIFY_SETTINGS_UNAVAILABLE_NOT_ZERO)", async () => {
    const ledgerPath = join(brain, "..", `${brain.split("/").at(-1)}.ledger`);
    writeFileSync(ledgerPath, "not a ledger"); cleanup.push(() => rmSync(ledgerPath, { force: true }));
    const read = readApifySpend({ ledgerPath, brain_id: "b", ledger: () => { throw new Error("disk I/O error"); },
      runs: { coverage: () => { throw new Error("disk I/O error"); } } }, "IthacaHousehold01");
    expect(read, "APIFY_SETTINGS_UNAVAILABLE_NOT_ZERO").toMatchObject({ ledger: "unavailable", day: null, brain_day: null, unresolved: [] });
  });

  test("spend lists unresolved runs with their reservation, and an unknown start keeps it", async () => {
    const ledgerPath = join(brain, "..", `${brain.split("/").at(-1)}.ledger2`);
    writeFileSync(ledgerPath, ""); cleanup.push(() => rmSync(ledgerPath, { force: true }));
    const row = { handle: "handle-1", actor_id: "HarborNotices01", build_number: "1.4.12", state: "unknown", abort_state: null, cost_basis: "reserved",
      reserved_micro: 1_150_000, charged_micro: null, final_micro: null, settled: 0, session_id: "s-ithaca", turn_id: "t-harbor",
      created_at: NOW, dispatched_at: NOW, updated_at: NOW } as unknown as ApifyRunRow;
    const scope = (name: "turn" | "session" | "day" | "brain_day") => ({ scope: name, liability_usd: 1.15, charged_usd: 0, reserved_usd: 1.15, residual_usd: 0,
      runs: 1, open_runs: 1, unknown_runs: 1, operator_resolved: 0, limit_usd: null });
    const read = readApifySpend({ ledgerPath, brain_id: "b", now: () => NOW, ledger: () => ({ unsettled: () => [row] }) as unknown as ApifyLedger,
      runs: { coverage: () => ({ ledger_id: "l", coverage: "Apify runs this host admitted…" as never, scopes: (["turn", "session", "day", "brain_day"] as const).map(scope) }) } },
      "IthacaHousehold01", { session_id: "s-ithaca", turn_id: "t-harbor" });
    expect(read.ledger).toBe("read");
    expect(read.turn?.unknown_runs).toBe(1);
    expect(read.unresolved).toEqual([expect.objectContaining({ actor_id: "HarborNotices01", state: "unknown", remote_outcome_unknown: true, reserved_usd: 1.15, charged_usd: null, liability_usd: 1.15 })]);
    expect(JSON.stringify(read)).not.toContain("handle-1");
  });
});
