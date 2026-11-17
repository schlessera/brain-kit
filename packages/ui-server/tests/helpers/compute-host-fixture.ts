/**
 * Hosted external compute against a fake Boat (#3108): a disposable brain,
 * database and compute state directory, the real Boat adapter on an instant
 * clock over the fake vendor transport, the real budget ledger and Activity
 * store, and core's real operation set. No vendor, no key, no network.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";

import { createBoatProvider } from "../../../compute-boat/src/provider.js";
import { fakeBoat, type FakeBoat } from "../../../compute-boat/tests/helpers/fake-boat.js";
import { createActivityStore } from "../../src/activity/store.js";
import { createComputeHost, type ComputeHostOptions, type ComputeTurnContext, type HostedComputeConfig } from "../../src/brain/compute-host.js";
import { createTurnBudgets } from "../../src/brain/turn-budgets.js";
import { createUiDb } from "../../src/db/client.js";

/** The bound credential's value: it must appear nowhere but the vendor request. */
export const SENTINEL = "boat_odysseus_sentinel_9c41e2";

export const budgetPolicy = (blockUsd = 2) => resolveGovernancePolicy({ schema_version: 1, budgets: {
  turn: { warn_usd: blockUsd / 2, block_usd: blockUsd, block_tokens: 1_000_000 },
  session: { warn_usd: blockUsd, block_usd: blockUsd * 2, block_tokens: 2_000_000 },
  day: { warn_usd: blockUsd, block_usd: blockUsd * 2, block_tokens: 2_000_000 } } });

export function summary(instances: Record<string, Partial<HostedComputeConfig["providers"][string]>> = {}): HostedComputeConfig {
  const base = { provider: "boat", byValue: false, apiKeyEnv: "BOAT_CI_KEY", options: null, lease: { maxSeconds: 3600 }, maxConcurrent: 2, hourlyCeilingUsd: null, retainOnRelease: null };
  const entries = Object.keys(instances).length ? instances : { "boat-small": {} };
  return { enabled: true, providers: Object.fromEntries(Object.entries(entries).map(([id, over]) => [id, { ...base, ...over }])) as HostedComputeConfig["providers"] };
}

export interface Card { request: PermissionRequest }

export function computeFixture(options: {
  config?: HostedComputeConfig;
  keys?: Record<string, string[]>;
  /** Host credential values by variable name; default: the two Boat names hold the sentinel. */
  credentials?: Record<string, string>;
  workerEnvExtra?: string[];
  budgets?: boolean;
  blockUsd?: number;
  /** Another fixture's vendor and its clock, for a host restarted over the same state. */
  vendor?: { fake: FakeBoat; clock: { now: number } };
  host?: Partial<ComputeHostOptions>;
  db?: ReturnType<typeof createUiDb>;
  dirs?: { base: string; brain: string; state: string };
} = {}) {
  const base = options.dirs?.base ?? realpathSync(mkdtempSync(join(tmpdir(), "odysseus-hosted-compute-")));
  const brain = options.dirs?.brain ?? join(base, "brain");
  const state = options.dirs?.state ?? join(base, "ui.db.compute");
  if (!options.dirs) {
    for (const [path, text] of Object.entries({
      "notes/raft.md": "---\ntype: note\n---\n# The raft\nTwenty trees, felled on Ogygia.\n",
      "notes/route.md": "---\ntype: note\n---\n# Route home\nKeep the Bear on the left hand.\n",
      ".env": "BOAT_CI_KEY=never-uploaded\n",
      "health/sea-sickness.md": "---\ntype: health\n---\n# Sea sickness\n",
    })) {
      mkdirSync(dirname(join(brain, path)), { recursive: true });
      writeFileSync(join(brain, path), text);
    }
    mkdirSync(state, { recursive: true, mode: 0o700 });
  }
  const db = options.db ?? createUiDb(":memory:");
  let now = Date.UTC(2026, 6, 12, 9);
  const clock = () => now;
  // One vendor clock: the adapter's waits advance it, so a pending deletion
  // or a sleeping command completes without real time passing.
  const vendorClock = options.vendor?.clock ?? { now: Date.now() };
  const fake = options.vendor?.fake ?? fakeBoat({ apiKey: SENTINEL, now: () => vendorClock.now });
  const provider = createBoatProvider({ now: () => vendorClock.now, sleep: async ms => { vendorClock.now += ms; } });
  const budgets = createTurnBudgets(db, { resolve: () => null }, clock);
  const store = createActivityStore(db);
  const governance: Array<{ kind: string; payload: unknown; turnId: string }> = [];
  const config = options.config ?? summary();
  const reads: string[] = [];
  const host = createComputeHost({
    db, brainPath: brain, stateDir: state, stateMasked: true,
    keys: options.keys ?? { boat: ["BOAT_CI_KEY"] }, workerEnvExtra: options.workerEnvExtra ?? [],
    readConfig: async ctx => { reads.push(ctx.turnId); return { ok: true, config }; },
    ...(options.budgets === false ? {} : { budgets }),
    activity: { store, stream: { pump() {} } as never, governance: async () => {} },
    credential: name => (options.credentials ?? { BOAT_CI_KEY: SENTINEL, BOAT_HEAVY_KEY: SENTINEL })[name],
    serviceOptions: { registry: { boat: { load: async () => ({ provider, keyEnv: "BRAIN_COMPUTE_BOAT_API_KEY" }) } }, fetch: fake.fetch, callTimeoutMs: 5_000, lockWaitMs: 2_000,
      clock: { now: () => vendorClock.now } },
    driver: { initialDelayMs: 5, maxDelayMs: 10 },
    ...options.host,
  });
  const cards: Card[] = [];
  function turn(turnId: string, overrides: Partial<ComputeTurnContext> & { decide?: (request: PermissionRequest) => PermissionDecision } = {}): ComputeTurnContext {
    const { decide, ...rest } = overrides;
    return {
      turnId, principalId: "odysseus", sessionId: () => "sess-ogygia",
      policy: { providers: [], protect: [], release: [] }, policyHash: null,
      posture: "interactive", noGrantSurface: false, autonomous: false, hasClient: () => true,
      toolName: name => `mcp__brain-ui__${name}`,
      requestPermission: async request => { cards.push({ request }); return decide ? decide(request) : { behavior: "allow" }; },
      isCurrent: () => true,
      govern: event => governance.push({ ...event, turnId } as never),
      ...rest,
    };
  }
  return {
    base, brain, state, db, fake, vendorClock, budgets, store, governance, host, cards, reads, turn,
    /** Advance the ledger, the adapter and this fixture's vendor clocks. */
    tick(ms: number) { now += ms; vendorClock.now += ms; },
    /** Every file under the state directory whose bytes contain `text`. */
    stateFilesContaining(text: string): string[] {
      const out: string[] = [];
      const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (readFileSync(path).includes(text)) out.push(path); } };
      walk(state);
      return out;
    },
    async begin(turnId: string, sessionId = "sess-ogygia", blockUsd = options.blockUsd ?? 2) {
      await budgets.begin(turnId, sessionId, budgetPolicy(blockUsd));
    },
    async close() { await host.close(); if (!options.db) db.close(); if (!options.dirs) rmSync(base, { recursive: true, force: true }); },
  };
}
