import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { resolveThinkingLevel } from "@schlessera/brain-ui-sdk/internal";
import type { Model } from "@earendil-works/pi-ai";
import type { ProviderInfo } from "@schlessera/brain-ui-sdk/server";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";

import type { CreatePiBackendOptions, PiProfile } from "./backend-options.js";

export interface ModelSpec {
  vendor?: string;
  model: string;
  thinkingLevel?: PiProfile["thinkingLevel"];
}

export function configuredProfiles(
  options: CreatePiBackendOptions
): PiProfile[] | undefined {
  return typeof options.profiles === "function" ? options.profiles() : options.profiles;
}

export function parseModelString(spec: string): ModelSpec {
  const slash = spec.indexOf("/");
  if (slash > 0) return { vendor: spec.slice(0, slash), model: spec.slice(slash + 1) };
  return { model: spec };
}

export function resolveModelSpec(
  options: CreatePiBackendOptions,
  profileId?: string
): ModelSpec | undefined {
  const profiles = configuredProfiles(options);
  if (profileId) {
    if (profileId === "default" && !profiles?.length && options.model) return parseModelString(options.model);
    const p = profiles?.find((x) => x.id === profileId);
    if (p) return { vendor: p.vendor, model: p.model, thinkingLevel: p.thinkingLevel };
    // Ad-hoc "vendor/modelId" profile ids are accepted (config-driven UIs may
    // pass them directly). A malformed opaque id is a caller error.
    if (profileId.includes("/")) return parseModelString(profileId);
    throw new BackendRequestError(`Unknown profileId: ${profileId}`);
  }
  if (profiles && profiles.length > 0) {
    const p = profiles[0];
    return { vendor: p.vendor, model: p.model, thinkingLevel: p.thinkingLevel };
  }
  if (options.model) return parseModelString(options.model);
  return undefined;
}

/**
 * Resolve a spec to a concrete pi Model, or undefined to let pi choose (only
 * when no vendor was configured at all). A DECLARED vendor/model that is not
 * in pi's builtin catalog throws instead of silently handing the choice back
 * to pi — which would run whichever provider happens to have ambient
 * credentials, under the declared profile's label and billing.
 */
export function toModel(spec: ModelSpec | undefined): Model<any> | undefined {
  if (!spec?.vendor) return undefined;
  let model: Model<any> | undefined;
  try {
    // Cast: getBuiltinModel is literal-typed over the static catalog; at
    // runtime it's a lookup returning undefined for unknown vendor/model.
    model = getBuiltinModel(spec.vendor as never, spec.model as never) as
      | Model<any>
      | undefined;
  } catch {
    model = undefined;
  }
  if (!model) {
    throw new BackendRequestError(
      `Unknown model "${spec.vendor}/${spec.model}" — not in pi's builtin catalog. ` +
        "Fix the profile's vendor/model or update the pi SDK."
    );
  }
  return model;
}

export function listPiProfiles(options: CreatePiBackendOptions): ProviderInfo[] {
  // Precedence: explicit profiles → a single default from `model`. No pi
  // ModelRegistry fallback: on a machine with an OpenRouter key that returns
  // ~1700 models — useless as a picker list, environment-dependent, and it
  // surfaces ids the deployment never chose. Profiles are deliberately an
  // explicit-configuration surface; a "vendor/model" string is still accepted
  // as an ad-hoc profileId (resolveModelSpec).
  const profiles = configuredProfiles(options);
  if (profiles && profiles.length > 0) {
    return profiles.map((p) => {
      // Effective reasoning level (pi defaults absent ones to "medium").
      // Presence doubles as "this profile supports an effort setting", so it
      // is OMITTED for models the catalog marks non-reasoning — pi would clamp
      // any level to "off" there, and advertising an effort knob for them
      // would be a lie. An unknown model (declared typo — fails loudly at
      // session time) gets no knob either.
      let model: Model<any> | undefined;
      try {
        model = p.vendor !== undefined ? getBuiltinModel(p.vendor as never, p.model as never) as Model<any> | undefined : undefined;
      } catch {
        model = undefined;
      }
      return {
        id: p.id,
        label: p.label,
        vendor: p.vendor,
        ...(model?.reasoning ? {
          thinkingLevel: resolveThinkingLevel(p.thinkingLevel ?? "medium", getSupportedThinkingLevels(model)),
          supportedThinkingLevels: getSupportedThinkingLevels(model),
        } : {}),
      };
    });
  }
  if (options.model) {
    const spec = parseModelString(options.model);
    return listPiProfiles({ ...options, profiles: [{ ...spec, id: "default", label: options.model }] });
  }
  return [];
}
