/**
 * The durable job store: `jobs/<id>/job.json` and its output and artifact
 * files under the compute state directory. Records are written atomically
 * (a failed publish keeps the previous record) and are the authority for
 * reconciliation. Directories are 0700 and files 0600.
 *
 * Layout:
 *   brain.json                 which brain this directory serves
 *   admission.lock             serialises admission across processes
 *   jobs/<id>/job.json         the record
 *   jobs/<id>/owner.lock       held while a process advances the job
 *   jobs/<id>/cancel           a cancel request from a process without the owner lock
 *   jobs/<id>/output/{stdout,stderr}
 *   jobs/<id>/artifacts/<sha256>
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileSafely } from "../safe-path.js";
import type { ComputeJobRecord, ComputeReceipt } from "./types.js";

/** Opaque job ids: `cj_` and 26 base32 characters. Anything else is unknown. */
export const COMPUTE_JOB_ID = /^cj_[a-z2-7]{26}$/;
const MAX_RECEIPTS = 500;

export function newComputeJobId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(26);
  let id = "cj_";
  for (const byte of bytes) id += alphabet[byte & 31];
  return id;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export class ComputeJobStore {
  readonly jobsDir: string;

  constructor(
    readonly stateDir: string,
    private readonly hooks: { beforePublish?: (path: string) => void } = {}
  ) {
    this.jobsDir = join(stateDir, "jobs");
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
  }

  /** Record which brain uses this directory, once; diagnostic only. */
  describeBrain(brain: string, root: string): void {
    const path = join(this.stateDir, "brain.json");
    if (existsSync(path)) return;
    try {
      writeFileSafely(path, `${JSON.stringify({ schema: 1, brain, root }, null, 2)}\n`, { replace: false, mode: 0o600 });
    } catch { /* another process wrote it first */ }
  }

  get admissionLockPath(): string {
    return join(this.stateDir, "admission.lock");
  }

  jobDir(id: string): string {
    if (!COMPUTE_JOB_ID.test(id)) throw new Error(`not a compute job id: ${id}`);
    return join(this.jobsDir, id);
  }

  ownerLockPath(id: string): string {
    return join(this.jobDir(id), "owner.lock");
  }

  cancelMarkerPath(id: string): string {
    return join(this.jobDir(id), "cancel");
  }

  /** Create the job's directory (0700) before its record, so its owner lock can be held first. */
  prepare(id: string): void {
    const dir = this.jobDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const sub of ["output", "artifacts"]) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  }

  create(job: ComputeJobRecord): void {
    this.prepare(job.id);
    this.publish(join(this.jobDir(job.id), "job.json"), job, false);
  }

  write(job: ComputeJobRecord): void {
    this.publish(join(this.jobDir(job.id), "job.json"), job, true);
  }

  private publish(path: string, job: ComputeJobRecord, replace: boolean): void {
    if (job.receipts.length > MAX_RECEIPTS) job.receipts.splice(0, job.receipts.length - MAX_RECEIPTS);
    const beforePublish = this.hooks.beforePublish;
    writeFileSafely(path, `${JSON.stringify(job, null, 2)}\n`, {
      replace,
      mode: 0o600,
      beforePublish: beforePublish ? () => beforePublish(path) : undefined,
    });
  }

  read(id: string): ComputeJobRecord | undefined {
    if (!COMPUTE_JOB_ID.test(id)) return undefined;
    const path = join(this.jobsDir, id, "job.json");
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    const job = JSON.parse(text) as ComputeJobRecord;
    if (job?.schema !== 1 || job.id !== id) throw new Error(`compute job record ${path} is not schema 1 for ${id}`);
    return job;
  }

  list(): ComputeJobRecord[] {
    const jobs: ComputeJobRecord[] = [];
    for (const name of readdirSync(this.jobsDir)) {
      if (!COMPUTE_JOB_ID.test(name)) continue;
      const job = this.read(name);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /** Store bytes under the job by content hash; returns the hash. */
  putArtifact(id: string, data: Uint8Array): string {
    const hash = sha256Hex(data);
    const path = join(this.jobDir(id), "artifacts", hash);
    if (!existsSync(path)) writeFileSafely(path, data, { mode: 0o600 });
    return hash;
  }

  artifactPath(id: string, sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not an artifact hash");
    return join(this.jobDir(id), "artifacts", sha256);
  }

  putOutput(id: string, stream: "stdout" | "stderr", data: Uint8Array): void {
    writeFileSafely(join(this.jobDir(id), "output", stream), data, { mode: 0o600 });
  }

  readOutput(id: string, stream: "stdout" | "stderr"): Uint8Array | undefined {
    try {
      return readFileSync(join(this.jobDir(id), "output", stream));
    } catch {
      return undefined;
    }
  }
}

export function receipt(job: ComputeJobRecord, at: number, entry: Omit<ComputeReceipt, "at">): void {
  job.receipts.push({ at, ...entry });
}
