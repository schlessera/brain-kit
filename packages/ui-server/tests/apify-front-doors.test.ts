/**
 * Every Apify front door reaches one implementation (#3162): `brain apify
 * --json`, the core MCP server's `brain_apify_*` tools and the hosted bridge
 * call the same core operations, so they refuse with the same codes, share
 * one ledger and cannot open a second consent, account or billing path.
 *
 * Keyless and offline: one loopback fake serves the Apify REST API and the
 * hosted MCP catalog; the token is a synthetic sentinel that must never
 * appear in any envelope, stdout or request URL. The Odysseus Actor and its
 * account, prices and origins are fictional.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApifyEnvelope } from "@schlessera/brain-common/internal/apify-operations";
import { APIFY_OPERATIONS, APIFY_TOOL_NAMES } from "@schlessera/brain-common/internal/apify-operations";
import { ledgerConsentState, openApifyLedger } from "@schlessera/brain-common/internal/apify";
import { createStandaloneApify, type StandaloneApify } from "@schlessera/brain/internal/apify";
import { filterSubprocessEnv } from "@schlessera/brain-ui-sdk/server";
import { HOST_ONLY_SECRET_ENV } from "@schlessera/brain-ui-sdk/internal";
import { apifyCommand, apifyCommandDeps } from "../../core/src/cli/commands/apify.js";
import { registerApifyTools } from "../../core/src/mcp-server.js";
import type { ApifyHost, ApifyHostTurn } from "../src/apify/host.js";
import {
  APIFY_INPUT, APIFY_LIMITS, APIFY_SENTINEL, apifyGrant, apifyPolicy, fakeApify, fixtureApifyHost, APIFY_PROFILE, type FakeApify,
} from "./fixtures/apify-host-fixture.js";

const REPO = resolve(import.meta.dir, "../../..");
let root: string, brain: string, ledgerPath: string, fake: FakeApify;
let hosts: ApifyHost[];
let standalones: StandaloneApify[];
let stdout: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "odysseus-apify-doors-"));
  brain = join(root, "ithaca");
  mkdirSync(brain, { recursive: true });
  mkdirSync(join(root, "private"), { mode: 0o700 });
  ledgerPath = join(root, "private", "apify-ledger.sqlite");
  fake = fakeApify();
  hosts = []; standalones = []; stdout = [];
});
afterEach(() => {
  for (const host of hosts) host.close();
  for (const service of standalones) service.close();
  fake.stop();
  rmSync(root, { recursive: true, force: true });
});

function standalone(env: Record<string, string | undefined> = { APIFY_TOKEN: APIFY_SENTINEL, BRAIN_APIFY_LEDGER: ledgerPath }): StandaloneApify {
  const service = createStandaloneApify({ root: brain, env, origin: fake.origin, mcpOrigin: fake.origin, profiles: [APIFY_PROFILE], waitSeconds: 1, pollMs: 1 });
  standalones.push(service);
  return service;
}

/** One `brain apify … --json` invocation, in a fresh service as a fresh process would be. */
async function cli(args: string[], env?: Record<string, string | undefined>): Promise<{ code: number; envelope: ApifyEnvelope }> {
  const create = apifyCommandDeps.create;
  apifyCommandDeps.create = () => standalone(env);
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { stdout.push(parts.join(" ")); });
  try {
    const before = stdout.length;
    const code = (await apifyCommand.run(args, { brain: { root: brain } as never, json: true })) ?? 0;
    return { code, envelope: JSON.parse(stdout.slice(before).join("\n")) as ApifyEnvelope };
  } finally { log.mockRestore(); apifyCommandDeps.create = create; }
}

/** The core MCP server's Apify tools on an in-memory transport, backed by the same standalone operations. */
async function mcp(env?: Record<string, string | undefined>): Promise<{ client: Client; call(name: string, input: unknown): Promise<{ isError: boolean; envelope: ApifyEnvelope }>;
  callRaw(name: string, input: unknown): Promise<{ isError: boolean; structured: unknown; text: string }> }> {
  const server = new McpServer({ name: "brain", version: "0" });
  registerApifyTools(server, () => standalone(env));
  const [left, right] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "odysseus", version: "0" });
  await Promise.all([server.connect(left), client.connect(right)]);
  return { client, async call(name, input) {
    const result = await client.callTool({ name, arguments: input as Record<string, unknown> });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    stdout.push(text);
    expect(result.structuredContent, "MCP_STRUCTURED_IS_ENVELOPE").toEqual(JSON.parse(text));
    return { isError: result.isError === true, envelope: JSON.parse(text) as ApifyEnvelope };
  }, async callRaw(name, input) {
    const result = await client.callTool({ name, arguments: input as Record<string, unknown> });
    return { isError: result.isError === true, structured: result.structuredContent, text: (result.content as Array<{ text: string }>)[0]!.text };
  } };
}

function hosted(): ApifyHost {
  const host = fixtureApifyHost(brain, fake, ledgerPath);
  hosts.push(host);
  return host;
}
function turn(overrides: Partial<ApifyHostTurn> = {}, approve: string[] = []): ApifyHostTurn {
  return { turnId: "t-voyage-1", principalId: "p-penelope", sessionId: () => "s-voyage", posture: "interactive", signal: new AbortController().signal,
    approvals: { requestPermission: async request => { approve.push(`${request.kind}:${request.toolName}`); return { behavior: "allow" }; } }, ...overrides };
}
async function viaHost(host: ApifyHost, t: ApifyHostTurn, operation: keyof typeof APIFY_TOOL_NAMES, input: unknown): Promise<ApifyEnvelope> {
  const envelope = await host.call(t, { tool: APIFY_TOOL_NAMES[operation], input });
  stdout.push(JSON.stringify(envelope));
  return envelope;
}

const data = <T>(envelope: ApifyEnvelope): T => {
  if (!envelope.ok) throw new Error(`expected ok, got ${JSON.stringify(envelope.error)}`);
  return envelope.data as T;
};
const code = (envelope: ApifyEnvelope) => envelope.ok ? "ok" : envelope.error.code;

describe("one implementation behind every front door", () => {
  test("CLI, MCP and the hosted bridge refuse the same way, and a refusal sends nothing", async () => {
    const doors = async (label: string, env?: Record<string, string | undefined>) => {
      const viaCli = (await cli(["discover", "sea", "charts"], env)).envelope;
      const viaMcp = (await (await mcp(env)).call("brain_apify_discover", { query: "sea charts" })).envelope;
      const viaBridge = await viaHost(hosted(), turn(), "discover", { query: "sea charts" });
      return { label, codes: [code(viaCli), code(viaMcp), code(viaBridge)] };
    };
    apifyPolicy(brain, null);
    expect(await doors("absent"), "APIFY_DOORS_DISABLED_BY_DEFAULT").toEqual({ label: "absent", codes: ["provider_disabled", "provider_disabled", "provider_disabled"] });
    apifyPolicy(brain, { enabled: true, discovery: "deny" });
    expect(await doors("deny"), "APIFY_DOORS_DISCOVERY_DENY").toEqual({ label: "deny", codes: ["policy_denied", "policy_denied", "policy_denied"] });
    expect(fake.seen, "APIFY_REFUSALS_SEND_NOTHING").toEqual([]);
    // Schema refusals are the shared ones: an address is not a catalog term on any door.
    apifyPolicy(brain, { enabled: true, discovery: "allow" });
    const address = [(await cli(["discover", "odysseus@ithaca.example"])).envelope, (await (await mcp()).call("brain_apify_discover", { query: "odysseus@ithaca.example" })).envelope,
      await viaHost(hosted(), turn(), "discover", { query: "odysseus@ithaca.example" })];
    expect(address.map(code), "APIFY_DOORS_SHARED_INPUT_CHECKS").toEqual(["invalid_input", "invalid_input", "invalid_input"]);
    expect(fake.seen).toEqual([]);
  });

  test("a standalone process without the shared ledger or the token refuses before contacting Apify", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", limits: APIFY_LIMITS });
    const noLedger = await cli(["discover", "sea", "charts"], { APIFY_TOKEN: APIFY_SENTINEL });
    expect(noLedger.code).toBe(1);
    expect(noLedger.envelope, "APIFY_STANDALONE_LEDGER_REQUIRED").toMatchObject({ ok: false, error: { code: "accounting_unavailable", reason: "ledger_unset" } });
    const noToken = await cli(["discover", "sea", "charts"], { BRAIN_APIFY_LEDGER: ledgerPath });
    expect(noToken.envelope, "APIFY_STANDALONE_TOKEN_REQUIRED").toMatchObject({ ok: false, error: { code: "authentication_required" } });
    expect(fake.seen, "APIFY_NO_LEDGER_NO_REQUEST").toEqual([]);
  });

  test("the CLI keeps consent across invocations and refuses a run nobody can approve", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "ask", limits: APIFY_LIMITS });
    const found = await cli(["discover", "sea", "charts"]);
    expect(found.code).toBe(0);
    const candidate = data<{ candidates: Array<{ candidate: string; actor: string }>; untrusted: true }>(found.envelope);
    expect(candidate.untrusted).toBe(true);
    // A fresh service, as a second process: the reference survives in the shared ledger.
    const inspected = data<{ eligibility: { executable: boolean; reasons: string[] } }>((await cli(["inspect", candidate.candidates[0]!.candidate])).envelope);
    expect(inspected.eligibility, "APIFY_CLI_INSPECT_ACROSS_INVOCATIONS").toEqual({ executable: true, reasons: [] });
    const prepared = data<{ proposal: string; admission: string }>((await cli(["prepare", candidate.candidates[0]!.candidate,
      "--input", JSON.stringify(APIFY_INPUT), "--max-charge-usd", "2"])).envelope);
    expect(prepared.admission).toBe("ask");
    const run = await cli(["run", prepared.proposal]);
    expect(run.code, "APIFY_STANDALONE_RUN_REFUSED").toBe(1);
    expect(run.envelope, "APIFY_STANDALONE_NO_GRANT_SURFACE").toMatchObject({ ok: false, error: { code: "approval_required", reason: "no_grant_surface" } });
    expect(fake.starts(), "APIFY_NO_START_WITHOUT_CONSENT").toBe(0);
    // Another session name cannot use this session's references.
    const foreign = await cli(["inspect", candidate.candidates[0]!.candidate, "--session", "suitors"]);
    expect(foreign.envelope, "APIFY_SESSION_BOUND_REFERENCE").toMatchObject({ ok: false, error: { code: "proposal_stale" } });
    expect(stdout.join("\n"), "APIFY_CLI_SENTINEL_NEVER_PRINTED").not.toContain(APIFY_SENTINEL);
  });

  test("an exact standing grant admits a standalone run once; status, results and abort follow", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant()], limits: APIFY_LIMITS });
    const candidate = data<{ candidates: Array<{ candidate: string }> }>((await cli(["discover", "sea", "charts"])).envelope).candidates[0]!.candidate;
    await cli(["inspect", candidate]);
    const prepared = data<{ proposal: string; admission: string }>((await cli(["prepare", candidate, "--input", JSON.stringify(APIFY_INPUT), "--max-charge-usd", "2"])).envelope);
    expect(prepared.admission, "APIFY_GRANT_MATCHES_EXACTLY").toBe("grant");
    const started = data<{ run: string; state: string; results: { available: boolean } }>((await cli(["run", prepared.proposal])).envelope);
    expect(started.state).toBe("succeeded");
    // The view passed on is the model view only: no accounting, ledger or remote ids.
    expect(Object.keys(started).sort(), "APIFY_RUN_VIEW_ONLY").toEqual(["abort", "remote_outcome_unknown", "results", "run", "state", "warnings"]);
    expect((await cli(["run", prepared.proposal])).envelope, "APIFY_PROPOSAL_ONCE").toMatchObject({ ok: false, error: { code: "proposal_stale" } });
    expect(code((await cli(["status", started.run])).envelope)).toBe("ok");
    const page = data<{ items: unknown[]; untrusted: true }>((await cli(["results", started.run, "--limit", "2"])).envelope);
    expect(page.items).toHaveLength(2);
    expect(page.untrusted).toBe(true);
    expect(data<{ outcome: string }>((await cli(["abort", started.run])).envelope).outcome).toBe("not_needed");
    expect(fake.starts(), "APIFY_ONE_START").toBe(1);
    expect(stdout.join("\n")).not.toContain(APIFY_SENTINEL);
    expect(fake.seen.every(entry => !entry.path.includes(APIFY_SENTINEL))).toBe(true);
  });

  test("the MCP wrappers keep a fixed roster and return discovered schemas as data", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant()], limits: APIFY_LIMITS });
    const door = await mcp();
    const roster = async () => (await door.client.listTools()).tools.map(tool => tool.name);
    const before = await roster();
    expect(before, "APIFY_MCP_FIXED_NAMES").toEqual(APIFY_OPERATIONS.map(operation => APIFY_TOOL_NAMES[operation]));
    const candidate = data<{ candidates: Array<{ candidate: string }> }>((await door.call("brain_apify_discover", { query: "sea charts" })).envelope).candidates[0]!.candidate;
    const inspected = data<{ input_fields: string[] }>((await door.call("brain_apify_inspect", { candidate })).envelope);
    expect(inspected.input_fields, "APIFY_SCHEMA_AS_DATA").toEqual(["harbour", "maxPages", "startUrls"]);
    const proposal = data<{ proposal: string }>((await door.call("brain_apify_prepare", { candidate, input: APIFY_INPUT, max_charge_usd: 2 })).envelope).proposal;
    expect(code((await door.call("brain_apify_run", { proposal })).envelope)).toBe("ok");
    expect(await roster(), "APIFY_MCP_ROSTER_UNCHANGED_BY_ACTOR").toEqual(before);
    // Raw remote ids, transport options and extra fields are refused by the shared strict schema,
    // as every core tool's schema violation is: an error result without structured content.
    const raw = await door.callRaw("brain_apify_run", { proposal, actor: "SeaCharts01" });
    expect(raw.isError, "APIFY_MCP_STRICT_INPUT").toBe(true);
    expect(raw.structured, "APIFY_MCP_STRICT_INPUT_NO_ENVELOPE").toBeUndefined();
    expect(raw.text).toContain("actor");
    expect(fake.starts()).toBe(1);
  });
});

describe("shared accounting and authority", () => {
  test("a hosted and a standalone process spend against one ledger", async () => {
    // Room in the account's UTC day for one run's reservation ($2 cap plus $0.008044 of lifecycle and storage),
    // but not for a second beside the first one's settled liability ($0.08 of events plus that lifecycle and storage).
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant()], limits: { ...APIFY_LIMITS, day_usd: 2.05 } });
    const host = hosted(), asked: string[] = [], t = turn({}, asked);
    const candidate = data<{ candidates: Array<{ candidate: string }> }>(await viaHost(host, t, "discover", { query: "sea charts" })).candidates[0]!.candidate;
    await viaHost(host, t, "inspect", { candidate });
    const proposal = data<{ proposal: string }>(await viaHost(host, t, "prepare", { candidate, input: APIFY_INPUT, max_charge_usd: 2 })).proposal;
    const hostedRun = data<{ run: string }>(await viaHost(host, t, "run", { proposal }));
    expect(asked, "APIFY_GRANT_ADMITS_WITHOUT_A_CARD").toEqual([]);
    const local = standalone();
    const standaloneCandidate = data<{ candidates: Array<{ candidate: string }> }>(await local.call("discover", { query: "sea charts" })).candidates[0]!.candidate;
    await local.call("inspect", { candidate: standaloneCandidate });
    const localProposal = data<{ proposal: string }>(await local.call("prepare", { candidate: standaloneCandidate, input: APIFY_INPUT, max_charge_usd: 2 })).proposal;
    expect(await local.call("run", { proposal: localProposal }), "APIFY_SHARED_ACCOUNT_DAY").toMatchObject({ ok: false, error: { code: "budget_exceeded", reason: "day_usd" } });
    expect(fake.starts(), "APIFY_SHARED_LEDGER_ONE_START").toBe(1);
    // A hosted run handle is not the standalone operator's, whatever process holds it.
    expect(await local.call("status", { run: hostedRun.run }), "APIFY_RETAINED_HANDLE_NOT_TRANSFERRED").toMatchObject({ ok: false, error: { code: "proposal_stale" } });
    expect(host.runs.coverage({ account_id: "IthacaHousehold01", session_id: "s-voyage", turn_id: "t-voyage-1" }).ledger_id,
      "APIFY_ONE_LEDGER_IDENTITY").toBeString();
  });

  test("a reconnect or a later turn cannot reuse an earlier turn's proposal, and approvals stay per use", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "ask", actors: "ask", limits: APIFY_LIMITS });
    const host = hosted(), asked: string[] = [];
    const first = turn({}, asked);
    const candidate = data<{ candidates: Array<{ candidate: string }> }>(await viaHost(host, first, "discover", { query: "sea charts" })).candidates[0]!.candidate;
    await viaHost(host, first, "inspect", { candidate });
    const proposal = data<{ proposal: string }>(await viaHost(host, first, "prepare", { candidate, input: APIFY_INPUT, max_charge_usd: 2 })).proposal;
    // Approving discovery and inspection never approved a run: those were catalog cards.
    expect(asked, "APIFY_CATALOG_APPROVALS_PER_USE").toEqual(["command:Apify catalog search", "command:Apify Actor inspection"]);
    const later = turn({ turnId: "t-voyage-2" }, asked);
    expect(await viaHost(host, later, "run", { proposal }), "APIFY_RECONNECT_NEW_TURN_STALE").toMatchObject({ ok: false, error: { code: "proposal_stale" } });
    const fork = turn({ sessionId: () => "s-fork" }, asked);
    expect(await viaHost(host, fork, "inspect", { candidate }), "APIFY_FORK_NOT_OWNER").toMatchObject({ ok: false, error: { code: "proposal_stale" } });
    expect(fake.starts()).toBe(0);
  });

  test("a run waits for the conversation to be named, so the turn budgets can attribute it (#3307)", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant()], limits: APIFY_LIMITS });
    const host = hosted(), unnamed = turn({ sessionId: () => null });
    const candidate = data<{ candidates: Array<{ candidate: string }> }>(await viaHost(host, unnamed, "discover", { query: "sea charts" })).candidates[0]!.candidate;
    await viaHost(host, unnamed, "inspect", { candidate });
    const proposal = data<{ proposal: string }>(await viaHost(host, unnamed, "prepare", { candidate, input: APIFY_INPUT, max_charge_usd: 2 })).proposal;
    expect(await viaHost(host, unnamed, "run", { proposal }), "APIFY_RUN_NEEDS_BOUND_SESSION")
      .toMatchObject({ ok: false, error: { code: "accounting_unavailable", reason: "session_unbound" } });
    expect(fake.starts()).toBe(0);
  });

  test("voice and autonomous turns keep their memberships: the host refuses before reading or sending", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant()], limits: APIFY_LIMITS });
    const host = hosted();
    for (const posture of ["voice", "autonomous"] as const) {
      expect(await viaHost(host, turn({ posture }), "discover", { query: "sea charts" }), `APIFY_${posture.toUpperCase()}_REFUSED`)
        .toMatchObject({ ok: false, error: { code: "policy_denied", reason: `${posture}_posture` } });
    }
    expect(fake.seen).toEqual([]);
  });
});

describe("standalone consent state in the shared ledger", () => {
  test("two processes holding one proposal admit it once: the transition is decided under the write lock", () => {
    const first = openApifyLedger(ledgerPath), second = openApifyLedger(ledgerPath);
    try {
      const [a, b] = [ledgerConsentState(() => first), ledgerConsentState(() => second)];
      const proposal = { principal_id: "local", session_id: "standalone:default", turn_id: "standalone:default:2026-07-12",
        binding: { account_id: "IthacaHousehold01", generation: "g" }, policy_hash: "h", facts: {} as never, input: {}, input_sha256: "i",
        origins: [], max_charge_usd: 1, expires_at: Date.now() + 60_000, state: "prepared" as const };
      a.addProposal("P".repeat(43), proposal, Date.now());
      // Both read it as prepared; only one may move it on.
      expect([a.proposal("P".repeat(43))!.state, b.proposal("P".repeat(43))!.state]).toEqual(["prepared", "prepared"]);
      expect([a.transition("P".repeat(43), "prepared", "admitting"), b.transition("P".repeat(43), "prepared", "admitting")],
        "APIFY_LEDGER_ONE_ADMISSION").toEqual([true, false]);
    } finally { first.close(); second.close(); }
  });
});

describe("a shell-issued CLI inside a worker", () => {
  test("receives neither the token nor the ledger, so it refuses before anything is sent", async () => {
    apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant()], limits: APIFY_LIMITS });
    const hostEnv = { PATH: process.env.PATH!, HOME: root, APIFY_TOKEN: APIFY_SENTINEL, BRAIN_APIFY_LEDGER: ledgerPath };
    expect(HOST_ONLY_SECRET_ENV, "APIFY_HOST_ONLY_NAMES").toEqual(expect.arrayContaining(["APIFY_TOKEN", "BRAIN_APIFY_LEDGER"]));
    for (const audience of ["agent", "brainCli", "cron"] as const) {
      // Even named as a per-spawn extra, neither crosses.
      const env = filterSubprocessEnv(hostEnv, audience, ["APIFY_TOKEN", "BRAIN_APIFY_LEDGER"]);
      expect(Object.keys(env), `APIFY_WORKER_ENV_${audience}`).not.toEqual(expect.arrayContaining(["APIFY_TOKEN"]));
      expect(Object.keys(env), `APIFY_WORKER_ENV_${audience}`).not.toEqual(expect.arrayContaining(["BRAIN_APIFY_LEDGER"]));
    }
    const env = filterSubprocessEnv(hostEnv, "agent");
    const child = Bun.spawn([process.execPath, join(REPO, "packages/core/src/cli/brain.ts"), "apify", "discover", "sea", "charts", "--json"],
      { cwd: brain, env: { ...env, BRAIN_ROOT: brain }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err).toBe(1);
    expect(JSON.parse(out), "APIFY_WORKER_CLI_REFUSES").toMatchObject({ ok: false, operation: "discover", error: { code: "accounting_unavailable" } });
    expect(out + err).not.toContain(APIFY_SENTINEL);
    expect(fake.seen).toEqual([]);
  });
});
