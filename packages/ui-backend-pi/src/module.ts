import type {
  BackendModule,
  BackendProfileError,
  BackendProfileParseResult,
  BackendProfileSchemaContext,
  ProviderInfo,
} from "@schlessera/brain-ui-sdk/server";
import { defineBackendModule } from "@schlessera/brain-ui-sdk/server";

import { hasStoredCredential } from "./auth.js";
import { createPiBackend } from "./backend.js";
import type { PiProfile } from "./backend-options.js";

const PROFILE_SOURCE = "BRAIN_UI_PI_PROFILES";
const CLAUDE_PROFILE_SOURCE = "BRAIN_UI_CLAUDE_PROFILES";
const CREDENTIAL_MEMO_MS = 5_000;

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

function failure(error: BackendProfileError): BackendProfileParseResult {
  return { ok: false, errors: [error] };
}

function parseProfiles(
  raw: string | null,
  context: BackendProfileSchemaContext
): BackendProfileParseResult {
  if (!raw) return { ok: true, profiles: [] };
  let inputs: unknown;
  try {
    inputs = JSON.parse(raw);
  } catch (error) {
    return failure({
      code: "invalid_json",
      message: `${PROFILE_SOURCE} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  if (!Array.isArray(inputs)) {
    return failure({
      code: "invalid_shape",
      message: `${PROFILE_SOURCE} must be a JSON array.`,
    });
  }

  const occupied = new Map(
    context.occupiedProfiles.map((profile) => [profile.id, profile.source])
  );
  const inactiveClaudeRaw = context.inactiveRosters?.find(
    (roster) => roster.backendId === "claude"
  )?.raw;
  if (inactiveClaudeRaw) {
    try {
      const inactiveClaudeProfiles = JSON.parse(inactiveClaudeRaw);
      if (Array.isArray(inactiveClaudeProfiles)) {
        for (const profile of inactiveClaudeProfiles) {
          if (profile && typeof profile.id === "string") {
            occupied.set(profile.id, CLAUDE_PROFILE_SOURCE);
          }
        }
      }
    } catch {
      // An inactive backend's malformed roster must not prevent the active backend booting.
    }
  }
  const seen = new Set<string>();
  for (const input of inputs as PiProfile[]) {
    if (!input || typeof input !== "object") {
      return failure({
        code: "invalid_entry",
        message: `Each ${PROFILE_SOURCE} entry must be an object.`,
      });
    }
    for (const field of ["id", "label", "vendor", "model"] as const) {
      if (typeof input[field] !== "string" || input[field].length === 0) {
        return failure({
          code: "invalid_entry",
          profileId: typeof input.id === "string" ? input.id : undefined,
          message: `Each ${PROFILE_SOURCE} entry needs a non-empty string ${field}.`,
        });
      }
    }
    if (input.id === "default" || /^claude(-|$)/.test(input.id)) {
      return failure({
        code: "reserved_id",
        profileId: input.id,
        message:
          `${PROFILE_SOURCE} id "${input.id}" is reserved for the Claude ` +
          "roster (built-in default and discovered claude-* aliases).",
      });
    }
    const occupiedSource = occupied.get(input.id);
    if (occupiedSource) {
      return failure({
        code: "duplicate_id",
        profileId: input.id,
        message:
          `${PROFILE_SOURCE} id "${input.id}" collides with a ` +
          `${occupiedSource} entry.`,
      });
    }
    if (seen.has(input.id)) {
      return failure({
        code: "duplicate_id",
        profileId: input.id,
        message: `Duplicate profile id in ${PROFILE_SOURCE}: "${input.id}".`,
      });
    }
    seen.add(input.id);
    if (
      input.thinkingLevel !== undefined &&
      !PI_THINKING_LEVELS.includes(input.thinkingLevel as PiThinkingLevel)
    ) {
      return failure({
        code: "invalid_entry",
        profileId: input.id,
        message:
          `${PROFILE_SOURCE} entry "${input.id}" has invalid thinkingLevel ` +
          `"${input.thinkingLevel}" (expected one of ${PI_THINKING_LEVELS.join(", ")}).`,
      });
    }
  }
  return { ok: true, profiles: inputs as PiProfile[] };
}

export const backendModule: BackendModule = defineBackendModule({
  id: "pi",
  profileSchema: {
    source: PROFILE_SOURCE,
    parse(raw, context) {
      return parseProfiles(raw, context);
    },
  },
  settingsHooks: {
    hiddenModelIds: true,
    defaultModelId: true,
    thinkingOverrides: true,
    billingOverrides: true,
  },
  resolveFromEnv(context) {
    try {
      const profiles = context.profiles as PiProfile[];
      const withOverrides = (): PiProfile[] => {
        const overrides = context.settings.getThinkingOverrides?.() ?? {};
        return profiles.map((profile) => {
          const override = overrides[profile.id];
          return override && PI_THINKING_LEVELS.includes(override as PiThinkingLevel)
            ? { ...profile, thinkingLevel: override as PiThinkingLevel }
            : profile;
        });
      };
      const backend = createPiBackend({
        brainPath: context.brainPath,
        ...(profiles.length > 0 ? { profiles: withOverrides } : {}),
        ...(context.confirmBashPatterns !== null
          ? { confirmBashPatterns: context.confirmBashPatterns }
          : {}),
        ...(context.log ? { log: context.log } : {}),
      });
      let credentialCache: { at: number; value: boolean } | null = null;
      const hasCredential = (): boolean => {
        if (credentialCache && Date.now() - credentialCache.at < CREDENTIAL_MEMO_MS) {
          return credentialCache.value;
        }
        let value = false;
        try {
          value = hasStoredCredential("openai-codex");
        } catch {
          value = false;
        }
        credentialCache = { at: Date.now(), value };
        return value;
      };
      return {
        ok: true,
        value: {
          backend,
          classifyBilling(profile: ProviderInfo) {
            return profile.vendor === "openai-codex" ? "subscription" : "api";
          },
          preferredProfile: {
            matches(profile: ProviderInfo) {
              return profile.vendor === "openai-codex";
            },
            hasCredential,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },
});
