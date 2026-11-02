/**
 * Admission checks that run before any effect: caller identity, capabilities,
 * the lease, the source manifest, the sandbox environment and artifacts.
 * Pure apart from reading the declared source files; the slot count, budget
 * reservation and record creation happen under the admission lock in
 * service.ts.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { providerAllows } from "@schlessera/brain-common/internal/governance-policy";

import type { ResolvedComputeInstance } from "../registry.js";
import type { ComputeRefusalCode, SourceBundle } from "../seams.js";
import { sha256Hex } from "./store.js";
import type { ComputeCaller, ComputeRefusal, ComputeRunRequest, ComputeServiceOptions } from "./types.js";

export function refuse(code: ComputeRefusalCode, reason: string): ComputeRefusal {
  return { ok: false, code, reason };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 512;

/** A caller the host supplied, in one of the three shapes. */
export function checkCaller(caller: ComputeCaller | undefined): ComputeRefusal | undefined {
  if (!caller || typeof caller !== "object") return refuse("policy_denied", "a compute job needs a caller identity from the host");
  if (caller.kind === "cli" || caller.kind === "mcp") {
    return nonEmpty(caller.principal) ? undefined : refuse("policy_denied", `a ${caller.kind} caller needs a principal`);
  }
  if (caller.kind === "hosted") {
    return nonEmpty(caller.principal) && nonEmpty(caller.session) && nonEmpty(caller.turn)
      ? undefined
      : refuse("policy_denied", "a hosted caller needs its principal, session and turn from the host");
  }
  return refuse("policy_denied", "unknown caller kind");
}

/** The same caller: kind and principal, and for hosted callers the session. */
export function sameCaller(a: ComputeCaller, b: ComputeCaller): boolean {
  if (a.kind !== b.kind || a.principal !== b.principal) return false;
  return a.kind !== "hosted" || (b.kind === "hosted" && a.session === b.session);
}

/** A normalised repository-relative path, or undefined when it is not one. */
export function relativePath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return undefined;
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return posix.normalize(path);
}

export interface Lease {
  seconds: number;
}

/** The finite lease the job will hold, within every ceiling. */
export function checkLease(instance: ResolvedComputeInstance, requested: number | undefined): Lease | ComputeRefusal {
  const configured = instance.config.lease?.maxSeconds;
  if (typeof configured !== "number" || !Number.isInteger(configured) || configured <= 0) {
    return refuse("lease_required", `compute instance "${instance.id}" has no finite lease.maxSeconds`);
  }
  const seconds = requested ?? configured;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
    return refuse("lease_required", "a compute job needs a finite lease: a positive whole number of seconds");
  }
  if (seconds > instance.provider.capabilities.maxLeaseSeconds) {
    return refuse("capability_unsupported", `"${instance.id}" cannot hold a lease longer than ${instance.provider.capabilities.maxLeaseSeconds} s`);
  }
  if (seconds > configured) return refuse("policy_denied", `"${instance.id}" allows leases up to ${configured} s`);
  return { seconds };
}

/** Capabilities the request needs, checked before the source is even read. */
export function checkCapabilities(
  instance: ResolvedComputeInstance,
  request: ComputeRunRequest
): ComputeRefusal | undefined {
  const { capabilities: caps } = instance.provider;
  const p = instance.provider;
  const unsupported = (what: string) => refuse("capability_unsupported", `"${instance.id}" (${p.id}) cannot ${what}`);
  if (caps.commands !== true) return unsupported("run commands");
  if ((request.source?.length ?? 0) > 0 && (caps.stage === false || typeof p.stage !== "function")) return unsupported("stage source");
  if ((request.artifacts?.length ?? 0) > 0) {
    if (caps.collect === false || typeof p.collect !== "function") return unsupported("collect artifacts");
    const limit = caps.collect.maxBytes;
    const over = request.artifacts!.find((a) => typeof a?.maxBytes === "number" && a.maxBytes > limit);
    if (over) return unsupported(`collect more than ${limit} bytes for ${over.path}`);
  }
  if (instance.config.retainOnRelease === true && caps.retain === false) return unsupported("retain data on release");
  if (caps.findByKey && typeof p.find !== "function") return unsupported("find a lost allocation (find is missing)");
  return undefined;
}

export interface ResolvedSource {
  files: { path: string; sha256: string; bytes: number }[];
  hash: string;
}

/** The manifest hash: the sorted paths and their content hashes. */
export function manifestHash(files: { path: string; sha256: string }[]): string {
  return sha256Hex(JSON.stringify(files.map((f) => [f.path, f.sha256])));
}

/**
 * Resolve the declared source: repository-relative regular files inside the
 * brain, reached without a symlink, hashed. Nothing undeclared is included
 * and the root is never implicit; an empty manifest is valid. With a
 * data-to-provider policy, each file is checked with the instance id as
 * recipient.
 */
export function resolveSource(
  root: string,
  paths: unknown,
  instanceId: string,
  policy: ComputeServiceOptions["sourcePolicy"],
  maxBytes: number | undefined
): ResolvedSource | ComputeRefusal {
  if (paths === undefined) return { files: [], hash: manifestHash([]) };
  if (!Array.isArray(paths)) return refuse("source_refused", "source must be a list of repository-relative paths");
  const realRoot = realpathSync(root);
  const seen = new Set<string>();
  const files: ResolvedSource["files"] = [];
  let total = 0;
  for (const raw of paths) {
    const path = relativePath(raw);
    if (!path) return refuse("source_refused", `not a repository-relative path: ${String(raw)}`);
    if (path === ".git" || path.startsWith(".git/")) return refuse("source_refused", `${path} is repository metadata, not source`);
    if (seen.has(path)) return refuse("source_refused", `${path} is declared twice`);
    seen.add(path);
    const abs = join(realRoot, path);
    let entry;
    try {
      entry = lstatSync(abs);
    } catch {
      return refuse("source_refused", `${path} does not exist`);
    }
    if (entry.isSymbolicLink()) return refuse("source_refused", `${path} is a symlink`);
    if (!entry.isFile()) return refuse("source_refused", `${path} is not a regular file`);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return refuse("source_refused", `${path} cannot be resolved`);
    }
    if (real !== abs) return refuse("source_refused", `${path} is reached through a symlink`);
    const data = readFileSync(abs);
    if (policy) {
      const type = path.endsWith(".md") ? String(parseFrontmatter(data.toString("utf8"), { dataOnly: true }).data.type ?? "") : "";
      if (!providerAllows(policy.providers, path, type, instanceId)) {
        return refuse("policy_denied", `${path} may not be sent to "${instanceId}" under the data-to-provider policy`);
      }
    }
    total += data.byteLength;
    files.push({ path, sha256: sha256Hex(data), bytes: data.byteLength });
  }
  if (maxBytes !== undefined && total > maxBytes) {
    return refuse("capability_unsupported", `"${instanceId}" stages at most ${maxBytes} bytes; the source is ${total}`);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, hash: manifestHash(files) };
}

/** A bundle over the resolved manifest, re-verifying each file's hash as it is read. */
export function sourceBundle(root: string, source: ResolvedSource): SourceBundle {
  const realRoot = realpathSync(root);
  return {
    hash: source.hash,
    files: source.files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      bytes: f.bytes,
      async read() {
        const data = readFileSync(join(realRoot, f.path));
        if (sha256Hex(data) !== f.sha256) throw new Error(`${f.path} changed after admission`);
        return new Uint8Array(data);
      },
    })),
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_NAME = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PRIVATE)(_|$)/i;

/**
 * The sandbox environment: explicit non-secret values only. A name that is
 * any instance's credential variable or looks like a credential, or a value
 * equal to the instance secret, is refused.
 */
export function checkEnv(
  env: unknown,
  credentialNames: ReadonlySet<string>,
  secret: string | undefined
): { env: Record<string, string> } | ComputeRefusal {
  if (env === undefined) return { env: {} };
  if (!env || typeof env !== "object" || Array.isArray(env)) return refuse("policy_denied", "env must be a record of names to values");
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) return refuse("policy_denied", `not an environment variable name: ${name}`);
    if (typeof value !== "string") return refuse("policy_denied", `${name} must be a string`);
    if (credentialNames.has(name) || CREDENTIAL_NAME.test(name)) {
      return refuse("policy_denied", `${name} looks like a credential; credentials are never forwarded into a sandbox`);
    }
    if (secret !== undefined && value.includes(secret)) {
      return refuse("policy_denied", `${name} carries the instance credential; credentials are never forwarded into a sandbox`);
    }
    out[name] = value;
  }
  return { env: out };
}

export function checkCommand(request: ComputeRunRequest): ComputeRefusal | undefined {
  if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((a) => typeof a !== "string")) {
    return refuse("policy_denied", "argv must be a non-empty list of strings");
  }
  if (request.cwd !== undefined && !relativePath(request.cwd)) return refuse("policy_denied", "cwd must be a relative path");
  return undefined;
}

export function checkArtifacts(artifacts: unknown): { path: string; maxBytes: number }[] | ComputeRefusal {
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) return refuse("policy_denied", "artifacts must be a list");
  const seen = new Set<string>();
  const out: { path: string; maxBytes: number }[] = [];
  for (const a of artifacts as { path?: unknown; maxBytes?: unknown }[]) {
    const path = relativePath(a?.path);
    if (!path) return refuse("policy_denied", `not a relative artifact path: ${String(a?.path)}`);
    if (seen.has(path)) return refuse("policy_denied", `${path} is declared twice`);
    if (typeof a.maxBytes !== "number" || !Number.isInteger(a.maxBytes) || a.maxBytes <= 0) {
      return refuse("policy_denied", `${path} needs a positive whole-number maxBytes`);
    }
    seen.add(path);
    out.push({ path, maxBytes: a.maxBytes });
  }
  return out;
}
