import { defaultIdentityPhase } from "./default-identity-phases.js";
import { installDbRepeatObservation, repeatWarmIndex } from "./db-repeat-observation.js";
import { installBootPruneCapture } from "./boot-prune-capture.js";
/** Real managed-server admission and native SDK turn; explicit fictional API profile. */
import { expect } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../../../ui-server/src/app.js";
import { resolveServerConfig } from "../../../ui-server/src/config/env.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createRecordingObservability } from "../../../ui-server/src/observability/index.js";
import { createPrincipal } from "../../../ui-server/src/db/principals.js";
import { createClaudeBackend } from "../../../ui-backend-claude/src/backend.js";
import { nativeModelReply } from "../../../ui-backend-claude/tests/helpers/native-model-reply.js";
import { serializeSigned } from "hono/utils/cookie";

const sharedGit = new URL(import.meta.url).searchParams.has("shared-git");
const bootPruneCapture = sharedGit && process.argv.includes("--boot-prune-capture");
let ownedBootPrune: ReturnType<typeof installBootPruneCapture> | undefined;
const appOnly = sharedGit && new URL(import.meta.url).searchParams.has("app-only");
const warm = new URL(import.meta.url).searchParams.has("warm");
const profile = new URL(import.meta.url).searchParams.get("profile") === "strict" ? "strict" : "governed";
const dbRepeat = sharedGit && warm && process.argv.includes("--db-repeat-index");
let dbObservation: ReturnType<typeof installDbRepeatObservation> | undefined;
const stageStarted = performance.now();
const stage = (stage: string) => { if (sharedGit) console.log(JSON.stringify({ sharedAppStage: { profile, warm, stage, elapsedMs: performance.now() - stageStarted } })); };
stage("module-loaded");
const brain = "/brain-fixture/brain", root = profile === "strict" ? "/identity-server-private/server-ws-strict" : "/identity-server-private/server-ws";
const home = join(root, "home"), config = join(home, ".claude"), data = root;
mkdirSync(data, { mode: 0o700, recursive: true }); mkdirSync(config, { recursive: true, mode: 0o700 });
const requests: Array<{ model: string; history: number; apiCredential: boolean }> = [];
// Native worker calls this loopback provider directly. The outer Docker network
// namespace has no external route; no fetch implementation or native SDK is mocked.
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; messages: unknown[] };
  requests.push({ model: body.model, history: body.messages.length, apiCredential: request.headers.get("x-api-key") === "odysseus-fictional-api-key" });
  return nativeModelReply();
} });
// Diagnostic only (#4325 F3, hosted runtime_host): when the bridge inventory
// probe runs before a new chat, record its phases and the UIDs its process
// tree ran as. Observes the existing spawn, startup-span and backend-log
// channels; changes nothing the turn sees.
const bridgeDiagnostic = { launches: [] as Array<Record<string, unknown>>, spans: [] as Array<{ startMs: number; endMs?: number }>,
  logs: [] as Array<{ atMs: number; level: string; message: string }>, otherLaunches: [] as Array<{ atMs: number; kind: string }>,
  turnStartMs: [] as number[], chatSentMs: undefined as number | undefined };
const diagnosticNow = () => Math.round(performance.now());
function processTreeUids(root: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { const stat = readFileSync(`/proc/${name}/stat`, "utf8"); parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])); } catch {}
  }
  const tree = [root], uids = new Set<number>();
  for (let i = 0; i < tree.length && tree.length < 64; i++) for (const [pid, ppid] of parents) if (ppid === tree[i]) tree.push(pid);
  for (const pid of tree) {
    try { const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]; if (uid !== undefined) uids.add(Number(uid)); } catch {}
  }
  return [...uids];
}
/** UIDs of every process whose own command line names the inventory entry, wherever the identity helper parented it. */
function markedProcessUids(): number[] {
  const uids = new Set<number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (!readFileSync(`/proc/${name}/cmdline`, "utf8").split("\u0000").some(arg => arg.endsWith("brain-bridge-inventory-entry.ts"))) continue;
      const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`, "utf8"))?.[1];
      if (uid !== undefined) uids.add(Number(uid));
    } catch {}
  }
  return [...uids];
}
function observeInventoryLaunch(proc: any) {
  const entry: Record<string, unknown> = { startMs: diagnosticNow(), pid: proc?.pid };
  const uids = new Set<number>(), entryUids = new Set<number>();
  bridgeDiagnostic.launches.push(entry);
  if (bridgeDiagnostic.launches.length > 8) return;
  let samples = 0;
  const sampler = setInterval(() => {
    if (++samples > 1200) { clearInterval(sampler); return; }
    try {
      for (const uid of processTreeUids(proc.pid)) uids.add(uid);
      for (const uid of markedProcessUids()) { if (!entryUids.size) entry.entrySeenMs = diagnosticNow(); entryUids.add(uid); }
      entry.uids = [...uids]; entry.entryUids = [...entryUids];
    } catch (error) { entry.sampleError = String(error); clearInterval(sampler); }
  }, 25);
  (sampler as { unref?: () => void }).unref?.();
  try {
    const [mine, theirs] = (proc.stdout as ReadableStream<Uint8Array>).tee();
    Object.defineProperty(proc, "stdout", { value: theirs, configurable: true });
    void (async () => {
      const reader = mine.getReader();
      let bytes = 0;
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        if (bytes === 0) entry.firstStdoutMs = diagnosticNow();
        bytes += chunk.value.byteLength;
      }
      entry.stdoutEndMs = diagnosticNow(); entry.stdoutBytes = bytes;
    })().catch(error => { entry.stdoutError = String(error); });
  } catch (error) { entry.stdoutTee = String(error); }
  void Promise.resolve(proc.exited).then(code => { entry.exitMs = diagnosticNow(); entry.exitCode = code; },
    error => { entry.exitError = String(error); }).finally(() => { clearInterval(sampler); entry.uids = [...uids]; });
}
function printBridgeDiagnostic(phase: string) {
  const line = JSON.stringify({ bridgeInventoryDiagnostic: { phase, profile, warm, atMs: diagnosticNow(), ...bridgeDiagnostic } });
  console.log(line); console.error(line.slice(0, 3000));
}
const backend = createClaudeBackend({ brainPath: brain, profiles: [{ id: "odysseus-haiku", label: "Odysseus Haiku", billing: "api",
  requiredEnvKeys: [], model: "claude-haiku-4-5", buildEnv: () => ({ ANTHROPIC_BASE_URL: provider.url.origin,
    ANTHROPIC_API_KEY: "odysseus-fictional-api-key", HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/local/bin:/usr/bin:/bin",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }) }], log(level, message) {
  if (String(message).includes("brain_bridge") && bridgeDiagnostic.logs.length < 32) bridgeDiagnostic.logs.push({ atMs: diagnosticNow(), level, message: String(message).slice(0, 300) });
} });
const backendProfiles: Array<string | undefined> = [];
const admissionReads: Array<ReturnType<NonNullable<Parameters<typeof backend.startTurn>[0]["bridge"]["admissionSafety"]>["read"]>> = [];
const observedBackend = { ...backend, startTurn(request: Parameters<typeof backend.startTurn>[0]) {
  backendProfiles.push(request.workerSandbox?.profile);
  bridgeDiagnostic.turnStartMs.push(diagnosticNow());
  const timing = request.startupTiming;
  if (timing) {
    const start = timing.start.bind(timing);
    timing.start = (name: string) => {
      const stop = start(name);
      if (name !== "brain_tool_inventory") return stop;
      const span: { startMs: number; endMs?: number } = { startMs: diagnosticNow() };
      bridgeDiagnostic.spans.push(span);
      return () => { span.endMs = diagnosticNow(); stop(); };
    };
  }
  // Observe the real host gate synchronously, returning each original read
  // unchanged. Native refusals otherwise collapse to a generic HTTP 403.
  const safety = request.bridge.admissionSafety;
  if (safety) {
    const read = safety.read.bind(safety);
    safety.read = () => {
      const value = read();
      if (admissionReads.length < 64) admissionReads.push({ ...value });
      return value;
    };
  }
  return backend.startTurn(request);
} };
const observability = createRecordingObservability(), secret = "odysseus-fixture-cookie-secret-0123456789";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let socket: WebSocket | undefined;
const spawnDescriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!, spawn = Bun.spawn, observedAdapters = new Set<string>();
Object.defineProperty(Bun, "spawn", { ...spawnDescriptor, value: (...args: any[]) => {
  const options = Array.isArray(args[0]) ? args[1] : args[0];
  const launch = options?.env?.BRAIN_WORKER_LAUNCH;
  if (launch) {
    const outer = JSON.parse(launch);
    dbObservation?.observe(outer);
    const source = outer.maintenance?.git?.source;
    if (source && !observedAdapters.has(source)) {
      observedAdapters.add(source);
      const nodes = [dirname(source), source, `${source}/config.json`].map((path, index) => {
        try { const info = index === 0 ? statSync(path) : lstatSync(path); return { uid: info.uid, gid: info.gid, mode: (info.mode & 0o7777).toString(8), directory: info.isDirectory() }; }
        catch (error) { return { error: (error as NodeJS.ErrnoException).code }; }
      });
      console.log(JSON.stringify({ actualFrozenGitAdapterOwnership: { serverUid: process.getuid?.(), serverGid: process.getgid?.(),
        classes: ["attested-stage-container", "git-adapter", "frozen-config"], nodes } }));
    }
  }
  const proc = Reflect.apply(spawn, Bun, args);
  if (typeof launch === "string") {
    if (launch.includes("brain-bridge-inventory-entry")) observeInventoryLaunch(proc);
    else if (bridgeDiagnostic.otherLaunches.length < 16) bridgeDiagnostic.otherLaunches.push({ atMs: diagnosticNow(),
      kind: launch.includes("node_modules/.bin/brain") ? "brain" : launch.includes("claude") ? "runtime" : "other" });
  }
  return proc;
} });
// Local diagnostic artifact only: fixed disposable fixture root, no contents or recursion.
function recordFixtureRootMetadata(phase: "before-app" | "after-app") {
  if (!sharedGit) return;
  const names = readdirSync("/brain-fixture/brain");
  if (names.length > 512) throw Error("FIXTURE_ROOT_METADATA_ENTRY_BOUND");
  const entries = names.sort().map(name => {
    const info = lstatSync(join("/brain-fixture/brain", name));
    return { name, uid: info.uid, gid: info.gid, mode: info.mode & 0o7777, dev: String(info.dev), ino: String(info.ino),
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other" };
  });
  const receipt = JSON.stringify({ localFixtureRootMetadata: { phase, entries } });
  if (Buffer.byteLength(receipt) > 65536) throw Error("FIXTURE_ROOT_METADATA_BYTE_BOUND");
  console.log(receipt);
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 30000;
  while (!check()) { if (Date.now() > deadline) throw Error(label); await Bun.sleep(10); }
}
try {
  if (sharedGit && !appOnly) {
    stage("git-consumer:start");
    const { captureSharedGitMaintenance } = await import("../shared-git-maintenance.native.js");
    await captureSharedGitMaintenance(brain, profile === "strict" ? "strict" : warm ? "warm" : "fresh");
    stage("git-consumer:done");
  }
  if (profile === "governed" && !warm && !appOnly && defaultIdentityPhase(process.argv.slice(2)) !== "fresh") {
    stage("stage-controls:start");
    const { captureMaintenanceStage } = await import("../maintenance-stage-provenance.native.js");
    await captureMaintenanceStage(brain);
    stage("stage-controls:done");
  }
  recordFixtureRootMetadata("before-app");
  if (dbRepeat) dbObservation = installDbRepeatObservation();
  if (bootPruneCapture) ownedBootPrune = installBootPruneCapture();
  stage("app-create:start");
  app = await createApp({ workerProfile: profile, config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: secret,
    HOST: "127.0.0.1", DB_PATH: join(data, "ui.db"), BRAIN_PATH: brain, NODE_ENV: "test", AGENT_BACKEND: "claude",
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0", BRAIN_UI_TURN_TIMEOUT_MS: "30000",
    BRAIN_UI_NATIVE_BRAIN_SOCKET: "/native-runtime/server-ws-manager.sock" }), registry: createStaticBackendRegistry([observedBackend], "claude"), observability });
  if (ownedBootPrune) { ownedBootPrune.capture(); stage("boot-prune:captured"); }
  stage("app-create:done");
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus inference", ttlSeconds: 3600 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  const cookie = await serializeSigned("brain_ui_session", principal.id, secret), frames: Array<Record<string, unknown>> = [];
  if (warm) {
    stage("warm-db:start");
    const { captureWarmMaintenanceDatabase } = await import("../maintenance-stage-provenance.native.js");
    await captureWarmMaintenanceDatabase(brain);
    stage("warm-db:done");
  }
  dbObservation?.begin(1);
  stage("index:start");
  const index = await fetch(`http://127.0.0.1:${server.port}/api/brain/index`, { method: "POST",
    headers: { cookie, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" }, body: "{}" });
  const indexed = await index.text();
  stage("index:done");
  console.log(JSON.stringify({ actualManagedIndex: { profile, warm, status: index.status, body: indexed },
    diagnostics: observability.logs.records().filter(log => String(log.body).includes("version probe failed") || String(log.body).includes("scratch prune failed")).map(log => ({ body: log.body, attributes: log.attributes })) }));
  expect(index.status, warm ? "ACTUAL_MANAGED_WARM_AUTHENTICATED_INDEX" : "ACTUAL_MANAGED_AUTHENTICATED_INDEX").toBe(200);
  expect(JSON.parse(indexed), "ACTUAL_MANAGED_AUTHENTICATED_INDEX_PUBLISHED").toEqual({ success: true });
  if (!sharedGit) {
    // The default composition indexes over the strict worker's persistent private publication (#2364).
    const retained = [".brain/scratch/private", ".brain/scratch/private/result.md"].map(path => {
      const info = lstatSync(join(brain, path)); return [info.uid, info.mode & 0o7777];
    });
    expect(retained, "ACTUAL_MANAGED_INDEX_OVER_PERSISTENT_STRICT_PRIVATE_OUTPUT").toEqual([[21001, 0o700], [21001, 0o600]]);
  }
  if (dbObservation) {
    dbObservation.published(1, index.status, JSON.parse(indexed));
    stage("repeat-index:start");
    const repeated = await repeatWarmIndex(dbObservation, server.port!, cookie);
    expect(repeated.status, "ACTUAL_MANAGED_REPEATED_WARM_AUTHENTICATED_INDEX").toBe(200);
    expect(repeated.body, "ACTUAL_MANAGED_REPEATED_WARM_INDEX_PUBLISHED").toEqual({ success: true });
    console.log(JSON.stringify({ actualRepeatedWarmIndex: { firstStatus: index.status, secondStatus: repeated.status,
      physicalStages: repeated.physicalStages, continuousBrainAndUiDatabase: true } }));
    stage("repeat-index:done");
  }
  const NativeWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
  stage("ws:start");
  socket = new NativeWebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${server.port}` } });
  socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
  await until(() => frames.some(frame => frame.type === "server_hello"), "REAL_SERVER_HELLO");
  socket.send(JSON.stringify({ type: "client_hello", protocolRev: 3, capabilities: { followUpQueue: true } }));
  socket.send(JSON.stringify({ type: "chat_message", text: "Plan the return to Ithaca.", providerId: "odysseus-haiku", requestId: "ithaca-ordinary" }));
  bridgeDiagnostic.chatSentMs = diagnosticNow();
  try { await until(() => frames.some(frame => frame.type === "result" || frame.type === "error"), "REAL_SERVER_NATIVE_TERMINAL"); }
  finally { printBridgeDiagnostic("terminal"); }
  await until(() => !app!.wsHost.coordinator.isTurnActive(), "REAL_SERVER_RELEASED_TURN");
  const admittedProfiles = app.db.query("SELECT profile FROM turn_governance_policy").all();
  expect(admittedProfiles, "ACTUAL_MANAGED_WS_SELECTED_PROFILE").toEqual(Array.from({ length: warm ? 2 : 1 }, () => ({ profile })));
  expect(backendProfiles, "ACTUAL_MANAGED_WS_BACKEND_SANDBOX").toEqual([profile]);
  console.log(JSON.stringify({ profile, warm, admittedProfiles, backendProfiles, requests, terminal: frames.filter(frame => frame.type === "result" || frame.type === "error"),
    limitations: observability.logs.records().filter(log => log.severity === "WARN" || String(log.body).includes("governed profile is unavailable")).map(log => log.body) }));
  const terminalTurnId = frames.find(frame => frame.type === "result" || frame.type === "error")?.turnId;
  console.log(JSON.stringify({ actualManagedAdmission: { profile, warm, reads: admissionReads,
    egress: app.db.query(`SELECT json_extract(payload,'$.method') method, json_extract(payload,'$.host') host,
      json_extract(payload,'$.outcome') outcome, json_extract(payload,'$.reason') reason
      FROM governance_events WHERE turn_id=? AND kind='egress_connection' ORDER BY id DESC LIMIT 16`).all(String(terminalTurnId ?? "")) } }));
  expect(requests, "ACTUAL_MANAGED_WS_NATIVE_REQUEST").toEqual([{ model: "claude-haiku-4-5", history: 1, apiCredential: true }]);
  expect(frames.some(frame => frame.type === "result" && frame.outcome === "success"), "ACTUAL_MANAGED_WS_NATIVE_RESULT").toBe(true);
  expect(frames.some(frame => frame.type === "error"), "ACTUAL_MANAGED_WS_ADMISSION_NO_ERROR").toBe(false);
  const unavailable = observability.logs.records().filter(log => String(log.body).includes("the governed profile is unavailable"));
  expect(unavailable, "ACTUAL_MANAGED_GOVERNED_MAINTENANCE_STAGE_READY").toEqual([]);
  stage("ws:done");
  if (sharedGit) {
    stage("prune-join:start");
    if (ownedBootPrune) await ownedBootPrune.join();
    else {
      expect(typeof app.wsHost.scratchPrune, "SHARED_GIT_OWNED_MAINTENANCE_JOIN_AVAILABLE").toBe("function");
      await app.wsHost.scratchPrune!();
    }
    stage("prune-join:done");
    console.log(JSON.stringify({ actualOwnedScratchPruneJoined: { profile, warm } }));
  }
} finally { try {
  stage("cleanup:start");
  try { socket?.close(); } finally {
    try { server?.stop(true); } finally {
      try { await app?.close(); } finally { provider.stop(true); }
    }
  }
  stage("cleanup:done");
  printBridgeDiagnostic("cleanup");
  recordFixtureRootMetadata("after-app");
  console.log(JSON.stringify({ actualMaintenanceFinalDiagnostics: observability.logs.records().filter(log => String(log.body).includes("version probe failed") || String(log.body).includes("scratch prune failed")).map(log => ({ body: log.body, attributes: log.attributes })) }));
  if (sharedGit) expect(observability.logs.records().filter(log => String(log.body).includes("version probe failed") || String(log.body).includes("scratch prune failed")),
    "SHARED_GIT_FRESH_WARM_CLI_SCRATCH_DIAGNOSTICS_CLEAN").toEqual([]);
  } finally { try { dbObservation?.restore(); } finally { try { ownedBootPrune?.restore(); } finally { Object.defineProperty(Bun, "spawn", spawnDescriptor); } } } }
