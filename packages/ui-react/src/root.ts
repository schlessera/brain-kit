import { createToolRendererRegistry } from "@schlessera/brain-ui-sdk/internal/client";
import { createAsrClientRegistry, type AsrClientRegistry, type ToolRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { createBrainUiConfig, type BrainUiConfig } from "./config.js";
import { createBrainApi, type BrainApi } from "./lib/api-client.js";
import { apiBaseFor, getBackendUrlFor, getWsUrlFor } from "./lib/backend.js";
import { createBrainStores, type BrainStores } from "./stores/create-stores.js";
import { createWebSocketClient } from "./connection.js";
import { createIndexedDbAnswerStorage, createMemoryAnswerStorage, type AnswerStorage } from "./lib/answer-delivery/storage.js";
import { createBrowserTabCoordinator, type TabCoordinator } from "./lib/answer-delivery/tabs.js";
import { disposeTracks, subscribeAllTracks, trackKey, trackRefs } from "./lib/draft-tracks.js";
import { registerBuiltInUpdateHolds } from "./lib/update-holds.js";
import type { LocalCaptureSink } from "./voice/local-capture.js";
import { createLocalPartitions, type LocalPartitions } from "./lib/local-partitions.js";
import { createRecordingStore, type RecordingStore } from "./lib/recordings.js";
import { createLocalWork, type LocalWork } from "./lib/local-work.js";

/** One IndexedDB database per app origin holds every root's and every account's partitions (#1014). */
const LOCAL_PARTITIONS_DB = "brain-ui-local";

/** Recording on the device while the host is unreachable (#1012). */
export interface LocalCaptureOptions {
  /** @internal Use the root recording store with preflight before permission. */
  durable?: boolean;
  /** A sink for one recording; called once per tap that starts one. */
  sink: () => LocalCaptureSink;
  /** MediaRecorder's chunk interval. A tuning default, never shown. */
  timesliceMs?: number;
}

export interface BrainUiRootOptions {
  config?: Partial<BrainUiConfig>;
  api?: BrainApi;
  request?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Stable, distinct prefix per embedder. Omit for an ephemeral isolated root. */
  storagePrefix?: string;
  /** null disables persistence (SSR, stories, tests). */
  storage?: Storage | null;
  /**
   * @internal Where submitted ask answers wait (#910). Defaults to IndexedDB
   * under the storage prefix; to memory when `storage` is null; to none when
   * the page has no IndexedDB, so answers cannot be queued and say so.
   */
  answerStorage?: AnswerStorage | null;
  /** @internal Cross-tab coordination for the answer queue. */
  answerTabs?: TabCoordinator | null;
  /**
   * Turns on "Record on this device". `true` uses this root's durable store
   * (requires persistence and a stable storagePrefix); `{ sink }` supplies
   * a caller-owned sink. Off when omitted.
   */
  localCapture?: LocalCaptureOptions | true | null;
}

/** Dependencies the connection closes over; none are resolved from React. */
export interface BrainUiServices {
  config: BrainUiConfig;
  api: BrainApi;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  /** @internal The full store state; shells use the exported store hooks (#1053). */
  stores: BrainStores;
  renderers: ToolRendererRegistry;
  asr: AsrClientRegistry;
  apiBase: () => string;
  backendUrl: (path: string) => string;
  wsUrl: () => string;
  /** Mounted connectivity poller for this root, if any. */
  recheckVpn: () => void;
  /** Answer-queue dependencies, resolved once for this root. */
  answerStorage: AnswerStorage | null;
  answerTabs: TabCoordinator | null;
  /** Local recording, or null when this root does not offer it. */
  localCapture: LocalCaptureOptions | null;
  /**
   * @internal Device-local partitions (#1014), one per account plus
   * `unassigned`. Null for a root without persistence: an ephemeral one, or
   * a page without IndexedDB.
   */
  partitions: LocalPartitions | null;
  /** Device-local audio on this root; null when persistence is disabled. */
  recordings: RecordingStore | null;
  /** @internal The work context kept in the signed-in account's partition (#1014). */
  localWork: LocalWork | null;
  registerVpnRecheck: (callback: () => void) => () => void;
}

export interface BrainUiRoot extends BrainUiServices {
  connection: ReturnType<typeof createWebSocketClient>;
  /** Submitted ask answers, from Submit to the host's receipt (#910). */
  answers: ReturnType<typeof createWebSocketClient>["answers"];
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
  // A root built without persistence (stories, tests, SSR) keeps submitted
  // answers in memory: receipts and live-page recovery still work, a reload
  // does not survive. A real page whose IndexedDB is missing gets no store
  // at all, and its cards say an answer cannot be saved, rather than
  // promising a durability they lack.
  const persistent = options.storage !== null && typeof indexedDB !== "undefined";
  const answerStorage = options.answerStorage !== undefined
    ? options.answerStorage
    : options.storage === null
      ? createMemoryAnswerStorage()
      : persistent ? createIndexedDbAnswerStorage(`${prefix}:answers`) : null;
  const answerTabs = options.answerTabs !== undefined
    ? options.answerTabs
    : persistent ? createBrowserTabCoordinator(`${prefix}:answers`) : null;
  // The work context needs a root that is the same one after a reload: an
  // ephemeral root (no prefix given) would only leave records nothing reads.
  // A page without IndexedDB still gets one: its writes fail, and say so.
  const partitions = options.storage !== null && options.storagePrefix !== undefined && typeof document !== "undefined"
    ? createLocalPartitions({
      name: LOCAL_PARTITIONS_DB,
      heldAccountKey: () => stores.connection.getState().accountKey,
      // Asked once; whatever the browser answers, nothing is promised from it.
      persist: () => { void navigator.storage?.persist?.().catch(() => {}); },
    })
    : null;
  const services: BrainUiServices = {
    answerStorage, answerTabs, partitions, recordings: null, localWork: null,
    localCapture: options.localCapture === true ? null : options.localCapture ?? null,
    config, api, request, stores, renderers, asr, apiBase,
    backendUrl: (path) => getBackendUrlFor(config, path),
    wsUrl: () => getWsUrlFor(config),
    recheckVpn: () => vpnRecheck?.(),
    registerVpnRecheck(callback) {
      vpnRecheck = callback;
      return () => { if (vpnRecheck === callback) vpnRecheck = null; };
    },
  };
  // What a service-worker update reload must wait for (#1015).
  registerBuiltInUpdateHolds(services);
  if (partitions) {
    services.recordings = createRecordingStore({ partitions, root: services, heldAccountKey: () => stores.connection.getState().accountKey });
    if (options.localCapture === true) services.localCapture = { sink: () => services.recordings!.sink(), durable: true };
    services.localWork = createLocalWork({
      stores, partitions,
      scope: `root:${prefix}`,
      tracks: (sessionId, origin) => trackRefs(services, trackKey(sessionId, origin)),
      watchTracks: (fn) => subscribeAllTracks(services, fn),
    });
  }
  const connection = createWebSocketClient(services);
  return Object.assign(services, {
    connection,
    answers: connection.answers,
    dispose() {
      connection.dispose();
      services.localWork?.dispose();
      services.recordings?.dispose();
      // Previews of images still in a draft or a held send: nothing else will release them.
      stores.drafts.getState().release();
      disposeTracks(services);
      answerTabs?.dispose();
      stores.activity.dispose();
      stores.graph.dispose();
      stores.file.getState().reset();
      vpnRecheck = null;
    },
  });
}
