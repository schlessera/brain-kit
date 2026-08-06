import { createRequire } from "module";
import {
  createClaudeBackend,
  createModelSource,
  defineProfiles,
  type InferenceProfile,
  type InferenceProfileInput,
  type ModelSource,
} from "@schlessera/brain-backend-claude";
import { getHiddenModelIds } from "../db/settings.js";
import type { ProviderInfo } from "@schlessera/brain-ui-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
} from "@schlessera/brain-ui-sdk/server";

/**
 * Backend registry for the deployment. Claude is always available.
 * `AGENT_BACKEND=pi` retains the legacy single-backend deployment mode when the
 * optional pi package is installed.
 *
 * The old five hardcoded personal inference profiles are gone: the Claude
 * backend ships the single "claude" default, and additional Anthropic-compatible
 * endpoints are declared via the BRAIN_UI_CLAUDE_PROFILES env var (documented in
 * .env.example) rather than in code.
 */

const BRAIN_PATH =
  process.env.BRAIN_PATH || `${process.env.HOME || "/root"}/brain`;

// The Claude Code native binary is not in node_modules — it is installed via
// the official curl-bash installer (~/.local/bin/claude, symlinked to
// /usr/local/bin/claude in the container). The Agent SDK can't always
// auto-discover it, so hand it the explicit path; override with CLAUDE_CODE_PATH.
const CLAUDE_CODE_PATH = process.env.CLAUDE_CODE_PATH || "/usr/local/bin/claude";

interface BackendRegistry {
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

let cachedRegistry: Promise<BackendRegistry> | null = null;
let profileSnapshot: ProfileSnapshot | null = null;
let modelSource: ModelSource | null = null;

async function createRegistry(
  backends: AgentBackend[],
  defaultBackendId: string
): Promise<BackendRegistry> {
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

/** Drop the memo so the next read reflects a refresh or a settings change. */
export function invalidateProfiles(): void {
  profileSnapshot = null;
}

/**
 * The Claude backend's discovery source, once the registry is built. Null when
 * discovery is disabled or the deployment runs a different backend.
 */
export async function getModelSource(): Promise<ModelSource | null> {
  await getRegistry();
  return modelSource;
}

/**
 * Hidden profile ids, from the settings table. Presentation only — a hidden
 * profile still resolves for sessions pinned to it. A db read failure must not
 * take the picker down, so it degrades to "nothing hidden".
 */
function hiddenIds(): Set<string> {
  try {
    return new Set(getHiddenModelIds());
  } catch (err) {
    console.warn(
      `[models] Could not read hidden models: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return new Set();
  }
}

/**
 * Model discovery is on unless explicitly disabled — except under a test
 * runner, where the default flips to off: discovery is a live call to the
 * Anthropic API, and a suite that silently depends on network access (and on
 * whatever credentials the developer happens to have exported) is flaky by
 * construction. Tests that want it set BRAIN_UI_MODEL_DISCOVERY=1 explicitly.
 */
function modelDiscoveryEnabled(): boolean {
  const raw = process.env.BRAIN_UI_MODEL_DISCOVERY?.trim().toLowerCase();
  if (raw) return !(raw === "0" || raw === "off" || raw === "false");
  return process.env.NODE_ENV !== "test";
}

/** How long a discovery result stays fresh. Default 24h. */
function modelTtlMs(): number {
  const raw = Number(process.env.BRAIN_UI_MODEL_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 24;
  return hours * 60 * 60 * 1000;
}

/**
 * Declared profiles (built-in default + BRAIN_UI_CLAUDE_PROFILES) plus every
 * discovered model whose id isn't already declared. Declared wins: the env stays
 * an override mechanism, and a hand-pinned entry keeps its label and endpoint.
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
  const result = [...declared, ...defineProfiles(extra)];
  mergeCache = { declared, discovered, result };
  return result;
}

async function buildRegistry(): Promise<BackendRegistry> {
  const primary = (process.env.AGENT_BACKEND || "claude")
    .trim()
    .toLowerCase();

  if (primary === "pi") {
    const pi = buildPiBackend();
    return createRegistry([pi], pi.id);
  }

  // Declared profiles are resolved EAGERLY so a malformed
  // BRAIN_UI_CLAUDE_PROFILES still fails at boot rather than on first request.
  const declared = loadClaudeProfiles();

  modelSource = createModelSource({
    brainPath: BRAIN_PATH,
    enabled: modelDiscoveryEnabled(),
    ttlMs: modelTtlMs(),
  });

  const claude = createClaudeBackend({
    brainPath: BRAIN_PATH,
    claudeCodePath: CLAUDE_CODE_PATH,
    // A function, not an array: discovery refreshes in the background and the
    // new roster has to be visible without restarting the process.
    profiles: () => mergeDiscovered(declared, modelSource?.list() ?? []),
  });
  const backends = [claude];

  // AGENT_BACKEND must name a configured backend. The in-process options are
  // "claude" (default) and "pi" (handled above). An unrecognized value is a
  // misconfiguration — fail loudly instead of silently coercing to claude and
  // running on the wrong backend with nothing in the logs.
  if (process.env.AGENT_BACKEND && !backends.some((b) => b.id === primary)) {
    throw new Error(
      `AGENT_BACKEND="${primary}" does not match any configured backend ` +
        `(expected "claude" or "pi").`
    );
  }
  return createRegistry(backends, primary);
}

async function getRegistry(): Promise<BackendRegistry> {
  if (!cachedRegistry) cachedRegistry = buildRegistry();
  return cachedRegistry;
}

/** All configured backends, with the default backend first. */
export async function getBackends(): Promise<AgentBackend[]> {
  return (await getRegistry()).backends;
}

/** Find a configured backend by its stable id. */
export async function getBackendById(
  id: string
): Promise<AgentBackend | undefined> {
  return (await getRegistry()).byId.get(id);
}

/** The default backend used for new and legacy sessions. */
export async function getDefaultBackend(): Promise<AgentBackend> {
  const registry = await getRegistry();
  return registry.byId.get(registry.defaultBackendId)!;
}

/** The stable id of the default backend. */
export async function getDefaultBackendId(): Promise<string> {
  return (await getRegistry()).defaultBackendId;
}

/** Resolve the backend that owns a globally unique profile id. */
export async function getBackendForProfile(
  profileId: string
): Promise<AgentBackend | undefined> {
  const registry = await getRegistry();
  // Deliberately resolved against the UNFILTERED roster: a session pinned to a
  // profile the user later hid must keep running.
  const snapshot = await getProfileSnapshot();
  const backendId = snapshot.owners.get(profileId);
  return backendId ? registry.byId.get(backendId) : undefined;
}

/** Resolve a persisted backend id, falling back for legacy/unknown sessions. */
export async function getBackendForSession(
  backendId: string | null | undefined
): Promise<AgentBackend> {
  if (backendId) {
    const backend = await getBackendById(backendId);
    if (backend) return backend;
  }
  return getDefaultBackend();
}

/**
 * Every available profile, tagged with its owning backend id.
 *
 * Hidden profiles are omitted by default (this feeds the picker); the settings
 * screen passes `includeHidden` to render the full catalog.
 */
export async function listAllProviders(
  options: { includeHidden?: boolean } = {}
): Promise<ProviderInfo[]> {
  const registry = await getRegistry();
  const snapshot = await getProfileSnapshot();
  const hidden = options.includeHidden ? new Set<string>() : hiddenIds();

  return registry.backends.flatMap((backend) =>
    (snapshot.byBackend.get(backend.id) ?? [])
      .filter((profile) => !hidden.has(profile.id))
      .map((profile) => ({ ...profile, backendId: backend.id }))
  );
}

/** Per-backend capability metadata exposed by the providers route. */
export async function getBackendsInfo(): Promise<
  Record<string, { id: string; capabilities: BackendCapabilities }>
> {
  const backends = await getBackends();
  return Object.fromEntries(
    backends.map((backend) => [
      backend.id,
      { id: backend.id, capabilities: backend.capabilities },
    ])
  );
}

/** @deprecated Use getDefaultBackend() or a routing-specific accessor. */
export async function getBackend(): Promise<AgentBackend> {
  return getDefaultBackend();
}

/** Test seam: drop the cached registry so later access rebuilds from env. */
export function resetBackendForTests(): void {
  cachedRegistry = null;
  profileSnapshot = null;
  modelSource = null;
}

/** Test seam: install one fake backend as the complete registry. */
export function setBackendForTests(backend: AgentBackend): void {
  cachedRegistry = createRegistry([backend], backend.id);
  profileSnapshot = null;
}

/** Test seam: install a complete fake registry with an explicit default. */
export function setBackendsForTests(
  backends: AgentBackend[],
  defaultBackendId = backends[0]?.id ?? ""
): void {
  cachedRegistry = createRegistry(backends, defaultBackendId);
  profileSnapshot = null;
}

// The built-in default profile's model. The Claude backend historically pinned
// the default to a specific model; after the SDK extraction the pin was lost and
// resumed default-profile sessions drifted to "whatever the CLI defaults to",
// silently changing model/behaviour/billing on every CLI bump. Re-pin it here
// (a committed default, overridable per deploy via BRAIN_UI_CLAUDE_DEFAULT_MODEL)
// so the default stays on a known model.
const BUILTIN_DEFAULT_MODEL =
  process.env.BRAIN_UI_CLAUDE_DEFAULT_MODEL?.trim() || "claude-sonnet-4-6";

function builtinDefaultProfiles(): InferenceProfile[] {
  return defineProfiles([
    {
      id: "claude",
      label: "Claude",
      vendor: "anthropic",
      model: BUILTIN_DEFAULT_MODEL,
      modelAliases: true,
      source: "builtin",
    },
  ]);
}

/**
 * The Claude roster: the pinned built-in "claude" default first, plus any extra
 * profiles from BRAIN_UI_CLAUDE_PROFILES (a JSON array of InferenceProfileInput
 * {id,label,model?,baseUrl?,authTokenEnv?,apiKeyEnv?,modelAliases?}).
 *
 * A malformed or duplicate-id roster THROWS — caught at boot by the registry
 * fail-fast — rather than silently degrading to default-only and rebilling
 * every pinned session to the subscription with nothing in the logs.
 */
function loadClaudeProfiles(): InferenceProfile[] {
  const base = builtinDefaultProfiles();
  const raw = process.env.BRAIN_UI_CLAUDE_PROFILES?.trim();
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
  return [...base, ...defineProfiles(declared)];
}

/**
 * Optional pi backend. @schlessera/brain-backend-pi is NOT a hard dependency — a
 * deployment that never opts into it does not need it (or its pi SDK peer deps)
 * installed. Loaded lazily so the server still boots without it; when requested
 * but absent, fail with an actionable message.
 */
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
  return mod.createPiBackend({ brainPath: BRAIN_PATH });
}
