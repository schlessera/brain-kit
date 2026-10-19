/** Cooperative integration ownership: remote Git CAS, never a branch lock. */
import { randomBytes } from "node:crypto";

export const RESERVATION_REF = "refs/heads/brain-integration-reservation";
export const LEASE_MS = 5 * 60_000, RENEW_MS = 60_000, MAX_MS = 60 * 60_000;
export interface Candidate { repository: string; pr: number; head: string; base: string; }
export interface Lease { id: string; actor: number; candidate: Candidate; acquired: number; expires: number; cap: number; }
export interface ReservationState {
  version: 1; updated: number; active: Lease | null;
  last: { action: "acquire" | "renew" | "release" | "revoke"; actor: number; at: number; previous: Lease | null; reason?: string } | null;
}
export interface Snapshot { oid: string | null; state: ReservationState; }
export type Operation = { kind: "acquire"; candidate: Candidate; id?: string } |
  { kind: "renew"; id: string } | { kind: "release"; id: string } | { kind: "revoke"; reason: string; maintainer: boolean };
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const emptyReservation = (): ReservationState => ({ version: 1, updated: 0, active: null, last: null });
export const sameCandidate = (a: Candidate, b: Candidate): boolean => a.repository === b.repository && a.pr === b.pr && a.head === b.head && a.base === b.base;
export const liveLease = (lease: Lease | null, now: number): lease is Lease => !!lease && now < lease.expires && now < lease.cap;

export function reservationServerTime(response: string): number {
  const headers = response.split(/\r?\n\r?\n/, 1)[0]!;
  const dates = [...headers.matchAll(/^date:\s*(.+)$/gim)];
  const age = /^age:\s*(\d+)/im.exec(headers);
  const now = dates.length === 1 ? Date.parse(dates[0]![1]!.trim()) : NaN;
  if (!/^HTTP\/\S+\s+200\b/.test(headers) || !Number.isFinite(now) || (age && Number(age[1]) > 0)) throw new Error("Fresh authoritative GitHub server clock unavailable");
  return now;
}

export function parseReservation(text: string): ReservationState {
  if (text.length > 16000) throw new Error("Unbounded shared reservation state");
  const state = JSON.parse(text) as ReservationState;
  if (state?.version !== 1 || !Number.isSafeInteger(state.updated) || state.updated < 0 || !Object.hasOwn(state, "active") || !Object.hasOwn(state, "last")) throw new Error("Invalid shared reservation state");
  const validActor = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  const validLease = (lease: Lease | null): boolean => lease === null || !!lease && typeof lease === "object" &&
    /^[a-f0-9]{32}$/.test(lease.id) && validActor(lease.actor) &&
    Number.isSafeInteger(lease.candidate?.pr) && lease.candidate.pr > 0 && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lease.candidate.repository) &&
    hash(lease.candidate.head) && hash(lease.candidate.base) &&
    [lease.acquired, lease.expires, lease.cap].every(value => Number.isSafeInteger(value) && value >= 0) && lease.acquired <= state.updated && lease.cap === lease.acquired + MAX_MS &&
    lease.expires <= Math.min(state.updated + LEASE_MS, lease.cap) && lease.expires > lease.acquired;
  if (!validLease(state.active)) throw new Error("Invalid shared reservation lease");
  const last = state.last;
  if (last !== null && (!last || typeof last !== "object" || !["acquire", "renew", "release", "revoke"].includes(last.action) ||
      !validActor(last.actor) || last.at !== state.updated || !validLease(last.previous) ||
      (last.action === "revoke" && (typeof last.reason !== "string" || !last.reason.trim() || last.reason.length > 1000 || !last.previous || state.active !== null)))) throw new Error("Invalid shared reservation audit");
  if (last === null && (state.active !== null || state.updated !== 0)) throw new Error("Missing shared reservation audit");
  return state;
}

export function assertLease(state: ReservationState, id: string, actor: number, candidate: Candidate, now: number): Lease {
  const lease = state.active;
  if (!liveLease(lease, now) || lease.id !== id || lease.actor !== actor || !sameCandidate(lease.candidate, candidate)) throw new Error("Missing, expired, superseded, wrong-owner or mismatched candidate reservation");
  return lease;
}

export function reservationTransition(state: ReservationState, operation: Operation, actor: number, now: number): ReservationState {
  if (!Number.isSafeInteger(actor) || actor <= 0 || !Number.isSafeInteger(now) || now < state.updated) throw new Error("Invalid actor or backwards/unavailable authoritative clock");
  const previous = state.active;
  let active = previous;
  if (operation.kind === "acquire") {
    if (liveLease(previous, now)) throw new Error(`Integration busy: ${JSON.stringify(previous)}`);
    active = { id: operation.id ?? randomBytes(16).toString("hex"), actor, candidate: operation.candidate, acquired: now, expires: now + LEASE_MS, cap: now + MAX_MS };
  } else if (operation.kind === "renew") {
    if (!previous) throw new Error("No reservation to renew");
    assertLease(state, operation.id, actor, previous.candidate, now);
    active = { ...previous, expires: Math.min(now + LEASE_MS, previous.cap) };
  } else if (operation.kind === "release") {
    // An expired owner may clean up its own lease, never a successor's.
    if (!previous || previous.id !== operation.id || previous.actor !== actor) throw new Error("Reservation release does not own the current lease");
    active = null;
  } else {
    if (!operation.maintainer || !operation.reason.trim() || operation.reason.length > 1000) throw new Error("Maintainer revocation requires an explicit bounded reason");
    if (!previous) throw new Error("No reservation to revoke");
    active = null;
  }
  return parseReservation(JSON.stringify({ version: 1, updated: now, active,
    last: { action: operation.kind, actor, at: now, previous, ...(operation.kind === "revoke" ? { reason: operation.reason } : {}) } }));
}

/** Every published commit has the inspected remote commit as its parent. */
export class GitReservationStore {
  constructor(readonly root: string, readonly remote = "origin", readonly ref = RESERVATION_REF) {}
  git(args: string[], input?: string): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: this.root, stdout: "pipe", stderr: "pipe",
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), env: { ...process.env,
        GIT_AUTHOR_NAME: "brain-kit coordination", GIT_AUTHOR_EMAIL: "coordination@example.invalid",
        GIT_COMMITTER_NAME: "brain-kit coordination", GIT_COMMITTER_EMAIL: "coordination@example.invalid" } });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  remoteOid(): string | null {
    const output = this.git(["ls-remote", "--refs", this.remote, this.ref]);
    if (!output) return null;
    const [oid, ref, ...extra] = output.split(/\s+/);
    if (!hash(oid) || ref !== this.ref || extra.length) throw new Error("Invalid remote reservation ref");
    return oid;
  }
  read(): Snapshot {
    const oid = this.remoteOid();
    if (!oid) return { oid, state: emptyReservation() };
    this.git(["fetch", "--no-tags", this.remote, oid]);
    const tree = this.git(["ls-tree", oid]);
    if (!/^100644 blob [a-f0-9]{40}\treservation\.json$/.test(tree)) throw new Error("Unknown shared coordination tree");
    return { oid, state: parseReservation(this.git(["show", `${oid}:reservation.json`])) };
  }
  publish(snapshot: Snapshot, state: ReservationState): boolean {
    const content = JSON.stringify(parseReservation(JSON.stringify(state))) + "\n";
    const blob = this.git(["hash-object", "-w", "--stdin"], content);
    const tree = this.git(["mktree"], `100644 blob ${blob}\treservation.json\n`);
    const oid = this.git(["commit-tree", tree, ...(snapshot.oid ? ["-p", snapshot.oid] : []), "-m", `integration: ${state.last?.action ?? "state"}`]);
    try {
      this.git(["push", "--porcelain", `--force-with-lease=${this.ref}:${snapshot.oid ?? ""}`, this.remote, `${oid}:${this.ref}`]);
      return true;
    } catch (error) {
      if (this.remoteOid() !== snapshot.oid) return false;
      throw error;
    }
  }
}
