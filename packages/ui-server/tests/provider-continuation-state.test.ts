/**
 * Both backends' real state copy behind production admission (#2726). A saved
 * pre-policy conversation holding a protected sentinel refuses to continue
 * under a provider-denied turn before its transcript is copied to a worker or
 * a provider request is made, and stays byte-identical. A conversation born
 * masked continues with its exact prior history, and Claude's saved project
 * auto-memory never enters a denied worker. Paired turns without provider
 * rules keep native resumption and memory.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../../ui-backend-claude/src/backend";
import { createPiBackend } from "../../ui-backend-pi/src/backend";
import { savePiSession } from "../../ui-backend-pi/src/session-storage";
import { sendPipe } from "../../ui-backend-pi/src/worker-protocol";
import { createUiDb } from "../src/db/client";
import { createHostExecution } from "../src/brain/host-execution";
import { createGovernedTurns } from "../src/brain/governed-turn";
import { createProviderExposures } from "../src/brain/provider-exposure";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { testAuthorization } from "./helpers/principal";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals";
import { usageEvents } from "../../ui-backend-claude/tests/helpers/usage-events.js";
import { writePolicy } from "./helpers/provider-policy";

/** Fictional protected text an earlier, pre-policy turn read from `me/identity.md`. */
const TRANSCRIPT_SENTINEL = "ODYSSEUS-TRANSCRIPT-SENTINEL-NOBODY";
const MEMORY_SENTINEL = "ODYSSEUS-MEMORY-SENTINEL-NOBODY";
const PRE_POLICY = "33333333-3333-4333-8333-333333333333";
const MiB = 1024 * 1024;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function base(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix)), brain = join(root, "brain");
  for (const dir of ["context/policies", "me", ".git", ".brain-index"]) mkdirSync(join(brain, dir), { recursive: true });
  writeFileSync(join(brain, "me/identity.md"), `# Odysseus\n${TRANSCRIPT_SENTINEL}\n`);
  writePolicy(brain, ["me"]);
  const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const execution = createHostExecution({ brainPath: brain, dbPath, exec: {} }); execution.attach(db);
  // Strict workers mount the startup view; the private index build is not under test.
  const turns = createGovernedTurns({ nativeManager: createNativeJournalFixture(brain, root).client, brainPath: brain, execution, profile: "strict",
    maskPaths: [], index: async () => {}, report() {}, exposures: createProviderExposures(db), privateIndexCommand: ["/bin/true"] });
  return { root, brain, db, principal, turns };
}

function hosted(b: ReturnType<typeof base>, backend: AgentBackend) {
  const host = new WsHost({ brainPath: b.brain, governedTurns: b.turns, registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => b.db),
    isPrincipalAuthorized: id => { const found = resolvePrincipal(b.db, id); return found !== null && isUsablePrincipal(found, Date.now()); } });
  const frames: ServerMessage[] = [];
  host.clients.add({ send: data => frames.push(JSON.parse(data)) }, b.principal.id);
  const errors = () => frames.flatMap(frame => frame.type === "error" ? [frame.message] : frame.type === "result" && frame.failure ? [frame.failure.message] : []);
  const named = () => frames.flatMap(frame => frame.type === "session_info" ? [frame.sessionId] : []);
  const send = async (text: string, sessionId?: string) => {
    const before = errors().length;
    await runSession(host, { authorization: testAuthorization(b.principal.id), text, attachments: [], ...(sessionId ? { sessionId } : {}) });
    return errors().slice(before).join("\n");
  };
  return { host, send, named };
}

test("claude: real admission and worker state copy refuse pre-policy history, continue born-masked history and omit memory", async () => {
  const b = base("odysseus-claude-continuation-");
  const config = join(b.root, "claude");
  const project = `projects/${b.brain.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const transcript = (id: string) => join(config, project, `${id}.jsonl`);
  mkdirSync(join(config, project, "memory"), { recursive: true });
  writeFileSync(join(config, "settings.json"), "{}");
  writeFileSync(transcript(PRE_POLICY), `{"type":"user","text":"Read me/identity.md"}\n{"type":"tool_result","text":"${TRANSCRIPT_SENTINEL}"}\n`);
  writeFileSync(join(config, project, "memory/MEMORY.md"), `Odysseus is called Nobody (${MEMORY_SENTINEL}).\n`);
  const savedPrePolicy = readFileSync(transcript(PRE_POLICY));
  const savedMemory = readFileSync(join(config, project, "memory/MEMORY.md"));
  let dispatched = 0, spawned = 0;
  const exits: Promise<number | null>[] = [];
  const queryFn = ((params: { options?: Options }) => {
    dispatched++;
    const session = params.options?.resume ?? randomUUID();
    const stream = (async function* () {
      // The worker reports what its copied runtime state holds, into its own transcript.
      const script = [
        `T="$CLAUDE_CONFIG_DIR/$PROJECT/$SESSION.jsonl"; mkdir -p "$CLAUDE_CONFIG_DIR/$PROJECT"`,
        `if [ -e "$T" ]; then H=$(sha256sum "$T" | cut -d' ' -f1); else H=none; fi`,
        `if [ -e "$CLAUDE_CONFIG_DIR/$PROJECT/memory/MEMORY.md" ]; then MEM=present; else MEM=absent; fi`,
        `if grep -rqs -e "${TRANSCRIPT_SENTINEL}" -e "${MEMORY_SENTINEL}" "$CLAUDE_CONFIG_DIR"; then S=found; else S=unseen; fi`,
        `printf '{"prior":"%s","memory":"%s","sentinel":"%s"}\\n' "$H" "$MEM" "$S" >> "$T"`,
        "exit 0",
      ].join("; ");
      spawned++;
      const child = params.options!.spawnClaudeCodeProcess!({ command: "/bin/sh",
        args: ["-c", script, ...(params.options?.resume ? [`--resume=${params.options.resume}`] : [])], cwd: b.brain,
        env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config, PROJECT: project, SESSION: session },
        signal: new AbortController().signal } as never);
      exits.push(new Promise(resolve => child.once("exit", (code: number | null) => resolve(code))));
      (child.stdout as NodeJS.ReadableStream).resume();
      yield { type: "system", subtype: "init", session_id: session, apiKeySource: "none" };
      yield* usageEvents(session, "claude-sonnet-4-6", 17, 9);
      yield { type: "result", subtype: "success", session_id: session, total_cost_usd: 0.01, duration_ms: 1, num_turns: 1, result: "Ithaca",
        usage: { input_tokens: 17, output_tokens: 9 } };
    })();
    return Object.assign(stream, { initializationResult: async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }) });
  }) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: b.brain, queryFn, workerState: { allowanceBytes: 4 * MiB, budgetBytes: 4 * MiB } });
  const h = hosted(b, backend);
  const report = (id: string) => JSON.parse(readFileSync(transcript(id), "utf8").trim().split("\n").at(-1)!);
  try {
    const refused = await h.send("Continue the old voyage.", PRE_POLICY);
    await Promise.all(exits);
    expect(readFileSync(transcript(PRE_POLICY), "utf8"), "CLAUDE_DENIED_RESUME_NEVER_RECEIVES_SENTINEL").not.toContain('"sentinel":"found"');
    expect({ dispatched, spawned }, "CLAUDE_PRE_POLICY_NO_COPY_NO_DISPATCH").toEqual({ dispatched: 0, spawned: 0 });
    expect(refused, "CLAUDE_PRE_POLICY_REFUSAL_ACTIONABLE").toContain("Start a new conversation; the saved one is kept unchanged");
    expect(readFileSync(transcript(PRE_POLICY)).equals(savedPrePolicy), "CLAUDE_SAVED_TRANSCRIPT_BYTE_IDENTICAL").toBe(true);

    expect(await h.send("A fresh voyage under the rule."), "CLAUDE_FRESH_DENIED_ADMITTED").toBe("");
    expect(await Promise.all(exits), "CLAUDE_WORKER_EXITS_CLEANLY").toEqual([0]);
    const born = h.named().at(-1)!;
    expect(report(born), "CLAUDE_FRESH_DENIED_STARTS_WITHOUT_MEMORY_OR_HISTORY").toEqual({ prior: "none", memory: "absent", sentinel: "unseen" });
    const before = readFileSync(transcript(born));
    expect(await h.send("The next leg.", born), "CLAUDE_BORN_MASKED_CONTINUES").toBe("");
    await Promise.all(exits);
    expect(report(born), "CLAUDE_BORN_MASKED_PRIOR_HISTORY_BYTE_IDENTICAL").toEqual({ prior: sha(before), memory: "absent", sentinel: "unseen" });
    expect(readFileSync(transcript(born)).subarray(0, before.length).equals(before), "CLAUDE_HISTORY_APPEND_ONLY").toBe(true);

    // Paired control: without provider rules the old conversation resumes with memory.
    writePolicy(b.brain, null);
    expect(await h.send("Continue the old voyage.", PRE_POLICY), "CLAUDE_UNMASKED_RESUME_ADMITTED").toBe("");
    await Promise.all(exits);
    expect(report(PRE_POLICY), "CLAUDE_UNMASKED_RESUMES_WITH_HISTORY_AND_MEMORY").toEqual({ prior: sha(savedPrePolicy), memory: "present", sentinel: "found" });
    expect(readFileSync(join(config, project, "memory/MEMORY.md")).equals(savedMemory), "CLAUDE_SAVED_MEMORY_BYTE_IDENTICAL").toBe(true);
  } finally { h.host.close(); b.db.close(); rmSync(b.root, { recursive: true, force: true }); }
});

test("pi: real admission and session open refuse pre-policy entries and continue born-masked entries exactly", async () => {
  const b = base("odysseus-pi-continuation-");
  const sessionDir = join(b.root, "pi-sessions"), agentDir = join(b.root, "pi-agent");
  mkdirSync(sessionDir); mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const entry = (id: string, role: "user" | "assistant", text: string, parentId: string | null) => ({ type: "message", id, parentId, timestamp: "2026-07-12T00:00:00.000Z",
    message: role === "user" ? { role, content: text, timestamp: 0 }
      : { role, content: [{ type: "text", text }], model: "odysseus-1", provider: "anthropic", stopReason: "stop", timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  const header = (id: string) => ({ type: "session", version: 3, id, cwd: b.brain, timestamp: "2026-07-12T00:00:00.000Z" });
  savePiSession(sessionDir, PRE_POLICY, [header(PRE_POLICY) as never, entry("u0", "user", "Read me/identity.md", null) as never,
    entry("a0", "assistant", TRANSCRIPT_SENTINEL, "u0") as never]);
  const savedPrePolicy = readFileSync(join(sessionDir, `${PRE_POLICY}.jsonl`));
  const inits: Array<{ sessionId: string; entries?: unknown[] }> = [];
  const original = worker.launchAgentWorkerAsync;
  const children: Array<() => void> = [];
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  // Only the Pi worker is replaced: what it is handed at init is exactly what the host copied.
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async (input: worker.WorkerLaunch) => {
    if (!String(input.command.at(-1)).includes("worker-entry")) return original(input);
    const stdout = new PassThrough(), stderr = new PassThrough(), exited = Promise.withResolvers<number>();
    const stop = () => { stdout.end(); stderr.end(); exited.resolve(0); };
    children.push(stop);
    let sessionId = "", prior: unknown[] = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk));
      if (message.type === "init") {
        sessionId = message.sessionId; prior = message.entries ?? [header(sessionId)];
        inits.push({ sessionId, ...(message.entries ? { entries: message.entries } : {}) });
        sendPipe(stdout, { type: "ready", sessionId, levels: [], cost: 0 });
      } else if (message.type === "prompt") {
        const n = prior.length, last = (prior.at(-1) as { id?: string }).id ?? null;
        const entries = [...prior, entry(`u${n}`, "user", "Next leg", last === sessionId ? null : last), entry(`a${n}`, "assistant", "Sailing on.", `u${n}`)];
        sendPipe(stdout, { type: "snapshot", entries: entries as never });
        sendPipe(stdout, { type: "done", cost: 0 });
        stop();
      }
      callback();
    } });
    return { stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }), released: async () => {} } as unknown as worker.LaunchedWorker;
  });
  const backend = createPiBackend({ brainPath: b.brain, sessionDir, model: "anthropic/claude-sonnet-4-5", loadExtensions: false });
  const h = hosted(b, backend);
  try {
    const refused = await h.send("Continue the old voyage.", PRE_POLICY);
    expect(JSON.stringify(inits), "PI_DENIED_RESUME_NEVER_RECEIVES_SENTINEL").not.toContain(TRANSCRIPT_SENTINEL);
    expect(inits, "PI_PRE_POLICY_NO_COPY_NO_DISPATCH").toEqual([]);
    expect(refused, "PI_PRE_POLICY_REFUSAL_ACTIONABLE").toContain("Start a new conversation; the saved one is kept unchanged");
    expect(readFileSync(join(sessionDir, `${PRE_POLICY}.jsonl`)).equals(savedPrePolicy), "PI_SAVED_TRANSCRIPT_BYTE_IDENTICAL").toBe(true);

    expect(await h.send("A fresh voyage under the rule."), "PI_FRESH_DENIED_ADMITTED").toBe("");
    const born = inits.at(-1)!.sessionId;
    expect(inits.at(-1)!.entries, "PI_FRESH_DENIED_STARTS_WITHOUT_HISTORY").toBeUndefined();
    const saved = readFileSync(join(sessionDir, `${born}.jsonl`), "utf8");
    expect(await h.send("The next leg.", born), "PI_BORN_MASKED_CONTINUES").toBe("");
    expect(inits.at(-1), "PI_BORN_MASKED_PRIOR_HISTORY_EXACT").toEqual({ sessionId: born, entries: saved.trim().split("\n").map(line => JSON.parse(line)) });
    expect(JSON.stringify(inits)).not.toContain(TRANSCRIPT_SENTINEL);

    // Paired control: without provider rules the old conversation resumes natively.
    writePolicy(b.brain, null);
    expect(await h.send("Continue the old voyage.", PRE_POLICY), "PI_UNMASKED_RESUME_ADMITTED").toBe("");
    expect(JSON.stringify(inits.at(-1)), "PI_UNMASKED_RESUMES_WITH_HISTORY").toContain(TRANSCRIPT_SENTINEL);
  } finally {
    for (const stop of children.splice(0)) stop();
    launch.mockRestore(); probe.mockRestore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    h.host.close(); b.db.close(); rmSync(b.root, { recursive: true, force: true });
  }
});
