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
import { webSearchBrief } from "@schlessera/brain-ui-sdk/internal";
import { createWebBroker, type WebBroker, type WebBrokerLimits, type WebReceipt } from "./broker.js";
import { createChildWebExecutor } from "./child-executor.js";

/** What ui-server uses of `@schlessera/brain-backend-pi/internal`. */
export interface PiWebExecutorModule {
  prepareWebExecutorState(options: { root: string; hostConfigPath: string; credentialEnv: Readonly<Record<string, string | undefined>>; path: string }):
    { dir: string; env: Record<string, string>; removed: string[]; cleanup(): void };
  webExecutorCommand(runtime: string, stateDir: string): [string, ...string[]];
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
      launch: () => {
        const state = options.module.prepareWebExecutorState({ root: options.root, hostConfigPath: options.hostConfigPath(), credentialEnv, path: options.path });
        options.onPrepared?.(state.removed);
        return { command: options.module.webExecutorCommand(options.runtime, state.dir), env: state.env, cwd: `${state.dir}/work`, cleanup: state.cleanup };
      },
    }),
    admittedProviders: () => admittedWebProviders(readHostConfig(options.hostConfigPath()), options.env),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.onReceipt ? { onReceipt: options.onReceipt } : {}),
  });
}
