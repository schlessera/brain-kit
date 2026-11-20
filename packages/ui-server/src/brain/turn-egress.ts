/** One admitted turn's concrete proxy, approval surface and durable records. */
import { originTrustMatch, type OriginTrust, type OriginDestination } from "./origin-trust.js";
import type { EffectiveGovernancePolicy, TrustMatch } from "@schlessera/brain-common/internal/governance-policy";
import { startEgressProxy, EgressAdmissionRefused, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { requestToolPermission, type BackendActivityEvent, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import type { Database } from "bun:sqlite";
import { occurrence, type Occurrence } from "../governance/occurrence.js";
import type { GovernanceEventInput } from "../governance/events.js";
import { contactedHosts, recordFirstTaint, sessionTaint, type TaintSource } from "../governance/session-taint.js";
import type { GovernanceWrites } from "../governance/event-writes.js";
import { safetyProjection } from "../governance/safety-store.js";
import { settleTurnSessionBinding } from "../ws/bridge-session-binding.js";
import { isMarkedUntrusted } from "../files/untrusted-marks.js";
import { createTurnExtraction } from "./turn-extraction.js";
import type { ExtractionJudge } from "../governance/extraction-judge.js";

type Classification = Extract<BackendActivityEvent, { kind: "outward_classification" }>["classification"];
const GITHUB_API_HOSTS = ["api.github.com", "uploads.github.com"] as const;
/**
 * Built-in mail submission (G5). SMTP submission is defined by its port, so
 * any host on these ports is outward; the hosts are HTTP mail-send APIs and
 * provider relays on alternate ports. `outward.hosts` adds the rest.
 */
const MAIL_SUBMISSION_PORTS = [25, 465, 587] as const;
const MAIL_SUBMISSION_HOSTS = ["gmail.googleapis.com", "graph.microsoft.com", "outlook.office365.com",
  "api.fastmail.com", "api.sendgrid.com", "smtp.sendgrid.net", "api.mailgun.net", "api.eu.mailgun.net", "smtp.mailgun.org",
  "smtp.eu.mailgun.org", "api.postmarkapp.com", "smtp.postmarkapp.com", "api.resend.com", "smtp.resend.com"] as const;

/** What the session did that tainted it, as the destination card names it (#3430). */
const TAINT_SOURCE_WORDING: Readonly<Record<TaintSource, string>> = {
  legacy_unknown: "received input with unknown provenance", web_fetch: "fetched a web page", web_search: "ran a web search", staged_share: "opened a shared file",
  workspace_read: "read a file under workspaces/", mcp_document: "read a document from an external MCP server",
  user_marked: "read a file marked untrusted", egress_connection: "received data from another site",
  fetching_command: "ran a command that fetches content", unclassified_command: "ran a command that may have fetched content",
  chat_attachment: "opened a chat attachment", apify_result: "received Apify results", github_result: "read GitHub issues or pull requests", compute_output: "collected an external compute job's output",
};

/**
 * The card a tainted interactive session raises for a destination outside its
 * taint allow-list (#3430): the destination, what tainted the session, and
 * what allowing it does.
 */
export function taintedDestinationDescription(destination: { host: string; port: number; method: string }, source: TaintSource | null): string {
  const cause = source ? `This session ${TAINT_SOURCE_WORDING[source]}, so content you did not write may be steering it.`
    : "This session read content you did not write, which may be steering it.";
  return `${cause} Allow it to connect to ${destination.host}:${destination.port}? `
    + `Allowing lets it send data to ${destination.host} for the rest of this session without asking again.`;
}

/** Hosts an approved visible action names; an unresolved destination names none. */
function actionHosts(action: Classification["actions"][number]): readonly string[] {
  if (action.action === "gh_write") return GITHUB_API_HOSTS;
  const host = action.target?.split("/")[0]?.replace(/:[0-9]+$/, "").toLowerCase();
  return host ? [host] : [];
}

/**
 * The tool calls in progress and their outward classification (G5). An
 * outward-host connection skips its card only while every classified call in
 * progress is a visible read, or an approved outward action naming that host.
 * Any unknown or opaque call in progress withholds the exception: the proxy
 * cannot tell which process opened a connection. A call ends at its result.
 */
export function createOutwardCalls() {
  const calls = new Map<string, { read: boolean; hosts: readonly string[] } | null>();
  return {
    activity(event: BackendActivityEvent): void {
      if (event.kind !== "outward_classification") return;
      // A refused or declined call never runs.
      if (event.decision !== "allow") { calls.delete(event.toolUseId); return; }
      const classification = event.classification;
      calls.set(event.toolUseId, classification.opaque ? null
        : classification.kind === "read" ? { read: true, hosts: [] }
        : classification.kind === "outward" ? { read: false, hosts: classification.actions.flatMap(actionHosts) } : null);
    },
    emitted(message: Parameters<BackendBridge["emit"]>[0]): void {
      if (message.type === "tool_result") calls.delete(message.toolUseId);
    },
    covers(host: string): boolean {
      const active = [...calls.values()];
      // Every call in progress must be a read or name this host: another
      // call's approval to a different destination covers nothing here.
      return active.length > 0 && active.every(call => call !== null && (call.read || call.hosts.includes(host)));
    },
  };
}

export async function prepareTurnEgress(options: {
  trust?: OriginTrust;
  policy: EffectiveGovernancePolicy; policyHash?:string|null; bridge: BackendBridge; controller: AbortController;
  turnId: string; sessionId: () => string | null; model: () => string | null;
  profile: "governed" | "strict"; origin: "interactive" | "voice";
  /**
   * Absent when the host keeps no governance record: limits still apply. A
   * returned promise is the record's commit (#2850); its failure stops the
   * turn like a synchronous one, and `settled()` waits for it.
   */
  record?(event: GovernanceEventInput): unknown;
  /** The record the session's taint and contacted hosts are read from (G6). Absent: no taint narrowing. */
  governanceDb?: Database;
  /**
   * Where the session's occurrences commit, and how admission reads it back
   * before that commit lands (#2850). Absent: the taint commits on
   * `governanceDb` through `record`.
   */
  governanceWrites?: Pick<GovernanceWrites, "firstTaint" | "taint"> & Partial<Pick<GovernanceWrites,"recordingAvailable" | "safety">>;
  /** The brain's host path, for the extraction classifier's read files and named paths (#4088). */
  brainPath?: string;
  /**
   * The judge for the classifier's ambiguous band (#4089), routed, metered
   * and budgeted by the caller. Used only while the policy sets
   * `taint.judge.mode: jev` beside `taint.classifier: heuristics`.
   */
  extractionJudge?: ExtractionJudge;
}) {
  const calls = createOutwardCalls();
  let recordingFailure: Error | undefined;
  const db = options.governanceDb;
  // Without a write worker the taint commits through `record`, at once, as it always did.
  const record = options.record;
  const writes: typeof options.governanceWrites = options.governanceWrites ?? (db && record ? {
    taint: (turnId: string | null, sessionId: string | null) => sessionTaint(db, turnId, sessionId),
    firstTaint: (event: GovernanceEventInput<"taint">) => { recordFirstTaint(db, event, record); return Promise.resolve(true); },
  } : undefined);
  const recording = new Set<Promise<unknown>>();
  // Hosts earlier turns of the session reached, then every host this turn admits.
  const contacted = new Set(db ? contactedHosts(db, options.sessionId()) : []);
  const collectionEpoch = (db?.query("SELECT id FROM safety_collections WHERE turn_id=?").get(options.turnId) as {id:string}|null)?.id??crypto.randomUUID();
  const exposures = new Map<string, Occurrence>();
  const exposureCommits = new Map<string, Promise<unknown>>();
  const normalBefore = new Set<string>();
  const standingRecipients = new Map<string, Pick<TrustMatch, "ruleId" | "policyHash" | "trustRevision" | "collectionRevision">>();
  const trustedInputs = new Map<string, { destination: OriginDestination; revision: string }>();
  let releaseTrust: (() => void) | undefined;
  const base = () => ({ turnId: options.turnId, sessionId: options.sessionId(), model: options.model(),
    actor: options.origin, profile: options.profile });
  const fail = () => {
    recordingFailure ??= new Error("Turn egress recording is unavailable");
    options.controller.abort(recordingFailure);
  };
  const track = (committed: unknown) => {
    if (!(committed instanceof Promise)) return;
    const pending = committed.catch(fail).finally(() => recording.delete(pending));
    recording.add(pending);
  };
  const report = (record: EgressRecord): void => {
    if (!options.record) return;
    try {
      const trustedSource = record.connectionId ? trustedInputs.has(record.connectionId) : false;
      track(options.record({ ...base(), kind: "egress_connection", payload: { ...record, ...(trustedSource ? { trustedSource: true } : {}), ...(record.connectionId && standingRecipients.has(record.connectionId) ? { standingRecipient: true, recipientAdmission: standingRecipients.get(record.connectionId) } : {}) } }));
      if (record.connectionId) { trustedInputs.delete(record.connectionId); standingRecipients.delete(record.connectionId); }
      const exposure = record.connectionId ? exposures.get(record.connectionId) : undefined;
      if (exposure) {
        exposures.delete(record.connectionId!);
        normalBefore.delete(record.connectionId!);
        // A clean HTTP completion proves bounded input ended. A tunnel close
        // or cancellation alone cannot prove all opaque delivery completed.
        const terminal = () => options.record!({ ...base(), kind: "taint_exposure", dedupeKey: exposure.id,
          payload: { occurrenceId: exposure.id, state: record.method !== "CONNECT" && record.outcome === "completed" ? "finalized" : "interrupted_unknown" } });
        // Removal can close the transport while its initial occurrence is
        // still committing. Terminal evidence must join that exact write.
        const initial = exposureCommits.get(record.connectionId!);
        track(initial ? initial.then(terminal) : terminal());
      }
      const denied = options.policy.egress.deny.some(pattern => {
        const normalized = pattern.toLowerCase().replace(/\.$/, "");
        return normalized.startsWith("*.") ? record.host.endsWith(normalized.slice(1)) && record.host !== normalized.slice(2) : record.host === normalized;
      });
      const reason = record.reason === "destination_not_allowed" ? denied ? "denied_host" : "not_allowlisted"
        : record.reason === "max_bytes_per_turn" ? "byte_cap"
        : record.reason === "taint_not_allowed" || record.reason === "taint_not_approved" ? "taint_allowlist" : undefined;
      if (reason) track(options.record({ ...base(), kind: "egress_denial", payload: {
        host: record.host, port: record.port, method: record.method, reason, bytes: record.bytes,
      } }));
    } catch { fail(); }
  };
  /**
   * Any admitted connection other than a host relay taints the session (G6),
   * recorded before its first byte. Each connection keeps independent evidence.
   */
  // A taint submitted but not yet committed counts (#2850).
  const firstTaint = () => db ? writes ? writes.taint(options.turnId, options.sessionId()) : sessionTaint(db, options.turnId, options.sessionId()) : null;
  /**
   * One card per destination host at a time: concurrent connections to the
   * same new host share its answer. An allowed connection's admission adds
   * its host to `contacted`, so the rest of this turn admits it, and its
   * charged `egress_connection` record carries it into later turns
   * (`contactedHosts`).
   */
  const asking = new Map<string, Promise<boolean>>();
  const approveTainted = async (destination: { host: string; port: number; method: string }, signal: AbortSignal): Promise<boolean> => {
    let pending = asking.get(destination.host);
    if (!pending) {
      pending = requestToolPermission(options.bridge, { toolUseId: crypto.randomUUID(), toolName: "Network", kind: "command",
        input: { ...destination, target: `${destination.host}:${destination.port}` },
        description: taintedDestinationDescription(destination, firstTaint()?.source ?? null),
      }).then(decision => decision.behavior === "allow", () => false).finally(() => asking.delete(destination.host));
      asking.set(destination.host, pending);
    }
    const allowed = await pending;
    return allowed && !signal.aborted;
  };
  // The extraction classifier (#4088), off unless the policy turns it on. It
  // needs the session's taint record, so a host that keeps none never runs it.
  const extraction = db && options.policy.taint.classifier === "heuristics" ? createTurnExtraction({ bridge: options.bridge, origin: options.origin,
    sessionId: options.sessionId, tainted: () => firstTaint() !== null, contacted, brainPath: options.brainPath,
    cause: () => { const source = firstTaint()?.source; return source ? TAINT_SOURCE_WORDING[source] : null; },
    marked: path => isMarkedUntrusted(db, path),
    ...(options.policy.taint.judge.mode === "jev" && options.extractionJudge ? { judge: options.extractionJudge } : {}) }) : null;
  const taint = db ? {
    allow: options.policy.taint.egress.allow,
    recipient: (destination: OriginDestination) => originTrustMatch(options.trust, destination, "recipientWhileRestricted", "0") !== null,
    tainted: (connectionId?: string) => {
      if (connectionId && normalBefore.has(connectionId)) {
        const projection = options.governanceWrites?.safety?.(options.turnId, options.sessionId()) ?? safetyProjection(db, options.turnId, options.sessionId());
        // Only this request's own newly recorded input may be excluded from
        // its first-byte check. A second connection gets no such authority.
        if (projection.coverage.state === "complete" && projection.unresolvedCount === 1 &&
          projection.earliestUnresolvedId === exposures.get(connectionId)?.id &&
          projection.reasons.every(reason => reason === "unresolved")) return false;
      }
      return firstTaint() !== null;
    },
    // An `allow` from the extraction classifier relaxes this check, and only
    // this one, while the readable call naming the host is in progress.
    contacted: (host: string) => contacted.has(host) || extraction?.relaxes(host) === true,
    // A refusal names what tainted the session, as the card does (#3431).
    cause: () => { const source = firstTaint()?.source; return source ? TAINT_SOURCE_WORDING[source] : null; },
    // Voice has no grant surface; it keeps refusing without a card (#3430).
    ...(options.origin === "interactive" ? { approve: approveTainted } : {}),
  } : undefined;
  /**
   * The proxy awaits this before the connection's first byte, so the taint
   * has committed by then. It is in force for every later admission from the
   * moment it is submitted.
   */
  const admitted = async (destination: { host: string; port: number; method: string; inference: boolean; provider: boolean; managedReference: boolean; connectionId: string; protocol?:string }): Promise<void> => {
    // A host relay's operation neither taints the session nor makes its host
    // one the worker's own traffic may reach once tainted (G6, #3246).
    // A managed acquisition has not delivered source content to the model.
    // Its immutable read must establish independent input evidence later.
    if (destination.inference || destination.provider || destination.managedReference) {
      if(writes?.recordingAvailable&&!writes.recordingAvailable(options.turnId,options.sessionId())){fail();throw new Error("Input recording unavailable before provider dispatch");}
      return;
    }
    if (firstTaint() === null) normalBefore.add(destination.connectionId);
    if (!writes) return;
    const exposure = occurrence(collectionEpoch, "proxy_input", destination.connectionId, "open");
    const match = originTrustMatch(options.trust, destination, "incomingContent", options.bridge.admissionSafety?.read().evidenceRevision ?? "0");
    exposure.admission = match ? { trusted: true, ruleId: match.ruleId, policyHash: match.policyHash, trustRevision: match.trustRevision, collectionRevision: match.collectionRevision }
      : { trusted: false, policyHash: options.policyHash ?? null, trustRevision: options.trust?.revision() ?? "0" };
    if (match) trustedInputs.set(destination.connectionId, { destination, revision: match.trustRevision });
    exposure.provenance=destination.method==="CONNECT"
      ? {kind:"tunnel_authority",authority:{host:destination.host,port:destination.port},verifiedBy:"host_proxy"}
      : destination.protocol==="http:"||destination.protocol==="https:"
        ? {kind:"web_origin",origin:{scheme:destination.protocol==="http:"?"http":"https",host:destination.host,port:destination.port},verifiedBy:"host_transport"}:null;
    exposures.set(destination.connectionId, exposure);
    try {
      const initial = writes.firstTaint({ ...base(), kind: "taint", payload: { source: "egress_connection", tool: null,
        detail: `${destination.method} ${destination.host}:${destination.port}`, occurrence: exposure } });
      exposureCommits.set(destination.connectionId, initial);
      await initial;
    } catch (error) { fail(); throw error; }
    finally { exposureCommits.delete(destination.connectionId); }
    if (match && options.trust!.revision() !== match.trustRevision) throw new EgressAdmissionRefused("Source trust changed before dispatch");
  };
  /** Settles once every record submitted so far has committed or failed; `recordingFailure()` is final after it. */
  const settled = async () => { while (recording.size) await Promise.all([...recording]); };
  const proxy = await startEgressProxy({ mode: options.policy.egress.mode, allow: options.policy.egress.allow,
    ...(options.bridge.admissionSafety ? { admissionSafety: options.bridge.admissionSafety } : {}),
    deny: options.policy.egress.deny, maxBytes: options.policy.egress.max_bytes_per_turn ?? Number.MAX_SAFE_INTEGER,
    outwardHosts: [...new Set([...GITHUB_API_HOSTS, ...MAIL_SUBMISSION_HOSTS, ...options.policy.outward.hosts])],
    outwardPorts: MAIL_SUBMISSION_PORTS,
    signal: options.controller.signal, observe: report, admitted,
    inputCurrent: connectionId => { const input = trustedInputs.get(connectionId); return !input || options.trust?.revision() === input.revision; },
    committed: destination => {
      if (destination.inference || destination.provider || destination.managedReference) return;
      const recipient = originTrustMatch(options.trust, destination, "recipientWhileRestricted", options.bridge.admissionSafety?.read().evidenceRevision ?? "0");
      if (recipient) { const { ruleId, policyHash, trustRevision, collectionRevision } = recipient; standingRecipients.set(destination.connectionId, { ruleId, policyHash, trustRevision, collectionRevision }); }
      if (!trustedInputs.has(destination.connectionId) && !standingRecipients.has(destination.connectionId)) contacted.add(destination.host);
    }, ...(taint ? { taint } : {}),
    approveOutward: async (destination, signal) => {
      if (calls.covers(destination.host)) return !signal.aborted;
      const decision = await requestToolPermission(options.bridge, { toolUseId: crypto.randomUUID(), toolName: "Network",
        kind: "command", input: destination,
        description: `${destination.method} to ${destination.host}:${destination.port}`,
      }, { noGrantSurface: options.origin === "voice" });
      return !signal.aborted && decision.behavior === "allow";
    },
  });
  releaseTrust = options.trust?.subscribe(() => proxy.invalidateInputs());
  options.controller.signal.addEventListener("abort", () => releaseTrust?.(), { once: true });
  const original = options.bridge;
  /** The bridge the backend receives, so its classifications and results open and close each call. */
  const bridge: BackendBridge = { ...original,
    emit(message) { calls.emitted(message); extraction?.emitted(message); original.emit(message); },
    activity(event) { calls.activity(event); original.activity?.(event); },
  };
  if (extraction) {
    // Read at each call, not here: the host installs its admission collector
    // on the bridge it handed this turn, possibly after this proxy started.
    let wrapped: { from: BackendBridge["inputSafety"]; to: BackendBridge["inputSafety"] } | undefined;
    Object.defineProperty(bridge, "inputSafety", { enumerable: true, configurable: true,
      get: () => {
        if (!wrapped || wrapped.from !== original.inputSafety) wrapped = { from: original.inputSafety, to: extraction.inputSafety(original.inputSafety) };
        return wrapped.to;
      },
      set: (value: BackendBridge["inputSafety"]) => { original.inputSafety = value; } });
  }
  const relayOperation = (kind: "inference" | "relayed", method: string, target: URL, signal: AbortSignal) => {
    const operation = proxy[kind](method, target, signal);
    return settleOperation(operation);
  };
  const settleOperation = (operation: ReturnType<typeof proxy.managedReference>) => {
    return { ...operation, async admit() {
      // Join this proxy's terminal records and this bridge's announced
      // session binding before the new snapshot. A concurrent FULL binding
      // must not change a healthy scope underneath its first admission.
      // Independent pending input still refuses in the unchanged final fences.
      if (operation.signal.aborted) return false;
      let abort: (() => void) | undefined;
      try {
        const ready = await Promise.race([settled().then(() => settleTurnSessionBinding(original, operation.signal)).catch(() => false), new Promise<false>(resolve => {
          abort = () => resolve(false);
          operation.signal.addEventListener("abort", abort, { once: true });
          if (operation.signal.aborted) resolve(false);
        })]);
        if (!ready) { operation.finish("denied", "session_binding_unavailable"); return false; }
        return !operation.signal.aborted && await operation.admit();
      } finally { if (abort) operation.signal.removeEventListener("abort", abort); }
    } };
  };
  return { ...proxy, stop() { releaseTrust?.(); proxy.stop(); }, bridge, recordingFailure: () => recordingFailure, settled,
    inference: (method: string, target: URL, signal: AbortSignal) => relayOperation("inference", method, target, signal),
    relayed: (method: string, target: URL, signal: AbortSignal) => relayOperation("relayed", method, target, signal),
    managedReference: (target: URL, signal: AbortSignal) => settleOperation(proxy.managedReference(target, signal)) };
}
