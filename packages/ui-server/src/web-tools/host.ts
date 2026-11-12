/**
 * The production web tools (#3686, epic #2765): the broker over the trusted
 * Pi executor, one child process per principal's session.
 *
 * Each session's child gets its own private directory under `root` (host
 * operational state beside the database, masked from every worker), a
 * sanitized copy of the host's `web-search.json` and the catalog providers'
 * API keys from the host environment. The directory is removed once the
 * child's whole process group is observed gone; whatever a crash left behind
 * is removed at boot, before any session starts.
 *
 * An explicit `provider` is admitted only when it is in the host's configured
 * chain (or override) and has a credential the executor can use: the same
 * set the Settings card and the brief report.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { startEgressProxy, webSearchBrief, type EgressDestinationPolicy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { createWebBroker, type WebBroker, type WebBrokerLimits, type WebReceipt } from "./broker.js";
import { createChildWebExecutor } from "./child-executor.js";

/** What ui-server uses of the pi backend's internal entry, mirrored structurally. */
export interface PiWebExecutorModule {
  prepareWebExecutorState(options: { root: string; hostConfigPath: string; credentialEnv: Readonly<Record<string, string | undefined>>; path: string }):
    { dir: string; env: Record<string, string>; removed: string[]; cleanup(): void };
  webExecutorCommand(runtime: string, stateDir: string, egress: { proxyDir: string }): [string, ...string[]];
}

interface HostWebToolsOptions {
  module: PiWebExecutorModule;
  root: string;
  hostConfigPath: () => string;
  /** The catalog providers' environment, as `resolveWebSearchEnv` reads it. */
  env: Readonly<Record<string, string | undefined>>;
  /** The runtime that runs the executor entry. */
  runtime: string;
  path: string;
  limits?: Partial<WebBrokerLimits>;
  onReceipt?: (receipt: WebReceipt) => void;
  /** Sanitizer removals for one started session, never values. */
  onPrepared?: (removed: readonly string[]) => void;
  /** Every connection the executor's egress route admitted or refused (#3687); never content or credentials. */
  onEgress?: (record: EgressRecord) => void;
  /** Bytes one executor session may move through its egress route, both directions. */
  maxEgressBytes?: number;
  /** @internal Test seam: the egress route's resolver. */
  lookup?: EgressDestinationPolicy["lookup"];
  /** @internal Test seam: destination ports, default 80 and 443. */
  egressPorts?: readonly number[];
  /** @internal Test seam: an extra CA certificate file the executor trusts, for fixture TLS origins. */
  caCertificates?: string;
}

/** The default byte ceiling of one executor session's egress route. */
const DEFAULT_MAX_EGRESS_BYTES = 64 * 1024 * 1024;

/** The host config's own CIDR exceptions (`ssrf.allowRanges`), the owner's choice of private ranges to reach. */
function hostAllowRanges(config: Record<string, unknown>): string[] {
  const ssrf = config.ssrf;
  const ranges = ssrf && typeof ssrf === "object" ? (ssrf as Record<string, unknown>).allowRanges : undefined;
  return Array.isArray(ranges) ? ranges.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map(entry => entry.trim()) : [];
}

function readHostConfig(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** The providers a call may name explicitly: configured and usable by the executor. */
function admittedWebProviders(config: Record<string, unknown>, env: Readonly<Record<string, string | undefined>>): string[] {
  return webSearchBrief(config, { toolName: "web_search", env: { ...env } }).providers.map(provider => provider.id);
}

export function createHostWebTools(options: HostWebToolsOptions): WebBroker {
  // A crash leaves session directories behind; nothing can still own them now.
  rmSync(options.root, { recursive: true, force: true });
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const credentialEnv = Object.fromEntries(Object.entries(options.env).filter(([name]) => !["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "HOME"].includes(name)));
  return createWebBroker({
    executor: createChildWebExecutor({
      launch: async () => {
        const configPath = options.hostConfigPath();
        // The executor's whole network: a host proxy that resolves and checks every destination.
        const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: options.maxEgressBytes ?? DEFAULT_MAX_EGRESS_BYTES,
          destinations: { allowRanges: hostAllowRanges(readHostConfig(configPath)), ...(options.lookup ? { lookup: options.lookup } : {}),
            ...(options.egressPorts ? { ports: options.egressPorts } : {}) },
          observe: record => { try { options.onEgress?.(record); } catch { /* A recorder cannot hold a connection open. */ } } });
        try {
          const state = options.module.prepareWebExecutorState({ root: options.root, hostConfigPath: configPath, credentialEnv, path: options.path });
          const cleanup = () => { egress.stop(); state.cleanup(); };
          try {
            options.onPrepared?.(state.removed);
            const env = options.caCertificates ? { ...state.env, NODE_EXTRA_CA_CERTS: options.caCertificates } : state.env;
            return { command: options.module.webExecutorCommand(options.runtime, state.dir, { proxyDir: egress.dir }), env, cwd: `${state.dir}/work`, cleanup };
          } catch (error) { cleanup(); throw error; }
        } catch (error) { egress.stop(); throw error; }
      },
    }),
    admittedProviders: () => admittedWebProviders(readHostConfig(options.hostConfigPath()), options.env),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.onReceipt ? { onReceipt: options.onReceipt } : {}),
  });
}
