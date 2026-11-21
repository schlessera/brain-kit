import { captureNativeReceipts } from "../../../../scripts/native-test-receipts.ts";
import "../../../../scripts/test-network-child-preload.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { defaultIdentityPhase } from "./default-identity-phases.js";
import { installDbRepeatObservation, repeatWarmIndex } from "./db-repeat-observation.js";
import { installBootPruneCapture } from "./boot-prune-capture.js";
/** Real managed-server admission and native SDK turn; explicit fictional API profile. */
import { expect } from "bun:test";
import { lstatSync, mkdirSync, statSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../../../ui-server/src/app.js";
import { resolveServerConfig } from "../../../ui-server/src/config/env.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createRecordingObservability } from "../../../ui-server/src/observability/index.js";
import { createPrincipal } from "../../../ui-server/src/db/principals.js";
import { createClaudeBackend } from "../../../ui-backend-claude/src/backend.js";
import { nativeModelReply } from "../../../ui-backend-claude/tests/helpers/native-model-reply.js";
import { serializeSigned } from "hono/utils/cookie";
import { bundledClaudeBinary } from "../../../core/src/providers/agents/claude-binary.js";
import { nativeScriptedService, nativeScriptedQuery } from "../../../../scripts/test-native-guard.ts";

import { observeNativeWorkerStartup } from "./native-worker-startup-diagnostics.js";
import type { LaunchedWorker } from "../../src/server/worker-launcher.js";
import { isNativeClaude } from "../../../../scripts/test-native-guard.ts";
const nativeBootstraps=new Map<number,Bun.Subprocess>();

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
// Temporary diagnosis of the fresh separate-UID startup; only sanitized tails persist.
if (defaultIdentityPhase(process.argv.slice(2)) === "fresh") process.argv.push(`--native-identity-startup-audit=${data}`);
// Actual separate-UID fixture: directory metadata is shared, file bytes are not.
const privateRoot=join(brain,"private");
if (existsSync(privateRoot)) {
  expect(process.getuid?.(),"PRIVATE_FIXTURE_GUARD_UID").toBe(21001);
  expect(lstatSync(privateRoot).uid,"PRIVATE_FIXTURE_OWNER_UID").toBe(21002);
  expect(lstatSync(privateRoot).mode & 0o007,"PRIVATE_FIXTURE_NO_WORLD_ACCESS").toBe(0);
  const privateEntries=readdirSync(privateRoot);
  expect(privateEntries,"PRIVATE_FIXTURE_PROVENANCE_TRAVERSABLE").toContain("result.md");
  const privateFile=join(privateRoot,privateEntries.includes(".gitattributes")?".gitattributes":"result.md");
  let readError: string | undefined;
  try {readFileSync(privateFile);} catch(error) {readError=(error as NodeJS.ErrnoException).code;}
  expect(readError,"PRIVATE_FIXTURE_CONTENTS_STAY_WORKER_ONLY").toBe("EACCES");
  const runtime=bundledClaudeBinary();if(!runtime)throw Error("installed SDK identity unavailable");
  // Plan only: no native process launches. The registered root is exercised by
  // the real turn below; the same accessible, unregistered root must refuse.
  const refusalReceipts=captureNativeReceipts();
  const refused=Bun.spawnSync([process.execPath,"-e",`
    import {nativeWorkerBoundary,nativeScriptedService} from "/repo/scripts/test-native-guard.ts";
    const spawnSync=Bun.spawnSync,which=Bun.which;
    Bun.which=((command,options)=>command==="strace"?"/synthetic/strace":which(command,options));
    Bun.spawnSync=((argv,options)=>(["bwrap","strace"].includes(argv[0])||argv[0]?.endsWith("/native-connect"))?{exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}:Reflect.apply(spawnSync,Bun,[argv,options]));
    process.env.GITHUB_ACTIONS="true";process.env.RUNNER_ENVIRONMENT="github-hosted";
    nativeScriptedService("http://127.0.0.1:1",{fixtureRoots:[${JSON.stringify(home)}]});
    nativeWorkerBoundary({BRAIN_WORKER_LAUNCH:JSON.stringify({command:["/usr/bin/true",${JSON.stringify(runtime)}],brainPath:${JSON.stringify(home)},env:{HOME:${JSON.stringify(home)}},argv:["bwrap","--ro-bind",${JSON.stringify(privateRoot)},"/tmp/odysseus-private","--","/usr/bin/true",${JSON.stringify(runtime)}]})});
  `],{env:{...process.env,...refusalReceipts.env},stdout:"pipe",stderr:"pipe"});
  const refusalText=refused.stderr.toString()+refusalReceipts.read();refusalReceipts.dispose();
  expect(refused.exitCode,"PRIVATE_FIXTURE_UNREGISTERED_ROOT_REFUSES").not.toBe(0);
  expect(refusalText).toContain("worker bind was not created or staged by the fixture");
  expect(refusalText).toContain('"nativeLaunched":false');
}
const requests: Array<{ model: string; history: number; apiCredential: boolean }> = [];
// Native worker calls this loopback provider directly. The outer Docker network
// namespace has no external route; no fetch implementation or native SDK is mocked.
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; messages: unknown[] };
  requests.push({ model: body.model, history: body.messages.length, apiCredential: request.headers.get("x-api-key") === "odysseus-fictional-api-key" });
  return nativeModelReply();
} });
nativeScriptedService(provider.url.origin, { fixtureRoots: [brain, home] });
const backend = createClaudeBackend({ brainPath: brain, queryFn: nativeScriptedQuery(query, provider.url.origin), profiles: [{ id: "odysseus-haiku", label: "Odysseus Haiku", billing: "api",
  requiredEnvKeys: [], model: "claude-haiku-4-5", buildEnv: () => ({ ANTHROPIC_BASE_URL: provider.url.origin,
    ANTHROPIC_API_KEY: "odysseus-fictional-api-key", HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/local/bin:/usr/bin:/bin",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }) }], log() {} });
const backendProfiles: Array<string | undefined> = [];
const admissionReads: Array<ReturnType<NonNullable<Parameters<typeof backend.startTurn>[0]["bridge"]["admissionSafety"]>["read"]>> = [];
const observedBackend = { ...backend, startTurn(request: Parameters<typeof backend.startTurn>[0]) {
  nativeScriptedService(provider.url.origin, { fixtureRoots: [brain, home] });
  backendProfiles.push(request.workerSandbox?.profile);
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
  const started=request.workerStarted;
  request.workerStarted=worker=>{
    started?.(worker);
    // The existing callback receives the full worker at runtime; its public
    // request type intentionally exposes only control/lifecycle operations.
    const full=worker as LaunchedWorker,bootstrap=nativeBootstraps.get(full.pid);
    if(bootstrap)observeNativeWorkerStartup(full,bootstrap,[secret,"odysseus-fictional-api-key"]);
  };
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
  const child=Reflect.apply(spawn, Bun, args) as Bun.Subprocess;
  if(launch) {
    const command=JSON.parse(launch).command as string[]|undefined;
    if(command?.[0] && isNativeClaude(command[0],command.slice(1))) {
      nativeBootstraps.set(child.pid,child);
      void child.exited.then(code=>console.error(JSON.stringify({kind:"native-fixture-bootstrap-exit",exitCode:code,signal:child.signalCode})),
        ()=>console.error(JSON.stringify({kind:"native-fixture-bootstrap-exit",exitCode:null,signal:child.signalCode})));
    }
  }
  return child;
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
  await until(() => frames.some(frame => frame.type === "result" || frame.type === "error"), "REAL_SERVER_NATIVE_TERMINAL");
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
  recordFixtureRootMetadata("after-app");
  console.log(JSON.stringify({ actualMaintenanceFinalDiagnostics: observability.logs.records().filter(log => String(log.body).includes("version probe failed") || String(log.body).includes("scratch prune failed")).map(log => ({ body: log.body, attributes: log.attributes })) }));
  if (sharedGit) expect(observability.logs.records().filter(log => String(log.body).includes("version probe failed") || String(log.body).includes("scratch prune failed")),
    "SHARED_GIT_FRESH_WARM_CLI_SCRATCH_DIAGNOSTICS_CLEAN").toEqual([]);
  } finally { try { dbObservation?.restore(); } finally { try { ownedBootPrune?.restore(); } finally { Object.defineProperty(Bun, "spawn", spawnDescriptor); } } } }
