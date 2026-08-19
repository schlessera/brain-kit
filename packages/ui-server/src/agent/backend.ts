import { createRequire } from "module";
import type {
  InferenceProfile,
  InferenceProfileInput,
  ModelSource,
} from "@schlessera/brain-backend-claude";
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
 * names, and the other never has to be present. Type-only imports above are
 * erased at runtime, so they cost nothing.
 *
 * The old five hardcoded personal inference profiles are gone: the Claude
 * backend ships the single "claude" default, and additional Anthropic-compatible
 * endpoints are declared via the BRAIN_UI_CLAUDE_PROFILES env var (documented in
 * .env.example) rather than in code.
 */

/** The runtime shape of @schlessera/brain-backend-claude, without importing it. */
type ClaudeBackendModule = typeof import("@schlessera/brain-backend-claude");

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
  getModelSource(): Promise<ModelSource | null>;
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


export function createBackendRegistry(
  options: BackendRegistryOptions
): BackendRegistry {
  const { brainPath, agent } = options;
  const getHidden = options.getHiddenModelIds ?? (() => []);

  let cachedRegistry: Promise<RegistrySnapshot> | null = null;
  let modelSource: ModelSource | null = null;

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
    declared: InferenceProfile[];
    discovered: InferenceProfileInput[];
    result: InferenceProfile[];
  } | null = null;

  function mergeDiscovered(
    claude: ClaudeBackendModule,
    declared: InferenceProfile[],
    discovered: InferenceProfileInput[]
  ): InferenceProfile[] {
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
  function builtinDefaultProfiles(claude: ClaudeBackendModule): InferenceProfile[] {
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
   * extra profiles from BRAIN_UI_CLAUDE_PROFILES (a JSON array of
   * InferenceProfileInput
   * {id,label,model?,baseUrl?,authTokenEnv?,apiKeyEnv?,modelAliases?}).
   *
   * A malformed or duplicate-id roster THROWS — caught at boot by the registry
   * fail-fast — rather than silently degrading to default-only and rebilling
   * every pinned session to the subscription with nothing in the logs.
   */
  function loadClaudeProfiles(claude: ClaudeBackendModule): InferenceProfile[] {
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
    for (const input of inputs as InferenceProfileInput[]) {
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

    const declared = (inputs as InferenceProfileInput[]).map((input) => ({
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
      throw new Error(
        `AGENT_BACKEND=${agent.backend ?? "claude"} but ` +
          '"@schlessera/brain-backend-claude" is not installed. ' +
          "Add it (it carries the Claude Agent SDK) or set AGENT_BACKEND=pi."
      );
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
      throw new Error(
        'AGENT_BACKEND=pi but "@schlessera/brain-backend-pi" is not installed. ' +
          "Add it (with its pi SDK dependencies) or set AGENT_BACKEND=claude."
      );
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
      throw new Error(
        `AGENT_BACKEND="${primary}" does not match any configured backend ` +
          `(expected "claude" or "pi").`
      );
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
  getModelSource: () => Promise<ModelSource | null>
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
      console.warn(
        `[models] Could not read hidden models: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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
