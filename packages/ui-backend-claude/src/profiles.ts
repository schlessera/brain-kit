import type { ProviderInfo, ThinkingLevel } from "@schlessera/brain-ui-sdk";
import type { UnavailableProfile } from "@schlessera/brain-ui-sdk/server";
import { claudeEffort, supportedClaudeEffort } from "./effort.js";

import { readEnvVar } from "./config/env.js";

/**
 * A resolved inference profile: a (model, endpoint, credentials) target the
 * Claude backend can run a conversation on. Replaces an earlier hardcoded
 * provider table, whose presets are gone: profiles are declared by the host
 * via {@link defineProfiles}.
 *
 * The env-remap mechanism is unchanged: a profile pointed at an
 * Anthropic-compatible proxy (OpenRouter, a local gateway, …) rewrites
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` and, when `modelAliases` is on,
 * the four model-alias envs the CLI resolves internally.
 */
export interface InferenceProfile {
  id: string;
  label: string;
  /** Optional vendor hint for client iconography/grouping (free-form). */
  vendor?: string;
  /** Model id passed to the SDK. Undefined = the SDK/CLI default model. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  supportedThinkingLevels?: ThinkingLevel[];
  allowedTools?: string[];
  /** Context window in tokens, when known. Presentation only. */
  contextWindow?: number;
  /** Where this profile came from. Presentation only. */
  source?: "builtin" | "declared" | "discovered";
  /** Env vars that must be present (non-empty) for this profile to be usable. */
  requiredEnvKeys: string[];
  /**
   * How a turn on this profile is billed. `"api"` only for a profile that
   * declares its own credential (`apiKeyEnv` / `authTokenEnv`); anything else —
   * including a profile built by hand without this field — is held to the
   * subscription: the ambient API credentials are cleared and the account the
   * CLI selected is checked before the prompt is sent (see subscription.ts).
   */
  billing?: "subscription" | "api";
  /** Environment overrides merged over the host environment before the query runs. */
  buildEnv(): Record<string, string>;
}

/** Declarative shape passed to {@link defineProfiles}. */
export interface InferenceProfileInput {
  id: string;
  label: string;
  vendor?: string;
  /** Model id. Undefined = the SDK/CLI default model. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  supportedThinkingLevels?: ThinkingLevel[];
  /** Anthropic-compatible endpoint. Sets `ANTHROPIC_BASE_URL`. */
  baseUrl?: string;
  /** Name of the env var holding a bearer token. Sets `ANTHROPIC_AUTH_TOKEN`. */
  authTokenEnv?: string;
  /** Name of the env var holding an x-api-key. Sets `ANTHROPIC_API_KEY`. */
  apiKeyEnv?: string;
  /**
   * Remap the CLI's model-alias envs (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`
   * and `CLAUDE_CODE_SUBAGENT_MODEL`) to `model`. Needed when routing through a
   * proxy whose model names differ from the built-in aliases. Requires `model`.
   */
  modelAliases?: boolean;
  allowedTools?: string[];
  /** Context window in tokens, when known (e.g. reported by model discovery). */
  contextWindow?: number;
  /** Where this profile came from. Presentation only. */
  source?: "builtin" | "declared" | "discovered";
}

/** The four model-alias envs the CLI resolves internally, all set to `model`. */
function modelEnv(model: string): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/**
 * Turn declarative profile inputs into resolved {@link InferenceProfile}s.
 * Each profile's `buildEnv()` reads the named env vars at call time so tokens
 * are never captured at config time.
 */
export function defineProfiles(
  inputs: InferenceProfileInput[]
): InferenceProfile[] {
  return inputs.map((input) => {
    const requiredEnvKeys = [input.authTokenEnv, input.apiKeyEnv].filter(
      (key): key is string => typeof key === "string" && key.length > 0
    );
    // Same test as the module's billing classification, so the two agree.
    const billing = input.authTokenEnv || input.apiKeyEnv ? "api" : "subscription";

    return {
      id: input.id,
      label: input.label,
      vendor: input.vendor,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      supportedThinkingLevels: input.supportedThinkingLevels,
      allowedTools: input.allowedTools,
      contextWindow: input.contextWindow,
      source: input.source,
      requiredEnvKeys,
      billing,
      buildEnv(): Record<string, string> {
        const env: Record<string, string> = {};
        if (input.baseUrl !== undefined) {
          env.ANTHROPIC_BASE_URL = input.baseUrl;
        }
        if (input.authTokenEnv !== undefined) {
          env.ANTHROPIC_AUTH_TOKEN = readEnvVar(input.authTokenEnv) ?? "";
          // Clear any inherited API key / OAuth token so the bearer-token path
          // wins over ambient credentials from the host process.
          env.ANTHROPIC_API_KEY = "";
          env.CLAUDE_CODE_OAUTH_TOKEN = "";
        }
        if (input.apiKeyEnv !== undefined) {
          env.ANTHROPIC_API_KEY = readEnvVar(input.apiKeyEnv) ?? "";
        }
        if (input.modelAliases && input.model !== undefined) {
          Object.assign(env, modelEnv(input.model));
        }
        return env;
      },
    };
  });
}

/**
 * The single built-in profile: native Claude Opus 5.5 at medium effort and
 * ambient credentials. Always available (no env keys required).
 */
export const DEFAULT_PROFILES: InferenceProfile[] = defineProfiles([
  { id: "claude", label: "Claude", vendor: "anthropic", model: "claude-opus-5-5", thinkingLevel: "medium" },
]);

export function getProfile(
  profiles: InferenceProfile[],
  id: string
): InferenceProfile | undefined {
  return profiles.find((profile) => profile.id === id);
}

export function isAvailable(profile: InferenceProfile): boolean {
  return profile.requiredEnvKeys.every((key) => {
    const value = readEnvVar(key);
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Safe metadata for the AVAILABLE profiles only — never keys or env. */
export function listProfiles(profiles: InferenceProfile[]): ProviderInfo[] {
  return profiles
    .filter(isAvailable)
    .map((profile) => {
      const levels = supportedClaudeEffort(profile);
      return {
        ...(levels.length ? { thinkingLevel: claudeEffort(profile), supportedThinkingLevels: levels } : {}),
        id: profile.id,
        label: profile.label,
        ...(profile.vendor !== undefined ? { vendor: profile.vendor } : {}),
        ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
        ...(profile.source !== undefined ? { source: profile.source } : {}),
      };
    });
}

/**
 * The profiles {@link listProfiles} leaves out because a required environment
 * key is missing (#1044). Only id, label and the `needs-credentials` reason:
 * the key's name stays on the host.
 */
export function listUnavailableProfiles(profiles: InferenceProfile[]): UnavailableProfile[] {
  return profiles
    .filter((profile) => !isAvailable(profile))
    .map((profile) => ({ id: profile.id, label: profile.label, reason: "needs-credentials" }));
}
