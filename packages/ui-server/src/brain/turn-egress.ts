/** One admitted turn's concrete proxy, approval surface and durable records. */
import { createHash } from "node:crypto";
import { originTrustMatchSnapshot, type OriginTrust, type OriginDestination } from "./origin-trust.js";
import type { EffectiveGovernancePolicy, TrustMatch } from "@schlessera/brain-common/internal/governance-policy";
import { startEgressProxy, canonicalEgressHost, validatedEgressProvenance, EgressAdmissionRefused, sameAuthority, STALE_SAFETY_ADMISSION, type EgressRecord } from "@schlessera/brain-ui-sdk/internal";
import { requestToolPermission, type BackendActivityEvent, type BackendBridge, type NetworkCardController, type PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import type { NetworkApprovalOffer, NetworkApprovalScope } from "@schlessera/brain-ui-sdk/protocol";
import type { Database } from "bun:sqlite";
import { occurrence, type Occurrence } from "../governance/occurrence.js";
import type { GovernanceEventInput } from "../governance/events.js";
import { contactedHosts, recordFirstTaint, sessionTaint, type TaintSource } from "../governance/session-taint.js";
import type { GovernanceWrites } from "../governance/event-writes.js";
import { safetyQueue, safetyReadVersion } from "../governance/safety-queue.js";
import { safetyProjection, safetyEvidenceSequence, sessionHistoryGeneration, unresolvedTaintClasses } from "../governance/safety-store.js";
import { canonicalNetworkOrigin, listActiveNetworkGrants, matchNetworkGrant } from "../governance/network-grants.js";
import { settleTurnSessionBinding, type SessionBindingRefusal } from "../ws/bridge-session-binding.js";
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

const networkAuthority = (destination: {host:string;port:number}) => `${destination.host.includes(":") ? `[${destination.host}]` : destination.host}:${destination.port}`;

/**
 * The card a tainted interactive session raises for a destination outside its
 * taint allow-list (#3430, #3595): the destination, what tainted the session,
 * and what allowing it does. Never promises "for the rest of this session" for
 * a once or managed-acquisition card.
 */
export function taintedDestinationDescription(
  destination: { host: string; port: number; method: string },
  source: TaintSource | null,
  options?: {
    managedReference?: boolean;
    scopes?: readonly NetworkApprovalScope[];
    suspendedGrant?: { newClasses: readonly string[] };
  }
): string {
  const cause = source ? `This session ${TAINT_SOURCE_WORDING[source]}, so content you did not write may be steering it.`
    : "This session read content you did not write, which may be steering it.";
  if (options?.managedReference) {
    return `${cause} Allow this managed GitHub acquisition from ${networkAuthority(destination)}? `
      + "Allowing covers only this acquisition.";
  }
  if (options?.suspendedGrant) {
    const added = options.suspendedGrant.newClasses
      .map((cls) => TAINT_SOURCE_WORDING[cls as TaintSource] ?? "read untrusted content")
      .join(", ");
    return `This chat has now also ${added}. Keep allowing ${destination.host}?`;
  }
  if (options?.scopes?.length) {
    return `${cause} Allow it to connect to ${networkAuthority(destination)}? `
      + "Allow once covers only this connection; origin or session scopes last for this chat until new untrusted input arrives or you revoke them.";
  }
  return `${cause} Allow it to connect to ${networkAuthority(destination)}? `
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
  let generation=0n;
  return {
    activity(event: BackendActivityEvent): void {
      if (event.kind !== "outward_classification") return;
      generation++;
      // A refused or declined call never runs.
      if (event.decision !== "allow") { calls.delete(event.toolUseId); return; }
      const classification = event.classification;
      calls.set(event.toolUseId, classification.opaque ? null
        : classification.kind === "read" ? { read: true, hosts: [] }
        : classification.kind === "outward" ? { read: false, hosts: classification.actions.flatMap(actionHosts) } : null);
    },
    emitted(message: Parameters<BackendBridge["emit"]>[0]): void {
      if (message.type === "tool_result" && calls.delete(message.toolUseId)) generation++;
    },
    generation:()=>generation.toString(),
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
  /** Stops the turn when a record cannot be retained, naming why (#4565); defaults to aborting `controller`. */
  stop?: (error: Error) => void;
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
  networkRefusal?(toolUseId:string): false | "superseded" | "expired" | "unconfirmed";
  /** Settles pending non-managed Network sibling requests in this session when a grant lands (#4966, #3595). */
  settleSiblings?(
    predicate: (req: PermissionRequest) => boolean,
    scope: NetworkApprovalScope | undefined,
    reason: string,
    excludeToolUseId: string,
    grantedClasses?: readonly string[]
  ): number;
  /** Broadcasts updated active grants for this session after a grant commits (#3595). */
  onGrantsChanged?(sessionId: string): void;
  /** Emits an inline host receipt when a later connection proceeds under an active standing grant (#3595). */
  emitStandingReceipt?(info: { connectionId: string; host: string; scope: "origin" | "session"; reason: string }): void;
  /**
   * Where the session's occurrences commit, and how admission reads it back
   * before that commit lands (#2850). Absent: the taint commits on
   * `governanceDb` through `record`.
   */
  governanceWrites?: Pick<GovernanceWrites, "firstTaint" | "taint"> & Partial<Pick<GovernanceWrites,"recordingAvailable" | "safety" | "record">>;
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
    firstTaint: async (event: GovernanceEventInput<"taint">) => {
      let pending:unknown;
      recordFirstTaint(db,event,input=>{pending=record(input);});
      const result=await pending;
      if(typeof result === "boolean")return result;
      if(result&&typeof result === "object"&&"recorded" in result)return result.recorded === true;
      const input=event.payload.occurrence;
      return !input?.admission?.trusted || db.query("SELECT id FROM safety_records WHERE id=? AND kind='occurrence'").get(input.id) !== null;
    },
  } : undefined);
  const recording = new Set<Promise<unknown>>();
  // Hosts earlier turns of the session reached, then every host this turn admits.
  const contacted = new Set(db ? contactedHosts(db, options.sessionId()) : []);
  const collectionEpoch = (db?.query("SELECT id FROM safety_collections WHERE turn_id=?").get(options.turnId) as {id:string}|null)?.id??crypto.randomUUID();
  const exposures = new Map<string, Occurrence>();
  const ownCollectionStarts = new Map<string,string>();
  // Per-connection own pending reservation exclusion (replaces ApprovalGroup, #4966).
  const pendingReservations = (connectionId?:string):readonly string[] => {
    const ownOcc = connectionId ? exposures.get(connectionId)?.id : undefined;
    if (!db || !ownOcc) return [];
    const queue = safetyQueue(db);
    return Object.freeze([...queue.pending].filter(p => p.occurrenceId === ownOcc).map(p => p.id));
  };
  /** Snapshot of unresolved untrusted-input classes active when each connection's approval was granted (#4966). */
  const connectionGrantedClasses = new Map<string, ReadonlySet<string>>();
  const exposureCommits = new Map<string, Promise<unknown>>();
  const normalBefore = new Set<string>();
  const standingRecipients = new Map<string, Pick<TrustMatch, "ruleId" | "policyHash" | "trustRevision" | "collectionRevision">>();
  const trustedInputs = new Map<string, { destination: OriginDestination; revision: string; ruleId: string; instance: string }>();
  const inputCurrent = (connectionId: string) => {
    const input = trustedInputs.get(connectionId); if (!input) return true;
    let current:ReturnType<OriginTrust["read"]> | undefined;
    try { current = options.trust?.read(); } catch { return false; }
    if (!current || current.ruleInstances[input.ruleId] !== input.instance) return false;
    if (current.revision === input.revision) return true;
    // Revalidate this admission's own source rule, never borrow a replacement
    // rule or rewrite the historical admission. Recipient-only edits are independent.
    const match = originTrustMatchSnapshot({ ...current, ruleInstances:current.ruleInstances, rules: current.rules.filter(rule => rule.id === input.ruleId) }, input.destination, "incomingContent", "0");
    if (!match) return false;
    input.revision = current.revision; return true;
  };
  let releaseTrust: (() => void) | undefined;
  const base = () => ({ turnId: options.turnId, sessionId: options.sessionId(), model: options.model(),
    actor: options.origin, profile: options.profile });
  const fail = () => {
    recordingFailure ??= new EgressAdmissionRefused("Turn egress recording is unavailable","egress_unavailable");
    if (options.stop) options.stop(recordingFailure); else options.controller.abort(recordingFailure);
  };
  const track = (committed: unknown) => {
    const confirm=(result:unknown)=>{
      // A positive existing id is a durable replay, not a lost write.
      if(result===false||result&&typeof result === "object"&&"recorded" in result&&result.recorded===false&&(!("id" in result)||typeof result.id !== "number"||result.id<=0))throw new Error("Egress audit was not durably recorded");
    };
    if (!(committed instanceof Promise)) {try{confirm(committed);}catch{fail();}return;}
    const pending = committed.then(confirm).catch(fail).finally(() => recording.delete(pending));
    recording.add(pending);
  };
  const releaseConnection = (connectionId?: string) => {
    if (!connectionId) return;
    trustedInputs.delete(connectionId);standingRecipients.delete(connectionId);
    exposures.delete(connectionId);ownCollectionStarts.delete(connectionId);exposureCommits.delete(connectionId);normalBefore.delete(connectionId);
    connectionGrantedClasses.delete(connectionId);
    approvalMarkers.delete(`${connectionId}:network`);approvalMarkers.delete(`${connectionId}:outward`);
  };
  const report = (record: EgressRecord): void => {
    try {
      if (!options.record) return;
      const trustedSource = record.connectionId ? trustedInputs.has(record.connectionId) : false;
      track(options.record({ ...base(), kind: "egress_connection", payload: { ...record, ...(trustedSource ? { trustedSource: true } : {}), ...(record.connectionId && standingRecipients.has(record.connectionId) ? { standingRecipient: true, recipientAdmission: standingRecipients.get(record.connectionId) } : {}) } }));
      const exposure = record.connectionId ? exposures.get(record.connectionId) : undefined;
      if (exposure) {
        // A clean HTTP completion proves bounded input ended. A tunnel close
        // or cancellation alone cannot prove all opaque delivery completed.
        const terminal = () => options.record!({ ...base(), kind: "taint_exposure", dedupeKey: exposure.id,
          payload: { occurrenceId: exposure.id, state: record.method !== "CONNECT" && record.outcome === "completed" ? "finalized" : "interrupted_unknown" } });
        // Removal can close the transport while its initial occurrence is
        // still committing. Terminal evidence must join that exact write.
        const initial = exposureCommits.get(record.connectionId!);
        track(initial ? initial.then(recorded=>recorded===true?terminal():undefined,()=>undefined) : terminal());
      }
      const denied = options.policy.egress.deny.some(pattern => {
        const normalized = canonicalEgressHost(pattern);
        return normalized.startsWith("*.") ? record.host.endsWith(normalized.slice(1)) && record.host !== normalized.slice(2) : record.host === normalized;
      });
      const reason = record.reason === "destination_not_allowed" ? denied ? "denied_host" : "not_allowlisted"
        : record.reason === "max_bytes_per_turn" ? "byte_cap"
        : ["taint_not_allowed","taint_not_approved","network_approval_expired","network_approval_unconfirmed"].includes(record.reason ?? "") ? "taint_allowlist" : undefined;
      if (reason) track(options.record({ ...base(), kind: "egress_denial", payload: {
        host: record.host, port: record.port, method: record.method, reason, bytes: record.bytes,
      } }));
    } catch { fail(); } finally { releaseConnection(record.connectionId); }
  };
  /**
   * Any admitted connection other than a host relay taints the session (G6),
   * recorded before its first byte. Each connection keeps independent evidence.
   */
  // A taint submitted but not yet committed counts (#2850).
  let taintRead: { version:string; value:ReturnType<typeof sessionTaint> } | undefined;
  const firstTaint = () => {
    if (!db) return null;
    const sessionId = options.sessionId(), version = JSON.stringify([safetyReadVersion(db),sessionId]);
    if (taintRead?.version === version) return taintRead.value;
    const value = writes ? writes.taint(options.turnId,sessionId) : sessionTaint(db,options.turnId,sessionId);
    taintRead = {version,value}; return value;
  };
  let projectionRead: {version:string;value:ReturnType<typeof safetyProjection>} | undefined;
  const currentProjection = () => {
    const sessionId = options.sessionId(), version = JSON.stringify([safetyReadVersion(db!),sessionId]);
    if (projectionRead?.version === version) return projectionRead.value;
    const value = writes?.safety?.(options.turnId,sessionId) ?? safetyProjection(db!,options.turnId,sessionId);
    projectionRead = {version,value}; return value;
  };
  /**
   * One request id per connection, carrying its canonical `origin` grouping key
   * and card revision (#4966, #3595). Pending Network taint cards stay valid
   * across further occurrences of already-shown classes and sibling pending
   * writes; a new class or degraded coverage updates the card in place under
   * the same id. Legacy replies without a scope still add the host to
   * `contacted` and settle same-host siblings; explicit `once` admits only the
   * answered connection, while `origin` and `session` persist host-owned
   * `network_grant` records and settle matching siblings.
   */
  const approvalMarkers = new Map<string,{version:string;marker:string}>();
  const approvalRevision = (connectionId?: string,kind: "network" | "outward" = "network") => {
      const callGeneration=kind==="outward"?calls.generation():"0";
      if (!db) return `unrecorded:${callGeneration}`;
      const excludedPending=kind==="network"?pendingReservations(connectionId):[];
      const safety = options.bridge.admissionSafety?.read(excludedPending);
      const key = `${connectionId ?? "global"}:${kind}`, version = JSON.stringify([safety?.evidenceRevision ?? safetyReadVersion(db), safety?.scope, safety?.authorityEpoch, safety?.authorityCurrent, safety?.recordingAvailable, options.trust?.revision() ?? "0", safetyQueue(db).generation.toString(),callGeneration]);
      const cached = approvalMarkers.get(key); if (cached?.version === version) return cached.marker;
      const state = options.governanceWrites?.safety?.(options.turnId, options.sessionId(),excludedPending) ?? safetyProjection(db, options.turnId, options.sessionId(),excludedPending);
      const ownStart=connectionId?ownCollectionStarts.get(connectionId):undefined;
      const starts=new Set<string>();if(ownStart)starts.add(ownStart);
      const inputs=new Set<string>();const ownInput=connectionId?exposures.get(connectionId)?.id:undefined;if(ownInput)inputs.add(ownInput);
      // An uninstrumented turn was already unknown before its first record.
      // Creating its sole incomplete epoch is metadata of this same input.
      const coverage=state.coverage.epochs.length===1&&starts.has(state.coverage.epochs[0]!.id)&&state.coverage.state==="incomplete"?"unknown":state.coverage.state;
      const marker = JSON.stringify([state.pendingCount, coverage, state.reasons.filter(reason => reason !== "unresolved"), safetyEvidenceSequence(db, options.turnId, options.sessionId(), [...inputs],[...starts]),
        options.trust?.revision() ?? "0", safety?.scope, safety?.authorityEpoch, safety?.authorityCurrent,
        writes?.recordingAvailable?.(options.turnId, options.sessionId(),excludedPending) ?? safety?.recordingAvailable,callGeneration]);
      approvalMarkers.set(key,{version,marker}); return marker;
    };
  const computeCardRevision = (
    destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean },
    projection: ReturnType<typeof safetyProjection>,
    classes: readonly string[]
  ): string => {
    const origin = canonicalNetworkOrigin(destination);
    const nonPendingReasons = projection.reasons.filter((r) => r !== "recording_pending" && r !== "unresolved").sort();
    return createHash("sha256")
      .update(JSON.stringify([
        origin.key,
        destination.method,
        projection.restriction === "restricted",
        classes,
        projection.coverage.state,
        nonPendingReasons,
      ]))
      .digest("hex")
      .slice(0, 16);
  };
  type NetworkAnswer = boolean | "once" | "origin" | "session" | "legacy" | "recheck" | "superseded" | "expired" | "unconfirmed";
  const approveTainted = async (
    destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean },
    signal: AbortSignal,
    connectionId?: string
  ): Promise<NetworkAnswer> => {
    if (!db || signal.aborted) return false;
    const toolUseId = crypto.randomUUID();
    const origin = canonicalNetworkOrigin(destination);
    const readClasses = () => unresolvedTaintClasses(db, options.turnId, options.sessionId());
    const readSuspended = (classes: readonly string[]) => {
      if (origin.managedReference) return null;
      const sid = options.sessionId();
      if (!sid) return null;
      const generation = sessionHistoryGeneration(db, options.turnId, sid);
      const match = matchNetworkGrant(db, sid, generation, origin.key, classes);
      return match?.kind === "suspended" ? match : null;
    };
    let currentClasses = readClasses();
    let currentProj = currentProjection();
    let currentRev = computeCardRevision(destination, currentProj, currentClasses);
    let suspended = readSuspended(currentClasses);
    const initialSafety = options.bridge.admissionSafety?.read();
    const buildOffer = (classes: readonly string[], susp: ReturnType<typeof readSuspended>): NetworkApprovalOffer => ({
      transport: origin.transport,
      scheme: origin.scheme,
      host: origin.host,
      port: origin.port,
      ...(origin.managedReference ? { managedReference: true } : {}),
      scopes: origin.managedReference ? ["once"] : ["once", "origin", "session"],
      ...(susp ? { suspendedGrant: true } : {}),
      classes: [...classes],
    });
    const buildDescription = (susp: ReturnType<typeof readSuspended>) =>
      taintedDestinationDescription(destination, firstTaint()?.source ?? null, {
        managedReference: origin.managedReference,
        scopes: origin.managedReference ? ["once"] : ["once", "origin", "session"],
        ...(susp ? { suspendedGrant: { newClasses: susp.newClasses } } : {}),
      });
    const checkRecordingAndAuthority = () => {
      const now = options.bridge.admissionSafety?.read();
      if (!now) return null;
      if ((!now.recordingAvailable && !now.recordingPending) || now.operationRecordingAvailable === false) {
        return STALE_SAFETY_ADMISSION;
      }
      if (initialSafety && !sameAuthority(now, initialSafety)) return STALE_SAFETY_ADMISSION;
      if (!now.authorityCurrent) return STALE_SAFETY_ADMISSION;
      return null;
    };
    let settledByRuleOrClear = false;
    const networkCard: NetworkCardController = {
      signal,
      evaluateChange() {
        const refusal = checkRecordingAndAuthority();
        if (refusal) return { action: "withdraw", reason: refusal };
        const now = options.bridge.admissionSafety?.read();
        if (now && !now.restricted && !now.recordingPending) {
          settledByRuleOrClear = true;
          return { action: "settle_allowed", reason: "Taint cleared" };
        }
        if (now && initialSafety && now.trustRevision !== initialSafety.trustRevision) {
          if (taint?.recipient?.(destination)) {
            settledByRuleOrClear = true;
            return { action: "settle_allowed", reason: "Allowed by rule" };
          }
        }
        const nextProj = currentProjection();
        const nextClasses = readClasses();
        const nextRev = computeCardRevision(destination, nextProj, nextClasses);
        if (nextRev === currentRev) return "noop";
        currentProj = nextProj;
        currentClasses = nextClasses;
        currentRev = nextRev;
        suspended = readSuspended(nextClasses);
        return {
          action: "update",
          revision: nextRev,
          description: buildDescription(suspended),
          network: buildOffer(nextClasses, suspended),
        };
      },
      revalidate(expectedRevision?: string) {
        if (signal.aborted) return "The network request stopped waiting.";
        const refusal = checkRecordingAndAuthority();
        if (refusal) return refusal;
        if (expectedRevision !== undefined && expectedRevision !== currentRev) return STALE_SAFETY_ADMISSION;
        const liveClasses = readClasses();
        if (liveClasses.some((cls) => !currentClasses.includes(cls))) return STALE_SAFETY_ADMISSION;
        return null;
      },
      onGrantedByGrant(_scope, grantedClasses) {
        if (connectionId) {
          connectionGrantedClasses.set(connectionId, new Set(grantedClasses ?? currentClasses));
        }
      },
      async commitScope(scope, principalId) {
        if (signal.aborted) {
          return { ok: false, cause: "operation_cancelled", reason: "The network request stopped waiting." };
        }
        const refusal = networkCard.revalidate();
        if (refusal) return { ok: false, cause: "safety_changed", reason: refusal };
        // Approving a network connection explicitly covers `egress_connection` so
        // the approved connection's own exposure (and concurrent settled siblings)
        // never self-suspend the grant just created (#4966, #3595).
        const grantedClasses = [...new Set([...currentClasses, "egress_connection"])].sort();
        if (connectionId) connectionGrantedClasses.set(connectionId, new Set(grantedClasses));
        if (origin.managedReference || scope === "once") {
          return { ok: true, scope: "once" };
        }
        if (scope === undefined) {
          // Legacy reply without scope preserves hostname/session grant and settles same-host siblings (#4966, #3595).
          contacted.add(origin.host);
          options.settleSiblings?.(
            (req) => req.network?.host === origin.host,
            undefined,
            `Allowed · ${origin.host}`,
            toolUseId,
            grantedClasses
          );
          return { ok: true };
        }
        // Origin or session grant: persist as host-owned `network_grant` off the event loop (#3595).
        const sid = options.sessionId();
        if (!sid || !db.query("SELECT 1 FROM sessions WHERE id=?").get(sid)) {
          return { ok: false, cause: "grant_storage_failed", reason: "The network grant requires an active session; nothing ran." };
        }
        const recordGrant = options.governanceWrites?.record ?? options.record;
        if (!recordGrant) {
          return { ok: false, cause: "grant_storage_failed", reason: "Network grant storage is unavailable; nothing ran." };
        }
        const grantId = `ng_${crypto.randomUUID().replace(/-/g, "")}`;
        const historyGeneration = sessionHistoryGeneration(db, options.turnId, sid);
        try {
          const result = await recordGrant({
            ...base(),
            sessionId: sid,
            actor: "user",
            kind: "network_grant",
            dedupeKey: grantId,
            payload: {
              grantId,
              scope,
              ...(scope === "origin" ? {
                origin: origin.key,
                transport: origin.transport,
                scheme: origin.scheme,
                host: origin.host,
                port: origin.port,
              } : {}),
              grantedClasses,
              historyGeneration,
              toolUseId,
              principalId,
            },
          });
          if (result === false || (result && typeof result === "object" && "recorded" in result && (result as { recorded?: unknown }).recorded === false)) {
            return { ok: false, cause: "grant_storage_failed", reason: "The network grant could not be retained; nothing ran." };
          }
        } catch {
          return { ok: false, cause: "grant_storage_failed", reason: "The network grant could not be retained; nothing ran." };
        }
        if (signal.aborted) {
          return { ok: false, cause: "operation_cancelled", reason: "The network request stopped waiting." };
        }
        const postRefusal = networkCard.revalidate();
        if (postRefusal) return { ok: false, cause: "safety_changed", reason: postRefusal };
        const confirmed = listActiveNetworkGrants(db, sid, historyGeneration, grantedClasses)
          .some((g) => g.grantId === grantId && !g.suspended);
        if (!confirmed) {
          return { ok: false, cause: "grant_storage_failed", reason: "The network grant could not be confirmed; nothing ran." };
        }
        if (scope === "origin") {
          options.settleSiblings?.(
            (req) => req.origin === origin.key,
            "origin",
            `Allowed by your grant for ${origin.host}`,
            toolUseId,
            grantedClasses
          );
        } else {
          options.settleSiblings?.(
            () => true,
            "session",
            "Allowed by your session grant",
            toolUseId,
            grantedClasses
          );
        }
        options.onGrantsChanged?.(sid);
        return { ok: true, scope };
      },
    };
    const decision = await requestToolPermission(options.bridge, {
      toolUseId,
      toolName: "Network",
      kind: "command",
      input: { ...destination, target: networkAuthority(destination) },
      description: buildDescription(suspended),
      revision: currentRev,
      origin: origin.key,
      network: buildOffer(currentClasses, suspended),
      networkCard,
    }).catch(() => ({ behavior: "deny" as const, message: "unconfirmed" }));
    if (signal.aborted) return false;
    if (decision.behavior === "allow") {
      if (settledByRuleOrClear) return "recheck";
      if (connectionId && !connectionGrantedClasses.has(connectionId)) {
        connectionGrantedClasses.set(connectionId, new Set([...currentClasses, "egress_connection"]));
      }
      return decision.networkScope ?? "legacy";
    }
    return options.networkRefusal?.(toolUseId) ?? false;
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
    approvalRevision,
    recipient: (destination: OriginDestination) => {
      const snapshot=options.trust?.read();
      const match=originTrustMatchSnapshot(snapshot,destination,"recipientWhileRestricted",options.bridge.admissionSafety?.read().evidenceRevision ?? "0");
      if(!match||!snapshot?.ruleInstances[match.ruleId])return false;
      const {ruleId,policyHash,trustRevision,collectionRevision}=match;
      return {ruleId,policyHash,trustRevision,collectionRevision,instance:snapshot.ruleInstances[ruleId]!};
    },
    tainted: (connectionId?: string) => {
      if (connectionId && normalBefore.has(connectionId)) {
        const projection = currentProjection();
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
    // Class-set grant fence at approval and first byte (#4966).
    grantCurrent: (connectionId: string, destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean }, _scope: "once" | "origin" | "session" | "legacy" | undefined) => {
      const safety = options.bridge.admissionSafety?.read();
      if (safety && ((!safety.recordingAvailable && !safety.recordingPending) || safety.operationRecordingAvailable === false || !safety.authorityCurrent)) {
        return "refuse" as const;
      }
      const granted = connectionGrantedClasses.get(connectionId);
      const current = unresolvedTaintClasses(db, options.turnId, options.sessionId());
      if (granted) {
        for (const cls of current) {
          if (!granted.has(cls)) return "new_class" as const;
        }
      }
      void destination;
      return "ok" as const;
    },
    // Standing origin/session grants for interactive turns only (#3595).
    ...(options.origin === "interactive" ? {
      standingGrant: (destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean }) => {
        if (destination.managedReference) return null;
        const sid = options.sessionId();
        if (!sid) return null;
        const origin = canonicalNetworkOrigin(destination);
        const generation = sessionHistoryGeneration(db, options.turnId, sid);
        const classes = unresolvedTaintClasses(db, options.turnId, sid);
        return matchNetworkGrant(db, sid, generation, origin.key, classes);
      },
      onStandingGrantApplied: (info: { connectionId: string; destination: { host: string; port: number; method: string; protocol: string; managedReference: boolean }; scope: "origin" | "session"; grantId: string }) => {
        options.emitStandingReceipt?.({
          connectionId: info.connectionId,
          host: info.destination.host,
          scope: info.scope,
          reason: info.scope === "origin" ? `Allowed by your grant for ${info.destination.host}` : "Allowed by your session grant",
        });
      },
      approve: approveTainted,
    } : {}),
  } : undefined;
  /**
   * The proxy awaits this before the connection's first byte, so the taint
   * has committed by then. It is in force for every later admission from the
   * moment it is submitted.
   */
  const admitted = async (destination: { host: string; port: number; method: string; inference: boolean; provider: boolean; managedReference: boolean; connectionId: string; protocol?:string }): Promise<void> => {
    let provenance:ReturnType<typeof validatedEgressProvenance>;
    try { provenance=validatedEgressProvenance(destination); } catch { throw new EgressAdmissionRefused("Invalid egress destination"); }
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
    const trustSnapshot = options.trust?.read();
    const candidate = originTrustMatchSnapshot(trustSnapshot, destination, "incomingContent", options.bridge.admissionSafety?.read().evidenceRevision ?? "0");
    const instance = candidate ? trustSnapshot?.ruleInstances[candidate.ruleId] : undefined;
    const match = typeof instance === "string" ? candidate : null;
    exposure.admission = match ? { trusted: true, ruleId: match.ruleId, policyHash: match.policyHash, trustRevision: match.trustRevision, collectionRevision: match.collectionRevision }
      : { trusted: false, policyHash: trustSnapshot ? trustSnapshot.policyHash : options.policyHash ?? null, trustRevision: trustSnapshot?.revision ?? "0" };
    exposure.provenance=provenance;
    exposures.set(destination.connectionId, exposure);
    const hadCollection=db?.query("SELECT id FROM safety_collections WHERE turn_id=?").get(options.turnId);
    try {
      const initial = writes.firstTaint({ ...base(), kind: "taint", payload: { source: "egress_connection", tool: null,
        detail: `${destination.method} ${destination.host}:${destination.port}`, occurrence: exposure } });
      exposureCommits.set(destination.connectionId, initial);
      if(await initial !== true)throw new EgressAdmissionRefused("Input occurrence was not durably recorded","egress_unavailable");
    } catch {
      // No occurrence means no trusted fact and no terminal exposure to append.
      exposures.delete(destination.connectionId);
      throw new EgressAdmissionRefused("Input occurrence recording unavailable","egress_unavailable");
    }
    finally { exposureCommits.delete(destination.connectionId); }
    if(db&&!hadCollection){
      const created=db.query("SELECT c.id FROM safety_collections c WHERE c.turn_id=? AND (SELECT r.id FROM safety_records r WHERE r.collection_id=c.id AND r.kind='occurrence' ORDER BY length(r.sequence),r.sequence LIMIT 1)=?").get(options.turnId,exposure.id) as {id:string}|null;
      if(created) ownCollectionStarts.set(destination.connectionId,created.id);
    }
    if(match)trustedInputs.set(destination.connectionId,{destination,revision:match.trustRevision,ruleId:match.ruleId,instance:instance!});
    if (match && !inputCurrent(destination.connectionId)) throw new EgressAdmissionRefused("Source trust changed before dispatch","source_trust_changed");
  };
  /** Settles once every record submitted so far has committed or failed; `recordingFailure()` is final after it. */
  const settleRecords = async () => { while (recording.size) await Promise.all([...recording]); };
  const settled = async () => { await proxy.settled(); await settleRecords(); };
  const proxy = await startEgressProxy({ pendingReservations, mode: options.policy.egress.mode, allow: options.policy.egress.allow,
    ...(options.bridge.admissionSafety ? { admissionSafety: options.bridge.admissionSafety } : {}),
    deny: options.policy.egress.deny, maxBytes: options.policy.egress.max_bytes_per_turn ?? Number.MAX_SAFE_INTEGER,
    outwardHosts: [...new Set([...GITHUB_API_HOSTS, ...MAIL_SUBMISSION_HOSTS, ...options.policy.outward.hosts])],
    outwardPorts: MAIL_SUBMISSION_PORTS,
    signal: options.controller.signal, observe: report, admitted,
    inputCurrent,
    committed:destination=>{
      if(destination.inference||destination.provider)return;
      if(destination.recipientAuthority.kind === "rule")standingRecipients.set(destination.connectionId,destination.recipientAuthority.admission);
      // Explicit once/origin/session grants never add to legacy `contacted` (#3595):
      // once is single-connection; origin/session live in host-owned `network_grant` records.
      const explicitScoped = destination.approvalScope === "once" || destination.approvalScope === "origin" || destination.approvalScope === "session";
      if (!destination.managedReference && !explicitScoped && (destination.recipientApproved || !trustedInputs.has(destination.connectionId) && !standingRecipients.has(destination.connectionId))) contacted.add(destination.host);
    }, ...(taint ? { taint } : {}),
    approveOutward: async (destination, signal) => {
      if (calls.covers(destination.host)) return !signal.aborted;
      const decision = await requestToolPermission(options.bridge, { toolUseId: crypto.randomUUID(), toolName: "Network",
        kind: "command", input: destination,
        description: `${destination.method} to ${networkAuthority(destination)}`,
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
      // Active siblings own their admission effects. The operation's bounded
      // evidence wait handles those after binding, without joining their requests.
      if (operation.signal.aborted) return false;
      let abort: (() => void) | undefined;
      try {
        const refusal = await Promise.race([settleRecords().then(() => settleTurnSessionBinding(original, operation.signal)).catch(() => "session_binding_unavailable" as const), new Promise<SessionBindingRefusal>(resolve => {
          abort = () => resolve("turn_cancelled");
          operation.signal.addEventListener("abort", abort, { once: true });
          if (operation.signal.aborted) resolve("turn_cancelled");
        })]);
        if (refusal !== null) { operation.mark("admitMs"); operation.finish(refusal === "turn_cancelled" ? "cancelled" : "denied", refusal); return false; }
        return !operation.signal.aborted && await operation.admit();
      } finally { if (abort) operation.signal.removeEventListener("abort", abort); }
    } };
  };
  return { ...proxy, stop() { releaseTrust?.(); proxy.stop(); }, bridge, recordingFailure: () => recordingFailure, settled,
    inference: (method: string, target: URL, signal: AbortSignal) => relayOperation("inference", method, target, signal),
    relayed: (method: string, target: URL, signal: AbortSignal) => relayOperation("relayed", method, target, signal),
    managedReference: (target: URL, signal: AbortSignal) => settleOperation(proxy.managedReference(target, signal)) };
}
