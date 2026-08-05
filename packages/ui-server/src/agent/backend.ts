import { createRequire } from "module";
import {
  createClaudeBackend,
  defineProfiles,
  type InferenceProfile,
  type InferenceProfileInput,
} from "@schlessera/brain-backend-claude";
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
  profileOwners: Map<string, string>;
  profiles: Map<string, ProviderInfo[]>;
}

let cachedRegistry: Promise<BackendRegistry> | null = null;

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
  const listedProfiles = await Promise.all(
    ordered.map(async (backend) => ({
      backend,
      profiles: await backend.listProfiles(),
    }))
  );
  const profileOwners = new Map<string, string>();
  const profiles = new Map<string, ProviderInfo[]>();

  for (const listed of listedProfiles) {
    profiles.set(listed.backend.id, listed.profiles);
    for (const profile of listed.profiles) {
      const owner = profileOwners.get(profile.id);
      if (owner && owner !== listed.backend.id) {
        throw new Error(
          `Profile id collision across backends: "${profile.id}" is exposed by "${owner}" and "${listed.backend.id}".`
        );
      }
      profileOwners.set(profile.id, listed.backend.id);
    }
  }

  return {
    backends: ordered,
    byId,
    defaultBackendId: resolvedDefaultId,
    profileOwners,
    profiles,
  };
}

async function buildRegistry(): Promise<BackendRegistry> {
  const primary = (process.env.AGENT_BACKEND || "claude")
    .trim()
    .toLowerCase();

  if (primary === "pi") {
    const pi = buildPiBackend();
    return createRegistry([pi], pi.id);
  }

  const claude = createClaudeBackend({
    brainPath: BRAIN_PATH,
    claudeCodePath: CLAUDE_CODE_PATH,
    profiles: loadClaudeProfiles(),
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
  const backendId = registry.profileOwners.get(profileId);
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

/** List every available profile, tagged with its owning backend id. */
export async function listAllProviders(): Promise<ProviderInfo[]> {
  const registry = await getRegistry();
  return registry.backends.flatMap((backend) =>
    (registry.profiles.get(backend.id) ?? []).map((profile) => ({
      ...profile,
      backendId: backend.id,
    }))
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
}

/** Test seam: install one fake backend as the complete registry. */
export function setBackendForTests(backend: AgentBackend): void {
  cachedRegistry = createRegistry([backend], backend.id);
}

/** Test seam: install a complete fake registry with an explicit default. */
export function setBackendsForTests(
  backends: AgentBackend[],
  defaultBackendId = backends[0]?.id ?? ""
): void {
  cachedRegistry = createRegistry(backends, defaultBackendId);
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

  return [...base, ...defineProfiles(inputs as InferenceProfileInput[])];
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
