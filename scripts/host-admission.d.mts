export const MARKER: "BRAIN_HOST_ADMISSION";
export const PREEMPTED_EXIT: 75;
export const RED_MAIN_FIX: "red-main-fix";
export const DEFAULT_GRACE_MS: number;
export function testLedgerFor(pid: number, start: string): string;
export function ledgerDir(env?: Record<string, string | undefined>): string;
export function admissionLimit(env?: Record<string, string | undefined>, cpus?: number): number;
export interface AdmissionEntry {
  id: string;
  state: "queued" | "holding";
  pid: number;
  start: string;
  worker: string;
  orchestrator: string | null;
  priority: "red-main-fix" | "ordinary";
  fixPR: number | null;
  label: string;
  seq: number;
  queuedAt: string;
  admittedAt?: string;
  child?: { pid: number; start: string };
  preempt?: { reason: string; by: string; at: string; graceMs: number };
}
export interface AdmissionState { version: 1; seq: number; entries: AdmissionEntry[] }
export function admissionOrder(entries: readonly AdmissionEntry[]): AdmissionEntry[];
export function readHistory(dir: string): Record<string, unknown>[];
export function withLedger<T>(dir: string, transaction: (state: AdmissionState) => T): Promise<T>;
export interface AdmissionOptions {
  env?: Record<string, string | undefined>;
  dir?: string;
  limit?: number;
  worker?: string;
  orchestrator?: string;
  redMainFix?: string | number;
  label?: string;
  pollMs?: number;
  root?: string;
  timingsOut?: string;
}
export function runAdmitted(command: readonly string[], options?: AdmissionOptions): Promise<number>;
export function preempt(slot: string, options?: { env?: Record<string, string | undefined>; dir?: string; orchestrator?: string; reason?: string; graceMs?: number }):
  Promise<{ slot: string; reason: string; preempted: true; forced: boolean }>;
export class RefusedError extends Error {}
export function status(options?: { env?: Record<string, string | undefined>; dir?: string }):
  Promise<{ ledger: string; limit: number; holders: AdmissionEntry[]; queue: AdmissionEntry[] }>;
export function inheritedAdmission(env?: Record<string, string | undefined>): boolean;
export function ensureHostAdmission(label: string): Promise<number | undefined>;
