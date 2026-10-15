import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { linkSync, openSync, closeSync, readlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { observeIndexDescendants } from "./native-worker-lifetime.js";
import { nativeReleaseObservations } from "./native-release-observation.js";
import { Database } from "bun:sqlite";

const SOURCE = "/repo";
const ARTIFACTS = "/proof/run";
const BACKEND = process.env.BRAIN_NATIVE_PROOF_BACKEND ?? "claude";
if (!["claude","pi"].includes(BACKEND)) throw Error("Unknown native backend proof selection");
const APP_UID = Number(process.env.BRAIN_NATIVE_PROOF_APP_UID ?? "1000");
if (![0,1000].includes(APP_UID)) throw Error("Unknown native app UID proof selection");
const DESCENDANT_CONTROL = BACKEND === "pi" && APP_UID === 0;
const RETAIN_INDEX_NAMESPACE = process.env.BRAIN_NATIVE_PROOF_RETAIN_INDEX_NAMESPACE === "1";
if (RETAIN_INDEX_NAMESPACE && !DESCENDANT_CONTROL) throw Error("Namespace retention reproduction requires Pi UID 0");
const releaseObservations = nativeReleaseObservations(ARTIFACTS);
let releasePinnedNamespace: (() => void) | undefined;
const recordedSpawn = Bun.spawn;
Bun.spawn = ((...args: any[]) => { const argv = Array.isArray(args[0]) ? args[0] : args[0].cmd; const native = argv[0]?.endsWith("/btrfs") || argv[0]?.endsWith("/python3"); const observeRelease = releaseObservations.prepare(argv); const start = performance.now(), child = Reflect.apply(recordedSpawn, Bun, args); observeRelease?.(child); if (native) { const command = argv[0].endsWith("/btrfs") ? argv.slice(1) : ["identity-inspect"]; appendFileSync(join(ARTIFACTS, "native-operations.jsonl"), JSON.stringify({ stage: "start", at: start, wallAt: Date.now(), command }) + "\n"); void child.exited.then((code: number) => { if (code !== 0 && argv[1] === "subvolume" && argv[2] === "sync") releasePinnedNamespace?.(); return appendFileSync(join(ARTIFACTS, "native-operations.jsonl"), JSON.stringify({ stage: "end", at: performance.now(), wallAt: Date.now(), ms: performance.now() - start, code, command }) + "\n"); }); } return child; }) as typeof Bun.spawn;
afterAll(async () => { try { await releaseObservations.close(); } finally { Bun.spawn = recordedSpawn; } });
const { serializeSigned } = await import(join(SOURCE, "node_modules/hono/dist/utils/cookie.js"));
const NativeWebSocket = WebSocket as any;
const sleep = (ms: number) => Bun.sleep(ms);
async function until(check: () => boolean, deadlineMs = 20000) {
  const end = performance.now() + deadlineMs;
  while (!check()) { if (performance.now() > end) throw Error("Probe wait deadline exceeded"); await sleep(10); }
}
test(`native hosted ${BACKEND} uid ${APP_UID} first/warm admission, health, WebSocket, Stop and cancellation`, async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const dir = join(ARTIFACTS, "appdata"); mkdirSync(dir);
  const brain = "/brain-fixture/brain";
  for (const path of ["notes", "node_modules/.bin", ".brain/scratch", "context/policies"]) mkdirSync(join(brain, path), { recursive: true });
  for (const path of ["home", "agent", "pi"]) mkdirSync(join(dir, path));
  writeFileSync(join(dir, "agent/settings.json"), "{}");
  writeFileSync(join(brain, ".gitignore"), "node_modules/\n.brain/\n");
  writeFileSync(join(brain, "brain.config.ts"), 'export default {profile:{name:"Odysseus",cliTitle:"Odysseus notebook"}};\n');
  // Real installed CLI source; this executable shim adds no mock logic.
  const cli = join(brain, "node_modules/.bin/brain");
  const authorityProgram = readFileSync(join(import.meta.dir,"worker-authority.py"),"utf8");
  // The fixed witness runs inside the actual automatic index maintenance worker.
  writeFileSync(cli, `#!/usr/bin/env bun\nif(Bun.argv[2]==="index"){const probe=Bun.spawnSync(["/usr/bin/python3","-I","-S","-c",${JSON.stringify(authorityProgram)},${JSON.stringify(String(APP_UID))},"maintenance",${JSON.stringify(DESCENDANT_CONTROL ? "cwd-descendant" : "")}],{stdout:"pipe",stderr:"pipe"});if(probe.exitCode!==0)throw Error(probe.stderr.toString());await Bun.write((process.env.BRAIN_WORKER_DATA_ROOT??".")+"/.brain/maintenance-authority.json",probe.stdout);}await import(${JSON.stringify(join(SOURCE, "packages/core/src/cli/brain.ts"))});\n`); chmodSync(cli, 0o755);
  const FILES = 2000, BYTES = 16384;
  for (let i = 0;i < FILES;i++) {
    const header = `---\ntype: note\ntitle: Odysseus voyage ${i}\nupdated: 2026-07-12\n---\nOdysseus charts Ithaca ${i}.\n`;
    const motif = "Athena marks the voyage. ";
    writeFileSync(join(brain, "notes", `voyage-${String(i).padStart(4, "0")}.md`), header + motif.repeat(Math.ceil((BYTES - header.length) / motif.length)).slice(0, BYTES - header.length));
  }
  const git = Bun.spawnSync(["git", "init", "--quiet", brain], { env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home") } });
  expect(git.exitCode, "OFFLINE_FIXTURE_GIT_INITIALIZED").toBe(0);
  const { serveNativeBrainManager } = await import(join(SOURCE, "packages/ui-sdk/src/server/native-brain-manager.ts"));
  const { hostOutputStagingLimits } = await import(join(SOURCE, "packages/ui-sdk/src/server/worker-state-limits.ts"));
  // The app child supplies no staging overrides; use the same existing defaults.
  const staging = hostOutputStagingLimits({});
  const show = Bun.spawnSync(["btrfs", "subvolume", "show", brain], { stdout: "pipe", stderr: "pipe" }); expect(show.exitCode).toBe(0);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show.stdout.toString())![1]!.replaceAll("-", "");
  const fs = Bun.spawnSync(["btrfs", "filesystem", "show", "/brain-fixture"], { stdout: "pipe", stderr: "pipe" }); expect(fs.exitCode).toBe(0);
  const fsid = /uuid:\s*([0-9a-f-]+)/.exec(fs.stdout.toString())![1]!;
  mkdirSync("/native-runtime", { mode: 0o755, recursive: true });
  const socket = "/native-runtime/manager.sock";
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath: socket,
    appUid: APP_UID, appGid: APP_UID, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  const permissions = Bun.spawnSync(["chown", "-R", `${APP_UID}:${APP_UID}`, dir, brain]); expect(permissions.exitCode).toBe(0);
  const child = Bun.spawn(["/usr/bin/setpriv", `--reuid=${APP_UID}`, `--regid=${APP_UID}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", process.execPath, "--preload", join(SOURCE, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "hosted-app-child.ts"), SOURCE, dir, brain, socket, BACKEND], {
    cwd: SOURCE,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "pi"), NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe"
  });
  const descendants = DESCENDANT_CONTROL ? observeIndexDescendants(ARTIFACTS, { retainMountNamespace: RETAIN_INDEX_NAMESPACE }) : undefined;
  releasePinnedNamespace = () => descendants?.releaseNamespace();
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  let exited = false; void child.exited.then(() => { exited = true; });
  const sockets: WebSocket[] = [], results: any[] = [];
  let receipt: any;
  let cleanExit = false;
  let hostProofPassed = false;
  try {
    await until(() => existsSync(join(dir, "ready.json")) || exited, 30000);
    if (exited) throw Error(`HOSTED_PROBE_PREREQUISITE: ${await errors}`);
    const ready = JSON.parse(readFileSync(join(dir, "ready.json"), "utf8"));
    expect(ready.rootWarnings.length, "NATIVE_ROOT_APP_WARNED_ONCE_AT_BOOT").toBe(APP_UID === 0 ? 1 : 0);
    const origin = `http://127.0.0.1:${ready.port}`;
    const cookie = await serializeSigned("brain_ui_session", ready.principalId, ready.secret);
    const status = await fetch(origin + "/api/status", { headers: { cookie } }).then(r => r.json()) as any;
    expect(status.runtime.workerHost.ordinary?.available, "NATIVE_BOOT_ORDINARY_WORKER_HEALTHY").toBe(true);
    expect(status.runtime.workerHost.governed, "NATIVE_BOOT_MAINTENANCE_GOVERNED_HEALTHY").toMatchObject({ available: true, profile: "governed", hostExecution: "worker" });
    expect(status.runtime.workerHost.rootServer?.warning ?? null, "NATIVE_ROOT_APP_PRESERVES_STATUS_WARNING").toBe(APP_UID === 0 ? ready.rootWarnings[0] : null);
    async function device() {
      const frames: any[] = [];
      const ws: WebSocket = new NativeWebSocket(origin.replace("http", "ws") + "/ws", { headers: { cookie, origin } }); sockets.push(ws);
      ws.addEventListener("message", ev => { const frame = { ...JSON.parse(String(ev.data)), receiptAt: performance.now() }; frames.push(frame); appendFileSync(join(ARTIFACTS, "frames.jsonl"), JSON.stringify(frame) + "\n"); });
      await until(() => frames.some(f => f.type === "server_hello"));
      ws.send(JSON.stringify({ type: "client_hello", protocolRev: 3, capabilities: { followUpQueue: true } }));
      return { ws, frames };
    }
    let sender = await device();
    const observer = await device();
    let sid: string | undefined;
    for (const phase of ["first", "warm"] as const) {
      const requestId = `odysseus-${phase}-admission`, begin = performance.now();
      const health: any[] = [], pings: any[] = [];
      let stop = false;
      const probe = (async () => {
        while (!stop) {
          const start = performance.now();
          try {
            const response = await fetch(origin + "/api/health", { headers: { cookie }, signal: AbortSignal.timeout(1000) });
            health.push({ elapsedMs: performance.now() - start, status: response.status, timeout: false }); await response.body?.cancel();
          } catch (error) { health.push({ elapsedMs: performance.now() - start, timeout: true, error: String(error) }); }
          await sleep(50);
        }
      })();
      const pingTimer = setInterval(() => {
        const id = `${phase}-${pings.length}`, at = performance.now(); pings.push({ id, at });
        observer.ws.send(JSON.stringify({ type: "ping", probeId: id }));
      }, 100);
      sender.ws.send(JSON.stringify({
        type: "chat_message", text: `Odysseus requests the ${phase} voyage record on 2026-07-12.`, requestId,
        draftId: phase === "first" ? "odysseus-first-chat" : undefined, sessionId: sid
      }));
      let completed = true;
      let durableAckMs: number | null = null;
      let ackRecovery: any = null;
      let recovery: any = null;
      let phaseError: string | null = null;
      try {
        await until(() => sender.frames.some(f => f.type === "session_info" && f.requestId === requestId), 45000);
        const ack = sender.frames.find(f => f.type === "session_info" && f.requestId === requestId)!;
        expect(ack.workerProfile?.actualProfile, "NATIVE_ADMITTED_GOVERNED_PROFILE").toBe("governed");
        sid = ack.sessionId;
        ackRecovery = await fetch(origin + `/api/sessions/${sid}/recovery`, { headers: { cookie }, signal: AbortSignal.timeout(1000) }).then(r => r.json());
        durableAckMs = performance.now() - begin;
        await until(() => sender.frames.some(f => f.type === "result" && f.receiptAt >= begin && f.sessionId === (sid ?? f.sessionId)) || sender.frames.some(f => f.type === "error" && f.receiptAt >= begin && f.requestId === requestId), 45000);
        // Visible result/journal frames precede final durable settlement and slot release.
        await until(() => sender.frames.some(f => f.type === "turn_journal" && f.turnId === ack.turnId && f.journal?.state === "complete") &&
          readFileSync(join(dir,"events.jsonl"),"utf8").trim().split("\n").map(line => JSON.parse(line)).some(row => row.kind === "session_slot_released" && row.turnId === ack.turnId),10000);
        expect(sender.frames.filter(f => f.type === "turn_journal" && f.turnId === ack.turnId).every(f => f.journal?.profile === "governed"), "NATIVE_JOURNAL_GOVERNED_PROFILE").toBe(true);
        recovery = await fetch(origin + `/api/sessions/${sid}/recovery`, { headers: { cookie }, signal: AbortSignal.timeout(1000) }).then(r => r.json());
      }
      catch (error) { completed = false; phaseError = String(error); }
      finally { stop = true; clearInterval(pingTimer); await probe; }
      const named = sender.frames.find(f => f.type === "session_info" && f.requestId === requestId);
      sid = named?.sessionId ?? sid;
      await sleep(200);
      const pongs = observer.frames.filter(f => f.type === "pong" && f.probeId?.startsWith(phase + "-"));
      const terminal = sender.frames.filter(f => (f.type === "result" || f.type === "error") && f.receiptAt >= begin);
      results.push({
        phase, completed, health, timeoutCount: health.filter(p => p.timeout).length, submitToAckMs: named ? named.receiptAt - begin : null,
        elapsedMs: performance.now() - begin, durableAckMs, ackRecovery, phaseError, pings: pings.length, pongs: pongs.length,
        pingLatencyMs: pongs.map(f => f.receiptAt - pings.find(p => p.id === f.probeId)!.at), recovery, terminal
      });
      if (!completed) break;
      if (phase === "first") {
        sender.ws.close();
        await until(() => sender.ws.readyState === WebSocket.CLOSED);
        sender = await device();
        sender.ws.send(JSON.stringify({ type: "session_resume", sessionId: sid }));
        await until(() => sender.frames.some(f => f.type === "session_info" && f.sessionId === sid));
        const recovered = await fetch(origin + `/api/sessions/${sid}/recovery`, { headers: { cookie }, signal: AbortSignal.timeout(1000) }).then(r => r.json());
        expect(recovered.latest?.requestId, "RECONNECT_RECOVERS_SAME_ACCEPTED_REQUEST").toBe(requestId);
        expect(recovered.latest?.state, "RECONNECT_RECOVERS_TERMINAL_REQUEST").toBe("terminal");
        await sleep(200);
        expect(readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"fake_provider_enter"')).length, "RECOVERY_READ_DID_NOT_EXECUTE_AGAIN").toBe(1);
      }
    }
    expect(results.every(r => r.timeoutCount === 0 && r.health.every((p: any) => p.status === 200 && p.elapsedMs <= 1000)), "HOSTED_ADMISSION_HEALTH_WITHIN_1_SECOND").toBe(true);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.completed && r.submitToAckMs !== null && r.submitToAckMs < 10000 && r.durableAckMs !== null && r.durableAckMs < 10000), "FIRST_AND_WARM_ADMISSION_WITHIN_10_SECONDS").toBe(true);
    expect(results.every(r => r.pings > 0 && r.pings === r.pongs && r.pingLatencyMs.every((ms: number) => ms < 1000)), "HOSTED_ADMISSION_WEBSOCKET_WITHIN_1_SECOND").toBe(true);
    for (const result of results) {
      const requestId = `odysseus-${result.phase}-admission`;
      expect(result.ackRecovery?.latest?.requestId, "NAMED_ACK_HAS_DURABLE_REQUEST_RECORD").toBe(requestId);
      expect(result.recovery?.latest?.state, "FIRST_AND_WARM_DURABLE_TERMINAL_RECOVERY").toBe("terminal");
      expect(result.recovery?.latest?.requestId, "FIRST_AND_WARM_RECOVERY_MATCHES_REQUEST").toBe(requestId);
      expect(result.recovery?.latest?.outcome, "FIRST_AND_WARM_SUCCESSFUL_RECOVERY").toBe("success");
      const attempt = result.phase === "first" ? 1 : 2;
      expect(existsSync(join(brain, `notes/worker-${attempt}.md`)), "REAL_ISOLATED_WORKER_WROTE_FIRST_AND_WARM_NOTES").toBe(true);
      const authority = JSON.parse(readFileSync(join(brain, `.brain/worker-authority-${attempt}.json`), "utf8"));
      expect(authority.namespaceUid, "NATIVE_AGENT_NAMESPACE_UID").toBe(APP_UID);
      expect(authority.ioctlsDenied).toHaveLength(7);
    }
    expect(readFileSync(join(dir,"events.jsonl"),"utf8").split("\n").filter(line => line.includes('"whole_brain_alias_scan"')), "NO_WHOLE_BRAIN_ADMISSION_WALK").toHaveLength(0);
    const cancelStart = performance.now();
    sender.ws.send(JSON.stringify({ type: "chat_message", text: "Odysseus requests a cancellable voyage record on 2026-07-12.", requestId: "odysseus-stop", sessionId: sid }));
    await until(() => existsSync(join(brain,"notes/worker-3.md")) && existsSync(join(dir, "events.jsonl")) && readFileSync(join(dir, "events.jsonl"), "utf8").includes('"attempt":3'), 15000);
    const cancelSentAt = performance.now();
    sender.ws.send(JSON.stringify({ type: "cancel", sessionId: sid }));
    await until(() => sender.frames.some(f => f.receiptAt >= cancelStart && ((f.type === "status" && f.status === "idle") || f.type === "result" || f.type === "error")), 15000);
    const cancelFrames = sender.frames.filter(f => f.receiptAt >= cancelStart), cancelElapsedMs = performance.now() - cancelStart;
    expect(cancelElapsedMs, "HOSTED_STOP_INTERRUPT_WITHIN_DEADLINE").toBeLessThan(15000);
    await until(() => sender.frames.some(f => f.type === "result" && f.outcome === "cancelled" && f.receiptAt >= cancelStart), 15000);
    expect(performance.now() - cancelSentAt, "HOSTED_STOP_TERMINAL_WITHIN_2_SECONDS").toBeLessThan(2000);
    const stoppedWorker = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.kind === "worker_exit" && row.attempt === 3);
    expect(stoppedWorker?.code, "HOSTED_STOP_KILLED_REAL_SLEEPING_WORKER").toBe(BACKEND === "pi" ? 137 : null);
    const stoppedTurnId = sender.frames.find(f => f.type === "result" && f.outcome === "cancelled" && f.receiptAt >= cancelStart)!.turnId;
    await until(() => readFileSync(join(dir,"events.jsonl"),"utf8").trim().split("\n").map(line => JSON.parse(line)).some(row => row.kind === "session_slot_released" && row.turnId === stoppedTurnId),10000);
    const admissionCancelStart = performance.now(), attemptBefore = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"fake_provider_enter"')).length;
    sender.ws.send(JSON.stringify({ type: "chat_message", text: "Odysseus requests an immediately cancelled voyage record.", requestId: "odysseus-cancel-admission", sessionId: sid }));
    sender.ws.send(JSON.stringify({ type: "cancel", sessionId: sid }));
    await until(() => sender.frames.some(f => f.receiptAt >= admissionCancelStart && ((f.type === "status" && f.requestId === "odysseus-cancel-admission" && ["idle", "cancelled"].includes(f.status)) || (f.type === "request_dropped" && f.requestId === "odysseus-cancel-admission"))), 15000);
    await sleep(500);
    const attemptsAfter = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"fake_provider_enter"')).length;
    expect(attemptsAfter, "HOSTED_CANCEL_ADMISSION_NEVER_ENTERED_PROVIDER").toBe(attemptBefore);
    const admissionCancelElapsedMs = performance.now() - admissionCancelStart;
    const beforeUnnamed = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"governed_begin_start"')).length;
    const unnamedStart = performance.now();
    sender.ws.send(JSON.stringify({ type: "chat_message", text: "Odysseus cancels before naming a voyage.", requestId: "odysseus-unnamed-cancel", draftId: "odysseus-unnamed-draft" }));
    await until(() => readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"governed_begin_start"')).length > beforeUnnamed, 10000);
    sender.ws.send(JSON.stringify({ type: "cancel" }));
    await until(() => sender.frames.some(f => f.receiptAt >= unnamedStart && f.type === "status" && f.status === "cancelled" && f.requestId === "odysseus-unnamed-cancel"), 10000);
    await sleep(200);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(line => line.includes('"fake_provider_enter"')).length, "UNNAMED_CANCEL_NEVER_ENTERED_PROVIDER").toBe(attemptBefore);
    // Drain the real queued refresh before shutdown intentionally discards pending work.
    await until(() => {
      const events = readFileSync(join(dir,"events.jsonl"),"utf8").trim().split("\n").map(line => JSON.parse(line));
      const failed = events.find(row => row.kind === "automatic_index_failed");
      if (failed) throw Error(`NATIVE_AUTOMATIC_INDEX_COMPLETED: ${failed.error}`);
      const warm = events.find(row => row.kind === "worker_exit" && row.attempt === 2);
      // index() acquires its complete native input after this observed invocation.
      return warm && events.some(start => start.kind === "automatic_index_started" && start.at > warm.at &&
        events.some(end => end.kind === "automatic_index_finished" && end.ordinal === start.ordinal));
    }, 90000);
    if (descendants) {
      const lifetime = descendants.result();
      expect(lifetime.truncated, "NATIVE_INDEX_DESCENDANT_WITNESS_NOT_TRUNCATED").toBe(false);
      expect(lifetime.records.length, "NATIVE_INDEX_ACTUALLY_STARTED_DETACHED_DESCENDANTS").toBeGreaterThanOrEqual(2);
      expect(lifetime.records.every(row => row.deadObservedWallAt !== undefined), "NATIVE_INDEX_DESCENDANTS_DRAIN_BEFORE_RELEASE_COMPLETES").toBe(true);
    }
    const sizes = Object.fromEntries(["ui.db", "ui.db-wal", "ui.db-shm"].map(name => [name, existsSync(join(dir, name)) ? statSync(join(dir, name)).size : 0]));
    receipt = {
      source: SOURCE, backend: BACKEND, appUid: APP_UID, bootWorkerHost: status.runtime.workerHost, cancelElapsedMs, cancelFrames, admissionCancelElapsedMs, files: FILES, generatedBytes: FILES * BYTES, sizes, results,
      workerFiles: readdirSync(join(brain, "notes")).filter(name => name.startsWith("worker-")), events: readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(value => JSON.parse(value))
    };
    writeFileSync(join(ARTIFACTS, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ ...receipt, results: results.map(r => ({ ...r, health: { count: r.health.length, timeoutCount: r.timeoutCount, maxMs: Math.max(...r.health.map((p: any) => p.elapsedMs)) } })) }));
    expect(receipt.workerFiles, "REAL_ISOLATED_WORKER_EXECUTED_FIRST_WARM_AND_CANCEL").toHaveLength(3);
    hostProofPassed = true;
  } finally {
    for (const socket of sockets) socket.close();
    writeFileSync(join(ARTIFACTS, "phase-progress.json"), JSON.stringify(results, null, 2));
    const shutdownStartedAt = performance.now();
    if (!exited) child.kill("SIGTERM");
    let forcedCleanup = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([child.exited, new Promise<number>(resolve => {
      cleanupTimer = setTimeout(() => { forcedCleanup = true; child.kill("SIGKILL"); void child.exited.then(resolve); }, 45000);
    })]);
    clearTimeout(cleanupTimer);
    descendants?.close();
    releasePinnedNamespace = undefined;
    cleanExit = code === 0 && !forcedCleanup;
    writeFileSync(join(ARTIFACTS, "cleanup.json"), JSON.stringify({ code, forcedCleanup, shutdownElapsedMs: performance.now() - shutdownStartedAt }));
    writeFileSync(join(ARTIFACTS, "host-output.txt"), await output); writeFileSync(join(ARTIFACTS, "host-errors.txt"), await errors);
    if (existsSync(join(dir, "boot-error.txt"))) writeFileSync(join(ARTIFACTS, "boot-error.txt"), readFileSync(join(dir, "boot-error.txt")));
    if (existsSync(join(dir, "events.jsonl"))) writeFileSync(join(ARTIFACTS, "events.jsonl"), readFileSync(join(dir, "events.jsonl")));
    try {
      if (code === 0 && receipt && hostProofPassed) {
        // The closed app has drained refresh work; no live reader can mutate SQLite sidecars.
        const index = new Database(join(brain, "brain.db"), { readonly: true });
        try {
          for (const attempt of [1,2]) {
            const row = index.query("SELECT path, content FROM documents WHERE path = ?").get(`notes/worker-${attempt}.md`) as { path: string; content: string } | null;
            expect(row?.content ?? "", "NATIVE_AUTOMATIC_INDEX_PUBLISHED_FIRST_AND_WARM_NOTES").toContain(BACKEND === "pi" ? "Odysseus marks the actual Pi worker." : "Odysseus marks the actual worker.");
          }
        } finally { index.close(); }
        expect(existsSync(join(brain,".brain/maintenance-authority.json")), "NATIVE_AUTOMATIC_INDEX_AUTHORITY_PUBLISHED").toBe(true);
        const maintenanceAuthority = JSON.parse(readFileSync(join(brain,".brain/maintenance-authority.json"),"utf8"));
        expect(maintenanceAuthority.namespaceUid, "NATIVE_MAINTENANCE_NAMESPACE_UID").toBe(0);
        expect(maintenanceAuthority.ioctlsDenied).toHaveLength(7);
        expect(maintenanceAuthority.nestedUsernsDenied, "NATIVE_MAINTENANCE_NESTED_USERNS_DENIED").toBe(true);
        expect(maintenanceAuthority.quotaWriteDenied, "NATIVE_MAINTENANCE_QUOTA_WRITE_DENIED").toBe(true);
        expect(maintenanceAuthority.siblingWriteDenied, "NATIVE_MAINTENANCE_SIBLING_SYSCTL_WRITE_DENIED").toBe(true);
        const workerLaunches = readFileSync(join(ARTIFACTS,"events.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.kind==="app_spawn_start"&&row.tail.some((value:string)=>value.endsWith("/ui-sdk/src/server/worker-entry.ts")));
        expect(workerLaunches.length, "NATIVE_REAL_AGENT_AND_MAINTENANCE_WORKERS_LAUNCHED").toBeGreaterThanOrEqual(3);
        expect(workerLaunches.every(row=>row.kernelUid===APP_UID), "NATIVE_WORKERS_KEEP_FIXED_KERNEL_UID").toBe(true);
        writeFileSync(join(ARTIFACTS, "worker-authority.json"), JSON.stringify({maintenance: maintenanceAuthority, agents: [1,2,3].map(attempt => JSON.parse(readFileSync(join(brain, `.brain/worker-authority-${attempt}.json`), "utf8")))}, null, 2));
        const db = new Database(join(dir, "ui.db"), { readonly: true });
        try {
          expect(db.query("SELECT count(*) AS count FROM writer_gate").get(), "NORMAL_CLOSE_RELEASED_WRITER_GATE").toEqual({ count: 0 });
          expect(db.query("SELECT count(*) AS count FROM turn_journal_reservations").get(), "NORMAL_CLOSE_RELEASED_CAS_RESERVATIONS").toEqual({ count: 0 });
        } finally { db.close(); }
        const appLeases = new Database(join(dir, "ui.db.native-leases.sqlite"), { readonly: true });
        try { expect(appLeases.query("SELECT count(*) AS count FROM native_root_leases").get(), "NORMAL_CLOSE_RELEASED_NATIVE_LEASE_ROWS").toEqual({ count: 0 }); }
        finally { appLeases.close(); }
        const ledgers = readdirSync(dir).filter(name => name.startsWith(".brain-maintenance-") && name.endsWith(".db")).map(name => join(dir, name));
        const fallback = `/tmp/brain-maintenance-budget-${APP_UID}/reservations.db`;
        if (existsSync(fallback)) ledgers.push(fallback);
        for (const path of ledgers) {
          const ledger = new Database(path, { readonly: true });
          try { expect(ledger.query("SELECT count(*) AS count FROM reservations WHERE released=0").get(), "NORMAL_CLOSE_RELEASED_MAINTENANCE_RESERVATIONS").toEqual({ count: 0 }); }
          finally { ledger.close(); }
        }
        const { createNativeBrainManagerClient } = await import(join(SOURCE, "packages/ui-sdk/src/server/native-brain-manager-client.ts"));
        const { createNativeJournalCapture } = await import(join(SOURCE, "packages/ui-server/src/brain/native-journal-capture.ts"));
        const first = "notes/linked-odysseus.md", alias = "notes/linked-athena.md"; writeFileSync(join(brain, first), "Odysseus original linked notes\n"); linkSync(join(brain, first), join(brain, alias));
        let retainedCalls = 0; const capture = createNativeJournalCapture(createNativeBrainManagerClient({ socketPath: socket }), async (fd: number, bytes: number) => { retainedCalls++; const value = readFileSync(`/proc/self/fd/${fd}`); expect(value.length).toBe(bytes); return createHash("sha256").update(value).digest("hex"); });
        try { await capture.initialize(); const policy = await capture.policy(); writeFileSync(join(brain, alias), "Athena updates both linked note names\n"); const observed = await capture.observe(new Map([["odysseus", policy]])); const paths = observed.changes.get("odysseus")!.map((c: any) => c.path); expect(paths, "NATIVE_CAPTURE_BOTH_ALIASES").toContain(first); expect(paths, "NATIVE_CAPTURE_BOTH_ALIASES").toContain(alias); expect(retainedCalls, "NATIVE_CAPTURE_ONE_RETAIN_PER_SEALED_INODE").toBe(2); await observed.commit(); writeFileSync(join(ARTIFACTS, "hardlink-capture.json"), JSON.stringify({ retainedCalls, paths, pass: true })); } finally { await capture.close(); }
        const ownerDirectory = join(ARTIFACTS, "crash-owner"); mkdirSync(ownerDirectory, { mode: 0o700 });
        expect(Bun.spawnSync(["chown", `${APP_UID}:${APP_UID}`, ownerDirectory]).exitCode).toBe(0);
        function ownerProcess(mode: "acquire" | "recover") {
          return Bun.spawn(["/usr/bin/setpriv", `--reuid=${APP_UID}`, `--regid=${APP_UID}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", process.execPath, "--preload", join(SOURCE, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "native-lease-child.ts"), SOURCE, mode, ownerDirectory, brain, socket, fsid, brainUuid], { cwd: SOURCE, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" });
        }
        const deadOwner = ownerProcess("acquire");
        let ownerExited = false; void deadOwner.exited.then(() => { ownerExited = true; });
        const ownerErrors = new Response(deadOwner.stderr).text();
        try {
          await until(() => existsSync(join(ownerDirectory, "acquired.json")) || ownerExited, 10000);
          if (ownerExited) expect(Number(ownerExited), `NATIVE_OWNER_MUST_BE_ALIVE_FOR_SIGKILL: ${await ownerErrors}`).toBe(0);
        }
        finally { deadOwner.kill("SIGKILL"); await deadOwner.exited; writeFileSync(join(ARTIFACTS, "native-owner-errors.txt"), await ownerErrors); }
        const saved = JSON.parse(readFileSync(join(ownerDirectory, "acquired.json"), "utf8"));
        const recoveryOwner = ownerProcess("recover");
        const recoveryErrors = new Response(recoveryOwner.stderr).text();
        expect(await recoveryOwner.exited, await recoveryErrors).toBe(0);
        const recovered = JSON.parse(readFileSync(join(ownerDirectory, "recovered.json"), "utf8"));
        expect(recovered.released, "DEAD_NATIVE_OWNER_RECOVERED_CHECKPOINT_AND_STAGE").toEqual([saved.stageId, saved.checkpointId]);
        expect(recovered.unknown).toEqual([]);
        const native = createNativeBrainManagerClient({ socketPath: socket });
        const records: any[] = []; let after: string | null = null;
        do { const page: { records: { state: string; id: string }[]; next: string | null } = await native.listRecovery(after); records.push(...page.records); after = page.next; } while (after);
        expect(records.every(record => record.state === "deleted"), "NORMAL_CLOSE_AND_OWNER_RECOVERY_LEFT_NO_NATIVE_ROOTS").toBe(true);
        writeFileSync(join(ARTIFACTS, "native-owner-recovery.json"), JSON.stringify({ recovered, records }, null, 2));
      }
    } finally { try { await service.close(); } finally { rmSync(dir, { recursive: true, force: true }); rmSync(join(ARTIFACTS,"crash-owner"), { recursive: true, force: true }); } }
  }
  expect(cleanExit, "HOSTED_NORMAL_SHUTDOWN_CLEAN_EXIT").toBe(true);
}, 120000);

// One fixed backend/UID cell owns this backend-independent root-lifetime control.
if (BACKEND === "pi" && APP_UID === 0) for (const held of ["descriptor", "cwd"] as const) test(`a retained native checkpoint ${held} records the actual release interruption and reconciles the same root`, async () => {
  const brain = "/brain-fixture/brain", name = "notes/worker-1.md";
  const { serveNativeBrainManager } = await import(join(SOURCE, "packages/ui-sdk/src/server/native-brain-manager.ts"));
  const { createNativeBrainManagerClient } = await import(join(SOURCE, "packages/ui-sdk/src/server/native-brain-manager-client.ts"));
  const show = Bun.spawnSync(["/usr/bin/btrfs", "subvolume", "show", brain]); expect(show.exitCode).toBe(0);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show.stdout.toString())![1]!.replaceAll("-", "");
  const fs = Bun.spawnSync(["/usr/bin/btrfs", "filesystem", "show", "/brain-fixture"]); expect(fs.exitCode).toBe(0);
  const fsid = /uuid:\s*([0-9a-f-]+)/.exec(fs.stdout.toString())![1]!;
  const socketPath = "/native-runtime/release-observation.sock";
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath,
    appGid: APP_UID, capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  const client = createNativeBrainManagerClient({ socketPath }), id = randomUUID();
  let fd: number | undefined, holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const checkpoint = await client.checkpoint(id);
    if (held === "descriptor") fd = openSync(join(checkpoint.path, name), "r");
    else { holder = Bun.spawn(["/bin/sh", "-c", "read line"], { cwd: checkpoint.path, env: {}, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      await until(() => { try { return readlinkSync(`/proc/${holder!.pid}/cwd`) === checkpoint.path; } catch { return false; } }); }
    await expect(client.release(id), "PINNED_NATIVE_RELEASE_REMAINS_UNKNOWN").rejects.toThrow("Native manager outcome is unknown");
    await releaseObservations.drain();
    const path = join(ARTIFACTS, "native-release", `${id}.json`);
    expect(existsSync(path), "NATIVE_RELEASE_FAILURE_DIAGNOSTIC_RETAINED").toBe(true);
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    expect(evidence.root.rootId, "NATIVE_RELEASE_DIAGNOSTIC_SAME_ROOT").toBe(checkpoint.rootId);
    expect(evidence.code, "NATIVE_RELEASE_DIAGNOSTIC_REAL_KILLED_COMMAND").toBe(137);
    expect(evidence.signals.some((signal: any) => signal.signal === "SIGKILL" && signal.abort?.reason === "AbortError: The connection was closed."), "NATIVE_RELEASE_DIAGNOSTIC_CONNECTION_ABORT").toBe(true);
    expect(evidence.samples.some((sample: any) => sample.references.some((reference: any) => held === "descriptor" ? reference.pid === process.pid && reference.fd === fd : reference.pid === holder?.pid && reference.kind === "cwd")),
      `NATIVE_RELEASE_DIAGNOSTIC_ACTUAL_PINNED_${held.toUpperCase()}`).toBe(true);
    expect(evidence.samples.every((sample: any) => sample.coverage.processesTruncated === false && sample.coverage.referencesTruncated === false),
      "NATIVE_RELEASE_CONTROL_OBSERVATION_NOT_TRUNCATED").toBe(true);
    if (fd !== undefined) { closeSync(fd); fd = undefined; }
    if (holder) { holder.kill("SIGKILL"); await holder.exited; holder = undefined; }
    expect(await client.release(id), "NATIVE_RELEASE_SAME_ID_RECONCILES_AFTER_READER_CLOSE").toEqual({ id, state: "deleted" });
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (holder) { holder.kill("SIGKILL"); await holder.exited; }
    try { await client.release(id); } finally { await service.close(); }
  }
}, 90_000);
