/** Hold every subscription research prompt behind the actual native handshake. */
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { settingsRefusal, subscriptionVerdict, type CliSettingsReport } from "../packages/ui-backend-claude/src/subscription";

export async function* protectedSurfacePrompt(params: {
  query: Promise<Query>;
  prompt: string;
  abort: AbortController;
  onChecked?: () => void;
  onRefused?: (reason: string) => void;
}): AsyncGenerator<SDKUserMessage> {
  const refuse = (reason: string) => {
    params.onRefused?.(reason);
    params.abort.abort();
  };
  try {
    const query = await params.query;
    const initialized = await query.initializationResult();
    const verdict = subscriptionVerdict(initialized.account);
    if (!verdict.ok) { refuse("native_subscription_account_refused"); return; }
    const getSettings = (query as Query & { getSettings?: () => Promise<CliSettingsReport> }).getSettings;
    const report = getSettings ? await getSettings.call(query) : undefined;
    if (!report?.effective || !Array.isArray(report.sources) || settingsRefusal(report)) {
      refuse("native_effective_or_policy_settings_refused"); return;
    }
    for (const layer of [report.effective, ...report.sources.map(source => source.settings)]) {
      for (const key of ["ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
        const selected = layer?.env?.[key];
        if (typeof selected === "string" && selected.trim() && selected !== "claude-sonnet-5-5") {
          refuse("native_auxiliary_model_settings_refused"); return;
        }
      }
    }
    if (params.abort.signal.aborted) return;
    params.onChecked?.();
    yield { type: "user", session_id: "", parent_tool_use_id: null,
      message: { role: "user", content: params.prompt } };
  } catch {
    refuse("native_subscription_handshake_unreadable");
  }
}
