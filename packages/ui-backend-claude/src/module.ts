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
 * Where a profile's requests actually go, for pricing. A profile with no
 * `baseUrl` runs against the SDK's own Anthropic endpoint — a direct vendor
 * call, billed at Anthropic's rates. A profile pointed at OpenRouter is billed
 * at OpenRouter's resale rates, which differ from the vendor's for ids both
 * catalogs carry. Any other Anthropic-compatible proxy resells at rates no
 * catalog describes, so its route stays unknown rather than being guessed.
 */
function routeForProfile(input: InferenceProfileInput): PricingRoute | undefined {
  if (!input.baseUrl) return "direct";
  let host: string;
  try {
    host = new URL(input.baseUrl).hostname.toLowerCase();
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
      // Pricing route per profile id, learned from the declared endpoint. A
      // profile absent from the map has no known route and prices by model id
      // alone, exactly as everything did before routes existed.
      const profileRoutes = new Map<string, PricingRoute>();
      const rememberRoute = (input: InferenceProfileInput) => {
        const route = routeForProfile(input);
        if (route) profileRoutes.set(input.id, route);
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
      const ambientBilling =
        context.config.ambientBilling === "subscription" ? "subscription" : "api";
      return {
        ok: true,
        value: {
          backend,
          classifyBilling(profile: ProviderInfo) {
            return declaredApiProfileIds.has(profile.id) ? "api" : ambientBilling;
          },
          classifyRoute(profile: ProviderInfo) {
            return profileRoutes.get(profile.id);
          },
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },
});
