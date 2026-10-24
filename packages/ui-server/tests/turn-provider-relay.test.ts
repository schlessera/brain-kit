/**
 * The acceptance case of #1673, composed as the server runs a turn: a governed
 * turn on managed storage loops the real `brain search` in its worker, under
 * real bubblewrap, with no key. Each relayed query embedding is metered on the
 * turn; once a request crosses the turn's block, the next one is refused with
 * `budget_exceeded` before any provider contact (ruling D3 on #1673). The
 * upstream is a fictional loopback Gemini endpoint the operator lists.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher";
import { createUiDb } from "../src/db/client";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { createTurnBudgets, TURN_BUDGET_COVERAGE } from "../src/brain/turn-budgets";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const HOST_KEY = "odysseus-host-gemini-key";
const vector = () => Array.from({ length: 1536 }, (_, index) => (index % 13) / 13);
let upstream: ReturnType<typeof Bun.serve>;
const seen: string[] = [];
let root: string, brain: string;

beforeAll(async () => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    seen.push(request.headers.get("x-goog-api-key") ?? "none");
    const count = ((await request.json()) as { requests?: unknown[] }).requests?.length ?? 1;
    return Response.json({ embeddings: Array.from({ length: count }, () => ({ values: vector() })),
      usageMetadata: { promptTokenCount: 9 * count, promptTokenDetails: [{ modality: "TEXT", tokenCount: 9 * count }] } });
  } });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/turn-provider-relay-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini" } }));
  // Each query embedding is 9 text tokens at $0.20 per million: $0.0000018.
  // The second crosses the turn's $0.000003 stop.
  writeFileSync(join(brain, "context/policies/governance.md"),
    "---\nschema_version: 1\nbudgets:\n  turn: { warn_usd: 0.000001, block_usd: 0.000003 }\n---\nAthena meters the voyage.\n");
  const index = Bun.spawn([process.execPath, BRAIN_CLI, "index", "--embeddings", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file", GEMINI_API_KEY: HOST_KEY, GOOGLE_GEMINI_BASE_URL: upstream.url.origin } });
  const [code, stderr] = await Promise.all([index.exited, new Response(index.stderr).text()]);
  if (code !== 0) throw new Error(`brain index --embeddings failed: ${stderr}`);
  seen.length = 0;
});
afterAll(() => { upstream.stop(true); rmSync(root, { recursive: true, force: true }); });

test("a governed turn's looped brain search is metered through the relay until its budget refuses the next request", async () => {
  const storage = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  const saved = Object.getOwnPropertyDescriptor(process.env, "GEMINI_API_KEY");
  // The server's own key: the relay's to hold, the worker's never.
  process.env.GEMINI_API_KEY = HOST_KEY;
  const state = mkdtempSync(join(root, "state-")), dbPath = join(state, "ui.db"), db = createUiDb(dbPath);
  const store = createActivityStore(db), stream = createActivityStream(store);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, state).client, brainPath: brain, execution, profile: "governed", maskPaths: [], index: async () => {}, report() {} });
  const outputs: string[] = [];
  let workerErrors = "", workerEnv = "";
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    request.bridge.emit({ type: "session_info", sessionId: "voyage-meter", isNew: true });
    const proxyDir = request.workerSandbox?.egress?.dir;
    if (proxyDir) {
      const search = (index: number) => `${process.execPath} ${BRAIN_CLI} search "Ithaca harbour" --json > /tmp/search-${index}.json; cat /tmp/search-${index}.json; echo; echo ===`;
      const child = Bun.spawn(workerCommand({ brainPath: brain, startupView: request.workerStartupView, sandbox: request.workerSandbox,
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp", BRAIN_ROOT: brain, GOOGLE_GEMINI_BASE_URL: upstream.url.origin, GEMINI_API_KEY: HOST_KEY },
        egress: { proxyDir }, command: ["/bin/sh", "-c", `env > /tmp/env.txt; ${search(1)}; ${search(2)}; ${search(3)}; cat /tmp/env.txt`] }),
      { env: {}, stdout: "pipe", stderr: "pipe" });
      const [, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      workerErrors = stderr;
      const parts = stdout.split("===\n");
      workerEnv = parts.pop() ?? "";
      outputs.push(...parts.map(part => part.trim()));
    }
    request.bridge.emit({ type: "result", sessionId: "voyage-meter", durationMs: 1, numTurns: 1, isError: false });
  } });
  const host = new WsHost({ brainPath: brain, governedTurns: turns, registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
    budgets: createTurnBudgets(db, { resolve: () => null }), cliProviderOrigins: new Map([["GEMINI_API_KEY", [upstream.url.origin]]]),
    activity: { store, stream, governance: input => { recordGovernanceEvent(db, input); } },
    isPrincipalAuthorized: id => { const found = resolvePrincipal(db, id); return found !== null && isUsablePrincipal(found, Date.now()); } });
  try {
    await runSession(host, { authorization: testAuthorization(principal.id), text: "Odysseus surveys the harbour three times.", attachments: [] });
    expect(outputs, workerErrors).toHaveLength(3);
    expect(workerEnv.includes(HOST_KEY), "TURN_WORKER_HOLDS_NO_KEY").toBe(false);
    const [first, second, third] = outputs.map(output => JSON.parse(output) as { results: Array<{ path: string }>; warnings: string[] });
    expect(first!.warnings, "FIRST_SEARCH_RELAYED").toEqual([]);
    expect(second!.warnings, "SECOND_SEARCH_RELAYED").toEqual([]);
    expect(third!.warnings.join("\n"), "NEXT_REQUEST_REFUSED_BUDGET_EXCEEDED").toContain("budget_exceeded");
    expect(third!.results.map(result => result.path)).toContain("notes/ithaca.md");
    expect(seen, "ONLY_ADMITTED_REQUESTS_REACH_PROVIDER").toEqual([HOST_KEY, HOST_KEY]);
    const rows = db.query("SELECT outcome, tokens, cost_usd FROM provider_relay_usage ORDER BY observed_at").all() as Array<{ outcome: string; tokens: number; cost_usd: number }>;
    expect(rows.map(row => [row.outcome, row.tokens]), "EACH_RELAYED_REQUEST_METERED_ON_TURN").toEqual([["completed", 9], ["completed", 9]]);
    const receipt = JSON.parse((db.query("SELECT receipt FROM turn_budget_usage").get() as { receipt: string }).receipt);
    expect(receipt.coverage).toBe(TURN_BUDGET_COVERAGE);
    expect(receipt.scopes[0].costUsd).toBeCloseTo(0.0000036, 12);
    expect(receipt.scopes[0].blocked, "PROVIDER_USAGE_BLOCKS_TURN_SCOPE").toBe(true);
    expect(queryGovernanceEvents(db, { kinds: ["budget_warning"], limit: 10 }), "PROVIDER_USAGE_WARNS")
      .toMatchObject([{ payload: { scope: "turn", unit: "usd" } }]);
  } finally {
    storage.mockRestore(); host.close(); db.close();
    if (saved) Object.defineProperty(process.env, "GEMINI_API_KEY", saved); else delete process.env.GEMINI_API_KEY;
  }
}, 60_000);
