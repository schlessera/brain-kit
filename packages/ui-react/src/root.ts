import { createToolRendererRegistry, createAsrClientRegistry, type AsrClientRegistry, type ToolRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { createBrainUiConfig, type BrainUiConfig } from "./config.js";
import { createBrainApi, type BrainApi } from "./lib/api-client.js";
import { apiBaseFor, getBackendUrlFor, getWsUrlFor } from "./lib/backend.js";
import { createBrainStores, type BrainStores } from "./stores/create-stores.js";
import { createWebSocketClient } from "./connection.js";

export interface BrainUiRootOptions {
  config?: Partial<BrainUiConfig>;
  api?: BrainApi;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Stable, distinct prefix per embedder. Omit for an ephemeral isolated root. */
  storagePrefix?: string;
  /** null disables persistence (SSR, stories, tests). */
  storage?: Storage | null;
}

/** Dependencies the connection closes over; none are resolved from React. */
export interface BrainUiServices {
  config: BrainUiConfig;
  api: BrainApi;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  stores: BrainStores;
  renderers: ToolRendererRegistry;
  asr: AsrClientRegistry;
  apiBase: () => string;
  backendUrl: (path: string) => string;
  wsUrl: () => string;
  /** Mounted connectivity poller for this root, if any. */
  recheckVpn: () => void;
  registerVpnRecheck: (callback: () => void) => () => void;
}

export interface BrainUiRoot extends BrainUiServices {
  connection: ReturnType<typeof createWebSocketClient>;
  dispose: () => void;
}

/** Construct isolated state without opening a socket or starting a poller. */
export function createBrainUiRoot(options: BrainUiRootOptions = {}): BrainUiRoot {
  return createRoot(options, createBrainUiConfig(options.config));
}

/** @internal The default application supplies its existing mutable config. */
export function createRoot(
  options: BrainUiRootOptions,
  config: BrainUiConfig,
  renderers = createToolRendererRegistry(),
  asr = createAsrClientRegistry(),
): BrainUiRoot {
  const request = options.request ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const apiBase = () => apiBaseFor(config);
  const api = options.api ?? createBrainApi(apiBase, request);
  const prefix = options.storagePrefix ?? `brain-ui:${crypto.randomUUID()}`;
  const stores = createBrainStores({
    api, apiBase, request,
    storage: () => options.storage !== undefined ? options.storage
      : typeof localStorage === "undefined" ? null : localStorage,
    storageKey: (key) => prefix ? `${prefix}:${key}` : key,
  });
  let vpnRecheck: (() => void) | null = null;
  const services: BrainUiServices = {
    config, api, request, stores, renderers, asr, apiBase,
    backendUrl: (path) => getBackendUrlFor(config, path),
    wsUrl: () => getWsUrlFor(config),
    recheckVpn: () => vpnRecheck?.(),
    registerVpnRecheck(callback) {
      vpnRecheck = callback;
      return () => { if (vpnRecheck === callback) vpnRecheck = null; };
    },
  };
  const connection = createWebSocketClient(services);
  return Object.assign(services, {
    connection,
    dispose() {
      connection.dispose();
      stores.activity.dispose();
      stores.graph.dispose();
      stores.file.getState().reset();
      vpnRecheck = null;
    },
  });
}
