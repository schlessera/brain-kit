/**
 * The connections the selected native runtime opens on a relayed turn (#3244).
 * The caller denies all external network and binds a scratch directory at the
 * worker's egress directory. The turn's options come from the production
 * assembly. Only the launcher is replaced, with the worker bootstrap's proxy
 * environment pointing at a loopback recorder that refuses every connection.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WORKER_EGRESS_DIR } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn } from "../../src/sdk-options.js";
import { nativeModelReply } from "../helpers/native-model-reply.js";

const scratch = process.argv[2]!;
const scenario = process.argv[3] === "webfetch" ? "webfetch" : "plain";
const connections: string[] = [];
const relayed: string[] = [];
const recorder = createServer((request, response) => { connections.push(`${request.method} ${request.url}`); response.writeHead(403); response.end(); });
recorder.on("connect", (request, socket) => { connections.push(`CONNECT ${request.url}`); socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
await new Promise<void>(resolve => recorder.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${(recorder.address() as { port: number }).port}`;
let called = false;
const relay = Bun.serve({ unix: join(WORKER_EGRESS_DIR, "inference.sock"), async fetch(request) {
  const body = await request.text();
  relayed.push(`${request.method} ${new URL(request.url).pathname}`);
  if (!body.includes('"stream":true')) return Response.json({ id: "msg_ithaca", type: "message", role: "assistant", model: "claude-probe",
    content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  if (scenario === "webfetch" && !called) {
    called = true;
    return nativeModelReply({ id: "toolu_ithaca", name: "WebFetch", input: { url: "https://ithaca.example/harbour", prompt: "Summarize the harbour notice." } });
  }
  return nativeModelReply();
} });
const brainPath = join(scratch, "ithaca"), home = join(scratch, "home");
mkdirSync(brainPath, { recursive: true }); mkdirSync(home);
const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 45_000);
const turn = createClaudeSdkTurn({
  backend: { brainPath },
  req: { prompt: "Odysseus checks the harbour notice.", signal: abortController.signal, turnBudgetMs: 30_000,
    bridge: { emit() {}, checkpointPermission() {}, async requestPermission() { return { behavior: "allow" }; } } } as never,
  hostInference: { proxyDir: WORKER_EGRESS_DIR },
  turnEnvironment: { HOME: home, CLAUDE_CONFIG_DIR: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  profile: { id: "claude", label: "Claude", model: "claude-haiku-4-5", billing: "subscription", requiredEnvKeys: [], buildEnv: () => ({}) },
  abortController, allowedTools: ["WebFetch"], confirmPatterns: [],
  turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
});
const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
  NO_PROXY: "", no_proxy: "" };
let result: string | undefined;
try {
  for await (const message of query({ prompt: turn.prompt, options: { ...turn.options, maxTurns: 3,
    spawnClaudeCodeProcess: input => spawn(input.command, input.args, { cwd: input.cwd, env: { ...input.env, ...proxyEnv }, signal: input.signal, stdio: ["pipe", "pipe", "pipe"] }),
  } })) {
    if (message.type === "result") result = message.subtype;
  }
} finally {
  clearTimeout(timer);
  // A connection opened while the runtime exits still reaches the recorder.
  // Negative window: no event reports that the exiting runtime opens no more
  // connections. A barrier on the runtime's close, a FIFO marker connection and
  // every accepted socket closing was tried (#3440): Bun's node:http reported the
  // marker about 1 s late, so it was slower than this window.
  await Bun.sleep(500);
  recorder.close(); relay.stop(true);
}
writeFileSync(join(scratch, "result.json"), JSON.stringify({ result, connections, relayed,
  env: turn.options.env, settings: turn.options.settings }));
