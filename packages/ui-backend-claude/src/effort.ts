import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { canonicalModelId, resolveThinkingLevel } from "@schlessera/brain-ui-sdk/internal";
import type { ThinkingLevel } from "@schlessera/brain-ui-sdk/protocol";
import type { InferenceProfile } from "./profiles.js";

const STANDARD: EffortLevel[] = ["low", "medium", "high"];
const EXTENDED: EffortLevel[] = [...STANDARD, "xhigh", "max"];

/**
 * Conservative fallback when discovery is disabled or an old cache has no capabilities.
 * Verified model capabilities: https://platform.claude.com/docs/en/build-with-claude/effort
 * Unknown/proxy model names advertise no effort support; API capability metadata wins.
 */
export function supportedClaudeEffort(profile: Pick<InferenceProfile, "model" | "supportedThinkingLevels">): EffortLevel[] {
  if (profile.supportedThinkingLevels !== undefined) {
    return EXTENDED.filter((level) => profile.supportedThinkingLevels!.includes(level));
  }
  const model = canonicalModelId(profile.model ?? "");
  if (model === "claude-opus-4-5") return [...STANDARD];
  if (model === "claude-opus-4-6" || model === "claude-sonnet-4-6") return [...STANDARD, "max"];
  if (["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5"].includes(model)) return [...EXTENDED];
  return [];
}

export function claudeEffort(profile: InferenceProfile, override?: ThinkingLevel): EffortLevel | undefined {
  return resolveThinkingLevel(override ?? profile.thinkingLevel ?? "medium", supportedClaudeEffort(profile)) as EffortLevel | undefined;
}
