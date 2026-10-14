import { appendFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [source, dir, brain, socket, selectedBackend = "claude"] = process.argv.slice(2);
const dbPath = join(dir!, "ui.db");
const firstImportStartedAt = performance.now();
const { createApp } = await import(join(source!, "packages/ui-server/src/app.ts"));
const { resolveServerConfig } = await import(join(source!, "packages/ui-server/src/config/env.ts"));
const { createStaticBackendRegistry } = await import(join(source!, "packages/ui-server/src/agent/backend.ts"));
const { createSilentObservability } = await import(join(source!, "packages/ui-server/src/observability/index.ts"));
const { createPrincipal } = await import(join(source!, "packages/ui-server/src/db/principals.ts"));
const { createPiBackend } = await import(join(source!, "packages/ui-backend-pi/src/backend.ts"));
const { startPiNativeInference } = await import("./pi-inference.js");
const { createClaudeBackend } = await import(join(source!, "packages/ui-backend-claude/src/backend.ts"));
const SECRET = "odysseus-probe-cookie-secret-0123456789";
const SID = "11111111-1111-4111-8111-111111111790";
const event = (kind: string, data: object = {}) => appendFileSync(join(dir!, "events.jsonl"), JSON.stringify({ kind, at: performance.now(), wallAt: Date.now(), ...data }) + "\n");
event("first_import_complete", { elapsedMs: performance.now() - firstImportStartedAt });
let piWorkerCount=0;
const tracedSpawn = Bun.spawn;
Bun.spawn = ((...args: any[]) => { const argv = Array.isArray(args[0]) ? args[0] : args[0].cmd, start = performance.now(), child = Reflect.apply(tracedSpawn, Bun, args); const tail = argv.slice(-8);
 const options=Array.isArray(args[0])?args[1]:args[0];let piAttempt:number|undefined;
 if(options?.env?.BRAIN_WORKER_LAUNCH){const launch=JSON.parse(options.env.BRAIN_WORKER_LAUNCH);if(launch.command?.some((part:string)=>part.endsWith("/ui-backend-pi/src/worker-entry.ts"))){piAttempt=++piWorkerCount;event("worker_start",{attempt:piAttempt,pid:child.pid,backend:"pi"});}}
 event("app_spawn_start", { pid: child.pid, tail }); void child.exited.then((code: number) => {event("app_spawn_end", { pid: child.pid, tail, code, elapsedMs: performance.now() - start });if(piAttempt)event("worker_exit",{attempt:piAttempt,code,pid:child.pid,backend:"pi"});}); return child; }) as typeof Bun.spawn;
let count = 0;
const inference = selectedBackend === "pi" ? startPiNativeInference(join(dir!,"pi"),event) : undefined;
const backend = inference ? createPiBackend({brainPath:brain!,model:inference.model,loadExtensions:false,log(level: string,message: string){event("backend_log",{level,message});}}) : createClaudeBackend({
  brainPath: brain,
  profiles: [{
    id: "odysseus-offline", label: "Odysseus offline", billing: "api", requiredEnvKeys: [],
    buildEnv: () => ({ PATH: "/usr/bin:/bin", HOME: join(dir!, "home"), CLAUDE_CONFIG_DIR: join(dir!, "agent") })
  }],
  listSessionsFn: async () => [], getSessionMessagesFn: async () => [],
  log(level: string, message: string) { event("backend_log", { level, message }); },
  queryFn: (params: any) => {
    const attempt = ++count; event("fake_provider_enter", { attempt });
    let child: any; try {
child = params.options.spawnClaudeCodeProcess({
        command: "/bin/sh", args: ["-c",
          `printf '%b' '---\\ntype: note\\ntitle: Odysseus worker ${attempt}\\nupdated: 2026-07-12\\n---\\nOdysseus marks the actual worker.\\n' > notes/worker-${attempt}.md; printf worker-pass; sleep ${attempt === 3 ? "10" : "0.05"}`],
        env: { PATH: "/usr/bin:/bin", HOME: join(dir!, "home"), CLAUDE_CONFIG_DIR: join(dir!, "agent") },
        signal: params.options.abortController.signal
      });
} catch (error) { event("worker_spawn_refused", { attempt, error: String(error) }); throw error; }
    child.stdin.end();
    let output = "", errors = "";
    child.stdout.on("data", (part: Buffer) => { output += part.toString(); });
    child.on("error", (error: Error) => { errors += String(error); event("worker_error", { attempt, error: String(error) }); });
    const exit = new Promise<number | null>(resolve => child.on("exit", (code: number | null) => resolve(code)));
    const stream = (async function*() {
      if (typeof params.prompt !== "string") {
        for await (const _message of params.prompt) { event("prompt_released", { attempt }); break; }
      }
      const code = await exit; event("worker_exit", { attempt, code, output, errors });
      if (params.options.abortController.signal.aborted) return;
      if (code !== 0 || output !== "worker-pass") throw Error(`Actual worker failed: ${code}; ${errors}; ${output}`);
      yield { type: "system", subtype: "init", session_id: SID };
      yield { type: "assistant", session_id: SID, message: { content: [{ type: "text", text: "Odysseus records the voyage." }] } };
      yield {
        type: "result", subtype: "success", session_id: SID, is_error: false,
        duration_ms: 100, duration_api_ms: 0, num_turns: 1, result: "Odysseus records the voyage.", total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      };
    })();
    return Object.assign(stream, {
      initializationResult: async () => ({ account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } }),
      close() { child.kill("SIGKILL"); }, interrupt: async () => { child.kill("SIGKILL"); }
    });
  },
});
let app: any, server: any;
try {
  const appCreateStartedAt = performance.now();
  app = await createApp({
    config: resolveServerConfig({
      AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: SECRET,
      HOST: "127.0.0.1", DB_PATH: dbPath, BRAIN_PATH: brain, NODE_ENV: "test", AGENT_BACKEND: selectedBackend,
      PI_CODING_AGENT_DIR: join(dir!, "pi"), BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0",
      BRAIN_UI_TURN_TIMEOUT_MS: "90000", BRAIN_UI_NATIVE_BRAIN_SOCKET: socket
    }), registry: createStaticBackendRegistry([backend], selectedBackend), observability: createSilentObservability()
  });
  event("app_create_complete", { elapsedMs: performance.now() - appCreateStartedAt });
  // Timing wrappers call the original methods unchanged. No admission path is replaced.
  for (const [owner, method, label] of [[app.wsHost.governedTurns, "begin", "governed_begin"], [app.wsHost.journal, "begin", "journal_begin"],
  [app.wsHost.journal, "finish", "journal_finish"]] as any[]) {
    const original = owner[method].bind(owner);
    owner[method] = (...args: any[]) => {
      const start = performance.now(); event(`${label}_start`, { turnId: args[0] });
      try {
        const result = original(...args);
        if (result && typeof result.then === "function") return result.then((value: any) => {
          if (label === "governed_begin" && value?.end) {
            const end = value.end.bind(value); value.end = async () => { const began = performance.now(); event("governed_end_start"); try { return await end(); } finally { event("governed_end_end", { elapsedMs: performance.now() - began }); } };
          }
          event(`${label}_end`, { turnId: args[0], elapsedMs: performance.now() - start }); return value;
        },
          (error: any) => { event(`${label}_error`, { turnId: args[0], elapsedMs: performance.now() - start, error: String(error) }); throw error; });
        event(`${label}_end`, { turnId: args[0], elapsedMs: performance.now() - start }); return result;
      } catch (error) { event(`${label}_error`, { turnId: args[0], elapsedMs: performance.now() - start, error: String(error) }); throw error; }
    };
  }
  for (const [owner, method, label] of [[app.wsHost.execution?.boundary, "governed", "boundary_governed"], [app.wsHost.governedTurns, "facts", "governed_facts"]] as any[]) {
    if (!owner?.[method]) continue; const original = owner[method].bind(owner); owner[method] = (...args: any[]) => { const start = performance.now(); event(label + "_start"); try { const answer = original(...args); event(label + "_end", { elapsedMs: performance.now() - start }); return answer; } catch (error) { event(label + "_error", { error: String(error), elapsedMs: performance.now() - start }); throw error; } };
  }
  const replayBegin = app.wsHost.failureReplay.begin.bind(app.wsHost.failureReplay);
  app.wsHost.failureReplay.begin = async (...args: any[]) => { const answer = await replayBegin(...args), finish = answer.finish.bind(answer); answer.finish = async (...values: any[]) => { const start = performance.now(); event("failure_replay_finish_start"); try { return await finish(...values); } finally { event("failure_replay_finish_end", { elapsedMs: performance.now() - start }); } }; return answer; };
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus admission", ttlSeconds: 3600 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  writeFileSync(join(dir!, "ready.json"), JSON.stringify({
    port: server.port, principalId: principal.id, pid: process.pid, secret: SECRET,
    dbBytes: statSync(dbPath).size, status: app.activity?.runtime?.snapshot?.()
  }));
  event("ready", { port: server.port });
  let closing = false;
  process.on("SIGTERM", async () => {
    if (closing) return; closing = true;
    try { server.stop(true); await app.close(); inference?.close(); event("closed"); process.exit(0); }
    catch (error) { event("close_error", { error: String(error) }); process.exit(1); }
  });
} catch (error) {
  writeFileSync(join(dir!, "boot-error.txt"), String(error));
  console.error(error); process.exit(2);
}
