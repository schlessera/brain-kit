import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [source, dir, brain, socket, selectedBackend = "claude"] = process.argv.slice(2);
const dbPath = join(dir!, "ui.db");
const firstImportStartedAt = performance.now();
const { createApp } = await import(join(source!, "packages/ui-server/src/app.ts"));
const { resolveServerConfig } = await import(join(source!, "packages/ui-server/src/config/env.ts"));
const { createStaticBackendRegistry } = await import(join(source!, "packages/ui-server/src/agent/backend.ts"));
const { createRecordingObservability } = await import(join(source!, "packages/ui-server/src/observability/index.ts"));
const { createPrincipal } = await import(join(source!, "packages/ui-server/src/db/principals.ts"));
const { createPiBackend } = await import(join(source!, "packages/ui-backend-pi/src/backend.ts"));
const { startPiNativeInference } = await import("./pi-inference.js");
const { createClaudeBackend } = await import(join(source!, "packages/ui-backend-claude/src/backend.ts"));
const SECRET = "odysseus-probe-cookie-secret-0123456789";
const SID = "11111111-1111-4111-8111-111111111790";
const event = (kind: string, data: object = {}) => appendFileSync(join(dir!, "events.jsonl"), JSON.stringify({ kind, at: performance.now(), wallAt: Date.now(), ...data }) + "\n");
event("first_import_complete", { elapsedMs: performance.now() - firstImportStartedAt });
// Observe real index completion, including guarded publication, without changing the call.
const { spyOn } = await import("bun:test");
const brainClients = await import(join(source!, "packages/ui-server/src/brain/client.ts"));
const createBrainClient = brainClients.createBrainClient;
let indexOrdinal = 0;
spyOn(brainClients, "createBrainClient").mockImplementation((...args: Parameters<typeof createBrainClient>) => {
  const brainClient = createBrainClient(...args), index = brainClient.index.bind(brainClient);
  brainClient.index = async (...values: Parameters<typeof index>) => {
    const ordinal = ++indexOrdinal; event("automatic_index_started", { ordinal });
    try { const result = await index(...values); event("automatic_index_finished", { ordinal }); return result; }
    catch (error) { event("automatic_index_failed", { ordinal, error: String(error) }); throw error; }
  };
  return brainClient;
});
// #2835: time every host apply at the bridge entry (journal idle wait included)
// and every index barrier, without changing either call.
const APPLY_TIMING = process.env.BRAIN_NATIVE_PROOF_APPLY_TIMING === "1";
if (APPLY_TIMING) {
  // #2848: how long admission takes to copy the turn's data tree and seed its index.
  const trees = await import(join(source!, "packages/ui-server/src/brain/turn-data-tree.ts"));
  const createTurnDataTree = trees.createTurnDataTree;
  spyOn(trees, "createTurnDataTree").mockImplementation((...args: Parameters<typeof createTurnDataTree>) => {
    const start = performance.now(); const tree = createTurnDataTree(...args);
    event("turn_tree_seed", { ms: performance.now() - start, masked: Boolean((args[0] as { masks?: unknown }).masks), mounted: Boolean(tree.mount) });
    return tree;
  });
  const bridges = await import(join(source!, "packages/ui-server/src/ws/bridge.ts"));
  const makeBridge = bridges.makeBridge;
  spyOn(bridges, "makeBridge").mockImplementation((...args: Parameters<typeof makeBridge>) => {
    const bridge = makeBridge(...args), apply = bridge.applyBrain, awaitIndex = bridge.awaitIndex;
    if (apply) bridge.applyBrain = async (input: any) => {
      const start = performance.now(); const result = await apply(input);
      event("apply_timing", { operation: input.operation, path: input.path, ms: performance.now() - start, ok: result.ok, indexed: result.indexed, indexStatus: result.indexStatus ?? null });
      return result;
    };
    if (awaitIndex) bridge.awaitIndex = async (name: string, input?: Record<string, unknown>) => {
      const start = performance.now();
      try { await awaitIndex(name, input); event("index_barrier", { name, ms: performance.now() - start, ok: true }); }
      catch (error) { event("index_barrier", { name, ms: performance.now() - start, ok: false, error: String(error) }); throw error; }
    };
    return bridge;
  });
}
// #2834: time every tool frame and every journal observation, without changing either.
const OBSERVATION_TIMING = process.env.BRAIN_NATIVE_PROOF_OBSERVATION_TIMING === "1";
if (OBSERVATION_TIMING) {
  const bridges = await import(join(source!, "packages/ui-server/src/ws/bridge.ts"));
  const makeBridge = bridges.makeBridge;
  spyOn(bridges, "makeBridge").mockImplementation((...args: Parameters<typeof makeBridge>) => {
    const bridge = makeBridge(...args), emit = bridge.emit;
    bridge.emit = (message: any) => {
      if (message.type === "tool_use_start" || message.type === "tool_result") event("timeline_frame", { frame: message.type, toolUseId: message.toolUseId, toolName: message.toolName ?? null, isError: message.isError ?? null, at: performance.now() });
      return emit(message);
    };
    return bridge;
  });
}
const ITHACA_CALLS = 20, ITHACA_DOC = "notes/voyage-0007.md";
const ithacaNote = (i: number) => `---\ntype: note\ntitle: Ithaca timeline ${i}\nupdated: 2026-07-12\n---\nTelemachus writes ${i}.\n`;
const ithacaPath = (prefix: string, i: number) => `notes/ithaca-${prefix}-${String(i).padStart(2, "0")}.md`;
/**
 * One fresh conversation per cell, so the request history stays short: the
 * cell's unmeasured setup calls, then 20 calls of its tool, one per request.
 * The reads after a writer or after `bash` run in the same worker as it.
 */
type Step = [name: string, input: object];
const ithacaCells = (): { label: string; setup: Step[]; tool: string; input: (i: number) => object }[] => [
  { label: "read_file", setup: [], tool: "read_file", input: () => ({ path: ITHACA_DOC }) },
  { label: "brain_read_base", setup: [], tool: "brain_read_base", input: () => ({ path: ITHACA_DOC }) },
  { label: "query_activity", setup: [], tool: "query_activity", input: () => ({ scope: "recent" }) },
  { label: "inbox_list", setup: [], tool: "inbox_list", input: () => ({ view: "queue" }) },
  { label: "brain_search", setup: [], tool: "brain_search", input: () => ({ query: "Ithaca voyage", limit: 5 }) },
  { label: "write_file", setup: [], tool: "write_file", input: i => ({ path: ithacaPath("timeline", i), content: ithacaNote(i) }) },
  { label: "edit_file", setup: [], tool: "edit_file", input: i => ({ path: ithacaPath("timeline", i), old_string: "writes", new_string: "edits" }) },
  { label: "bash read", setup: [], tool: "bash", input: () => ({ command: `cat ${ITHACA_DOC} > /dev/null` }) },
  { label: "bash write", setup: [], tool: "bash", input: i => ({ command: `echo Penelope ${i} > ${ithacaPath("bash", i)}` }) },
  { label: "read_file after write_file", setup: [["write_file", { path: ithacaPath("after", 0), content: ithacaNote(0) }]], tool: "read_file", input: () => ({ path: ITHACA_DOC }) },
  { label: "read_file after bash", setup: [["bash", { command: `cat ${ITHACA_DOC} > /dev/null` }]], tool: "read_file", input: () => ({ path: ITHACA_DOC }) },
];
const ithacaSteps = () => ithacaCells().map(cell => ({ label: cell.label,
  steps: [...cell.setup.map(([name, input]): [string, object, string | null] => [name, input, null]),
    ...Array.from({ length: ITHACA_CALLS }, (_, i): [string, object, string | null] => [cell.tool, cell.input(i), cell.label])] }));
const SCHERIA_LOGS = 20;
const scheriaPath = (i: number) => `notes/scheria-log-${String(i).padStart(2, "0")}.md`;
const scheriaContent = (i: number) => `---\ntype: note\ntitle: Scheria log ${i}\nupdated: 2026-07-12\n---\nNausicaa finds Odysseus on the Scheria shore, log ${i}.\n`;
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
/** The Claude timing turn: the turn's own brain-ui MCP handlers, called as the runtime would, then a same-turn search. */
async function* scheriaClaudeTurn(params: any, attempt: number) {
  if (typeof params.prompt !== "string") for await (const _message of params.prompt) { event("prompt_released", { attempt }); break; }
  const sid = "11111111-1111-4111-8111-111111111791";
  yield { type: "system", subtype: "init", session_id: sid };
  const { Client } = await import(join(source!, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"));
  const { InMemoryTransport } = await import(join(source!, "node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"));
  const client = new Client({ name: "odysseus-native-timing", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await params.options.mcpServers["brain-ui"].instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    const call = async (name: string, args: object) => {
      const result = await client.callTool({ name, arguments: args });
      const parsed = JSON.parse(result.content[0].text);
      if (!parsed.ok) throw Error(`${name} refused: ${result.content[0].text}`);
    };
    for (let i = 0; i < SCHERIA_LOGS; i++) await call("write_file", { path: scheriaPath(i), content: scheriaContent(i), expectedBaseHash: null });
    for (let i = 0; i < SCHERIA_LOGS; i++) await call("edit_file", { path: scheriaPath(i), expectedBaseHash: sha256(scheriaContent(i)), old_string: "Scheria shore", new_string: "Scheria harbour" });
    // The runtime admits mcp__brain__brain_search through every unmatched PreToolUse hook first.
    for (const matcher of params.options.hooks.PreToolUse.filter((entry: any) => !entry.matcher)) for (const hook of matcher.hooks) {
      const output = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__brain__brain_search", tool_input: { query: "Nausicaa" }, tool_use_id: "scheria-search",
        session_id: sid, transcript_path: "", cwd: brain }, "scheria-search", { signal: params.options.abortController.signal });
      if (output?.hookSpecificOutput?.permissionDecision === "deny") throw Error(`search refused: ${output.hookSpecificOutput.permissionDecisionReason}`);
    }
    // #2848: the search runs where the agent's does, in the turn's actual
    // strict worker, through the brain's own MCP server on its data tree.
    const worker = params.options.spawnClaudeCodeProcess({ command: process.execPath,
      args: [join(source!, "scripts/native-proof/mcp-search-worker.ts"), join(source!, "packages/core/src/cli/brain.ts"), "harbour Nausicaa", brain],
      env: { PATH: "/usr/bin:/bin", HOME: join(dir!, "home"), CLAUDE_CONFIG_DIR: join(dir!, "agent") }, signal: params.options.abortController.signal });
    worker.stdin.end();
    let output = "", errors = "";
    worker.stdout.on("data", (part: Buffer) => { output += part.toString(); });
    worker.stderr?.on("data", (part: Buffer) => { errors += part.toString(); });
    const code = await new Promise<number | null>(resolve => worker.on("exit", (exit: number | null) => resolve(exit)));
    const answer = (() => { try { return JSON.parse(output.trim().split("\n").at(-1) ?? ""); } catch { return { error: output.slice(-400) }; } })();
    event("scheria_search", { backend: "claude", via: "worker-mcp", code, errors: errors.slice(-400), ...answer });
  } finally { await client.close(); }
  yield { type: "assistant", session_id: sid, message: { content: [{ type: "text", text: "Odysseus files the Scheria log." }] } };
  yield { type: "result", subtype: "success", session_id: sid, is_error: false, duration_ms: 100, duration_api_ms: 0, num_turns: 1,
    result: "Odysseus files the Scheria log.", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
}
let piWorkerCount=0;
const tracedSpawn = Bun.spawn;
Bun.spawn = ((...args: any[]) => { const argv = Array.isArray(args[0]) ? args[0] : args[0].cmd, start = performance.now(), child = Reflect.apply(tracedSpawn, Bun, args); const tail = argv.slice(-8);
 const options=Array.isArray(args[0])?args[1]:args[0];let piAttempt:number|undefined;
 if(options?.env?.BRAIN_WORKER_LAUNCH){const launch=JSON.parse(options.env.BRAIN_WORKER_LAUNCH);if(launch.command?.some((part:string)=>part.endsWith("/ui-backend-pi/src/worker-entry.ts"))){piAttempt=++piWorkerCount;event("worker_start",{attempt:piAttempt,pid:child.pid,backend:"pi"});}}
 event("app_spawn_start", { pid: child.pid, tail, kernelUid:Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${child.pid}/status`,"utf8"))![1]) }); void child.exited.then((code: number) => {event("app_spawn_end", { pid: child.pid, tail, code, elapsedMs: performance.now() - start });if(piAttempt)event("worker_exit",{attempt:piAttempt,code,pid:child.pid,backend:"pi"});}); return child; }) as typeof Bun.spawn;
let count = 0;
const observability = createRecordingObservability();
const authorityProgram = readFileSync(join(import.meta.dir,"worker-authority.py"),"utf8");
const authorityCommand = `/usr/bin/python3 -I -S -c '${authorityProgram.replaceAll("'", "'\\''")}' ${process.getuid!()}`;
// A fixture origin each worker reaches through its turn proxy: one recorded connection per turn.
const egressOrigin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname; event("egress_origin_request", { path }); return new Response(`Ithaca road ${path}`);
} });
// "localhost", not 127.0.0.1: only the proxy resolves it, whatever the worker exempts.
const egressCommand = (attempt: number) => `/usr/bin/python3 -I -S -c 'import sys,urllib.request;sys.stdout.write(urllib.request.urlopen(sys.argv[1],timeout=5).read().decode())' http://localhost:${egressOrigin.port}/voyage-${attempt} > .brain/egress-${attempt}.txt`;
const inference = selectedBackend === "pi" ? startPiNativeInference(join(dir!,"pi"),event,authorityCommand,egressCommand,
  APPLY_TIMING ? { count: SCHERIA_LOGS, path: scheriaPath, content: scheriaContent, sha256 } : undefined, OBSERVATION_TIMING ? { cells: ithacaSteps() } : undefined) : undefined;
if (inference) process.env.BRAIN_UI_PI_CREDENTIAL_ORIGINS = inference.origin;
const backend = inference ? createPiBackend({brainPath:brain!,model:inference.model,loadExtensions:false,log(level: string,message: string){event("backend_log",{level,message});}}) : createClaudeBackend({
  brainPath: brain,
  profiles: [{
    id: "odysseus-offline", label: "Odysseus offline", billing: "api", requiredEnvKeys: [],
    // A fictional key: on managed storage the host relay holds it, never the worker.
    buildEnv: () => ({ PATH: "/usr/bin:/bin", HOME: join(dir!, "home"), CLAUDE_CONFIG_DIR: join(dir!, "agent"), ANTHROPIC_API_KEY: "odysseus-offline-api-key" })
  }],
  listSessionsFn: async () => [], getSessionMessagesFn: async () => [],
  log(level: string, message: string) { event("backend_log", { level, message }); },
  queryFn: (params: any) => {
    const attempt = ++count; event("fake_provider_enter", { attempt });
    // First, warm and Stop are attempts 1-3; the timing turn follows them.
    if (APPLY_TIMING && attempt === 4) return Object.assign(scheriaClaudeTurn(params, attempt), {
      initializationResult: async () => ({ account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } }),
      getSettings: async () => ({ effective: { env: { ...params.options.settings?.env } }, sources: [{ source: "flagSettings", settings: params.options.settings }] }),
      close() {}, interrupt: async () => {},
    });
    let child: any; try {
child = params.options.spawnClaudeCodeProcess({
        command: "/bin/sh", args: ["-c", OBSERVATION_TIMING && attempt >= 4
          // #2834 harbour records after first, warm and Stop: one worker write each, for journal begin and finish timings.
          ? `echo Eurycleia ${attempt} > notes/ithaca-harbour-${attempt}.md; printf worker-pass`
          : `${authorityCommand} > .brain/worker-authority-${attempt}.json && ${egressCommand(attempt)} && printf '%b' '---\\ntype: note\\ntitle: Odysseus worker ${attempt}\\nupdated: 2026-07-12\\n---\\nOdysseus marks the actual worker.\\n' > notes/worker-${attempt}.md; printf worker-pass; sleep ${attempt === 3 ? "10" : "0.05"}`],
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
      // What the CLI reports for the host's pinned flag settings, so the relay's route gate sees its own route.
      getSettings: async () => ({ effective: { env: { ...params.options.settings?.env } }, sources: [{ source: "flagSettings", settings: params.options.settings }] }),
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
      BRAIN_UI_TURN_TIMEOUT_MS: OBSERVATION_TIMING ? "900000" : "90000", BRAIN_UI_NATIVE_BRAIN_SOCKET: socket
    }), registry: createStaticBackendRegistry([backend], selectedBackend), observability
  });
  const {spyOn} = await import("bun:test");
  const workerSandbox = await import(join(source!,"packages/ui-sdk/src/server/worker-sandbox.ts"));
  const scan = workerSandbox.scanForOutsideLinks;
  spyOn(workerSandbox,"scanForOutsideLinks").mockImplementation((brain:string,path:string,limit?:number) => {
    if(brain===path)event("whole_brain_alias_scan");
    return scan(brain,path,limit);
  });
  // Observe the actual final slot release, rather than guessing cleanup duration.
  const releaseSlot = app.wsHost.coordinator.running.delete.bind(app.wsHost.coordinator.running);
  app.wsHost.coordinator.running.delete = (turn: any) => { const released = releaseSlot(turn); event("session_slot_released", {sessionId:turn.sessionId,turnId:turn.turnId}); return released; };
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
  if (OBSERVATION_TIMING) {
    const journal = app.wsHost.journal, observe = journal.observe.bind(journal), ended = journal.toolEnded?.bind(journal);
    journal.observe = async () => { const start = performance.now(); try { return await observe(); } finally { event("timeline_observe", { start, ms: performance.now() - start }); } };
    // Every completed capture, periodic and scope-limit ones included, reports here once per active turn.
    journal.onObservation?.((turnId: string) => event("timeline_capture", { turnId, at: performance.now() }));
    if (ended) journal.toolEnded = (turnId: string, toolUseId: string) => {
      const start = performance.now(), work = ended(turnId, toolUseId);
      void work.finally(() => event("timeline_tool_ended", { toolUseId, start, ms: performance.now() - start })).catch(() => {});
      return work;
    };
    // An observation's hold freezes the turn's workers; the next request waits for the resume.
    const scope = app.wsHost.scope, workerStarted = scope.workerStarted.bind(scope);
    scope.workerStarted = (turnId: string, worker: any) => {
      const freeze = worker.freeze.bind(worker), resume = worker.resume.bind(worker);
      worker.freeze = () => { event("timeline_freeze", { at: performance.now() }); return freeze(); };
      worker.resume = () => { const answer = resume(); event("timeline_resume", { at: performance.now() }); return answer; };
      return workerStarted(turnId, worker);
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
    rootWarnings: observability.logs.find({severity:"WARN"}).filter((log:any)=>String(log.body).includes("runs as root")).map((log:any)=>String(log.body)),
    port: server.port, egressPort: egressOrigin.port, principalId: principal.id, pid: process.pid, secret: SECRET,
    dbBytes: statSync(dbPath).size, status: app.activity?.runtime?.snapshot?.()
  }));
  event("ready", { port: server.port });
  let closing = false;
  process.on("SIGTERM", async () => {
    if (closing) return; closing = true;
    try { server.stop(true); await app.close(); inference?.close(); egressOrigin.stop(true); event("fixture_warnings",{messages:observability.logs.records().map((log:any)=>({severity:log.severityText,body:log.body}))}); event("closed"); process.exit(0); }
    catch (error) { event("close_error", { error: String(error) }); process.exit(1); }
  });
} catch (error) {
  writeFileSync(join(dir!, "boot-error.txt"), String(error));
  console.error(error); process.exit(2);
}
