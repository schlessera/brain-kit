/** Read-only reservation history. Authorized lease time is not worker busy time. */
import { parseReservation } from "./integration-reservation";
export interface LeaseObservation {
  id: string; pr: number; head: string; base: string; acquired: number; expires: number; cap: number;
  endedAt: number | null; ending: "release" | "revoke" | "expiry-inferred"; sources: string[];
}
export interface ReservationArchive {
  version: 1; repository: string; collectedAt: string; sourceRef: string; sourceHead: string | null;
  leases: LeaseObservation[]; error?: string;
}

/** Renewals and later releases enrich one lease rather than adding occupancy. */
export function mergeLeaseObservations(rows: LeaseObservation[]): LeaseObservation[] {
  const result = new Map<string, LeaseObservation>();
  for (const row of rows) {
    if (!row || !/^[a-f0-9]{32}$/.test(row.id) || !Number.isSafeInteger(row.pr) || row.pr < 1 ||
      ![row.head, row.base].every(s => /^[a-f0-9]{40}$/.test(s)) ||
      ![row.acquired, row.expires, row.cap].every(Number.isFinite) || row.acquired > row.expires || row.expires > row.cap ||
      !Array.isArray(row.sources) || !row.sources.length || row.sources.some(s => !/^[a-f0-9]{40}$/.test(s)) ||
      !["release", "revoke", "expiry-inferred"].includes(row.ending) ||
      (row.ending === "expiry-inferred" ? row.endedAt !== null : !Number.isFinite(row.endedAt) || row.endedAt! < row.acquired)) throw new Error("Invalid archived lease");
    const old = result.get(row.id);
    if (old && ((["pr", "head", "base", "acquired", "cap"] as const).some(k => old[k] !== row[k]) ||
      old.endedAt !== null && row.endedAt !== null && (old.endedAt !== row.endedAt || old.ending !== row.ending))) throw new Error("Conflicting lease history");
    const merged = structuredClone(old ?? row);
    merged.expires = Math.max(merged.expires, row.expires);
    if (row.endedAt !== null) { merged.endedAt = row.endedAt; merged.ending = row.ending; }
    merged.sources = [...new Set([...(old?.sources ?? []), ...row.sources])].sort();
    result.set(row.id, merged);
  }
  return [...result.values()].sort((a, b) => a.acquired - b.acquired || a.id.localeCompare(b.id));
}
export function reservationObservations(repository: string, rows: { source: string; state: any }[]): LeaseObservation[] {
  const result = new Map<string, LeaseObservation>();
  for (const { source, state: raw } of rows) {
    const state = parseReservation(JSON.stringify(raw));
    if (!/^[a-f0-9]{40}$/.test(source) || !Number.isFinite(state.updated)) throw new Error("Invalid reservation source");
    for (const lease of [state.active, state.last?.previous]) {
      if (!lease) continue;
      if (lease.candidate?.repository !== `https://github.com/${repository}` || !Number.isSafeInteger(lease.candidate.pr) ||
        !/^[a-f0-9]{32}$/.test(lease.id) || ![lease.candidate.head, lease.candidate.base].every(x => /^[a-f0-9]{40}$/.test(x)) ||
        ![lease.acquired, lease.expires, lease.cap].every(x => Number.isFinite(x)) || lease.expires > lease.cap || lease.acquired > lease.expires) throw new Error("Invalid reservation lease");
      const old = result.get(lease.id);
      if (old && (old.pr !== lease.candidate.pr || old.head !== lease.candidate.head || old.base !== lease.candidate.base || old.acquired !== lease.acquired || old.cap !== lease.cap)) throw new Error("Conflicting lease history");
      const record: LeaseObservation = old ?? { id: lease.id, pr: lease.candidate.pr, head: lease.candidate.head, base: lease.candidate.base,
        acquired: lease.acquired, expires: lease.expires, cap: lease.cap, endedAt: null, ending: "expiry-inferred", sources: [] };
      record.expires = Math.max(record.expires, lease.expires); record.sources.push(source);
      if (state.last && ["release", "revoke"].includes(state.last.action) && state.last.previous?.id === lease.id) {
        record.endedAt = state.last!.at; record.ending = state.last!.action as "release" | "revoke";
      }
      result.set(lease.id, record);
    }
  }
  return [...result.values()];
}

export function collectReservationHistory(repository: string, since: string): ReservationArchive {
  const run = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
    if (p.exitCode !== 0) throw new Error(`Reservation history unavailable: ${new TextDecoder().decode(p.stderr)}`);
    return new TextDecoder().decode(p.stdout).trim();
  };
  const ref = "refs/heads/brain-integration-reservation";
  const remote = run(["ls-remote", "--refs", "origin", ref]).split(/\s+/)[0];
  if (!remote || !/^[a-f0-9]{40}$/.test(remote)) throw new Error("Reservation ref unavailable");
  run(["fetch", "--no-tags", "origin", remote]);
  const commits = run(["rev-list", "--first-parent", remote]).split("\n"), rows: { source: string; state: any }[] = [];
  for (const source of commits) {
    const state = parseReservation(run(["show", `${source}:reservation.json`]));
    rows.push({ source, state });
    // The protocol caps leases at one hour. Keep the preceding source record.
    // Server timestamps drive this bound; commit author clocks do not.
    if (Number.isFinite(state.updated) && state.updated < Date.parse(since) - 3600000) break;
  }
  return { version: 1, repository, collectedAt: new Date().toISOString(), sourceRef: ref, sourceHead: remote,
    leases: reservationObservations(repository, rows) };
}
