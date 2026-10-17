/** Isolated research executor for #1969; never imported by a shipped package. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [mode, installation, state] = process.argv.slice(2) as [string, string, string];
const entry = join(installation, "node_modules/pi-web-access/dist/index.js");
if (mode === "mcp") {
  // The published executable owns protocol, validation, result storage and signals.
  await import(join(installation, "node_modules/pi-web-access/dist/mcp-cli.js"));
} else {
  const sdk = await import(join(installation, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
  let selected: any;
  let calls = 0;
  const inference = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    const tool = ++calls === 1 ? selected : undefined;
    const events: any[] = [{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant",
      model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 } } }];
    events.push({ type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: "toolu_executor", name: tool.name, input: {} }
      : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool
        ? { type: "input_json_delta", partial_json: JSON.stringify(tool.arguments) }
        : { type: "text_delta", text: "Odysseus completed the search." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" });
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  } });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "models.json"), JSON.stringify({ providers: { anthropic: {
    baseUrl: inference.url.origin, apiKey: "offline-fixture" } } }));
  const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
  const loader = new sdk.DefaultResourceLoader({ cwd: state, agentDir: state, settingsManager: settings,
    noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [entry] });
  await loader.reload();
  const runtime = await sdk.ModelRuntime.create({ agentDir: state });
  const { session, extensionsResult } = await sdk.createAgentSession({ cwd: state, agentDir: state,
    settingsManager: settings, resourceLoader: loader, modelRuntime: runtime,
    model: runtime.getModel("anthropic", "claude-sonnet-4-6"), thinkingLevel: "off", noTools: "builtin",
    sessionManager: sdk.SessionManager.inMemory(state) });
  if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
  // A real SDK session supplies ExtensionAPI and ExtensionContext. No fabricated context.
  let result: any;
  session.subscribe((e: any) => { if (e.type === "tool_execution_end") result = e.result; });
  const lines = createInterface({ input: process.stdin });
  console.log(JSON.stringify({ ready: true, tools: session.getActiveToolNames() }));
  try {
    for await (const line of lines) {
      const request = JSON.parse(line);
      selected = request; calls = 0; result = undefined;
      await session.prompt("Search for Odysseus and the mast.");
      if (!result) throw new Error("FULL_EXTENSION_TOOL_DID_NOT_EXECUTE");
      console.log(JSON.stringify({ id: request.id, result }));
    }
  } finally { session.dispose(); inference.stop(true); }
}
