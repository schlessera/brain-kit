import { randomUUID } from "node:crypto";
import type { CapacityEvidence, WindowEvidence } from "./history-evidence.js";
import { RECENT } from "./history-model.js";
export type Severity = "observed" | "low" | "critical";
export interface Refusal {
  target: string;
  resource: "bytes" | "quota" | "inodes" | "unknown";
  at: number;
  successAt: number | null;
}
export interface Pressure {
  identity: string; rootScope: string;
  severity: Severity; capacity: boolean; forecast: boolean; refusals: Refusal[];
  at: number; recoveryAt: number | null;
  episode: string | null; resolvedEpisode: string | null;
  supportAt: number | null; scopeChanged: boolean;
}
export const newPressure = (identity: string, rootScope: string): Pressure => ({ identity, rootScope, severity: "observed", capacity: false, forecast: false, refusals: [], at: 0, recoveryAt: null, episode: null, resolvedEpisode: null, supportAt: null, scopeChanged: false });
const rank = (severity: Severity) => severity === "critical" ? 2 : severity === "low" ? 1 : 0;
const within = (evidence: WindowEvidence, days: number) => evidence.state === "finite" && evidence.days !== null && evidence.days <= days;
const beyond = (evidence: WindowEvidence, days: number) => evidence.state === "non-depleting" || evidence.state === "finite" && evidence.days !== null && evidence.days > days;
function percentage(evidence: CapacityEvidence, threshold: number) {
  return evidence.total !== null && Number.isSafeInteger(evidence.total) && evidence.total > 0 && evidence.available !== null && Number.isSafeInteger(evidence.available) && evidence.available >= 0
    ? BigInt(evidence.available) * 100n <= BigInt(evidence.total) * BigInt(threshold) : null;
}

/** Independent causes survive missing evidence. Only a complete recovery pair can downgrade. */
export function observePressure(previous: Pressure, evidence: CapacityEvidence | null, now: number): Pressure {
  const next = structuredClone(previous);
  if (!evidence || !evidence.fresh || evidence.at > now || now - evidence.at > RECENT || evidence.at < previous.at) {
    next.recoveryAt = null; next.supportAt = null; next.at = Math.max(next.at, now); return next;
  }
  if (evidence.identity !== previous.identity || evidence.rootScope !== previous.rootScope) {
    next.recoveryAt = null; next.supportAt = null; next.scopeChanged = true; return next;
  }
  next.scopeChanged = false;
  const criticalCapacity = percentage(evidence, 5) === true, lowCapacity = percentage(evidence, 10) === true;
  const criticalForecast = within(evidence.short, 7) && within(evidence.long, 7), lowForecast = within(evidence.short, 30) || within(evidence.long, 30);
  next.capacity ||= lowCapacity; next.forecast ||= lowForecast;
  const incoming: Severity = next.refusals.length || criticalCapacity || criticalForecast ? "critical" : lowCapacity || lowForecast ? "low" : "observed";
  const capacityRecovery = percentage(evidence, previous.severity === "critical" ? 7 : 12) === false;
  const forecastRecovery = previous.severity === "critical"
    ? beyond(evidence.short, 10) || beyond(evidence.long, 10)
    : beyond(evidence.short, 45) && beyond(evidence.long, 45);
  const refusalRecovery = next.refusals.every(refusal => refusal.resource === "bytes" && refusal.successAt !== null && refusal.successAt > refusal.at && percentage(evidence, 7) === false);
  // A known matching recovery of quota/inode limits still lacks their capacity
  // observation in this version. Keep those refusals explicit and unresolved.
  const supportedCapacity = next.capacity && percentage(evidence, 7) === true;
  const supportedForecast = next.forecast && evidence.short.state !== "unavailable" && evidence.long.state !== "unavailable" && !forecastRecovery;
  const supportedRefusal = next.refusals.some(refusal => refusal.at <= now && now - refusal.at <= RECENT) && !refusalRecovery;
  next.supportAt = supportedCapacity || supportedForecast || supportedRefusal ? evidence.at : null;
  if (rank(incoming) > rank(previous.severity)) {
    next.severity = incoming; next.recoveryAt = null;
    if (incoming === "critical") { next.episode = randomUUID(); next.supportAt = evidence.at; }
  } else if (previous.severity !== "observed") {
    const allRecover = (!next.capacity || capacityRecovery) && (!next.forecast || forecastRecovery) && refusalRecovery;
    if (!allRecover) next.recoveryAt = null;
    else if (evidence.at > previous.at) {
      if (next.recoveryAt === null) next.recoveryAt = evidence.at;
      else if (evidence.at - next.recoveryAt >= 60_000) {
        next.recoveryAt = null; next.supportAt = null;
        if (previous.severity === "critical") {
          next.severity = "low"; next.resolvedEpisode = next.episode; next.episode = null;
          if (next.refusals.length) next.capacity = true;
          next.refusals = [];
        } else {
          next.severity = "observed"; next.capacity = false; next.forecast = false; next.refusals = [];
        }
      }
    }
  }
  next.at = Math.max(previous.at, evidence.at);
  return next;
}

/** Only an owning operation reports effects; this function never probes a write. */
export function ownerWrite(previous: Pressure, report: { target: string; resource: Refusal["resource"]; at: number; outcome: "no-space" | "success" }, now: number): Pressure {
  const next = structuredClone(previous);
  if (report.at > now || report.at < next.at || !/^[a-f0-9]{32}$/.test(report.target)) { next.recoveryAt = null; return next; }
  if (report.outcome === "no-space") {
    if (next.severity !== "critical") next.episode = randomUUID();
    next.severity = "critical"; next.recoveryAt = null; next.supportAt = report.at;
    const refusal = next.refusals.find(value => value.target === report.target && value.resource === report.resource);
    if (refusal) { refusal.at = report.at; refusal.successAt = null; }
    else next.refusals.push({ target: report.target, resource: report.resource, at: report.at, successAt: null });
  } else {
    const refusal = next.refusals.find(value => value.target === report.target && value.resource === report.resource);
    if (refusal && report.at > refusal.at) { refusal.successAt = report.at; next.recoveryAt = null; }
  }
  next.at = Math.max(next.at, report.at);
  return next;
}
