/**
 * The trusted host web executor (#3686, epic #2765): one child process per
 * principal's session, started by the host's web broker. It runs the pinned
 * upstream pi-web-access extension in an actual Pi SDK session and executes
 * the four admitted tools through that session's own tool pipeline.
 *
 * What this process holds, and nothing more:
 *
 * - A private, host-created directory (`HOME`, `PI_CODING_AGENT_DIR`, cwd,
 *   cache and temp all inside it) with a sanitized copy of the host's
 *   `web-search.json` (`prepareWebExecutorState`, `./web-executor.ts`).
 * - The provider API keys the host's environment supplies, under the same
 *   trusted host policy as before.
 * - Exactly one extension: the pinned package's published entry, resolved
 *   from this package's own dependency. No repository-defined extension,
 *   hook, setting, context file, skill, prompt or theme is loaded: settings
 *   are in-memory and empty, discovery is off, and the cwd is empty.
 *
 * No model turn runs. A call goes straight to `runToolCall` against the
 * session's tools, with the session's real extension context, so no
 * inference is needed and no command, shortcut or nested workflow is
 * reachable. The line protocol is `child-executor.ts`'s in ui-server: `call`
 * and `cancel` in; `ready`, `result` and `cancelled` out.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { runToolCall } from "@earendil-works/pi-agent-core";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { WEB_TOOL_NAME_LIST, type WebToolName } from "@schlessera/brain-ui-sdk/tool-contracts";
import { pinnedWebExtensionEntry } from "./web-executor.js";

const [stateDir] = process.argv.slice(2);
if (!stateDir) throw new Error("usage: web-executor-entry <private state dir>");
const agentDir = join(stateDir, "agent"), cwd = join(stateDir, "work");

const PINNED_WEB_EXTENSION = pinnedWebExtensionEntry();

// The private directory's path is host detail: no result or message names it.
const redact = (text: string) => text.split(stateDir).join("<web executor>");
const send = (frame: unknown): void => { process.stdout.write(redact(JSON.stringify(frame)) + "\n"); };

const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
const loader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: [PINNED_WEB_EXTENSION],
});
await loader.reload();
const loaded = loader.getExtensions();
// The credentialed process loads one extension, the pinned one, or refuses to start.
if (loaded.errors.length || loaded.extensions.length !== 1 || loaded.extensions[0]!.path !== PINNED_WEB_EXTENSION) {
  process.stderr.write(`web executor: unexpected extension set ${JSON.stringify(loaded.extensions.map(entry => entry.path))} ${JSON.stringify(loaded.errors)}\n`);
  process.exit(70);
}
// Explicit paths inside the private directory; this slice runs no model, so nothing is refreshed.
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
  allowModelNetwork: false, refreshOnCreate: false });
const { session } = await createAgentSession({
  cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, noTools: "builtin",
  sessionManager: SessionManager.inMemory(cwd),
});
const tools = session.agent.state.tools.filter(tool => (WEB_TOOL_NAME_LIST as readonly string[]).includes(tool.name));
if (tools.length !== WEB_TOOL_NAME_LIST.length) {
  process.stderr.write(`web executor: the pinned extension registered ${JSON.stringify(session.getActiveToolNames())}\n`);
  process.exit(70);
}

/** The ids of what a result stored, for the host to map to its own handles. */
function storedIds(result: { details?: unknown; structuredContent?: unknown }): string[] {
  const ids: string[] = [];
  for (const source of [result.structuredContent, result.details]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["responseId", "fetchId"]) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "string" && value && !ids.includes(value)) ids.push(value);
    }
  }
  return ids;
}

const running = new Map<string, AbortController>();
const assistantMessage = {
  role: "assistant", content: [], api: "anthropic-messages", provider: "host", model: "web-executor",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: 0,
} as const;

async function call(id: string, tool: WebToolName, input: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  running.set(id, controller);
  try {
    const outcome = await runToolCall({ type: "toolCall", id, name: tool, arguments: input as never }, {
      tools, assistantMessage: assistantMessage as never,
      context: { messages: [], tools }, signal: controller.signal,
    });
    if (controller.signal.aborted) return send({ type: "cancelled", id });
    const result = outcome.result as { content?: Array<{ type: string; text?: string }>; details?: unknown; structuredContent?: unknown };
    const text = (result.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
    if (outcome.isError) return send({ type: "result", id, ok: false, code: "failed", message: text.slice(0, 500) || "The web tool failed." });
    const [handle, ...handles] = storedIds(result);
    send({ type: "result", id, ok: true, text, ...(handle ? { handle } : {}), ...(handles.length ? { handles } : {}) });
  } catch (error) {
    if (controller.signal.aborted) return send({ type: "cancelled", id });
    send({ type: "result", id, ok: false, code: "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
  } finally { running.delete(id); }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let frame: { type?: string; id?: string; tool?: string; input?: unknown };
  try { frame = JSON.parse(line); } catch { process.exit(65); }
  if (frame.type === "cancel" && typeof frame.id === "string") { running.get(frame.id)?.abort(); return; }
  if (frame.type !== "call" || typeof frame.id !== "string" || !(WEB_TOOL_NAME_LIST as readonly string[]).includes(frame.tool ?? "")
    || !frame.input || typeof frame.input !== "object" || Array.isArray(frame.input)) process.exit(65);
  void call(frame.id, frame.tool as WebToolName, frame.input as Record<string, unknown>);
});
// The host closing stdin is the end of this session.
lines.on("close", () => { session.dispose(); process.exit(0); });
send({ type: "ready" });
