/** Frozen pre-upgrade SDK inputs. Never calls createClaudeSdkTurn or the migration. */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import baseline from "./legacy-sdk-inputs.json" with { type: "json" };
import { INFERENCE_PLACEHOLDER } from "@schlessera/brain-ui-sdk/internal";
import { createBrainUiMcpServer } from "../../src/ask-user-tool.js";
import { createTurnTempTool } from "../../src/turn-temp-tool.js";
export { baseline };
export function legacySdkTurn(brain: string, sessionId: string, environment: Record<string, string>, socket: string, signal: AbortController) {
  const settings = structuredClone(baseline.settings);
  // The frozen relayed fixture used OAuth; this keyless API fixture selects
  // its own placeholder. This is transport preparation, not request migration.
  delete (settings.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN;
  settings.env.ANTHROPIC_API_KEY = INFERENCE_PLACEHOLDER;
  settings.env.ANTHROPIC_UNIX_SOCKET = socket;
  const options: Options = {
    cwd: brain, sessionId, model: "claude-opus-5-5", permissionMode: "default", includePartialMessages: true, forwardSubagentText: true,
    abortController: signal, settingSources: ["project"],
    disallowedTools: [...baseline.disallowedTools], allowedTools: [...baseline.allowedTools],
    systemPrompt: { type: "preset", preset: "claude_code", snapshot: true, append: baseline.append },
    settings, env: { ...environment, ...settings.env }, canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    mcpServers: { "brain-ui": createBrainUiMcpServer({ stableRoster: true, brainPath: brain,
      turnTemp: createTurnTempTool({ root: () => undefined, allowanceBytes: 1024 ** 3, scratch: "/tmp/brain-worker-scratch", keep: [], exclude: [], linkedText: () => "" }) }) },
  };
  return { options, prompt: "Odysseus checks Ithaca step 0.", finishWorker: async () => {} };
}
