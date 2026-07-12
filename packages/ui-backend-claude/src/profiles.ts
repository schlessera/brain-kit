import type { ProviderInfo } from "@brainform/ui-sdk";

/**
 * A resolved inference profile: a (model, endpoint, credentials) target the
 * Claude backend can run a conversation on. Descends from brain-ui's hardcoded
 * `ProviderConfig`, but the five personal presets are gone — profiles are now
 * declared by the host via {@link defineProfiles}.
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
  allowedTools?: string[];
  /** Env vars that must be present (non-empty) for this profile to be usable. */
  requiredEnvKeys: string[];
  /** Environment overrides merged over `process.env` before the query runs. */
  buildEnv(): Record<string, string>;
}

/** Declarative shape passed to {@link defineProfiles}. */
export interface InferenceProfileInput {
  id: string;
  label: string;
  vendor?: string;
  /** Model id. Undefined = the SDK/CLI default model. */
  model?: string;
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

    return {
      id: input.id,
      label: input.label,
      vendor: input.vendor,
      model: input.model,
      allowedTools: input.allowedTools,
      requiredEnvKeys,
      buildEnv(): Record<string, string> {
        const env: Record<string, string> = {};
        if (input.baseUrl !== undefined) {
          env.ANTHROPIC_BASE_URL = input.baseUrl;
        }
        if (input.authTokenEnv !== undefined) {
          env.ANTHROPIC_AUTH_TOKEN = process.env[input.authTokenEnv] ?? "";
          // Clear any inherited API key / OAuth token so the bearer-token path
          // wins over ambient credentials from the host process.
          env.ANTHROPIC_API_KEY = "";
          env.CLAUDE_CODE_OAUTH_TOKEN = "";
        }
        if (input.apiKeyEnv !== undefined) {
          env.ANTHROPIC_API_KEY = process.env[input.apiKeyEnv] ?? "";
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
 * The single built-in profile: native Claude on the SDK's default model and
 * ambient credentials. Always available (no env keys required).
 */
export const DEFAULT_PROFILES: InferenceProfile[] = defineProfiles([
  { id: "claude", label: "Claude", vendor: "anthropic" },
]);

export function getProfile(
  profiles: InferenceProfile[],
  id: string
): InferenceProfile | undefined {
  return profiles.find((profile) => profile.id === id);
}

export function isAvailable(profile: InferenceProfile): boolean {
  return profile.requiredEnvKeys.every((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/** Safe metadata for the AVAILABLE profiles only — never keys or env. */
export function listProfiles(profiles: InferenceProfile[]): ProviderInfo[] {
  return profiles.filter(isAvailable).map(({ id, label, vendor }) => ({
    id,
    label,
    ...(vendor !== undefined ? { vendor } : {}),
  }));
}
