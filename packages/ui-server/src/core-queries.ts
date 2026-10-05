/**
 * Lazy access to core's supported content-index queries.
 *
 * `@schlessera/brain` is an OPTIONAL peer of this package (#696 ruling A): a
 * host installs a compatible core release when it wants the graph view or
 * index-derived voice vocabulary, and every other server feature boots without
 * it. Nothing here imports core statically — neither values nor types — so the
 * published declarations stay usable by a consumer that never installs it.
 * The shapes below are the documented query results
 * (docs/content-index-queries.md); the SDK payloads they feed are the same
 * structures.
 *
 * Resolution happens once per access object (one per app), on first use.
 * Before any function is used, the resolved installation must prove it is the
 * real package: the `@schlessera/brain/package.json` it resolves to names
 * `@schlessera/brain`, carries a version in {@link CORE_QUERIES_RANGE}, and
 * owns the `./queries` entry that was loaded; then each feature checks that
 * every operation it calls is a function. A separate `brain` binary on PATH
 * never substitutes for any of this, and there is no SQL or subprocess
 * fallback. Native connections stay inside core, opened and closed per call.
 */
import type { Logger } from "@opentelemetry/api-logs";
import { createRequire } from "module";
import { dirname, relative, isAbsolute } from "path";
import type {
  GraphMaintenanceResponse,
  GraphMetaResponse,
  GraphSubgraphResponse,
} from "@schlessera/brain-ui-sdk/protocol";

/** The package that owns the content index. */
export const CORE_PACKAGE = "@schlessera/brain";
/** Its supported query entry. */
export const CORE_QUERIES_ENTRY = "@schlessera/brain/queries";
/**
 * Core releases whose `./queries` entry ships every operation this server
 * calls. 0.40.0 is the first release with the entry (0.39.0 has none); a 1.x
 * line is outside what this release of the server has been checked against.
 */
export const CORE_QUERIES_RANGE = ">=0.40.0 <1.0.0";

export type QueryCode =
  | "missing_index"
  | "incompatible_index"
  | "corrupt_index"
  | "busy_index"
  | "unavailable_index"
  | "not_computed"
  | "not_found"
  | "invalid_input";

export type QueryResult<T> =
  | { ok: true; value: T; snapshot: { schemaVersion: number; newestIndexedAt: string | null } }
  | { ok: false; error: { code: QueryCode; retryable: boolean } };

interface Root {
  brainPath: string;
}

/** The five drawn-graph operations the graph routes call. */
export interface GraphQueries {
  readGraphMeta(opts: Root): QueryResult<GraphMetaResponse>;
  readGraphClusters(opts: Root & { community?: number; includeIsolates?: boolean }): QueryResult<GraphSubgraphResponse>;
  readGraphNeighborhood(opts: Root & { center: string; depth?: number; direction?: "in" | "out" | "both" }): QueryResult<GraphSubgraphResponse>;
  readGraphDiscovery(opts: Root & { root?: string; direction?: "out" | "both"; maxDepth?: number }): QueryResult<GraphSubgraphResponse>;
  readGraphMaintenance(opts: Root & { staleDays?: number; now?: string }): QueryResult<GraphMaintenanceResponse>;
}

/** The vocabulary operation the keyterm builder calls. */
export interface VoiceQueries {
  readVoiceVocabulary(opts: Root & { limit: number }): QueryResult<{ terms: string[]; extractorVersion: number }>;
}

const GRAPH_OPERATIONS = [
  "readGraphMeta",
  "readGraphClusters",
  "readGraphNeighborhood",
  "readGraphDiscovery",
  "readGraphMaintenance",
] as const satisfies readonly (keyof GraphQueries)[];
const VOICE_OPERATIONS = ["readVoiceVocabulary"] as const satisfies readonly (keyof VoiceQueries)[];

/**
 * Why core's query capability is unusable. Sanitized: no paths, no native
 * error text — only which check refused.
 */
export type CoreQueriesUnavailableReason =
  /** The package or its `./queries` entry does not resolve. */
  | "not_installed"
  /** What resolved is not `@schlessera/brain`, or its entry lives elsewhere. */
  | "identity_mismatch"
  /** The installed version is outside {@link CORE_QUERIES_RANGE}. */
  | "version_unsupported"
  /** The entry lacks an operation this feature calls. */
  | "operation_missing"
  /** The entry resolved but failed to load. */
  | "load_failed";

export type CoreCapability<T> =
  | { ok: true; queries: T }
  | { ok: false; reason: CoreQueriesUnavailableReason };

/** One app's lazily resolved, cached view of core's query entry. */
export interface CoreQueryAccess {
  graph(): CoreCapability<GraphQueries>;
  voice(): CoreCapability<VoiceQueries>;
}

/** How the package is located and loaded — the real `require`, except in tests. */
export interface CoreModuleLoader {
  resolve(specifier: string): string;
  load(specifier: string): unknown;
}

function defaultLoader(): CoreModuleLoader {
  const require = createRequire(import.meta.url);
  return {
    resolve: (specifier) => require.resolve(specifier),
    load: (specifier) => require(specifier),
  };
}

// Tests replace the loader to stage absent and skewed installations through
// the real app; this hook is internal and not exported from the package.
let loaderOverride: (() => CoreModuleLoader) | null = null;
export function setCoreModuleLoaderForTesting(factory: (() => CoreModuleLoader) | null): void {
  loaderOverride = factory;
}

type Resolved =
  | { ok: true; entry: Record<string, unknown> }
  | { ok: false; reason: CoreQueriesUnavailableReason; version?: string };

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveEntry(loader: CoreModuleLoader): Resolved {
  let manifestPath: string;
  let entryPath: string;
  try {
    manifestPath = loader.resolve(`${CORE_PACKAGE}/package.json`);
    entryPath = loader.resolve(CORE_QUERIES_ENTRY);
  } catch {
    return { ok: false, reason: "not_installed" };
  }
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = loader.load(`${CORE_PACKAGE}/package.json`) as typeof manifest;
  } catch {
    return { ok: false, reason: "load_failed" };
  }
  if (!manifest || manifest.name !== CORE_PACKAGE || !inside(dirname(manifestPath), entryPath)) {
    return { ok: false, reason: "identity_mismatch" };
  }
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (!version || !Bun.semver.satisfies(version, CORE_QUERIES_RANGE)) {
    return { ok: false, reason: "version_unsupported", ...(version ? { version } : {}) };
  }
  let entry: unknown;
  try {
    entry = loader.load(CORE_QUERIES_ENTRY);
  } catch {
    return { ok: false, reason: "load_failed", version };
  }
  if (!entry || typeof entry !== "object") return { ok: false, reason: "load_failed", version };
  return { ok: true, entry: entry as Record<string, unknown> };
}

function feature<T>(resolved: Resolved, operations: readonly string[]): CoreCapability<T> {
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const queries: Record<string, unknown> = {};
  for (const name of operations) {
    const fn = resolved.entry[name];
    if (typeof fn !== "function") return { ok: false, reason: "operation_missing" };
    queries[name] = fn;
  }
  return { ok: true, queries: queries as T };
}

/**
 * Create an access object. Nothing resolves until a feature is first asked
 * for; the verdict — usable or not — is then kept for the access's lifetime,
 * so a host that installs core restarts the server to pick it up.
 */
export function createCoreQueryAccess(options: { log?: Logger } = {}): CoreQueryAccess {
  let resolved: Resolved | undefined;
  let graph: CoreCapability<GraphQueries> | undefined;
  let voice: CoreCapability<VoiceQueries> | undefined;
  const reported = new Set<string>();

  const entry = (): Resolved => {
    resolved ??= resolveEntry((loaderOverride ?? defaultLoader)());
    return resolved;
  };
  const report = <T>(name: "graph" | "voice", capability: CoreCapability<T>): CoreCapability<T> => {
    if (!capability.ok && !reported.has(name)) {
      reported.add(name);
      const version = resolved && !resolved.ok ? resolved.version : undefined;
      options.log?.emit({
        severityText: "WARN",
        body:
          `${name === "graph" ? "graph view" : "index-derived voice vocabulary"} unavailable: ` +
          `install ${CORE_PACKAGE} ${CORE_QUERIES_RANGE} alongside this server`,
        attributes: {
          "core.reason": capability.reason,
          "core.required": CORE_QUERIES_RANGE,
          ...(version ? { "core.version": version } : {}),
        },
      });
    }
    return capability;
  };

  return {
    graph: () => (graph ??= report("graph", feature<GraphQueries>(entry(), GRAPH_OPERATIONS))),
    voice: () => (voice ??= report("voice", feature<VoiceQueries>(entry(), VOICE_OPERATIONS))),
  };
}

let processAccess: CoreQueryAccess | undefined;
/**
 * The access used by callers that are not handed one — the exported
 * `buildKeyterms` run from a deployment script, for instance. One per process.
 */
export function defaultCoreQueryAccess(): CoreQueryAccess {
  processAccess ??= createCoreQueryAccess();
  return processAccess;
}
