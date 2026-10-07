/** Run only inside an explicitly offline network namespace; no real credentials. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addCommand } from "../../../packages/core/src/cli/commands/add";
import { initContext } from "../../../packages/core/src/lib/context";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import { claudeRunner } from "../../../packages/core/src/providers/agents/cli-runners";
import { installBrainSurface } from "./brain-fixture";
import { fixtures, prepare } from "./pipeline";
import { MODEL, startRelay } from "./relay";

function response(id: number, tool: boolean, command: string) {
  const block = tool ? { type: "tool_use", id: `tool_${id}`, name: "Bash", input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify({ command }) } : { type: "text_delta", text: "Captured the fictional note." };
  const frames = [
    { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function main() {
  if (process.env.BRAIN_SMART_OFFLINE !== "1") throw Error("Explicit offline harness required");
  const f = fixtures.find(f => f.id === "t-module")!, p = await prepare(f);
  const source = new URL("../../../", import.meta.url).pathname;
  const native = bundledClaudeBinary(); if (!native) throw Error("No installed actual CLI");
  const home = join(p.root, ".isolated-home"); mkdirSync(home);
  const token = "sk-ant-oat01-offline-fixture-not-a-credential";
  const receiptPath = join(p.root, ".native-receipt.json");
  installBrainSurface(p.root, source);
  process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token; process.env.ANTHROPIC_API_KEY = "";
  process.env.ANTHROPIC_AUTH_TOKEN = ""; process.env.BRAIN_ROOT = p.root;
  process.env.BRAIN_SMART_SOURCE = source; process.env.BRAIN_SMART_RECEIPT = receiptPath;
  process.env.BRAIN_SMART_NATIVE_COMMAND = JSON.stringify([native]);
  process.env.CLAUDE_CODE_PATH = join(source, "scripts/evals/smart-capture/native-observer.ts");
  process.env.PATH = `${p.root}/bin:${process.env.PATH}`;
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  let dispatched = 0;
  const readOnlyReview = process.env.BRAIN_SMART_READONLY_REVIEW === "1";
  const relay = startRelay({ oauthToken: token, save: calls => writeFileSync(join(p.root, ".physical-calls.json"), JSON.stringify(calls)),
    async fetch(_url, init) {
      const body = JSON.parse(String(init.body)); dispatched++;
      if (readOnlyReview && body.tools?.length) throw Error("Read-only review exposed a tool");
      for (const message of body.messages) for (const block of Array.isArray(message.content) ? message.content : []) if (block.type === "tool_result") console.log(JSON.stringify({ offlineToolResult: block.content }));
      const isMain = JSON.stringify(body).includes(f.content);
      const hasTool = body.messages.some((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "tool_use"));
      return response(dispatched, !readOnlyReview && isMain && !hasTool, `brain add ${JSON.stringify(f.content)} --type study`);
    },
  });
  process.env.ANTHROPIC_BASE_URL = relay.url;
  try {
    const brain = await initContext({ root: p.root });
    await addCommand.run([f.content, "--smart"], { brain, json: true, agentRunner: claudeRunner() });
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!receipt.finished || receipt.failure || !receipt.result || receipt.init.model !== MODEL || receipt.account.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || !relay.complete() || !dispatched) throw Error("Actual CLI/auth/relay/close seam did not complete");
    const found = [...new Bun.Glob("studies/*.md").scanSync({ cwd: p.root })];
    if (readOnlyReview ? found.length !== 0 : found.length !== 1 || !readFileSync(join(p.root, found[0]!), "utf8").includes(f.content)) throw Error("Actual native tool surface/write control failed");
    console.log(JSON.stringify({ passed: true, actualCli: receipt.init.claude_code_version, model: receipt.init.model, accountSource: receipt.account.tokenSource, physicalRequests: relay.calls.length, actualToolWrite: !readOnlyReview, readOnlyReview, externalRequests: 0 }));
  } finally { relay.stop(); p.close(); }
}
if (import.meta.main) await main();
