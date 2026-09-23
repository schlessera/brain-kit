import type {
  BackendModule,
  BackendModuleContext,
  BackendProfileError,
  BackendProfileParseResult,
  PricingRoute,
  ProviderInfo,
} from "@schlessera/brain-ui-sdk/server";
import { defineBackendModule } from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "./backend.js";
import { readEnvVar } from "./config/env.js";
import { createModelSource } from "./model-discovery.js";
import {
  defineProfiles,
  type InferenceProfile,
  type InferenceProfileInput,
} from "./profiles.js";

const PROFILE_SOURCE = "BRAIN_UI_CLAUDE_PROFILES";

function failure(error: BackendProfileError): BackendProfileParseResult {
  return { ok: false, errors: [error] };
}

function parseProfiles(
  raw: string | null,
  occupiedProfiles: readonly { id: string; source: string }[]
): BackendProfileParseResult {
  const builtin: InferenceProfileInput = {
    id: "claude",
    label: "Claude",
    vendor: "anthropic",
    modelAliases: true,
    source: "builtin",
  };
  if (!raw) return { ok: true, profiles: [builtin] };

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

  const seen = new Set([builtin.id, ...occupiedProfiles.map((profile) => profile.id)]);
  for (const input of inputs as InferenceProfileInput[]) {
    if (!input || typeof input.id !== "string" || input.id.length === 0) {
      return failure({
        code: "invalid_entry",
        message: `Each ${PROFILE_SOURCE} entry needs a non-empty string id.`,
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
  }

  return {
    ok: true,
    profiles: [
      builtin,
      ...(inputs as InferenceProfileInput[]).map((input) => ({
        source: "declared" as const,
        ...input,
      })),
    ],
  };
}

function configString(context: BackendModuleContext, key: string): string {
  const value = context.config[key];
  return typeof value === "string" ? value : "";
}

function configBoolean(context: BackendModuleContext, key: string): boolean {
  return context.config[key] === true;
}

function configNumber(context: BackendModuleContext, key: string): number | undefined {
  const value = context.config[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Where requests to a given endpoint actually go, for pricing. An endpoint on
 * OpenRouter is billed at OpenRouter's resale rates, which differ from the
 * vendor's for the ids both catalogs carry. No endpoint at all means the SDK's
 * own Anthropic base URL — a direct vendor call. Any other Anthropic-compatible
 * proxy resells at rates no catalog describes, so its route stays unknown
 * rather than being guessed: an unknown route prices by model id, while a
 * wrong one freezes a rate the run was never billed at.
 */
function routeForBaseUrl(baseUrl: string | undefined): PricingRoute | undefined {
  if (!baseUrl) return "direct";
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // An unparseable baseUrl says nothing about the route.
    return undefined;
  }
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai")
    ? "openrouter"
    : undefined;
}

export const backendModule: BackendModule = defineBackendModule({
  id: "claude",
  profileSchema: {
    source: PROFILE_SOURCE,
    parse(raw, context) {
      return parseProfiles(raw, context.occupiedProfiles);
    },
  },
  settingsHooks: {
    hiddenModelIds: true,
    defaultModelId: true,
    customOpenRouterModels: true,
    billingOverrides: true,
  },
  modelSource(context) {
    return createModelSource({
      brainPath: context.brainPath,
      enabled: configBoolean(context, "modelDiscovery"),
      ...(configNumber(context, "modelTtlMs") !== undefined
        ? { ttlMs: configNumber(context, "modelTtlMs") }
        : {}),
    });
  },
  resolveFromEnv(context) {
    try {
      const defaultModel = configString(context, "defaultModel");
      const inputs = context.profiles as InferenceProfileInput[];
      const declaredApiProfileIds = new Set<string>();
      // Declared endpoint per profile id, for pricing-route classification.
      // The URL is stored rather than a resolved route because a profile that
      // declares none inherits the ambient one, which is only knowable later.
      const profileBaseUrls = new Map<string, string>();
      const rememberRoute = (input: InferenceProfileInput) => {
        if (input.baseUrl) profileBaseUrls.set(input.id, input.baseUrl);
      };
      const normalized = inputs.map((input) => {
        const resolved =
          input.id === "claude" && input.source === "builtin"
            ? { ...input, ...(defaultModel ? { model: defaultModel } : {}) }
            : input;
        if (resolved.authTokenEnv || resolved.apiKeyEnv) {
          declaredApiProfileIds.add(resolved.id);
        }
        rememberRoute(resolved);
        return resolved;
      });
      const declared = defineProfiles(normalized);

      let mergeCache: {
        discovered: readonly InferenceProfileInput[];
        customKey: string;
        result: InferenceProfile[];
      } | null = null;
      const profiles = (): InferenceProfile[] => {
        const custom = (context.settings.getCustomOpenRouterModels?.() ?? []).map(
          (model): InferenceProfileInput => ({
            id: `openrouter:${model}`,
            label: `${model} (OpenRouter)`,
            vendor: "openrouter",
            model,
            baseUrl: "https://openrouter.ai/api",
            authTokenEnv: "OPENROUTER_API_KEY",
            modelAliases: true,
            source: "declared",
          })
        );
        const discovered = (context.modelSource?.list() ?? []) as InferenceProfileInput[];
        const customKey = custom.map((profile) => profile.id).join("\n");
        if (
          mergeCache &&
          mergeCache.discovered === discovered &&
          mergeCache.customKey === customKey
        ) {
          return mergeCache.result;
        }
        const declaredIds = new Set(declared.map((profile) => profile.id));
        const customExtra = custom.filter((input) => !declaredIds.has(input.id));
        for (const input of customExtra) {
          declaredApiProfileIds.add(input.id);
          rememberRoute(input);
        }
        const knownIds = new Set([
          ...declaredIds,
          ...customExtra.map((input) => input.id),
        ]);
        const extra = discovered.filter((input) => !knownIds.has(input.id));
        for (const input of extra) rememberRoute(input);
        const result = [...declared, ...defineProfiles([...customExtra, ...extra])];
        mergeCache = { discovered, customKey, result };
        return result;
      };

      const claudeCodePath = configString(context, "claudeCodePath");
      const backend = createClaudeBackend({
        brainPath: context.brainPath,
        ...(claudeCodePath ? { claudeCodePath } : {}),
        profiles,
        ...(context.confirmBashPatterns !== null
          ? { confirmBashPatterns: context.confirmBashPatterns }
          : {}),
        ...(context.log ? { log: context.log } : {}),
      });
      return {
        ok: true,
        value: {
          backend,
          classifyBilling(profile: ProviderInfo) {
            // A profile without its own credential runs on the subscription or
            // is refused before its prompt is sent (subscription.ts), so the
            // host's ambient credentials no longer decide this.
            return declaredApiProfileIds.has(profile.id) ? "api" : "subscription";
          },
          classifyRoute(profile: ProviderInfo) {
            // A profile that declares no baseUrl does NOT thereby reach
            // Anthropic: `buildEnv()` sets nothing, the host's own
            // ANTHROPIC_BASE_URL survives the subprocess env filter (it is on
            // the agent allowlist), and the turn goes wherever that points. An
            // operator who set it to OpenRouter globally would otherwise have
            // every run frozen at Anthropic's rates. Read at classify time,
            // never cached at setup: this value decides which rate lands in a
            // rollup, and a stale read would freeze the wrong one.
            return routeForBaseUrl(
              profileBaseUrls.get(profile.id) ?? readEnvVar("ANTHROPIC_BASE_URL")
            );
          },
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },
});
