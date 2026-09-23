import type { Logger } from "@opentelemetry/api-logs";
import type { BillingMode, ProviderInfo } from "@schlessera/brain-ui-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
  BackendLogFn,
  BackendModelSource,
  BackendModelSourceState,
  BackendModule,
  BackendModuleContext,
  BackendSettingsHooks,
  BackendSettingsReaders,
  ResolvedBackendModule,
} from "@schlessera/brain-ui-sdk/server";
import { BackendProfileConfigError } from "@schlessera/brain-ui-sdk/server";
import type { BackendRuntimeReport } from "@schlessera/brain-ui-sdk/server";
import { createRequire } from "module";

import type { AgentConfig } from "../config/env.js";

export type { BackendLogFn } from "@schlessera/brain-ui-sdk/server";
export type ModelDiscoverySource = BackendModelSource;
export type ModelDiscoveryState = BackendModelSourceState;

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

export interface BackendRegistryOptions {
  brainPath: string;
  agent: AgentConfig;
  getHiddenModelIds?: () => string[];
  getDefaultModelId?: () => string | null;
  getCustomOpenRouterModels?: () => string[];
  getThinkingOverrides?: () => Record<string, string>;
  getBillingOverrides?: () => Record<string, BillingMode>;
  log?: Logger;
}

export interface BackendRegistry {
  getBackends(): Promise<AgentBackend[]>;
  getBackendById(id: string): Promise<AgentBackend | undefined>;
  getDefaultBackend(): Promise<AgentBackend>;
  getDefaultBackendId(): Promise<string>;
  getBackendForProfile(profileId: string): Promise<AgentBackend | undefined>;
  /** Null/empty is a legacy session; an unknown non-empty id is an error. */
  getBackendForSession(backendId: string | null | undefined): Promise<AgentBackend>;
  listAllProviders(options?: { includeHidden?: boolean }): Promise<ProviderInfo[]>;
  getPreferredProfileId(): Promise<string | null>;
  getBackendsInfo(): Promise<
    Record<string, { id: string; capabilities: BackendCapabilities }>
  >;
  getModelSource(): Promise<ModelDiscoverySource | null>;
  invalidateProfiles(): void;
}

interface RegistrySnapshot {
  backends: AgentBackend[];
  byId: Map<string, AgentBackend>;
  defaultBackendId: string;
  resolved: Map<string, ResolvedBackendModule>;
  modelSource: BackendModelSource | null;
}

interface ProfileSnapshot {
  at: number;
  byBackend: Map<string, ProviderInfo[]>;
  owners: Map<string, string>;
}

const PROFILE_MEMO_MS = 5_000;

function buildSnapshot(
  backends: AgentBackend[],
  defaultBackendId: string,
  resolved = new Map<string, ResolvedBackendModule>(),
  modelSource: BackendModelSource | null = null
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
  return { backends: ordered, byId, defaultBackendId: resolvedDefaultId, resolved, modelSource };
}

interface FirstPartyBackend {
  id: "claude" | "pi";
  specifier: string;
  profiles(agent: AgentConfig): string | null;
  /** A non-primary module whose configured profile roster opts it in. */
  joinsPrimary: boolean;
}

interface ParsedBackendDescriptor {
  descriptor: BackendModule;
  profiles: BackendModuleContext["profiles"];
}

// The only runtime-discovery surface: two fixed first-party packages. The
// environment never supplies a specifier or introduces another identity.
const FIRST_PARTY_BACKENDS: readonly FirstPartyBackend[] = [
  {
    id: "claude",
    specifier: "@schlessera/brain-backend-claude",
    profiles: (agent) => agent.profilesJson,
    joinsPrimary: false,
  },
  {
    id: "pi",
    specifier: "@schlessera/brain-backend-pi",
    profiles: (agent) => agent.piProfilesJson,
    joinsPrimary: true,
  },
];

function firstParty(id: string): FirstPartyBackend | undefined {
  return FIRST_PARTY_BACKENDS.find((entry) => entry.id === id);
}

function activeFirstPartyBackends(agent: AgentConfig): readonly FirstPartyBackend[] {
  const primary = agent.backend || "claude";
  return FIRST_PARTY_BACKENDS.filter(
    (entry) =>
      entry.id === primary || (entry.joinsPrimary && Boolean(entry.profiles(agent)))
  );
}

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
    'AGENT_BACKEND=claude but "@schlessera/brain-backend-claude" is not installed. ' +
      "Add it (it carries the Claude Agent SDK) or set AGENT_BACKEND=pi."
  );
}

function missingConfiguredBackendError(entry: FirstPartyBackend): Error {
  if (entry.id === "pi") {
    return new Error(
      'BRAIN_UI_PI_PROFILES is set but "@schlessera/brain-backend-pi" is not ' +
        "installed. Add it (with its pi SDK dependencies) or unset the variable."
    );
  }
  return new Error(
    'BRAIN_UI_CLAUDE_PROFILES is set but "@schlessera/brain-backend-claude" is not ' +
      "installed. Add it (it carries the Claude Agent SDK) or unset the variable."
  );
}

function moduleNotFoundSpecifier(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, specifier, message } = error as {
    code?: unknown;
    specifier?: unknown;
    message?: unknown;
  };
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return null;
  if (typeof specifier === "string") return specifier;
  if (typeof message === "string") {
    const quoted = /Cannot find (?:package|module) '([^']+)'/.exec(message);
    if (quoted) return quoted[1];
  }
  return null;
}

export async function loadBackendModule(
  key: "claude" | "pi",
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier)
): Promise<unknown> {
  const entry = firstParty(key)!;
  try {
    return await importer(entry.specifier);
  } catch (error) {
    if (moduleNotFoundSpecifier(error) === entry.specifier) {
      throw missingBackendError(key);
    }
    throw error;
  }
}

/** Load and structurally validate the one descriptor exported by a backend package. */
export async function loadBackendDescriptor(
  key: "claude" | "pi",
  importer?: (specifier: string) => Promise<unknown>
): Promise<BackendModule> {
  return backendDescriptorFromModule(key, await loadBackendModule(key, importer));
}

function backendDescriptorFromModule(
  key: "claude" | "pi",
  loaded: unknown
): BackendModule {
  const backendPackage = loaded as { backendModule?: unknown };
  const descriptor = backendPackage.backendModule as Partial<BackendModule> | undefined;
  if (
    !descriptor ||
    descriptor.id !== key ||
    typeof descriptor.resolveFromEnv !== "function" ||
    typeof descriptor.profileSchema?.parse !== "function" ||
    !descriptor.settingsHooks
  ) {
    throw new Error(
      `The ${key} backend package does not export a valid backendModule descriptor.`
    );
  }
  return descriptor as BackendModule;
}

function parseBackendDescriptors(
  agent: AgentConfig,
  entries: readonly FirstPartyBackend[],
  descriptors: ReadonlyMap<string, BackendModule>
): Map<string, ParsedBackendDescriptor> {
  const occupiedProfiles: { id: string; source: string }[] = [];
  const activeIds = new Set(entries.map((entry) => entry.id));
  const inactiveRosters = FIRST_PARTY_BACKENDS.filter(
    (entry) => !activeIds.has(entry.id)
  ).map((entry) => ({ backendId: entry.id, raw: entry.profiles(agent) }));
  const parsed = new Map<string, ParsedBackendDescriptor>();
  for (const entry of entries) {
    const descriptor = descriptors.get(entry.id);
    if (!descriptor) {
      throw new Error(`Backend descriptor "${entry.id}" was not loaded.`);
    }
    const result = descriptor.profileSchema.parse(entry.profiles(agent), {
      occupiedProfiles,
      inactiveRosters,
    });
    if (!result.ok) throw new BackendProfileConfigError(result.errors);
    parsed.set(entry.id, { descriptor, profiles: result.profiles });
    for (const profile of result.profiles) {
      occupiedProfiles.push({ id: profile.id, source: descriptor.profileSchema.source });
    }
  }
  return parsed;
}

/**
 * Boot guard. It resolves active optional backend packages and synchronously
 * loads their descriptors so backend-owned profile validation finishes before
 * the application can report healthy. Inactive rosters are supplied as raw
 * collision data without loading or strictly parsing their packages. Backend
 * construction and model discovery remain lazy in the registry.
 */
export function assertBackendResolvable(
  agent: AgentConfig,
  resolve: (specifier: string) => void = (specifier) => {
    createRequire(import.meta.url).resolve(specifier);
  },
  load: (specifier: string) => unknown = (specifier) => {
    return createRequire(import.meta.url)(specifier);
  }
): void {
  const primary = agent.backend || "claude";
  const primaryEntry = firstParty(primary);
  if (!primaryEntry) throw unknownBackendError(primary);

  const entries = activeFirstPartyBackends(agent);
  const descriptors = new Map<string, BackendModule>();
  for (const entry of entries) {
    try {
      resolve(entry.specifier);
    } catch {
      if (entry.id === primary) throw missingBackendError(entry.id);
      throw missingConfiguredBackendError(entry);
    }
    try {
      descriptors.set(
        entry.id,
        backendDescriptorFromModule(entry.id, load(entry.specifier))
      );
    } catch (error) {
      if (entry.id === primary && moduleNotFoundSpecifier(error) === entry.specifier) {
        throw missingBackendError(entry.id);
      }
      if (entry.id !== primary && moduleNotFoundSpecifier(error) === entry.specifier) {
        throw missingConfiguredBackendError(entry);
      }
      throw error;
    }
  }
  parseBackendDescriptors(agent, entries, descriptors);
}

/** What a backend's boot-time runtime probe found, keyed to its backend. */
export interface BackendRuntimeProbe {
  backendId: string;
  report: BackendRuntimeReport;
}

/**
 * Probe the runtime every active first-party backend would spawn, at boot
 * (#211). A backend whose runtime is missing or will not start throws, which
 * refuses the boot — the same reason a missing backend package does
 * (`assertBackendResolvable`). A runtime that is not the one the backend was
 * measured against is a warning naming both, not a refusal
 * (docs/decisions/claude-code-runtime.md).
 */
export function probeBackendRuntimes(
  agent: AgentConfig,
  brainPath: string,
  log?: Logger,
  load: (specifier: string) => unknown = (specifier) => createRequire(import.meta.url)(specifier)
): BackendRuntimeProbe[] {
  const probes: BackendRuntimeProbe[] = [];
  for (const entry of activeFirstPartyBackends(agent)) {
    const descriptor = backendDescriptorFromModule(entry.id, load(entry.specifier));
    if (!descriptor.probeRuntime) continue;
    const report = descriptor.probeRuntime({
      brainPath,
      config: { ...agent },
      profiles: [],
      confirmBashPatterns: agent.confirmBashPatterns,
      settings: {},
    });
    const pair = (runtime: string, sdk?: string) => (sdk ? `${runtime} / SDK ${sdk}` : runtime);
    log?.emit({
      severityText: "INFO",
      body: `${entry.id} runtime: ${report.runtime.name} ${report.runtime.version}`,
      attributes: {
        "backend.id": entry.id,
        "runtime.version": report.runtime.version,
        "runtime.command": report.runtime.command,
        "runtime.host_provided": report.runtime.hostProvided,
        ...(report.sdk ? { "sdk.version": report.sdk.version } : {}),
      },
    });
    if (report.measured && !report.measured.matches) {
      log?.emit({
        severityText: "WARN",
        body:
          `${entry.id} runtime ${pair(report.runtime.version, report.sdk?.version)} is not the one its ` +
          `behaviour was measured against (${pair(report.measured.runtime, report.measured.sdk)}); ` +
          "continuing — re-run scripts/measure-claude-runtime.ts",
        attributes: { "backend.id": entry.id, "runtime.host_provided": report.runtime.hostProvided },
      });
    }
    probes.push({ backendId: entry.id, report });
  }
  return probes;
}

function settingsFor(
  hooks: BackendSettingsHooks,
  readers: BackendSettingsReaders
): Partial<BackendSettingsReaders> {
  return {
    ...(hooks.hiddenModelIds ? { getHiddenModelIds: readers.getHiddenModelIds } : {}),
    ...(hooks.defaultModelId ? { getDefaultModelId: readers.getDefaultModelId } : {}),
    ...(hooks.customOpenRouterModels
      ? { getCustomOpenRouterModels: readers.getCustomOpenRouterModels }
      : {}),
    ...(hooks.thinkingOverrides
      ? { getThinkingOverrides: readers.getThinkingOverrides }
      : {}),
    ...(hooks.billingOverrides
      ? { getBillingOverrides: readers.getBillingOverrides }
      : {}),
  };
}

export function createBackendRegistry(options: BackendRegistryOptions): BackendRegistry {
  const { brainPath, agent } = options;
  const primary = agent.backend || "claude";
  if (!firstParty(primary)) {
    return makeRegistry(async () => {
      throw unknownBackendError(primary);
    }, options);
  }

  const readers: BackendSettingsReaders = {
    getHiddenModelIds: options.getHiddenModelIds ?? (() => []),
    getDefaultModelId: options.getDefaultModelId ?? (() => null),
    getCustomOpenRouterModels: options.getCustomOpenRouterModels ?? (() => []),
    getThinkingOverrides: options.getThinkingOverrides ?? (() => ({})),
    getBillingOverrides: options.getBillingOverrides ?? (() => ({})),
  };
  const backendLog = options.log ? toBackendLog(options.log) : undefined;
  let cachedRegistry: Promise<RegistrySnapshot> | null = null;

  async function buildRegistry(): Promise<RegistrySnapshot> {
    const entries = activeFirstPartyBackends(agent);
    const descriptors = new Map<string, BackendModule>();
    for (const entry of entries) {
      descriptors.set(entry.id, await loadBackendDescriptor(entry.id));
    }
    const parsedDescriptors = parseBackendDescriptors(agent, entries, descriptors);
    const resolved = new Map<string, ResolvedBackendModule>();
    const backends: AgentBackend[] = [];
    let modelSource: BackendModelSource | null = null;

    for (const entry of entries) {
      const parsed = parsedDescriptors.get(entry.id)!;
      const { descriptor } = parsed;

      const baseContext: BackendModuleContext = {
        brainPath,
        config: { ...agent },
        profiles: parsed.profiles,
        confirmBashPatterns: agent.confirmBashPatterns,
        settings: settingsFor(descriptor.settingsHooks, readers),
        ...(backendLog ? { log: backendLog } : {}),
      };
      const source = descriptor.modelSource?.(baseContext) ?? null;
      const resolution = await descriptor.resolveFromEnv({
        ...baseContext,
        ...(source ? { modelSource: source } : {}),
      });
      if (!resolution.ok) throw resolution.error;
      if (resolution.value.backend.id !== descriptor.id) {
        throw new Error(
          `Backend descriptor "${descriptor.id}" built backend "${resolution.value.backend.id}".`
        );
      }
      resolved.set(descriptor.id, resolution.value);
      backends.push(resolution.value.backend);
      modelSource ??= source;
    }
    return buildSnapshot(backends, primary, resolved, modelSource);
  }

  const getRegistry = (): Promise<RegistrySnapshot> => {
    if (!cachedRegistry) cachedRegistry = buildRegistry();
    return cachedRegistry;
  };
  return makeRegistry(getRegistry, options);
}

export function createStaticBackendRegistry(
  entries: Array<AgentBackend | ResolvedBackendModule>,
  defaultBackendId = entries[0]
    ? "backend" in entries[0]
      ? entries[0].backend.id
      : entries[0].id
    : "",
  options: {
    getHiddenModelIds?: () => string[];
    getDefaultModelId?: () => string | null;
    getBillingOverrides?: () => Record<string, BillingMode>;
    modelSource?: BackendModelSource | null;
    log?: Logger;
  } = {}
): BackendRegistry {
  const resolved = new Map<string, ResolvedBackendModule>();
  const backends = entries.map((entry) => {
    if (!("backend" in entry)) return entry;
    resolved.set(entry.backend.id, entry);
    return entry.backend;
  });
  const snapshot = buildSnapshot(
    backends,
    defaultBackendId,
    resolved,
    options.modelSource ?? null
  );
  return makeRegistry(async () => snapshot, options);
}

function makeRegistry(
  getRegistry: () => Promise<RegistrySnapshot>,
  options: {
    getHiddenModelIds?: () => string[];
    getDefaultModelId?: () => string | null;
    getBillingOverrides?: () => Record<string, BillingMode>;
    log?: Logger;
  }
): BackendRegistry {
  let profileSnapshot: ProfileSnapshot | null = null;

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

  function hiddenIds(): Set<string> {
    try {
      return new Set(options.getHiddenModelIds?.() ?? []);
    } catch (error) {
      options.log?.emit({
        severityText: "WARN",
        body: "could not read hidden models; treating none as hidden",
        attributes: { error: error instanceof Error ? error.message : String(error) },
      });
      return new Set();
    }
  }

  function billingOverrides(): Record<string, BillingMode> {
    try {
      return options.getBillingOverrides?.() ?? {};
    } catch (error) {
      options.log?.emit({
        severityText: "WARN",
        body: "could not read billing overrides; using derived billing modes",
        attributes: { error: error instanceof Error ? error.message : String(error) },
      });
      return {};
    }
  }

  async function getPreferredProfileId(): Promise<string | null> {
    try {
      const snapshot = await getProfileSnapshot();
      const override = options.getDefaultModelId?.() ?? null;
      if (override && snapshot.owners.has(override)) return override;

      const registry = await getRegistry();
      const hidden = hiddenIds();
      for (const backend of registry.backends) {
        const preference = registry.resolved.get(backend.id)?.preferredProfile;
        if (!preference) continue;
        const match = (snapshot.byBackend.get(backend.id) ?? []).find(
          (profile) => preference.matches(profile) && !hidden.has(profile.id)
        );
        if (match) return (await preference.hasCredential()) ? match.id : null;
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
      const snapshot = await getProfileSnapshot();
      const backendId = snapshot.owners.get(profileId);
      return backendId ? registry.byId.get(backendId) : undefined;
    },
    async getBackendForSession(backendId) {
      const registry = await getRegistry();
      if (!backendId) return registry.byId.get(registry.defaultBackendId)!;
      const backend = registry.byId.get(backendId);
      if (!backend) {
        throw new Error(`Stored backend id "${backendId}" is not configured.`);
      }
      return backend;
    },
    async listAllProviders(listOptions = {}) {
      const registry = await getRegistry();
      const snapshot = await getProfileSnapshot();
      const hidden = listOptions.includeHidden ? new Set<string>() : hiddenIds();
      const overrides = billingOverrides();
      const providers = registry.backends.flatMap((backend) =>
        (snapshot.byBackend.get(backend.id) ?? [])
          .filter((profile) => !hidden.has(profile.id))
          .map((profile) => {
            const entry = { ...profile, backendId: backend.id };
            const resolvedBackend = registry.resolved.get(backend.id);
            const billingMode = overrides[profile.id] ?? resolvedBackend?.classifyBilling?.(profile);
            // The route is the backend's alone to say — no user override, no
            // ambient fallback: nothing outside the backend knows where a
            // profile's requests go. Absent stays absent, and pricing then
            // resolves by model id as it always did.
            const pricingRoute = resolvedBackend?.classifyRoute?.(profile);
            return {
              ...entry,
              ...(billingMode ? { billingMode } : {}),
              ...(pricingRoute ? { pricingRoute } : {}),
            };
          })
      );
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
    async getModelSource() {
      return (await getRegistry()).modelSource;
    },
    invalidateProfiles() {
      profileSnapshot = null;
    },
  };
}
