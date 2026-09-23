import type { BillingMode, PricingRoute, ProviderInfo } from "../protocol.js";
import type { AgentBackend } from "./backend.js";
import type { ConfirmPatternSource } from "./confirm-patterns.js";

/** @experimental Minimal logging boundary shared by backend modules and hosts. */
export type BackendLogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attrs?: Record<string, string | number | boolean>
) => void;

/** @experimental Common metadata every backend profile declaration exposes. */
export interface BackendProfileDeclaration {
  id: string;
  label: string;
  vendor?: string;
}

/** @experimental Machine-readable profile configuration failure. */
export interface BackendProfileError {
  code: "invalid_json" | "invalid_shape" | "invalid_entry" | "reserved_id" | "duplicate_id";
  message: string;
  profileId?: string;
}

/** @experimental Result of a backend-owned profile parser. */
export type BackendProfileParseResult =
  | { ok: true; profiles: BackendProfileDeclaration[] }
  | { ok: false; errors: BackendProfileError[] };

/** @experimental Host-facing error retaining the backend's typed failures. */
export class BackendProfileConfigError extends Error {
  constructor(readonly errors: readonly BackendProfileError[]) {
    super(errors[0]?.message ?? "Invalid backend profiles.");
    this.name = "BackendProfileConfigError";
  }
}

/** @experimental Profiles already claimed by descriptors earlier in the registry. */
export interface BackendProfileSchemaContext {
  occupiedProfiles: readonly { id: string; source: string }[];
  /** Raw profile data for inactive first-party backends; active schemas may inspect it leniently. */
  inactiveRosters?: readonly { backendId: string; raw: string | null }[];
}

/** @experimental Backend-owned profile parsing and validation. */
export interface BackendProfileSchema {
  /** Environment/configuration name used in user-facing errors. */
  source: string;
  parse(raw: string | null, context: BackendProfileSchemaContext): BackendProfileParseResult;
}

/** @experimental Settings readers the host can make available to a descriptor. */
export interface BackendSettingsReaders {
  getHiddenModelIds(): string[];
  getDefaultModelId(): string | null;
  getCustomOpenRouterModels(): string[];
  getThinkingOverrides(): Record<string, string>;
  getBillingOverrides(): Record<string, BillingMode>;
}

/** @experimental A descriptor opts into only the settings readers it consumes. */
export interface BackendSettingsHooks {
  hiddenModelIds?: true;
  defaultModelId?: true;
  customOpenRouterModels?: true;
  thinkingOverrides?: true;
  billingOverrides?: true;
}

/** @experimental Discovery freshness exposed to the host's models routes. */
export interface BackendModelSourceState {
  enabled: boolean;
  refreshedAt: number | null;
  stale: boolean;
  error?: string;
}

/** @experimental Optional model discovery owned by a backend module. */
export interface BackendModelSource {
  list(): BackendProfileDeclaration[];
  state(): BackendModelSourceState;
  ensureFresh(): Promise<void>;
  refresh(): Promise<void>;
}

/** @experimental Inputs a host supplies without knowing a backend's implementation. */
export interface BackendModuleContext {
  brainPath: string;
  /** Resolved host configuration. Backend modules own the keys they consume. */
  config: Readonly<Record<string, unknown>>;
  profiles: readonly BackendProfileDeclaration[];
  confirmBashPatterns: readonly ConfirmPatternSource[] | null;
  settings: Partial<BackendSettingsReaders>;
  log?: BackendLogFn;
  modelSource?: BackendModelSource | null;
}

/**
 * What a backend found when it probed its own runtime at boot.
 *
 * @experimental
 */
export interface BackendRuntimeReport {
  runtime: {
    name: string;
    version: string;
    /** What a turn would spawn, as the backend's SDK selected it. */
    command: string;
    /** The host named the binary itself instead of taking the SDK's. */
    hostProvided: boolean;
  };
  sdk?: { name: string; version: string };
  /** The pair the backend's behaviour was measured against, and whether this is it. */
  measured?: { runtime: string; sdk?: string; matches: boolean };
}

/** @experimental Backend-specific registry behavior returned with the backend value. */
export interface ResolvedBackendModule {
  backend: AgentBackend;
  classifyBilling?(profile: ProviderInfo): BillingMode;
  /**
   * Which pricing catalog runs on this profile are billed through. Only the
   * backend knows where a profile's requests actually go, and a model id does
   * not say — the two catalogs share ids at different rates. Return undefined
   * for a route the backend cannot name (an unrecognised proxy); pricing then
   * falls back to resolving by model id alone.
   */
  classifyRoute?(profile: ProviderInfo): PricingRoute | undefined;
  preferredProfile?: {
    matches(profile: ProviderInfo): boolean;
    hasCredential(): boolean | Promise<boolean>;
  };
}

/** @experimental Explicit success/failure from descriptor construction. */
export type BackendModuleResolution =
  | { ok: true; value: ResolvedBackendModule }
  | { ok: false; error: Error };

/**
 * A self-describing agent backend package.
 *
 * @experimental This extension interface may change before 1.0.
 */
export interface BackendModule {
  id: string;
  resolveFromEnv(
    context: BackendModuleContext
  ): BackendModuleResolution | Promise<BackendModuleResolution>;
  profileSchema: BackendProfileSchema;
  settingsHooks: BackendSettingsHooks;
  modelSource?(context: BackendModuleContext): BackendModelSource | null;
  /**
   * Probe the runtime a turn would spawn, synchronously, at boot. Throws when
   * that runtime is missing or will not start, which refuses the boot; returns
   * what it found otherwise.
   */
  probeRuntime?(context: BackendModuleContext): BackendRuntimeReport;
}

/** @experimental Identity helper providing inference and excess-property checks. */
export function defineBackendModule(module: BackendModule): BackendModule {
  return module;
}
