import type { Logger } from "@opentelemetry/api-logs";
import { createRequire } from "module";
import type { AgentConfig } from "../config/env.js";
import type { ProviderInfo } from "@schlessera/brain-ui-sdk";
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
 * `createRequire` path): a deployment installs the one its AGENT_BACKEND
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
   * Every available profile, tagged with its owning backend id. Hidden
   * profiles are omitted by default (this feeds the picker); the settings
   * screen passes `includeHidden` to render the full catalog.
   */
  listAllProviders(options?: { includeHidden?: boolean }): Promise<ProviderInfo[]>;
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
}

export function createBackendRegistry(
  options: BackendRegistryOptions
): BackendRegistry {
  const { brainPath, agent } = options;
  const getHidden = options.getHiddenModelIds ?? (() => []);

  let cachedRegistry: Promise<RegistrySnapshot> | null = null;
  let modelSource: ClaudeModelSource | null = null;

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
    result: ClaudeProfile[];
  } | null = null;

  function mergeDiscovered(
    claude: ClaudeBackendModule,
    declared: ClaudeProfile[],
    discovered: ClaudeProfileInput[]
  ): ClaudeProfile[] {
    if (
      mergeCache &&
      mergeCache.declared === declared &&
      mergeCache.discovered === discovered
    ) {
      return mergeCache.result;
    }

    const declaredIds = new Set(declared.map((profile) => profile.id));
    const extra = discovered.filter((input) => !declaredIds.has(input.id));
    const result = [...declared, ...claude.defineProfiles(extra)];
    mergeCache = { declared, discovered, result };
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
   * the same `createRequire` path so the server still boots without the unused
   * one; when the configured backend's package is absent, fail with an
   * actionable message.
   */
  function buildClaudeBackend(): AgentBackend {
    const require = createRequire(import.meta.url);
    let claude: ClaudeBackendModule;
    try {
      claude = require("@schlessera/brain-backend-claude");
    } catch {
      throw missingBackendError("claude");
    }
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

    return claude.createClaudeBackend({
      brainPath,
      claudeCodePath: agent.claudeCodePath,
      // A function, not an array: discovery refreshes in the background and the
      // new roster has to be visible without restarting the process.
      profiles: () =>
        mergeDiscovered(claude, declared, modelSource?.list() ?? []),
    });
  }

  function buildPiBackend(): AgentBackend {
    const require = createRequire(import.meta.url);
    let mod: { createPiBackend?: (opts: { brainPath: string }) => AgentBackend };
    try {
      mod = require("@schlessera/brain-backend-pi");
    } catch {
      throw missingBackendError("pi");
    }
    if (typeof mod.createPiBackend !== "function") {
      throw new Error(
        '"@schlessera/brain-backend-pi" does not export createPiBackend.'
      );
    }
    return mod.createPiBackend({ brainPath });
  }

  async function buildRegistry(): Promise<RegistrySnapshot> {
    const primary = agent.backend || "claude";

    if (primary === "pi") {
      const pi = buildPiBackend();
      return buildSnapshot([pi], pi.id);
    }

    const backends = [buildClaudeBackend()];

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

  return makeRegistry(getRegistry, getHidden, async () => {
    await getRegistry();
    return modelSource;
  });
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
  options: { getHiddenModelIds?: () => string[] } = {}
): BackendRegistry {
  const snapshot = buildSnapshot(backends, defaultBackendId);
  return makeRegistry(
    async () => snapshot,
    options.getHiddenModelIds ?? (() => []),
    async () => null
  );
}

/** The accessor surface, shared by the config-driven and static registries. */
function makeRegistry(
  getRegistry: () => Promise<RegistrySnapshot>,
  getHidden: () => string[],
  getModelSource: () => Promise<ModelDiscoverySource | null>,
  log?: Logger
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

      return registry.backends.flatMap((backend) =>
        (snapshot.byBackend.get(backend.id) ?? [])
          .filter((profile) => !hidden.has(profile.id))
          .map((profile) => ({ ...profile, backendId: backend.id }))
      );
    },

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
