import type { InferenceUsage } from "./inference-usage.js";
import { readReceivedHead } from "./relay-response.js";
import { chargeReceivedBytes } from "./egress-accounting.js";
/** Concrete host-owned HTTP/CONNECT transport for one turn; no TLS interception. */
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, chownSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { safetyRecordSchema } from "../safety.js";
import { createEgressOperation, TransportHandoffFailed } from "./egress-operation.js";
import { workerIdentityHelper } from "./worker-identity.js";
import { join } from "node:path";
import { safetySnapshotRefusal, type AdmissionSafety, type AdmissionSafetySnapshot } from "./admission-safety.js";

/** A readable may emit its last data and end together. Hold both in order,
 * applying backpressure while this connection waits for another writer. */
function guardedStream(source: { pause(): unknown; resume(): unknown }, wait: () => Iterable<Promise<void>>) {
  let queued: Array<() => void> | undefined;
  const resume = () => { if (!queued) source.resume(); };
  const on = <Args extends unknown[]>(handle: (...args: Args) => void) => async (...args: Args) => {
    if (queued) { queued.push(() => handle(...args)); return; }
    for (const pending of wait()) {
      if (!queued) {
        queued = [() => handle(...args)];
        source.pause();
      }
      await pending;
    }
    if (!queued) { handle(...args); return; }
    const ready = queued;
    queued = undefined;
    resume();
    for (const deliver of ready) deliver();
  };
  // Close follows queued data/FIN, but a disconnect without buffered data
  // still cancels a pending admission immediately.
  const afterQueued = (handle: () => void) => () => {
    if (queued) queued.push(handle);
    else handle();
  };
  return { on, resume, afterQueued };
}

export const WORKER_EGRESS_DIR = "/run/brain-egress";
export const WORKER_EGRESS_SOCKET = `${WORKER_EGRESS_DIR}/proxy.sock`;
/** What the worker bootstrap sets so a tool's network reaches the turn proxy; a tool spawn must keep them. */
export const WORKER_EGRESS_TRANSPORT_ENV = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "GIT_SSH_COMMAND"]);
/** The trusted in-namespace bootstrap that forwards loopback TCP to `WORKER_EGRESS_SOCKET`, then runs a command behind it. */
export function egressBootstrapEntry(): string { return Bun.resolveSync("./egress-worker-entry", import.meta.dir); }
export type EgressFailureReason = "budget" | "safety_changed" | "policy_denied" | "unavailable" | "cancelled";
export type EgressChargeFailure = { ok: false; reason: EgressFailureReason };
export type EgressChargeResult = { ok: true } | EgressChargeFailure;
const FAILURE_DETAILS = {
  budget: { reason:"max_bytes_per_turn",status:403,message:"egress limit exceeded" },
  safety_changed: { reason:"safety_changed",status:403,message:"safety or authority changed" },
  policy_denied: { reason:"policy_denied",status:403,message:"network policy refused the request" },
  unavailable: { reason:"egress_unavailable",status:503,message:"egress unavailable" },
  cancelled: { reason:"cancelled",status:499,message:"request cancelled" },
} as const;
export function egressChargeRefusal(failure: EgressChargeFailure, subject: string) {
  const detail=FAILURE_DETAILS[failure.reason];return {...detail,message:`${subject} ${detail.message}`};
}
/** Snapshot the failure site before finish() aborts its own operation signal. */
export function captureEgressFailure(signal:AbortSignal,operation?:{failure():EgressChargeFailure|undefined}) {
  const failure=operation?.failure() ?? (signal.aborted?{ok:false as const,reason:"cancelled" as const}:undefined);
  return failure?{failure,outcome:"cancelled" as const,status:egressChargeRefusal(failure,"Network").status}
    :{failure:undefined,outcome:"failed" as const,status:502 as const};
}
/** Capture the category with the terminal audit decision, before abort listeners run. */
function terminalFailure(outcome: EgressRecord["outcome"], reason?: string): EgressChargeFailure | undefined {
  if (outcome === "completed") return undefined;
  const category: EgressFailureReason = reason === "max_bytes_per_turn" || reason === "max_reference_wire_bytes" ? "budget"
    : reason === "safety_changed" || reason === "source_trust_changed" ? "safety_changed"
    : reason === "egress_unavailable" || reason === "session_binding_unavailable" || outcome === "failed" ? "unavailable"
    : outcome === "cancelled" ? "cancelled" : "policy_denied";
  return Object.freeze({ok:false,reason:category});
}
export type EgressRecipientAuthority = {kind:"rule";admission:{ruleId:string;policyHash:string;trustRevision:string;collectionRevision:string;instance:string}} | {kind:"approval"|"allowance"};
export type InferenceTimingMark = "admitMs" | "bodyMs" | "credentialMs" | "dispatchMs" | "headersMs" | "firstChunkMs";
export interface EgressRecord extends Partial<Record<InferenceTimingMark | "loopLagMaxMs", number>>, InferenceUsage {

  /** Host identity, shared with admission and terminal observation; never a tool correlation. */
  connectionId?: string;
  /** Only the server's concrete inference-relay admission supplies this tag. */
  inference?: true;
  /** Only a validated provider-relay operation supplies this tag (#3246); never with `inference`. */
  provider?: true;
  /** Host-managed acquisition only; returned immutable content has its own read evidence. */
  managedReference?: true;
  /** Explicit Network card approval, independent of source trust. */
  recipientApproved?: true;
  /** False for charged preparation that never crossed the dispatch boundary. */
  dispatched?: boolean;
  failureReason?: EgressFailureReason;
  method: string;
  host: string;
  port: number;
  /** Only cleartext HTTP has an observable path. Never invent one for CONNECT. */
  path?: string;
  bytes: number;
  /** HTTP includes a conservative framing allowance; CONNECT counts opaque stream bytes. */
  accounting: "http_wire_bound" | "opaque_bytes";
  durationMs: number;
  outcome: "completed" | "denied" | "failed" | "cancelled";
  reason?: string;
}
export interface EgressProxyOptions {
  /** Host-owned effective state. No request header or concurrent operation supplies authority. */
  admissionSafety?: AdmissionSafety;
  /** Exact host-owned write reservations of this connection's approved card peers. */
  pendingReservations?(connectionId:string):readonly string[];
  /** Host source decision remains valid before each delivered byte. */
  inputCurrent?(connectionId: string): boolean;
  mode: "record" | "allowlist";
  /** Exact DNS names/IPs or *.suffix; deny always wins. */
  allow: readonly string[];
  deny: readonly string[];
  maxBytes: number;
  outwardHosts: readonly string[];
  /** Destination ports that are outward on any host, such as mail submission. */
  outwardPorts?: readonly number[];
  /** Host authority for this connection. An observation of a tool is not a grant. */
  approveOutward?(destination: { host: string; port: number; method: string }, signal: AbortSignal): Promise<boolean>;
  observe(record: EgressRecord): void;
  /**
   * Untrusted-input narrowing (G6). While `tainted()` holds, a destination
   * other than a host relay (the inference relay or a validated provider-relay
   * operation, #3246) must also match `allow` or be one `contacted()` reports;
   * deny and the ordinary rules still apply first. `approve`, when present,
   * asks before refusing a narrowed destination (#3430); absent, or resolving
   * anything but `true`, refuses.
   */
  taint?: { allow: readonly string[]; tainted(connectionId?: string): boolean;
    /**
     * `destination`: the connection asking, so a host grant scoped to one
     * origin or connection can tell (#3595). `generation` is the grant
     * generation `generation()` reported when the connection was created.
     */
    contacted(host: string, destination?: { port: number; method: string; protocol: string; connectionId: string; managedReference: boolean; generation: number }): boolean;
    /** The host's current grant generation, read once as each connection is created (#3595). */
    generation?(): number;
    /** Immutable evidence/authority marker; excludes inputs admitted under this exact shared card. */
    approvalRevision?(connectionId?: string, kind?: "network" | "outward"): string;
    recipient?(destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean }): boolean | Extract<EgressRecipientAuthority,{kind:"rule"}>["admission"];
    approve?(destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean }, signal: AbortSignal, connectionId?: string, replacement?:boolean): Promise<boolean | "superseded" | "expired" | "unconfirmed">;
    /** What tainted the session, as "it …" completes it, for a refusal's message (#3431). */
    cause?(): string | null };
  /**
   * A destination passed every check; called before its first upstream byte.
   * A returned promise is awaited first, so a durable record it makes commits
   * before any byte flows; its rejection refuses the connection, as
   * `call_not_admitted` when it is an {@link EgressAdmissionRefused}.
   */
  admitted?(destination: { host: string; port: number; method: string; inference: boolean; provider: boolean; managedReference: boolean; connectionId: string; protocol?: string }): unknown;
  /** Synchronous notification only after final admission, immediately before dispatch. */
  preparing?(destination: { host: string; port: number; method: string; protocol: string; connectionId: string; inference: boolean; provider: boolean; managedReference: boolean; recipientApproved: boolean }): void;
  committed?(destination: { host: string; port: number; method: string; protocol: string; connectionId: string; inference: boolean; provider: boolean; managedReference: boolean; recipientApproved: boolean; recipientAuthority: EgressRecipientAuthority }): void;
  signal?: AbortSignal;
  /**
   * Destination address policy (#3687). When set, the proxy resolves every
   * destination itself, refuses one with any loopback, private, link-local,
   * shared, multicast or reserved address, or an unlisted port, and connects
   * to the address it checked, so a rebinding resolver cannot swap it.
   * Cloud metadata addresses are refused even inside `allowRanges`.
   */
  destinations?: EgressDestinationPolicy;
}
export interface EgressDestinationPolicy {
  /** Host-owned CIDR ranges a private address may be reached in, such as an owner's own `ssrf.allowRanges`. */
  allowRanges?: readonly string[];
  /** Destination ports; default 80 and 443. */
  ports?: readonly number[];
  /** @internal Test seam: the resolver. Default the system's. */
  lookup?(host: string): Promise<ReadonlyArray<{ address: string; family: number }>>;
}
/** Addresses no public web destination has (IANA special-purpose registries). */
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");
/** Instance metadata services; never reachable, whatever a range allows. */
const METADATA = new BlockList();
for (const address of ["169.254.169.254", "169.254.170.2", "169.254.170.23", "100.100.100.200", "192.0.0.192"]) METADATA.addAddress(address, "ipv4");
METADATA.addAddress("fd00:ec2::254", "ipv6");
/** An IPv4-mapped IPv6 address is judged as the IPv4 address it carries. */
function unmapped(address: string): { address: string; family: "ipv4" | "ipv6" } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: "ipv4" };
  return { address, family: isIP(address) === 6 ? "ipv6" : "ipv4" };
}
function rangeList(ranges: readonly string[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const [network, bits] = range.trim().split("/");
    const family = isIP(network ?? "");
    const prefix = bits === undefined ? (family === 6 ? 128 : 32) : Number(bits);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error("Invalid egress allow range");
    list.addSubnet(network!, prefix, family === 6 ? "ipv6" : "ipv4");
  }
  return list;
}
/** Why one resolved address is refused, or null when it may be reached. */
export function egressAddressRefusal(address: string, allow?: BlockList): "metadata_destination" | "private_destination" | null {
  const { address: value, family } = unmapped(address);
  if (!isIP(value)) return "private_destination";
  if (METADATA.check(value, family)) return "metadata_destination";
  if (NON_PUBLIC.check(value, family) && !allow?.check(value, family)) return "private_destination";
  return null;
}
export const canonicalEgressHost = (value: string) => {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  const host = normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  return isIP(host) === 6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host;
};
/** The history wire schema is also the host's destination admission validator. */
export function validatedEgressProvenance(destination:{method:string;protocol?:string;host:string;port:number}) {
  const host=canonicalEgressHost(destination.host),port=destination.port;
  if(destination.method!=="CONNECT"&&destination.protocol!=="http:"&&destination.protocol!=="https:")throw new Error("Invalid destination protocol");
  return safetyRecordSchema.options[0].shape.provenance.parse(destination.method==="CONNECT"
    ? {kind:"tunnel_authority",authority:{host,port},verifiedBy:"host_proxy"}
    : {kind:"web_origin",origin:{scheme:destination.protocol==="https:"?"https":"http",host,port},verifiedBy:"host_transport"});
}
function matches(host: string, patterns: readonly string[]): boolean {
  return patterns.some(value => {
    const pattern = canonicalEgressHost(value);
    return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) : host === pattern;
  });
}
/**
 * What a refused connection tells the tool that made it (#3430, #3431). curl,
 * git and `egress-connect` print the status line, so it carries the reason;
 * HTTP clients also get it as the body. `cause` uses `egress_denial`'s reason
 * words, plus `outward_not_approved`. No request content, header or credential
 * appears in either.
 */
export interface EgressRefusal {
  cause: "denied_host" | "not_allowlisted" | "byte_cap" | "taint_allowlist" | "outward_not_approved" | "private_destination" | "destination_port"
    | "call_not_admitted" | "safety_changed" | "egress_unavailable";
  message: string;
}
function describeRefusal(reason: string | undefined, host: string, denied: boolean, tainted: string | null | undefined): EgressRefusal | undefined {
  switch (reason) {
    case "safety_changed": case "source_trust_changed": return { cause: "safety_changed", message: "Blocked: this turn's safety or authority changed. A fresh request needs a fresh decision." };
    case "egress_unavailable": return { cause: "egress_unavailable", message: "Blocked: this turn's network admission is unavailable because safety recording could not be verified." };
    case "network_approval_expired": return { cause: "taint_allowlist", message: "The destination approval expired before the owner answered. No connection was made." };
    case "network_approval_unconfirmed": return { cause: "taint_allowlist", message: "The host could not confirm approval for this connection. No connection was made." };
    case "taint_not_approved": return { cause: "taint_allowlist",
      message: "Blocked: this session read untrusted content, this host is outside its allow-list, and the user declined the connection. Do not retry it; say what you needed it for." };
    case "taint_not_allowed": return { cause: "taint_allowlist",
      message: `Blocked: this session read untrusted content${tainted ? ` (it ${tainted})` : ""}, and ${host} is not on its taint allow-list or among the hosts it already reached. `
        + "Do not retry it; tell the user. They can add the host to taint.egress.allow in the brain's governance policy, or continue in a new session." };
    case "destination_not_allowed": return denied
      ? { cause: "denied_host", message: `Blocked: ${host} is on this brain's egress deny list. Do not retry it; tell the user.` }
      : { cause: "not_allowlisted", message: `Blocked: ${host} is not on this brain's egress allow list. Do not retry it; tell the user, who can add it to egress.allow in the brain's governance policy.` };
    case "max_bytes_per_turn": return { cause: "byte_cap",
      message: "Blocked: this turn has used up its network byte limit (egress.max_bytes_per_turn). Do not retry in this turn; tell the user." };
    case "outward_not_approved": return { cause: "outward_not_approved",
      message: `Blocked: a connection to ${host} acts outside the brain in the user's name, and it was not approved. Do not retry it; say what you needed it for.` };
    case "private_destination": case "metadata_destination": case "unresolved_destination": return { cause: "private_destination",
      message: `Blocked: ${host} is not a public web address. Do not retry it; tell the user.` };
    case "call_not_admitted": return { cause: "call_not_admitted",
      message: `Blocked: this call may not send anything to ${host} under this conversation's provider policy or budget. Do not retry it; tell the user.` };
    case "destination_port": return { cause: "destination_port",
      message: `Blocked: ${host} was reached on a port the web route does not allow. Do not retry it; tell the user.` };
    default: return undefined;
  }
}
/** The status text each refusal answers with; the declined card's text predates #3431. */
const REFUSAL_STATUS: Readonly<Record<EgressRefusal["cause"], string>> = {
  denied_host: "Forbidden - host on the egress deny list", not_allowlisted: "Forbidden - host not on the egress allow list",
  byte_cap: "Forbidden - turn network byte limit reached", taint_allowlist: "Forbidden - untrusted session, host not allowed",
  outward_not_approved: "Forbidden - outward connection not approved",
  private_destination: "Forbidden - not a public web address", destination_port: "Forbidden - destination port not allowed",
  call_not_admitted: "Forbidden - not admitted for this call",
  safety_changed: "Forbidden - safety or authority changed", egress_unavailable: "Service Unavailable - safety recording unavailable",
};

/**
 * Thrown by `admitted` to refuse one connection on the host's own authority
 * (#3687): recorded as `denied` with reason `call_not_admitted`, where any
 * other failure of the hook is `failed` with `proxy_error`.
 */
export class EgressAdmissionRefused extends Error {
  constructor(message = "The host did not admit this connection.", readonly reason: "call_not_admitted" | "source_trust_changed" | "egress_unavailable" = "call_not_admitted") { super(message); this.name = "EgressAdmissionRefused"; }
}
/** One refused connection's 403, with its reason when it has one. */
function refusalHead(refusal: EgressRefusal | undefined, reason: string | undefined, failure?: EgressChargeFailure): { code: number; status: string; body: string } | undefined {
  if (!refusal) {
    if (!failure) return undefined; const detail=egressChargeRefusal(failure,"Network");
    return {code:detail.status,status:detail.status===503?"Service Unavailable":detail.status===499?"Client Closed Request":"Forbidden",body:detail.message+"\n"};
  }
  const status = reason === "taint_not_approved" ? "Forbidden - declined by the user" : reason === "network_approval_expired" ? "Forbidden - approval expired" : REFUSAL_STATUS[refusal.cause];
  return { code: refusal.cause === "egress_unavailable" ? 503 : 403, status, body: `${refusal.message}\n` };
}
/** No header controlled by the peer can select a second upstream or carry proxy authority. */
const hopHeaders = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
function headers(message: IncomingMessage): Record<string, string | string[]> {
  const blocked = new Set([...hopHeaders, ...(message.headers.connection ?? "").split(",").map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(message.headers).filter(([name, value]) => value !== undefined && !blocked.has(name))) as Record<string, string | string[]>;
}

export async function startEgressProxy(options: EgressProxyOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw new Error("Egress maxBytes must be a finite nonnegative integer");
  for (const pattern of [...options.allow, ...options.deny, ...options.outwardHosts, ...options.taint?.allow ?? []]) {
    if ((!isIP(canonicalEgressHost(pattern)) && !/^(?:\*\.)?[a-zA-Z0-9.-]+$/.test(pattern)) || pattern.includes("..")) throw new Error("Invalid egress host pattern");
  }
  const destinationPorts = options.destinations ? new Set(options.destinations.ports ?? [80, 443]) : undefined;
  const allowRanges = options.destinations ? rangeList(options.destinations.allowRanges ?? []) : undefined;
  const resolve = options.destinations?.lookup ?? (async (host: string) => dnsLookup(host, { all: true, verbatim: true }));
  for (const port of [...options.outwardPorts ?? [], ...destinationPorts ?? []]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid outward port");
  }
  const separateIdentity = Boolean(workerIdentityHelper());
  const dir = mkdtempSync(join(tmpdir(), "brain-egress-"));
  try {
    if (separateIdentity) chownSync(dir, process.getuid!(), process.getgid!());
    chmodSync(dir, separateIdentity ? 0o750 : 0o700);
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  const socketPath = join(dir, "proxy.sock");
  const inputCurrent = (id: string) => { try { return options.inputCurrent?.(id) !== false; } catch { return false; } };
  const connections = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const lifecycles = new Set<ReturnType<typeof createEgressOperation>>();
  const inputs = new Map<string, () => void>();
  let usedBytes = 0, stopped = false;
  const server = createServer();
  server.maxHeadersCount = 100;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.on("connection", socket => { connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket)); });
  const track = (socket: Socket) => { connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket)); return socket; };
  /**
   * `relay` names the host relay that sent this operation; worker HTTP and
   * CONNECT traffic has none and cannot claim one, whatever its destination.
   */
  const inferenceControllers = new Set<AbortController>();
  function operation(method: string, url: URL, relay?: "inference" | "provider" | "reference") {
    const inference = relay === "inference", provider = relay === "provider", managedReference = relay === "reference";
    const connectionId = crypto.randomUUID();
    // Grants committed after this moment are not this connection's (#3595).
    const generation = options.taint?.generation?.() ?? 0;
    let snapshot: AdmissionSafetySnapshot | undefined;
    const started = performance.now();
    const marks: Partial<Record<InferenceTimingMark | "loopLagMaxMs", number>> = {};
    let lagExpected = started + 50;
    const sampleLag = () => { const at = performance.now(); marks.loopLagMaxMs = Math.max(marks.loopLagMaxMs ?? 0, at - lagExpected); lagExpected = at + 50; };
    let lagTimer = inference ? setInterval(sampleLag, 50) : undefined;
    lagTimer?.unref();
    const stopLag = () => { if (lagTimer) { sampleLag(); clearInterval(lagTimer); lagTimer = undefined; } };
    const mark = (name: InferenceTimingMark) => {
      if (!inference || finished || marks[name] !== undefined) return;
      if (name === "dispatchMs") stopLag();
      marks[name] = Math.max(0, performance.now() - started);
    };
    const controller = new AbortController(); controllers.add(controller);
    if (inference) inferenceControllers.add(controller);
    let finished = false, firstAdmissionPending = false, firstAdmissionStarted = false;
    const usage: InferenceUsage = {};
    // Matching may ignore a DNS root dot; resolution must preserve it.
    const dialHost = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const host = canonicalEgressHost(dialHost), port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    let bytes = 0, granted = false;
    /** The checked address this connection is pinned to, under a destination policy. */
    let pinned: { address: string; family: number } | undefined;
    let finalOutcome: EgressRecord["outcome"] | undefined, finalReason: string | undefined;
    let failure: EgressChargeFailure | undefined;
    const lifecycle = createEgressOperation({
      decide(terminal) {
        if (firstAdmissionPending && terminal.outcome !== "cancelled") mark("admitMs");
        stopLag(); finished = true; inferenceControllers.delete(controller);
        finalOutcome=terminal.outcome;finalReason=terminal.reason;failure=terminalFailure(terminal.outcome,terminal.reason);
        controllers.delete(controller);inputs.delete(connectionId);
      },
      abort:()=>controller.abort(),
      observe({outcome,reason,dispatched}) {
        lifecycles.delete(lifecycle);
        // Records never contain request headers, content, credentials or query strings.
        try { options.observe({connectionId,...(inference?{inference:true}:{}),...(provider?{provider:true}:{}),...(managedReference?{managedReference:true}:{}),method,host,port,dispatched,
          ...(failure?{failureReason:failure.reason}:{}),...(dispatched&&granted?{recipientApproved:true}:{}),...(method==="CONNECT"?{}:{path:url.pathname}),bytes,
          accounting:method==="CONNECT"?"opaque_bytes":"http_wire_bound",...(inference ? { ...marks, ...usage } : {}),durationMs:performance.now()-started,outcome,...(reason?{reason}:{})}); } catch { /* A recorder cannot keep a connection alive. */ }
      },
    });
    lifecycles.add(lifecycle);
    const finish=lifecycle.finish;
    const revokeInput = () => { finish("cancelled", "source_trust_changed"); };
    inputs.set(connectionId, revokeInput);
    // Turn cleanup must observe final audit failures before it publishes its
    // terminal outcome; socket close callbacks run only after stop returns.
    controller.signal.addEventListener("abort", () => {
      const reason=controller.signal.reason;
      if (reason instanceof EgressAdmissionRefused && reason.reason === "egress_unavailable") finish("denied","egress_unavailable");
      else finish("cancelled", "turn_cancelled");
    }, { once: true });
    const charge = (count: number): EgressChargeResult => {
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Egress charge bytes must be a nonnegative safe integer");
      return maySendNow(count) ? { ok: true } : failure ?? {ok:false,reason:"cancelled"};
    };
    const receive=(count:number):EgressChargeResult=>chargeReceivedBytes(count,{remaining:()=>Math.max(0,options.maxBytes-usedBytes),charge:bytes=>{const result=charge(bytes);return result.ok?undefined:result;}})??{ok:true};
    const receiveHead=(first:string,rawHeaders:readonly string[]):EgressChargeResult=>readReceivedHead(first,rawHeaders,{remaining:()=>Math.max(0,options.maxBytes-usedBytes),charge:bytes=>{const result=charge(bytes);return result.ok?undefined:result;}})??{ok:true};
    /** One approval wait; cancelling this connection or the turn resolves it as refused. */
    const approval = async (ask: ((destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean }, signal: AbortSignal) => Promise<boolean | "superseded" | "expired" | "unconfirmed">) | undefined) => {
      if (!ask || !lifecycle.active()) return false;
      let answer: boolean | "superseded" | "expired" | "unconfirmed" = "unconfirmed";
      let cancelled: (() => void) | undefined;
      try {
        const cancellation = new Promise<false>(resolve => {
          cancelled = () => resolve(false);
          controller.signal.addEventListener("abort", cancelled, { once: true });
          if (controller.signal.aborted) resolve(false);
        });
        answer = await Promise.race([ask({ host, port, method, protocol: url.protocol, managedReference }, controller.signal), cancellation]);
      } catch { /* A failed approval denies. */ }
      finally { if (cancelled) controller.signal.removeEventListener("abort", cancelled); }
      return controller.signal.aborted || stopped ? false : answer;
    };
    // An approval of this destination outside the taint allow-list (#3430).
    let outwardApproved = false, grantRevision: string | undefined, outwardRevision: string | undefined;
    const readSafety = () => {
      try { return options.admissionSafety?.read(options.pendingReservations?.(connectionId)); }
      catch (error) {
        // Record the cause before the surrounding admission or transport unwinds.
        finish("denied", "egress_unavailable");
        throw error;
      }
    };
    function* pendingRecording() {
      try {
        yield* options.admissionSafety?.pendingRecording?.(snapshot, controller.signal,
          () => options.pendingReservations?.(connectionId)) ?? [];
      } catch { finish("denied", "egress_unavailable"); }
    }
    const approvalRevision = (own = false, outward = false) => options.taint?.approvalRevision?.(own || !outward ? connectionId : undefined, outward ? "outward" : "network") ?? JSON.stringify(readSafety());
    const grantCurrent = (own = false) => {
      if (!granted && !outwardApproved) return true;
      try {
        // After handoff, an explicit Network answer is the standing session grant.
        const sessionGrant=granted&&lifecycle.dispatched()&&options.taint?.contacted(host,asking);
        return (!granted||sessionGrant||grantRevision===approvalRevision(own))&&(!outwardApproved||outwardRevision===approvalRevision(own,true));
      } catch { return false; }
    };
    // A marker can change because recording or authority disappeared while a
    // card was pending. Classify that live failure before a generic stale card.
    const refuseStaleApproval = () => {
      try { if (!refuseSafety(readSafety(),snapshot)) finish("denied","safety_changed"); }
      catch { finish("denied","egress_unavailable"); }
    };
    const recipient = { host, port, method, protocol: url.protocol, managedReference };
    const asking = { port, method, protocol: url.protocol, connectionId, managedReference, generation };
    // Checked again after an approval wait, during which another connection may taint the session.
    // Inference/provider relays retain G5. Managed references retain ordinary
    // G6 recipient narrowing; repository trust never grants outbound authority.
    const recipientDecision = (final = false): EgressRecipientAuthority | null => {
      if(granted)return {kind:"approval"};
      if(inference||provider)return {kind:"allowance"};
      const rule=options.taint?.recipient?.(recipient);
      if(rule)return typeof rule === "object" ? {kind:"rule",admission:rule} : {kind:"allowance"};
      if(!options.taint?.tainted(final?connectionId:undefined)||matches(host,options.taint.allow)||options.taint.contacted(host,asking))return {kind:"allowance"};
      return null;
    };
    const narrowed = (final = false) => recipientDecision(final) === null;
    const narrowing = async () => {
      for (const pending of pendingRecording()) await pending;
      if (options.admissionSafety?.pendingRecording) {
        if (!lifecycle.active() || refuseSafety(readSafety(), snapshot)) return false;
      }
      if (!narrowed()) return true;
      const ask = options.taint?.approve;
      if (!ask) { finish("denied","taint_not_allowed"); return false; }
      const askNetwork = (replacement:boolean) => {
        grantRevision = approvalRevision();
        return approval((destination, signal) => ask(destination, signal, connectionId, replacement));
      };
      let beforeCard = readSafety();
      let answer = await askNetwork(false);
      while (answer === "superseded") {
        const current = readSafety();
        // The host withdrew this card. A new card can ask about new evidence
        // for the same pending connection only while its authority still holds.
        if (!snapshot || !beforeCard || !current || !lifecycle.active() || lifecycle.dispatched() ||
            refuseSafety(current, snapshot) || current.trustRevision !== snapshot.trustRevision || current.trustRevision !== beforeCard.trustRevision ||
            current.evidenceRevision === beforeCard.evidenceRevision || !narrowed()) {
          refuseStaleApproval(); return false;
        }
        if (usedBytes >= options.maxBytes) { finish("denied", "max_bytes_per_turn"); return false; }
        beforeCard = current;
        answer = await askNetwork(true);
      }
      granted = answer === true;
      if (granted && !grantCurrent()) { refuseStaleApproval(); return false; }
      if (!granted) finish(stopped ? "cancelled" : "denied", answer === "expired" ? "network_approval_expired"
        : answer === "unconfirmed" ? "network_approval_unconfirmed" : "taint_not_approved");
      return granted;
    };
    const refuseSafety = (current: AdmissionSafetySnapshot | undefined, before?: AdmissionSafetySnapshot) => {
      const reason = current && !current.recordingAvailable && current.operationRecordingAvailable !== true ? "unavailable" : safetySnapshotRefusal(current,before) ? "safety_changed" : undefined;
      if (!reason) return false;
      finish("denied",egressChargeRefusal({ok:false,reason},"Network").reason); return true;
    };
    const admitDestination = () => lifecycle.admit(async () => {
      if (!lifecycle.active()) return false;
      snapshot = readSafety();
      for (const pending of pendingRecording()) await pending;
      if (!lifecycle.active() || refuseSafety(snapshot?.recordingAvailable === false ? readSafety() : snapshot, snapshot)) return false;
      if (stopped || options.signal?.aborted) { finish("cancelled", "turn_cancelled"); return false; }
      if (matches(host, options.deny) || options.mode === "allowlist" && !matches(host, options.allow)) { finish("denied", "destination_not_allowed"); return false; }
      if (usedBytes >= options.maxBytes) { finish("denied", "max_bytes_per_turn"); return false; }
      if (destinationPorts) {
        if (!destinationPorts.has(port)) { finish("denied", "destination_port"); return false; }
        let addresses: ReadonlyArray<{ address: string; family: number }>;
        try { addresses = isIP(dialHost) ? [{ address: dialHost, family: isIP(dialHost) }] : await resolve(dialHost); }
        catch { finish("denied", "unresolved_destination"); return false; }
        if (!lifecycle.active()) return false;
        if (!addresses.length) { finish("denied", "unresolved_destination"); return false; }
        // Every address must pass: a mixed answer is refused, not narrowed.
        for (const entry of addresses) {
          const refused = egressAddressRefusal(entry.address, allowRanges);
          if (refused) { finish("denied", refused); return false; }
        }
        pinned = addresses[0];
      }
      if (!await narrowing() || !lifecycle.active()) return false;
      if (matches(host, options.outwardHosts) || options.outwardPorts?.includes(port)) {
        outwardRevision = approvalRevision(false,true);
        const approveOutward=options.approveOutward;
        if ((await approval(approveOutward ? ({host,port,method},signal)=>approveOutward({host,port,method},signal) : undefined)) !== true) { finish(stopped ? "cancelled" : "denied", "outward_not_approved"); return false; }
        outwardApproved = true;
        if (!grantCurrent()) { refuseStaleApproval(); return false; }
      }
      if (!await narrowing() || !lifecycle.active()) return false;
      // A recorder failure aborts the turn through its own signal; it cannot admit.
      try {
        for (const pending of pendingRecording()) await pending;
        if (options.admissionSafety?.pendingRecording) {
          if (!lifecycle.active() || refuseSafety(readSafety(), snapshot)) return false;
        }
        if (!await lifecycle.effect(() => options.admitted?.({ host, port, method, inference, provider, managedReference, connectionId, protocol:url.protocol }))) return false;
      } catch (error) { if (error instanceof EgressAdmissionRefused && error.reason === "source_trust_changed") revokeInput(); else if (error instanceof EgressAdmissionRefused) finish("denied", error.reason); else finish("failed", "proxy_error"); return false; }
      if (stopped || controller.signal.aborted) { finish("cancelled", "turn_cancelled"); return false; }
      return true;
    });
    const admit = !inference ? admitDestination : async () => {
      const first = !firstAdmissionStarted;
      if (first) { firstAdmissionStarted = true; firstAdmissionPending = true; }
      try { return await admitDestination(); }
      finally {
        if (first) {
          marks.admitMs = Math.max(0, performance.now() - started);
          firstAdmissionPending = false;
        }
      }
    };
    const observeUsage = (reported: InferenceUsage) => { if (inference && !finished) Object.assign(usage, reported); };
    // No await may intervene between this check and connect/request/fetch.
    const maySendNow = (count: number): EgressRecipientAuthority | null => {
      try {
      if (!lifecycle.active() || stopped || controller.signal.aborted) { finish("cancelled", "turn_cancelled"); return null; }
      const stateRefusal=lifecycle.sendRefusal(count,options.maxBytes-usedBytes);
      if (stateRefusal) { finish(stateRefusal==="turn_cancelled"?"cancelled":"denied",stateRefusal);return null; }
      const current = readSafety();
      if (refuseSafety(current,snapshot)) return null;
      if (!grantCurrent(true)) { refuseStaleApproval(); return null; }
      if (!inputCurrent(connectionId)) { revokeInput(); return null; }
      const authority=recipientDecision(true);
      if (!authority) { finish("denied", "taint_not_allowed"); return null; }
      usedBytes += count; bytes += count;
      return authority;
      } catch { finish("denied", "egress_unavailable"); return null; }
    };
    const prepare = (): EgressChargeResult => {
      try{return lifecycle.prepare(()=>options.preparing?.({...recipient,connectionId,inference,provider,recipientApproved:granted}))?{ok:true}:failure??{ok:false,reason:"cancelled"};}
      catch{finish("denied","egress_unavailable");return failure!;}
    };
    const dispatch = (send:()=>void): EgressChargeResult => {
      const prepared=prepare();if(!prepared.ok)return prepared;
      let authority:EgressRecipientAuthority|null=null;
      try{return lifecycle.dispatch(options.maxBytes-usedBytes,()=>Boolean(authority=maySendNow(0)),send,()=>options.committed?.({...recipient,connectionId,inference,provider,recipientApproved:granted,recipientAuthority:authority!}))?{ok:true}:failure??{ok:false,reason:"cancelled"};}
      catch(error){if(error instanceof TransportHandoffFailed)throw error;finish("failed","upstream_unreachable");throw new Error("Egress transport could not start");}
    };
    /** Why this connection was refused, for the tool that made it; undefined while admitted or for a bare refusal. */
    const refusal = () => {
      if (finalOutcome !== "denied" && finalReason !== "source_trust_changed") return undefined;
      let cause: string | null | undefined;
      if (finalReason === "taint_not_allowed") try { cause = options.taint?.cause?.(); } catch { /* The message names no cause. */ }
      return describeRefusal(finalReason, host, matches(host, options.deny), cause);
    };
    return { pendingRecording, observeUsage, mark, host, dialHost, finish, ownCleanup:lifecycle.ownCleanup, charge, receive, receiveHead, admit, prepare, dispatch, refusal, failure:()=>failure, signal: controller.signal, outcome: () => finalOutcome, reason: () => finalReason, pinned: () => pinned };
  }
  server.on("connect", (request, client, head) => {
    client.on("error", () => {});
    let target: URL;
    try {
      if (!request.url || !/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\]):[0-9]+$/.test(request.url)) throw new Error();
      target = new URL(`http://${request.url}`);
      validatedEgressProvenance({method:"CONNECT",protocol:target.protocol,host:target.hostname,port:Number(target.port||80)});
    } catch { client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    const op = operation("CONNECT", target);
    let connected = false, upstream: Socket | undefined;
    op.signal.addEventListener("abort", () => {
      if (!upstream) return;
      if (connected || op.outcome() !== "failed") client.destroy();
      if (op.outcome() === "completed" && upstream.writableEnded) upstream.destroySoon();
      else upstream.destroy();
    }, { once: true });
    const fromClient = guardedStream(client, op.pendingRecording);
    client.once("close", fromClient.afterQueued(() => op.finish(stopped || !connected ? "cancelled" : "completed")));
    const upstreamFailed=()=>{
      const prior=op.outcome();op.finish("failed","upstream_unreachable");
      if(connected||(prior&&prior!=="failed")){client.destroy();return;}
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    };
    const refuseConnect=()=>{
        const declined = refusalHead(op.refusal(), op.reason(), op.failure());
        client.end(declined ? `HTTP/1.1 ${declined.code} ${declined.status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(declined.body)}\r\nConnection: close\r\n\r\n${declined.body}`
          : "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    void (async () => {
      if (!await op.admit() || client.destroyed || !op.prepare().ok) {
        refuseConnect();return;
      }
      for (const pending of op.pendingRecording()) await pending;
      if (!op.receive(head.length).ok) { refuseConnect(); return; }
      const address = op.pinned();
      const sent=op.dispatch(()=>{upstream=track(connect({host:address?.address??op.dialHost,port:Number(target.port||80)}));});
      if(!sent.ok){refuseConnect();return;}
      const tunnel = upstream!;
      const fromTunnel = guardedStream(tunnel, op.pendingRecording);
      tunnel.once("connect", fromTunnel.on(() => {
        if (stopped || op.signal.aborted || client.destroyed || !op.charge(0).ok) { tunnel.destroy(); return; }
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) tunnel.write(head);
        client.on("data", fromClient.on((chunk: Buffer) => { if (!op.receive(chunk.length).ok) { client.destroy(); tunnel.destroy(); return; } if (!tunnel.write(chunk)) client.pause(); }));
        tunnel.on("data", fromTunnel.on((chunk: Buffer) => { if (!op.receive(chunk.length).ok) { client.destroy(); tunnel.destroy(); return; } if (!client.write(chunk)) tunnel.pause(); }));
        tunnel.on("drain", fromClient.resume); client.on("drain", fromTunnel.resume);
      }));
      tunnel.once("error",upstreamFailed);
      tunnel.once("end", fromTunnel.on(() => { if (!op.charge(0).ok) { client.destroy(); tunnel.destroy(); return; } client.end(); }));
      client.once("end", fromClient.on(() => { if (!op.charge(0).ok) { client.destroy(); tunnel.destroy(); return; } tunnel.end(); }));
      tunnel.once("close", fromTunnel.afterQueued(() => {
        if (!client.writableEnded && (connected || op.outcome() !== "failed")) client.destroy();
      }));
    })().catch(error => {if(error instanceof TransportHandoffFailed)upstreamFailed();else{op.finish("failed","proxy_error");client.destroy();}});
  });
  server.on("request", (request, response) => {
    let target: URL;
    try {
      target = new URL(request.url!);
      if (target.protocol !== "http:" || target.username || target.password || target.hash) throw new Error();
      validatedEgressProvenance({method:request.method??"GET",protocol:target.protocol,host:target.hostname,port:Number(target.port||80)});
    } catch { response.writeHead(400); response.end(); return; }
    const op = operation(request.method ?? "GET", target);
    op.signal.addEventListener("abort", () => { if (response.headersSent) response.destroy(); }, { once: true });
    response.once("close", () => op.finish(stopped ? "cancelled" : response.writableFinished ? "completed" : "cancelled"));
    const refuse = () => {
      if(response.destroyed||response.writableEnded)return;
      if(response.headersSent){response.destroy();return;}
      const declined = refusalHead(op.refusal(), op.reason(), op.failure());
      if (declined) response.writeHead(declined.code, declined.status, { "content-type": "text/plain; charset=utf-8" }).end(declined.body);
      else { response.writeHead(403); response.end(); }
    };
    void (async () => {
      if (!await op.admit() || response.destroyed) { refuse(); return; }
      for (const pending of op.pendingRecording()) await pending;
      if(!op.receiveHead(`${request.method} ${request.url} HTTP/${request.httpVersion}`,request.rawHeaders).ok){refuse();return;}
      const outgoingHeaders = { ...headers(request), host: target.host, connection: "close" };
      const address = op.pinned();
      // Under a destination policy the request goes to the checked address; Host keeps the name.
      const upstreamTarget = new URL(target);
      if (address) upstreamTarget.hostname = address.family === 6 ? `[${address.address}]` : address.address;
      if (!op.prepare().ok) { refuse(); return; }
      let outgoing!:ReturnType<typeof httpRequest>;
      const upstreamFailed=()=>{op.finish("failed","upstream_unreachable");if(!response.headersSent)response.writeHead(502);response.end();};
      const sendUpstream=(send:()=>void)=>{
        try{const decision=op.dispatch(send);if(decision.ok)return true;}
        catch(error){if(error instanceof TransportHandoffFailed){upstreamFailed();return false;}}
        outgoing?.destroy();if(!response.headersSent)refuse();else response.destroy();return false;
      };
      for (const pending of op.pendingRecording()) await pending;
      const responseEvents = guardedStream({
        pause: () => outgoing.socket?.pause(), resume: () => outgoing.socket?.resume(),
      }, op.pendingRecording);
      const acceptResponse = responseEvents.on((incoming: IncomingMessage) => {
        const fromOrigin = guardedStream(incoming, op.pendingRecording);
        if (!op.receiveHead(`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}`,incoming.rawHeaders).ok) {
          refuse(); incoming.destroy(); outgoing.destroy(); return;
        }
        const writeHeaders = () => { if (!response.headersSent) response.writeHead(incoming.statusCode ?? 502, headers(incoming)); };
        incoming.on("data", fromOrigin.on((chunk: Buffer) => {
          if (!op.receive(chunk.length + 16).ok) {
            if (!response.headersSent) refuse(); else response.destroy();
            incoming.destroy(); outgoing.destroy(); return;
          }
          writeHeaders(); if (!response.write(chunk)) incoming.pause();
        }));
        response.on("drain", fromOrigin.resume);
        incoming.once("end", fromOrigin.on(() => { if (!response.destroyed && !response.writableEnded) { if (!op.charge(0).ok) { response.destroy(); return; } writeHeaders(); response.end(); } }));
      });
      const dispatched=sendUpstream(()=>{outgoing=httpRequest(upstreamTarget, { method: request.method, headers: outgoingHeaders,signal:op.signal,
        // This operation owns its connection. A pooled socket can have an
        // unread origin FIN when another independently fenced request takes it.
        agent: false }, incoming => {
        incoming.once("error", () => { op.finish("failed", "upstream_response_failed"); response.destroy(); });
        void acceptResponse(incoming);
      });});
      if(!dispatched)return;
      outgoing.on("information",responseEvents.on(incoming=>{
        if(!op.receiveHead(`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}`,incoming.rawHeaders).ok){refuse();outgoing.destroy();}
      }));
      // 101 uses upgrade rather than information; this HTTP path never tunnels it.
      outgoing.once("upgrade", (incoming, socket, head) => {
        socket.on("error", () => {});
        void responseEvents.on(() => {
          const received = op.receiveHead(`HTTP/${incoming.httpVersion} ${incoming.statusCode} ${incoming.statusMessage}`, incoming.rawHeaders);
          if (received.ok && head.length) op.receive(head.length);
          socket.destroy();
          if (op.failure()) refuse(); else upstreamFailed();
        })();
      });
      op.signal.addEventListener("abort", () => { outgoing.destroy(); if (op.outcome() === "cancelled") response.destroy(); }, { once: true });
      outgoing.once("error",upstreamFailed);
      response.once("close", () => outgoing.destroy());
      const fromWorker = guardedStream(request, op.pendingRecording);
      request.on("data", fromWorker.on((chunk: Buffer) => { if (!op.receive(chunk.length + 16).ok) { outgoing.destroy(); if (!response.headersSent) refuse(); else response.destroy(); return; } let accepted=false;if(!sendUpstream(()=>{accepted=outgoing.write(chunk);}))return;if(!accepted)request.pause(); }));
      outgoing.on("drain", fromWorker.resume);
      request.once("end", fromWorker.on(() => { if (!op.charge(0).ok) { outgoing.destroy(); if (!response.headersSent) refuse(); else response.destroy(); return; } sendUpstream(()=>{outgoing.end();}); }));
      request.once("error", () => { op.finish("cancelled", "client_disconnected"); outgoing.destroy(); });
    })().catch(() => { op.finish("failed", "proxy_error"); response.destroy(); });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); }); });
    if (separateIdentity) chownSync(socketPath, process.getuid!(), process.getgid!());
    chmodSync(socketPath, separateIdentity ? 0o660 : 0o600);
  } catch (error) { server.close(); rmSync(dir, { recursive: true, force: true }); throw error; }
  const stop = () => {
    if (stopped) return;
    stopped = true; options.signal?.removeEventListener("abort", stop);
    for (const controller of controllers) controller.abort(options.signal?.reason);
    for (const socket of connections) socket.destroy();
    server.close(); rmSync(dir, { recursive: true, force: true });
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  return { dir, socketPath, stop, inferenceInFlight: () => inferenceControllers.size > 0,
    async settled() { await Promise.all([...lifecycles].map(operation=>operation.settled())); },
    /** Fence only inputs whose host decision changed; unrelated traffic remains active. */
    invalidateInputs() { for (const [id, revoke] of inputs) if (!inputCurrent(id)) revoke(); },
    usedBytes: () => usedBytes, remainingBytes: () => Math.max(0, options.maxBytes - usedBytes),
    /** The existing inference relay shares this turn's admission, counter and audit. */
    inference(method: string, target: URL, signal: AbortSignal) { return relayedOperation(method, target, signal, "inference"); },
    /**
     * The CLI provider relay's validated requests (#1673): egress to the
     * provider (G5), with the turn's deny/allow rules, byte ceiling and
     * connection record, sent by the host so the key stays there. Like the
     * inference relay, it neither taints the session nor is narrowed by its
     * taint (G6, #3246); only the relay's own validated routes reach this.
     */
    relayed(method: string, target: URL, signal: AbortSignal) { return relayedOperation(method, target, signal, "provider"); },
    /** Host-only fixed GitHub acquisition channel. No worker header can select it. */
    managedReference(target: URL, signal: AbortSignal) {
      if (target.protocol !== "https:" || !["github.com", "api.github.com"].includes(target.hostname)
        || target.port || target.username || target.password || target.search || target.hash)
        throw new Error("Managed reference needs a fixed GitHub HTTPS recipient");
      return relayedOperation("CONNECT", target, signal, "reference");
    },
  };
  function relayedOperation(method: string, target: URL, signal: AbortSignal, relay: "inference" | "provider" | "reference") {
    validatedEgressProvenance({method,protocol:target.protocol,host:target.hostname,port:Number(target.port||(target.protocol==="https:"?443:80))});
    const op = operation(method, new URL(target), relay);
    const abort = () => op.finish("cancelled", "client_disconnected");
    signal.addEventListener("abort", abort, { once: true });
    op.ownCleanup(()=>signal.removeEventListener("abort",abort));
    if (signal.aborted) abort();
    return { ...(options.admissionSafety?.pendingRecording ? { pendingRecording: op.pendingRecording } : {}), observeUsage: op.observeUsage, mark: op.mark, charge: op.charge, signal: op.signal, outcome: op.outcome, refusal: op.refusal, reason: op.reason, failure: op.failure,
      admit: async () => !op.signal.aborted && await op.admit(),
      prepare:op.prepare,dispatch:op.dispatch,
      finish:op.finish,
    };
  }
}
