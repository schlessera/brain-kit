import type { Logger } from "@opentelemetry/api-logs";
import { createRequire } from "module";
import type { AgentConfig } from "../config/env.js";
import type { BillingMode, ProviderInfo } from "@schlessera/brain-ui-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
} from "@schlessera/brain-ui-sdk/server";

/**
 * Backend registry for one app instance. Built by `createApp()` from the
 * resolved configuration — no ambient environment and no module-level state,
 * so two apps with different backend configuration coexist in one process and
 * tests install fakes by constructing a registry, not by mutating a module.
 *
 * BOTH backend packages are optional peers loaded lazily (the same
 * dynamic-import path): a deployment installs the one its AGENT_BACKEND
 * names, and the other never has to be present — at runtime AND at
 * type-check time (see the structural mirrors below).
 *
 * The old five hardcoded personal inference profiles are gone: the Claude
 * backend ships the single "claude" default, and additional Anthropic-compatible
 * endpoints are declared via the BRAIN_UI_CLAUDE_PROFILES env var (documented in
 * .env.example) rather than in code.
 */

/*
 * Structural mirrors of @schlessera/brain-backend-claude.
 *
 * Both backend packages are optional peers, and NOTHING here may reference
 * their specifiers — not even in a type position. A type import (or a
 * `typeof import(...)`) is resolved by TypeScript, so it would either survive
 * into the emitted `.d.ts` (breaking the `types`-condition consumer) or, once
 * scrubbed there, still break the `bun`-condition consumer whose tsconfig
 * follows `src/index.ts` (this repo's own root tsconfig does exactly that).
 * Either way a pi-only TypeScript deployment would need the Claude package —
 * and its Anthropic Agent SDK — installed just to typecheck. Half of F1
 * undone.
 *
 * So the slice of the Claude module this registry drives is mirrored here by
 * hand, in exchange for two mechanical guards in
 * tests/declaration-surface.test.ts: type-level assertions that the REAL
 * module (tests may import it; only src must stay clean) is assignable to
 * these mirrors — so drift fails the build — and a scan proving no backend
 * specifier appears anywhere under src/ or in any emitted declaration.
 * Function members are property-style on purpose: strictFunctionTypes checks
 * them contravariantly, where method syntax would be bivariant and let an
 * incompatible drift slide.
 */

/**
 * Mirror of the backends' `BackendLogFn` — the minimal log seam a backend
 * accepts. A callback rather than a Logger so the backend packages carry no
 * telemetry dependency; {@link toBackendLog} adapts the registry's Logger.
 */
export type BackendLogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attrs?: Record<string, string | number | boolean>
) => void;

const LEVEL_SEVERITY = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
} as const;

function toBackendLog(log: Logger): BackendLogFn {
  return (level, message, attrs) =>
    log.emit({
      severityText: LEVEL_SEVERITY[level],
      body: message,
      ...(attrs ? { attributes: attrs } : {}),
    });
}

/** Mirror of the Claude package's `InferenceProfileInput` (declarative shape). */
export interface ClaudeProfileInput {
  id: string;
  label: string;
  vendor?: string;
  /** Model id. Undefined = the SDK/CLI default model. */
  model?: string;
  /** Anthropic-compatible endpoint. */
  baseUrl?: string;
  /** Name of the env var holding a bearer token. */
  authTokenEnv?: string;
  /** Name of the env var holding an x-api-key. */
  apiKeyEnv?: string;
  /** Remap the CLI's model-alias envs to `model`. Requires `model`. */
  modelAliases?: boolean;
  allowedTools?: string[];
  /** Context window in tokens, when known. Presentation only. */
  contextWindow?: number;
  /** Where this profile came from. Presentation only. */
  source?: "builtin" | "declared" | "discovered";
}

/** Reasoning levels pi accepts (mirror of pi-agent-core's `ThinkingLevel`). */
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

/** Mirror of the pi package's `PiProfile` (declarative shape). */
export interface PiProfileInput {
  id: string;
  label: string;
  /** pi provider id, e.g. "openai-codex", "anthropic", "google". */
  vendor: string;
  /** pi model id within the vendor, e.g. "gpt-5.6-sol". */
  model: string;
  /** Reasoning level for new sessions; pi clamps to the model's capability. */
  thinkingLevel?: PiThinkingLevel;
}

/** Mirror of the Claude package's resolved `InferenceProfile`. */
export interface ClaudeProfile {
  id: string;
  label: string;
  vendor?: string;
  model?: string;
  allowedTools?: string[];
  contextWindow?: number;
  source?: "builtin" | "declared" | "discovered";
  /** Env vars that must be present (non-empty) for this profile to be usable. */
  requiredEnvKeys: string[];
  /** Environment overrides merged over the host environment. */
  buildEnv: () => Record<string, string>;
}

/**
 * The slice of the lazily-required Claude module this registry drives. The
 * real module carries more (and looser-optional) options; assignability is
 * asserted in tests/declaration-surface.test.ts.
 */
export interface ClaudeBackendModule {
  createClaudeBackend: (options: {
    brainPath: string;
    claudeCodePath?: string;
    profiles?: ClaudeProfile[] | (() => ClaudeProfile[]);
    confirmBashPatterns?: readonly string[];
    log?: BackendLogFn;
  }) => AgentBackend;
  createModelSource: (options: {
    brainPath: string;
    ttlMs?: number;
    enabled?: boolean;
  }) => ClaudeModelSource;
  defineProfiles: (inputs: ClaudeProfileInput[]) => ClaudeProfile[];
}

/** Discovery source as the registry internals see it: the public slice + list(). */
export interface ClaudeModelSource extends ModelDiscoverySource {
  list: () => ClaudeProfileInput[];
}

/**
 * Discovery freshness, as exposed on the public registry surface.
 *
 * `list()` is omitted on purpose — it returns Claude profile inputs, only the
 * registry internals consume it (see {@link ClaudeModelSource}), and exposing
 * it would put those types on every consumer's plate for no reader.
 */
export interface ModelDiscoveryState {
  enabled: boolean;
  /** When discovery last succeeded; null when it never has. */
  refreshedAt: number | null;
  /** The cached result is older than the TTL (or absent). */
  stale: boolean;
  /** Last discovery failure, if the current list is served despite one. */
  error?: string;
}

/** The slice of the Claude backend's discovery source the routes consume. */
export interface ModelDiscoverySource {
  state(): ModelDiscoveryState;
  /** Refresh if stale. Awaits only when there is nothing cached to serve. */
  ensureFresh(): Promise<void>;
  /** Force a refresh regardless of TTL. Rejects on failure. */
  refresh(): Promise<void>;
}

export interface BackendRegistryOptions {
  /** Where the brain repo lives (handed to every backend). */
  brainPath: string;
  /** Resolved agent configuration (AGENT_BACKEND, profiles, discovery...). */
  agent: AgentConfig;
  /**
   * Profile ids the user keeps out of the model picker (from the app's
   * settings table). Presentation only — a hidden profile still resolves for
   * sessions pinned to it. Defaults to "nothing hidden".
   */
  getHiddenModelIds?: () => string[];
  /**
   * Settings-stored default profile id (Settings → Models). Null/absent =
   * auto (a connected subscription-auth profile, else the default backend's
   * own default).
   */
  getDefaultModelId?: () => string | null;
  /**
   * User-managed OpenRouter model ids (from the app's settings table), added
   * to the Claude roster as declared OpenRouter profiles at runtime.
   */
  getCustomOpenRouterModels?: () => string[];
  /**
   * Per-profile reasoning-effort overrides (from the app's settings table),
   * applied over the pi roster's configured levels at read time — no rebuild
   * or redeploy needed.
   */
  getThinkingOverrides?: () => Record<string, PiThinkingLevel>;
  /**
   * Per-profile billing-mode overrides (from the app's settings table).
   * Consulted LAST: an override wins over both the declared-credential rule
   * and the ambient predicate. Defaults to "no overrides".
   */
  getBillingOverrides?: () => Record<string, BillingMode>;
  /**
   * Where the registry and its backends report. Adapted to the backends'
   * minimal callback ({@link BackendLogFn}) before crossing the package
   * boundary. Absent means silence.
   */
  log?: Logger;
}

export interface BackendRegistry {
  /** All configured backends, with the default backend first. */
  getBackends(): Promise<AgentBackend[]>;
  /** Find a configured backend by its stable id. */
  getBackendById(id: string): Promise<AgentBackend | undefined>;
  /** The default backend used for new and legacy sessions. */
  getDefaultBackend(): Promise<AgentBackend>;
  /** The stable id of the default backend. */
  getDefaultBackendId(): Promise<string>;
  /** Resolve the backend that owns a globally unique profile id. */
  getBackendForProfile(profileId: string): Promise<AgentBackend | undefined>;
  /** Resolve a persisted backend id, falling back for legacy/unknown sessions. */
  getBackendForSession(backendId: string | null | undefined): Promise<AgentBackend>;
  /**
   * Every available profile, tagged with its owning backend id and (when the
   * registry can classify it) its resolved `billingMode` — settings override
   * applied last. Hidden profiles are omitted by default (this feeds the
   * picker); the settings screen passes `includeHidden` to render the full
   * catalog.
   */
  listAllProviders(options?: { includeHidden?: boolean }): Promise<ProviderInfo[]>;
  /**
   * The profile new sessions and host-initiated turns (shares, actions)
   * default to when the client named none, or null for "the default
   * backend's own default". Resolution: the Settings-stored default model
   * (when it still exists on the roster) wins; otherwise AUTO — a
   * subscription-auth profile (pi vendor "openai-codex") that is on the
   * roster, not hidden, and whose account is actually connected. The
   * resolved profile is also listed FIRST by `listAllProviders`, so a fresh
   * client's picker lands on it.
   */
  getPreferredProfileId(): Promise<string | null>;
  /** Per-backend capability metadata exposed by the providers route. */
  getBackendsInfo(): Promise<
    Record<string, { id: string; capabilities: BackendCapabilities }>
  >;
  /**
   * The Claude backend's discovery source, once the registry is built. Null
   * when discovery is disabled or the deployment runs a different backend.
   */
  getModelSource(): Promise<ModelDiscoverySource | null>;
  /** Drop the profile memo so the next read reflects a refresh or settings change. */
  invalidateProfiles(): void;
}

interface RegistrySnapshot {
  backends: AgentBackend[];
  byId: Map<string, AgentBackend>;
  defaultBackendId: string;
}

/**
 * Profiles are NOT part of the registry snapshot: a backend's roster can grow
 * while the process runs (model discovery refreshing behind a request), so they
 * are recomputed behind a short memo and can be invalidated explicitly.
 */
interface ProfileSnapshot {
  at: number;
  byBackend: Map<string, ProviderInfo[]>;
  owners: Map<string, string>;
}

const PROFILE_MEMO_MS = 5_000;

function buildSnapshot(
  backends: AgentBackend[],
  defaultBackendId: string
): RegistrySnapshot {
  if (backends.length === 0) {
    throw new Error("Backend registry requires at least one backend.");
  }

  const byId = new Map(backends.map((backend) => [backend.id, backend]));
  const resolvedDefaultId = byId.has(defaultBackendId)
    ? defaultBackendId
    : backends[0].id;
  const ordered = [
    byId.get(resolvedDefaultId)!,
    ...backends.filter((backend) => backend.id !== resolvedDefaultId),
  ];

  return { backends: ordered, byId, defaultBackendId: resolvedDefaultId };
}


const BACKEND_SPECIFIERS = {
  claude: "@schlessera/brain-backend-claude",
  pi: "@schlessera/brain-backend-pi",
} as const;

function unknownBackendError(primary: string): Error {
  return new Error(
    `AGENT_BACKEND="${primary}" does not match any configured backend ` +
      `(expected "claude" or "pi").`
  );
}

function missingBackendError(primary: "claude" | "pi"): Error {
  if (primary === "pi") {
    return new Error(
      'AGENT_BACKEND=pi but "@schlessera/brain-backend-pi" is not installed. ' +
        "Add it (with its pi SDK dependencies) or set AGENT_BACKEND=claude."
    );
  }
  return new Error(
    `AGENT_BACKEND=${primary} but "@schlessera/brain-backend-claude" is not installed. ` +
      "Add it (it carries the Claude Agent SDK) or set AGENT_BACKEND=pi."
  );
}

/**
 * Boot-time guard: the SELECTED backend's package must at least RESOLVE, so a
 * broken install refuses to start instead of reporting healthy and failing
 * every agent turn (the guarantee the old static import gave, restored without
 * giving up the lazy load — `require.resolve` never executes the module, so
 * the Agent SDK still loads on first use only). Called by `createApp()` next
 * to the auth assertions; skipped when an explicit registry is injected.
 *
 * An unrecognized AGENT_BACKEND fails here too, for the same reason.
 *
 * The `resolve` parameter exists for tests (simulating an absent package);
 * production callers pass nothing.
 */
/** The specifier an ERR_MODULE_NOT_FOUND failed on, or null for any other error. */
function moduleNotFoundSpecifier(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, specifier, message } = error as {
    code?: unknown;
    specifier?: unknown;
    message?: unknown;
  };
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return null;
  // Bun's ResolveMessage (not an Error instance) carries the failing
  // specifier as a property; Node quotes it in the message instead.
  if (typeof specifier === "string") return specifier;
  if (typeof message === "string") {
    const quoted = /Cannot find (?:package|module) '([^']+)'/.exec(message);
    if (quoted) return quoted[1];
  }
  return null;
}

/**
 * Load an optional backend package, mapping ONLY "the backend package itself
 * is not installed" to the actionable install hint. Everything else — the
 * backend missing one of its OWN transitive deps, a syntax error, a throwing
 * top-level — is a different failure whose original error IS the diagnostic,
 * so it is rethrown untouched. The distinction rides on ERR_MODULE_NOT_FOUND
 * naming the specifier it failed on: a transitive miss names the transitive
 * dep, not the backend, and must not read as "backend not installed".
 *
 * `await import()` rather than `createRequire()(...)`: the backend packages
 * are ESM, and a CJS require of them under plain Node dies with
 * ERR_REQUIRE_ESM — which the old blanket catch then reported as "not
 * installed" on a machine where the package was sitting right there.
 *
 * The `importer` parameter exists for tests (simulating absent or broken
 * packages); production callers pass nothing.
 */
export async function loadBackendModule(
  // "claude" | "pi" spelled out, NOT keyof typeof BACKEND_SPECIFIERS: the
  // keyof form drags the table's literal string types — the backend
  // specifiers — into the emitted .d.ts, which the declaration-surface gate
  // rightly refuses.
  key: "claude" | "pi",
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier)
): Promise<unknown> {
  const specifier = BACKEND_SPECIFIERS[key];
  try {
    return await importer(specifier);
  } catch (error) {
    if (moduleNotFoundSpecifier(error) === specifier) throw missingBackendError(key);
    throw error;
  }
}

/**
 * Parse + validate the pi roster from BRAIN_UI_PI_PROFILES (a JSON array of
 * {id,label,vendor,model,thinkingLevel?}). Malformed input THROWS rather than
 * silently dropping the roster; `assertBackendResolvable` runs this at boot so
 * a bad config refuses to start instead of reporting healthy and 500ing later.
 *
 * Ids Claude's side of the picker uses or can mint later ("default",
 * "claude", "claude-*" — discovery canonicalizes every Anthropic model to a
 * claude-* alias) are rejected, as is any collision with an id declared in
 * BRAIN_UI_CLAUDE_PROFILES — a cross-backend collision otherwise surfaces as
 * a 500 on first request. Claude's own JSON is parsed leniently here: when it
 * is malformed, the Claude loader raises its own (more precise) boot error.
 */
export function parsePiProfiles(
  raw: string | null,
  claudeProfilesRaw?: string | null
): PiProfileInput[] {
  if (!raw) return [];

  let inputs: unknown;
  try {
    inputs = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `BRAIN_UI_PI_PROFILES is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!Array.isArray(inputs)) {
    throw new Error("BRAIN_UI_PI_PROFILES must be a JSON array.");
  }

  const claudeIds = new Set<string>();
  if (claudeProfilesRaw) {
    try {
      const claudeInputs = JSON.parse(claudeProfilesRaw);
      if (Array.isArray(claudeInputs)) {
        for (const entry of claudeInputs) {
          if (entry && typeof entry.id === "string") claudeIds.add(entry.id);
        }
      }
    } catch {
      // Malformed Claude JSON is the Claude loader's error to raise.
    }
  }

  const seen = new Set<string>();
  for (const input of inputs as PiProfileInput[]) {
    if (!input || typeof input !== "object") {
      throw new Error("Each BRAIN_UI_PI_PROFILES entry must be an object.");
    }
    for (const field of ["id", "label", "vendor", "model"] as const) {
      if (typeof input[field] !== "string" || input[field].length === 0) {
        throw new Error(
          `Each BRAIN_UI_PI_PROFILES entry needs a non-empty string ${field}.`
        );
      }
    }
    if (input.id === "default" || /^claude(-|$)/.test(input.id)) {
      throw new Error(
        `BRAIN_UI_PI_PROFILES id "${input.id}" is reserved for the Claude ` +
          "roster (built-in default and discovered claude-* aliases)."
      );
    }
    if (claudeIds.has(input.id)) {
      throw new Error(
        `BRAIN_UI_PI_PROFILES id "${input.id}" collides with a ` +
          "BRAIN_UI_CLAUDE_PROFILES entry."
      );
    }
    if (seen.has(input.id)) {
      throw new Error(`Duplicate profile id in BRAIN_UI_PI_PROFILES: "${input.id}".`);
    }
    seen.add(input.id);
    if (
      input.thinkingLevel !== undefined &&
      !PI_THINKING_LEVELS.includes(input.thinkingLevel)
    ) {
      throw new Error(
        `BRAIN_UI_PI_PROFILES entry "${input.id}" has invalid thinkingLevel ` +
          `"${input.thinkingLevel}" (expected one of ${PI_THINKING_LEVELS.join(", ")}).`
      );
    }
  }
  return inputs as PiProfileInput[];
}

export function assertBackendResolvable(
  agent: AgentConfig,
  resolve: (specifier: string) => void = (specifier) => {
    createRequire(import.meta.url).resolve(specifier);
  }
): void {
  const primary = agent.backend || "claude";
  if (!(primary in BACKEND_SPECIFIERS)) throw unknownBackendError(primary);
  const key = primary as keyof typeof BACKEND_SPECIFIERS;
  try {
    resolve(BACKEND_SPECIFIERS[key]);
  } catch {
    throw missingBackendError(key);
  }
  // BRAIN_UI_PI_PROFILES opts the pi backend in ALONGSIDE the primary — its
  // package must resolve at boot too, or the roster silently loses those
  // profiles on first request instead of refusing to start.
  if (agent.piProfilesJson && key !== "pi") {
    try {
      resolve(BACKEND_SPECIFIERS.pi);
    } catch {
      throw new Error(
        'BRAIN_UI_PI_PROFILES is set but "@schlessera/brain-backend-pi" is not ' +
          "installed. Add it (with its pi SDK dependencies) or unset the variable."
      );
    }
  }
  // Validate the pi roster itself at boot too — the registry is built lazily,
  // so without this a malformed BRAIN_UI_PI_PROFILES would still report a
  // healthy startup and only fail on first request.
  parsePiProfiles(agent.piProfilesJson, agent.profilesJson);
}

export function createBackendRegistry(
  options: BackendRegistryOptions
): BackendRegistry {
  const { brainPath, agent } = options;
  const getHidden = options.getHiddenModelIds ?? (() => []);
  const backendLog = options.log ? toBackendLog(options.log) : undefined;

  let cachedRegistry: Promise<RegistrySnapshot> | null = null;
  let modelSource: ClaudeModelSource | null = null;

  /**
   * Declared profiles carrying their OWN credential env vars
   * (authTokenEnv/apiKeyEnv) — api-billed regardless of the ambient
   * credential. Populated when the Claude roster resolves, which happens
   * before any profile can be listed or run.
   */
  const declaredApiProfileIds = new Set<string>();
  /** The Claude backend's id, once built — Claude's subscription path only applies to its own profiles. */
  let claudeBackendId: string | null = null;

  /**
   * Base billing classification for one roster entry, BEFORE the settings
   * override (applied last by the shared accessor surface):
   *   - a non-Claude backend profile → by VENDOR: pi's "openai-codex" runs
   *     only against a ChatGPT-subscription OAuth credential (the provider
   *     has no API-key path at all) → "subscription"; every other vendor
   *     resolves ambient API keys → "api";
   *   - a declared Claude profile with explicit credentials → "api";
   *   - everything ambient (built-in default, discovered models, declared
   *     entries without their own credentials) → the env-resolved ambient
   *     mode (subscription iff the OAuth token is present and no
   *     ANTHROPIC_API_KEY — the Agent SDK's own precedence).
   */
  function classifyBilling(profile: ProviderInfo & { backendId: string }): BillingMode {
    if (claudeBackendId === null || profile.backendId !== claudeBackendId) {
      return profile.vendor === "openai-codex" ? "subscription" : "api";
    }
    if (declaredApiProfileIds.has(profile.id)) return "api";
    return agent.ambientBilling;
  }

  /**
   * Declared profiles (built-in default + BRAIN_UI_CLAUDE_PROFILES) plus every
   * discovered model whose id isn't already declared. Declared wins: the env
   * stays an override mechanism, and a hand-pinned entry keeps its label and
   * endpoint.
   *
   * Memoized on the discovered array's identity — `createModelSource` swaps the
   * array only on a successful refresh, so steady state is one comparison.
   */
  let mergeCache: {
    declared: ClaudeProfile[];
    discovered: ClaudeProfileInput[];
    customKey: string;
    result: ClaudeProfile[];
  } | null = null;

  /**
   * User-managed OpenRouter models (Settings → Models) as declared Claude
   * profiles — same shape a BRAIN_UI_CLAUDE_PROFILES OpenRouter entry has,
   * but editable at runtime without an env change or redeploy.
   */
  function customOpenRouterInputs(): ClaudeProfileInput[] {
    const models = options.getCustomOpenRouterModels?.() ?? [];
    return models.map((model) => ({
      id: `openrouter:${model}`,
      label: `${model} (OpenRouter)`,
      vendor: "openrouter",
      model,
      baseUrl: "https://openrouter.ai/api",
      authTokenEnv: "OPENROUTER_API_KEY",
      modelAliases: true,
      source: "declared" as const,
    }));
  }

  function mergeDiscovered(
    claude: ClaudeBackendModule,
    declared: ClaudeProfile[],
    discovered: ClaudeProfileInput[]
  ): ClaudeProfile[] {
    const custom = customOpenRouterInputs();
    const customKey = custom.map((profile) => profile.id).join("\n");
    if (
      mergeCache &&
      mergeCache.declared === declared &&
      mergeCache.discovered === discovered &&
      mergeCache.customKey === customKey
    ) {
      return mergeCache.result;
    }

    const declaredIds = new Set(declared.map((profile) => profile.id));
    const customExtra = custom.filter((input) => !declaredIds.has(input.id));
    // OpenRouter runs on its own key: always api-billed, like an env-declared
    // profile with explicit credentials.
    for (const input of customExtra) declaredApiProfileIds.add(input.id);
    const knownIds = new Set([...declaredIds, ...customExtra.map((input) => input.id)]);
    const extra = discovered.filter((input) => !knownIds.has(input.id));
    const result = [...declared, ...claude.defineProfiles([...customExtra, ...extra])];
    mergeCache = { declared, discovered, customKey, result };
    return result;
  }

  // The built-in default profile's model. The Claude backend historically
  // pinned the default to a specific model; after the SDK extraction the pin
  // was lost and resumed default-profile sessions drifted to "whatever the CLI
  // defaults to", silently changing model/behaviour/billing on every CLI bump.
  // Re-pin it (a committed default, overridable per deploy via
  // BRAIN_UI_CLAUDE_DEFAULT_MODEL) so the default stays on a known model.
  function builtinDefaultProfiles(claude: ClaudeBackendModule): ClaudeProfile[] {
    return claude.defineProfiles([
      {
        id: "claude",
        label: "Claude",
        vendor: "anthropic",
        model: agent.defaultModel,
        modelAliases: true,
        source: "builtin",
      },
    ]);
  }

  /**
   * The Claude roster: the pinned built-in "claude" default first, plus any
   * extra profiles from BRAIN_UI_CLAUDE_PROFILES (a JSON array of profile
   * inputs: {id,label,model?,baseUrl?,authTokenEnv?,apiKeyEnv?,modelAliases?}).
   *
   * A malformed or duplicate-id roster THROWS — caught at boot by the registry
   * fail-fast — rather than silently degrading to default-only and rebilling
   * every pinned session to the subscription with nothing in the logs.
   */
  function loadClaudeProfiles(claude: ClaudeBackendModule): ClaudeProfile[] {
    const base = builtinDefaultProfiles(claude);
    const raw = agent.profilesJson;
    if (!raw) return base;

    let inputs: unknown;
    try {
      inputs = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `BRAIN_UI_CLAUDE_PROFILES is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (!Array.isArray(inputs)) {
      throw new Error("BRAIN_UI_CLAUDE_PROFILES must be a JSON array.");
    }

    // Reject duplicate ids (including collisions with the built-in "claude"): a
    // duplicate silently shadows and can resolve to the wrong credentials.
    const seen = new Set(base.map((profile) => profile.id));
    for (const input of inputs as ClaudeProfileInput[]) {
      if (!input || typeof input.id !== "string" || input.id.length === 0) {
        throw new Error(
          "Each BRAIN_UI_CLAUDE_PROFILES entry needs a non-empty string id."
        );
      }
      if (seen.has(input.id)) {
        throw new Error(
          `Duplicate profile id in BRAIN_UI_CLAUDE_PROFILES: "${input.id}".`
        );
      }
      seen.add(input.id);
      // The same non-empty test defineProfiles applies to requiredEnvKeys: a
      // profile bringing its own credential env var is api-billed.
      if (input.authTokenEnv || input.apiKeyEnv) declaredApiProfileIds.add(input.id);
    }

    const declared = (inputs as ClaudeProfileInput[]).map((input) => ({
      source: "declared" as const,
      ...input,
    }));
    return [...base, ...claude.defineProfiles(declared)];
  }


  /**
   * NEITHER backend package is a hard dependency — a deployment installs the
   * one its AGENT_BACKEND names (both, if it switches). Loaded lazily through
   * {@link loadBackendModule} so the server still boots without the unused
   * one; only "the package is absent" maps to the actionable install hint,
   * any other load failure surfaces as itself.
   */
  async function buildClaudeBackend(): Promise<AgentBackend> {
    const claude = (await loadBackendModule("claude")) as ClaudeBackendModule;
    if (typeof claude.createClaudeBackend !== "function") {
      throw new Error(
        '"@schlessera/brain-backend-claude" does not export createClaudeBackend.'
      );
    }

    // Declared profiles are resolved EAGERLY so a malformed
    // BRAIN_UI_CLAUDE_PROFILES still fails at boot rather than on first request.
    const declared = loadClaudeProfiles(claude);

    modelSource = claude.createModelSource({
      brainPath,
      enabled: agent.modelDiscovery,
      ttlMs: agent.modelTtlMs,
    });

    const backend = claude.createClaudeBackend({
      brainPath,
      claudeCodePath: agent.claudeCodePath,
      ...(backendLog ? { log: backendLog } : {}),
      // Omitted entirely when unconfigured, so the backend's own defaults
      // apply; an explicit [] passes through and disables confirmation.
      ...(agent.confirmBashPatterns !== null
        ? { confirmBashPatterns: agent.confirmBashPatterns }
        : {}),
      // A function, not an array: discovery refreshes in the background and the
      // new roster has to be visible without restarting the process.
      profiles: () =>
        mergeDiscovered(claude, declared, modelSource?.list() ?? []),
    });
    claudeBackendId = backend.id;
    return backend;
  }

  async function buildPiBackend(): Promise<AgentBackend> {
    const mod = (await loadBackendModule("pi")) as {
      createPiBackend?: (opts: {
        brainPath: string;
        profiles?: PiProfileInput[] | (() => PiProfileInput[]);
        log?: BackendLogFn;
        confirmBashPatterns?: readonly string[];
      }) => AgentBackend;
    };
    if (typeof mod.createPiBackend !== "function") {
      throw new Error(
        '"@schlessera/brain-backend-pi" does not export createPiBackend.'
      );
    }
    // Re-parsed here (assertBackendResolvable already validated at boot) so an
    // injected-registry path without the boot assert still fails loudly.
    const profiles = parsePiProfiles(agent.piProfilesJson, agent.profilesJson);
    // A FUNCTION, so per-profile thinking overrides from settings are read on
    // every use (roster listing AND new-session model resolution) — a change
    // in Settings applies to the next turn without a rebuild.
    const withOverrides = (): PiProfileInput[] => {
      const overrides = options.getThinkingOverrides?.() ?? {};
      return profiles.map((profile) =>
        overrides[profile.id]
          ? { ...profile, thinkingLevel: overrides[profile.id] }
          : profile
      );
    };
    return mod.createPiBackend({
      brainPath,
      ...(profiles.length > 0 ? { profiles: withOverrides } : {}),
      ...(backendLog ? { log: backendLog } : {}),
      // Same shared confirm-pattern config as the Claude backend, so both
      // backends stop on the same destructive bash shapes.
      ...(agent.confirmBashPatterns !== null
        ? { confirmBashPatterns: agent.confirmBashPatterns }
        : {}),
    });
  }

  async function buildRegistry(): Promise<RegistrySnapshot> {
    const primary = agent.backend || "claude";

    if (primary === "pi") {
      const pi = await buildPiBackend();
      return buildSnapshot([pi], pi.id);
    }

    const backends = [await buildClaudeBackend()];

    // BRAIN_UI_PI_PROFILES opts the pi backend in ALONGSIDE claude: its
    // profiles join the picker (e.g. OpenAI models under a ChatGPT
    // subscription via pi's "openai-codex" vendor) while claude stays the
    // default backend. Without the variable, behavior is unchanged.
    if (agent.piProfilesJson) {
      backends.push(await buildPiBackend());
    }

    // AGENT_BACKEND must name a configured backend. The in-process options are
    // "claude" (default) and "pi" (handled above). An unrecognized value is a
    // misconfiguration — fail loudly instead of silently coercing to claude and
    // running on the wrong backend with nothing in the logs.
    if (agent.backend && !backends.some((b) => b.id === primary)) {
      throw unknownBackendError(primary);
    }
    return buildSnapshot(backends, primary);
  }

  async function getRegistry(): Promise<RegistrySnapshot> {
    if (!cachedRegistry) cachedRegistry = buildRegistry();
    return cachedRegistry;
  }

  /**
   * Whether the openai-codex (ChatGPT subscription) account is connected —
   * a cheap file probe through the pi package, memoized briefly so provider
   * listings and turn routing don't re-read the auth store on every call.
   */
  let codexCredentialCache: { at: number; value: boolean } | null = null;
  async function hasCodexCredential(): Promise<boolean> {
    const piInPlay = Boolean(agent.piProfilesJson) || (agent.backend || "claude") === "pi";
    if (!piInPlay) return false;
    if (codexCredentialCache && Date.now() - codexCredentialCache.at < PROFILE_MEMO_MS) {
      return codexCredentialCache.value;
    }
    let value = false;
    try {
      const mod = (await loadBackendModule("pi")) as {
        hasStoredCredential?: (providerId: string) => boolean;
      };
      value =
        typeof mod.hasStoredCredential === "function" &&
        mod.hasStoredCredential("openai-codex");
    } catch {
      value = false;
    }
    codexCredentialCache = { at: Date.now(), value };
    return value;
  }

  return makeRegistry(
    getRegistry,
    getHidden,
    async () => {
      await getRegistry();
      return modelSource;
    },
    options.log,
    {
      classify: classifyBilling,
      ...(options.getBillingOverrides
        ? { getOverrides: options.getBillingOverrides }
        : {}),
    },
    {
      ...(options.getDefaultModelId ? { getOverride: options.getDefaultModelId } : {}),
      auto: { vendor: "openai-codex", hasCredential: hasCodexCredential },
    }
  );
}

/**
 * A registry over an explicit backend list — the seam tests (and embedders
 * with their own backend wiring) use instead of mutating module state. Takes
 * the same optional hidden-ids reader so visibility behavior matches
 * production.
 */
export function createStaticBackendRegistry(
  backends: AgentBackend[],
  defaultBackendId = backends[0]?.id ?? "",
  options: {
    getHiddenModelIds?: () => string[];
    getDefaultModelId?: () => string | null;
    getBillingOverrides?: () => Record<string, BillingMode>;
    log?: Logger;
  } = {}
): BackendRegistry {
  const snapshot = buildSnapshot(backends, defaultBackendId);
  return makeRegistry(
    async () => snapshot,
    options.getHiddenModelIds ?? (() => []),
    async () => null,
    options.log,
    // No classifier: an embedder's backends carry no credential topology this
    // registry could reason about, so only an explicit override sets a mode.
    options.getBillingOverrides
      ? { getOverrides: options.getBillingOverrides }
      : {},
    // No auto rule either — only the stored default applies here.
    options.getDefaultModelId ? { getOverride: options.getDefaultModelId } : {}
  );
}

/** The accessor surface, shared by the config-driven and static registries. */
function makeRegistry(
  getRegistry: () => Promise<RegistrySnapshot>,
  getHidden: () => string[],
  getModelSource: () => Promise<ModelDiscoverySource | null>,
  log?: Logger,
  billing: {
    /** Base classification per roster entry; absent = the registry cannot classify. */
    classify?: (profile: ProviderInfo & { backendId: string }) => BillingMode;
    /** Settings overrides, consulted LAST — an override wins over `classify`. */
    getOverrides?: () => Record<string, BillingMode>;
  } = {},
  defaults: {
    /** Settings-stored default profile id; null/absent = auto. */
    getOverride?: () => string | null;
    /** Auto rule: prefer this vendor's profile while its account is connected. */
    auto?: { vendor: string; hasCredential: () => Promise<boolean> };
  } = {}
): BackendRegistry {
  let profileSnapshot: ProfileSnapshot | null = null;

  /** Recompute the profile roster (memoized), asserting cross-backend id uniqueness. */
  async function getProfileSnapshot(): Promise<ProfileSnapshot> {
    if (profileSnapshot && Date.now() - profileSnapshot.at < PROFILE_MEMO_MS) {
      return profileSnapshot;
    }

    const registry = await getRegistry();
    const byBackend = new Map<string, ProviderInfo[]>();
    const owners = new Map<string, string>();

    for (const backend of registry.backends) {
      const profiles = await backend.listProfiles();
      byBackend.set(backend.id, profiles);
      for (const profile of profiles) {
        const owner = owners.get(profile.id);
        if (owner && owner !== backend.id) {
          throw new Error(
            `Profile id collision across backends: "${profile.id}" is exposed by "${owner}" and "${backend.id}".`
          );
        }
        owners.set(profile.id, backend.id);
      }
    }

    profileSnapshot = { at: Date.now(), byBackend, owners };
    return profileSnapshot;
  }

  /** A settings read failure must not take the picker down — degrade to "nothing hidden". */
  function hiddenIds(): Set<string> {
    try {
      return new Set(getHidden());
    } catch (err) {
      log?.emit({
        severityText: "WARN",
        body: "could not read hidden models; treating none as hidden",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
      return new Set();
    }
  }

  /** Same degradation discipline: a failed override read means derived modes apply. */
  function billingOverrides(): Record<string, BillingMode> {
    try {
      return billing.getOverrides?.() ?? {};
    } catch (err) {
      log?.emit({
        severityText: "WARN",
        body: "could not read billing overrides; using derived billing modes",
        attributes: { error: err instanceof Error ? err.message : String(err) },
      });
      return {};
    }
  }

  /**
   * The preferred-default profile. The stored Settings override wins while it
   * still names a roster profile (a vanished profile falls through to auto
   * rather than pinning turns to nothing); auto is the first non-hidden
   * roster entry of the auto vendor, but only while its credential exists.
   * Any failure degrades to "no preference" — this must never take routing
   * down.
   */
  async function getPreferredProfileId(): Promise<string | null> {
    try {
      const snapshot = await getProfileSnapshot();
      const override = defaults.getOverride?.() ?? null;
      if (override && snapshot.owners.has(override)) return override;

      const auto = defaults.auto;
      if (!auto) return null;
      const registry = await getRegistry();
      const hidden = hiddenIds();
      for (const backend of registry.backends) {
        const match = (snapshot.byBackend.get(backend.id) ?? []).find(
          (profile) => profile.vendor === auto.vendor && !hidden.has(profile.id)
        );
        if (match) return (await auto.hasCredential()) ? match.id : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  return {
    async getBackends() {
      return (await getRegistry()).backends;
    },

    async getBackendById(id) {
      return (await getRegistry()).byId.get(id);
    },

    async getDefaultBackend() {
      const registry = await getRegistry();
      return registry.byId.get(registry.defaultBackendId)!;
    },

    async getDefaultBackendId() {
      return (await getRegistry()).defaultBackendId;
    },

    async getBackendForProfile(profileId) {
      const registry = await getRegistry();
      // Deliberately resolved against the UNFILTERED roster: a session pinned
      // to a profile the user later hid must keep running.
      const snapshot = await getProfileSnapshot();
      const backendId = snapshot.owners.get(profileId);
      return backendId ? registry.byId.get(backendId) : undefined;
    },

    async getBackendForSession(backendId) {
      const registry = await getRegistry();
      if (backendId) {
        const backend = registry.byId.get(backendId);
        if (backend) return backend;
      }
      return registry.byId.get(registry.defaultBackendId)!;
    },

    async listAllProviders(options = {}) {
      const registry = await getRegistry();
      const snapshot = await getProfileSnapshot();
      const hidden = options.includeHidden ? new Set<string>() : hiddenIds();
      // Read fresh on every listing (not memoized with the snapshot), so a
      // saved override is live for the very next run without invalidation.
      const overrides = billingOverrides();

      const providers = registry.backends.flatMap((backend) =>
        (snapshot.byBackend.get(backend.id) ?? [])
          .filter((profile) => !hidden.has(profile.id))
          .map((profile) => {
            const entry = { ...profile, backendId: backend.id };
            const billingMode = overrides[profile.id] ?? billing.classify?.(entry);
            return billingMode ? { ...entry, billingMode } : entry;
          })
      );

      // A connected subscription-auth profile leads the list: a fresh client
      // with no stored selection defaults to providers[0].
      const preferredId = await getPreferredProfileId();
      if (preferredId) {
        const index = providers.findIndex((provider) => provider.id === preferredId);
        if (index > 0) providers.unshift(...providers.splice(index, 1));
      }
      return providers;
    },

    getPreferredProfileId,

    async getBackendsInfo() {
      const backends = (await getRegistry()).backends;
      return Object.fromEntries(
        backends.map((backend) => [
          backend.id,
          { id: backend.id, capabilities: backend.capabilities },
        ])
      );
    },

    getModelSource,

    invalidateProfiles() {
      profileSnapshot = null;
    },
  };
}
