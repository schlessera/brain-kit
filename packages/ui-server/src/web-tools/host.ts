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
 *
 * Every connection the executor opens is attributed to the call in flight
 * (#3687). With none in flight it is refused: nothing the executor sends then
 * belongs to a turn. A connection to a provider's API host, a search, an
 * extraction fallback or a nested model call alike, is put to that call's
 * authority, which checks data routing and budget and counts it at unknown
 * cost; a refusal settles the call with the authority's code.
 *
 * A turn whose inference the host relays lends each of its calls its admitted
 * model (#3688). The executor host starts that model's relay into the
 * session's own egress route, so the relayed requests meet the same per-call
 * admission, and stops it once the turn's calls are done. One session lends
 * one turn's model at a time: a call from another turn, or for another model,
 * while one is lent is refused rather than relayed under the wrong turn.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { EgressAdmissionRefused, startEgressProxy, webSearchBrief, type EgressDestinationPolicy, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import type { WebModelEgress, WebModelGrant } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createWebBroker, type WebBroker, type WebBrokerLimits, type WebCallRefusal, type WebExecutor, type WebExecutorRequest, type WebReceipt } from "./broker.js";
import { configuredWebHosts, webHostRecipient } from "./recipients.js";
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

/**
 * Admit one executor connection for the call it belongs to. Calls of one
 * session normally share its turn; a connection that could belong to two
 * turns is attributed to neither and refused. A relayed model request is
 * admitted again just before dispatch; each admission is checked, but one
 * connection is counted once (`counted`, by its id).
 *
 * @internal Exported for its unit test.
 */
export async function admitConnection(broker: WebBroker, owner: { principalId: string; sessionId: string }, host: string, configured: ReadonlyMap<string, string>,
  connection?: { id: string; counted: Set<string> }): Promise<void> {
  const calls = broker.inFlight(owner);
  if (!calls.length) throw new EgressAdmissionRefused("No web call is running for this conversation.");
  const recipient = webHostRecipient(host, configured);
  // A page the call fetches: its address and bytes are the route's to check.
  if (recipient === undefined) return;
  if (new Set(calls.map(call => call.scope.turnId)).size !== 1) throw new EgressAdmissionRefused("This connection could belong to more than one turn.");
  const [call] = calls as [typeof calls[number]];
  if (!call.authority) return;
  let refusal: WebCallRefusal | null;
  try { refusal = await call.authority.admit(recipient); }
  catch { refusal = { code: "unavailable", message: "The host could not check this web call's admission; nothing more was sent." }; }
  if (refusal) {
    for (const each of calls) each.refuse(refusal);
    throw new EgressAdmissionRefused(refusal.message);
  }
  if (connection) {
    if (connection.counted.has(connection.id)) return;
    connection.counted.add(connection.id);
  }
  call.authority.attempt({ recipient, host, callId: call.callId });
}

/** One session's lent model relay (#3688): one turn's model at a time, stopped with that turn's last call. */
function modelLender(egress: WebModelEgress) {
  let lent: { key: string; users: number; ready: Promise<{ grant: WebModelGrant; stop(): void }> } | undefined;
  const release = (current: NonNullable<typeof lent>) => {
    if (--current.users > 0 || lent !== current) return;
    lent = undefined;
    void current.ready.then(relay => relay.stop(), () => {});
  };
  return {
    async acquire(request: WebExecutorRequest, signal: AbortSignal): Promise<{ grant: WebModelGrant; release(): void }> {
      const model = request.model!;
      const key = `${request.scope.turnId}\0${model.provider}/${model.model}`;
      if (lent && lent.key !== key) throw new Error("This conversation's web executor is relaying another turn's model; retry once that call has finished.");
      const current = lent ??= { key, users: 0, ready: model.open(egress, signal) };
      current.users++;
      try { return { grant: (await current.ready).grant, release: () => release(current) }; }
      catch (error) {
        // A failed start is not kept: the next call tries again.
        if (lent === current) lent = undefined;
        current.users--;
        throw error;
      }
    },
  };
}

export function createHostWebTools(options: HostWebToolsOptions): WebBroker {
  // A crash leaves session directories behind; nothing can still own them now.
  rmSync(options.root, { recursive: true, force: true });
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const credentialEnv = Object.fromEntries(Object.entries(options.env).filter(([name]) => !["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "HOME"].includes(name)));
  const ownerKey = (owner: { principalId: string; sessionId: string }) => `${owner.principalId}\0${owner.sessionId}`;
  // Each launching session's egress route, until its executor has opened.
  const routes = new Map<string, WebModelEgress>();
  const child = createChildWebExecutor({
    launch: async owner => {
      const configPath = options.hostConfigPath();
      const config = readHostConfig(configPath);
      const providerHosts = configuredWebHosts(config);
      // Connections already counted for their call, until they finish.
      const counted = new Set<string>();
      // The executor's whole network: a host proxy that resolves and checks every destination.
      const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: options.maxEgressBytes ?? DEFAULT_MAX_EGRESS_BYTES,
        destinations: { allowRanges: hostAllowRanges(config), ...(options.lookup ? { lookup: options.lookup } : {}),
          ...(options.egressPorts ? { ports: options.egressPorts } : {}) },
        admitted: destination => admitConnection(broker, owner, destination.host, providerHosts, { id: destination.connectionId, counted }),
        observe: record => {
          if (record.connectionId) counted.delete(record.connectionId);
          try { options.onEgress?.(record); } catch { /* A recorder cannot hold a connection open. */ }
        } });
      routes.set(ownerKey(owner), { dir: egress.dir, inference: egress.inference });
      try {
        const state = options.module.prepareWebExecutorState({ root: options.root, hostConfigPath: configPath, credentialEnv, path: options.path });
        const cleanup = () => { egress.stop(); state.cleanup(); };
        try {
          options.onPrepared?.(state.removed);
          const env = options.caCertificates ? { ...state.env, NODE_EXTRA_CA_CERTS: options.caCertificates } : state.env;
          return { command: options.module.webExecutorCommand(options.runtime, state.dir, { proxyDir: egress.dir }), env, cwd: `${state.dir}/work`, cleanup };
        } catch (error) { cleanup(); throw error; }
      } catch (error) { routes.delete(ownerKey(owner)); egress.stop(); throw error; }
    },
  });
  const executor: WebExecutor = {
    async open(owner, signal) {
      let session: Awaited<ReturnType<WebExecutor["open"]>>, route: WebModelEgress | undefined;
      try { session = await child.open(owner, signal); }
      finally { route = routes.get(ownerKey(owner)); routes.delete(ownerKey(owner)); }
      const lender = route ? modelLender(route) : undefined;
      return {
        ended: session.ended,
        close: reason => session.close(reason),
        async call(request, callSignal) {
          if (!request.model) return session.call(request, callSignal);
          let lease: Awaited<ReturnType<NonNullable<typeof lender>["acquire"]>>;
          try {
            if (!lender) throw new Error("This conversation's web executor has no egress route for a relayed model.");
            lease = await lender.acquire(request, callSignal);
          } catch (error) {
            const message = `The turn's model could not be lent to web search, so nothing was sent: ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}`;
            for (const call of broker.inFlight(owner)) if (call.callId === request.callId) call.refuse({ code: "unavailable", message });
            return { ok: false, code: "failed", message };
          }
          try { return await session.call({ ...request, modelGrant: lease.grant }, callSignal); }
          finally { lease.release(); }
        },
      };
    },
  };
  const broker: WebBroker = createWebBroker({
    executor,
    admittedProviders: () => admittedWebProviders(readHostConfig(options.hostConfigPath()), options.env),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.onReceipt ? { onReceipt: options.onReceipt } : {}),
  });
  return broker;
}
