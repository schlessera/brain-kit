/** One privileged Markdown application boundary, owned by the server. */
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, rmdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  brainApplicationInput, BRAIN_APPLICATION_MAX_BYTES,
  type BrainApplicationInput, type BrainApplicationPolicy, type BrainApplicationResult,
} from "@schlessera/brain-ui-sdk/server";
import { BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { createHostBoundary, MAINTENANCE_ENTRY, type HostBoundary } from "./host-boundary.js";
import { subprocessEnv } from "../config/env.js";
import { isProtectedTarget } from "./protected-target.js";

export const contentHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export interface BrainApplicationRequest {
  principalId: string;
  turnId: string;
  input: BrainApplicationInput;
}
interface Change { path: string; expectedBaseHash: string | null; content: string | null }
interface Directory { fd: number; path: string; dev: number; ino: number }
interface Target { path: string; at: string; chain: Directory[]; content: string | null; hash: string | null; mode?: number }
class Refusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function refuse(code: string, message: string): never { throw new Refusal(code, message); }
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const at = (dir: Directory, name: string) => `/proc/self/fd/${dir.fd}/${name}`;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function validatePath(path: string): void {
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === "..") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path))
    refuse("invalid_target", "Use an exact repository-relative path without traversal or control characters.");
  const folded = parts.map(p => p.normalize("NFKC").toLowerCase());
  if (folded[0] === "context" && (folded.length === 1 || folded[1] === "policies"))
    refuse("policy_denied", "Agent applications cannot change context/policies or its ancestors or aliases.");
  // The privileged route accepts documents, not executable configuration,
  // databases, images, directories, device files or repository metadata.
  const hiddenSegment = parts.find(p => p.startsWith("."));
  if (hiddenSegment) {
    const scratchHint = parts[0] === ".brain" && parts[1] === "scratch"
      ? " Use the worker shell for scratch files when that area is writable." : "";
    refuse("unsupported_kind", `Hidden path segment "${hiddenSegment}" is not supported. Hidden files and directories are not written by this route.${scratchHint}`);
  }
  if (!path.endsWith(".md"))
    refuse("unsupported_kind", "Only ordinary UTF-8 Markdown document files are supported by this route.");
}
function openDirectory(path: string): Directory {
  const fd = openSync(path, directoryFlags);
  const info = fstatSync(fd);
  return { fd, path, dev: info.dev, ino: info.ino };
}
function closeTarget(target: Target): void { for (const dir of target.chain.reverse()) closeSync(dir.fd); }
function readRegular(path: string, onMode?: (mode: number) => void): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    if (errno(error) === "ELOOP") refuse("alias_denied", "The target is a symlink; no change was applied.");
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) refuse("alias_denied", "The target must be a regular file with exactly one link.");
    if (info.size > BRAIN_APPLICATION_MAX_BYTES) refuse("payload_too_large", "The existing document exceeds the application byte bound.");
    onMode?.(info.mode & 0o7777);
    const bytes = readFileSync(fd);
    if (bytes.length > BRAIN_APPLICATION_MAX_BYTES) refuse("payload_too_large", "The existing document exceeds the application byte bound.");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return refuse("unsupported_kind", "The target is not a UTF-8 document."); }
  } finally { closeSync(fd); }
}
function openTarget(root: string, path: string, create: boolean, created: string[] = []): Target {
  validatePath(path);
  const chain: Directory[] = [];
  try {
    chain.push(openDirectory(root));
    const parts = path.split("/");
    for (const part of parts.slice(0, -1)) {
      const parent = chain.at(-1)!;
      const anchored = at(parent, part);
      try { chain.push(openDirectory(anchored)); }
      catch (error) {
        if (errno(error) === "ENOENT" && create) {
          mkdirSync(anchored, { mode: 0o755 });
          created.push(join(parent.path, part));
          chain.push(openDirectory(anchored));
        } else if (errno(error) === "ENOTDIR" || errno(error) === "ELOOP") {
          refuse("alias_denied", "A target directory is a symlink or is not a directory.");
        } else throw error;
      }
      // Store the visible identity independently from descriptor-relative I/O.
      chain.at(-1)!.path = join(parent.path, part);
    }
    const target = at(chain.at(-1)!, parts.at(-1)!);
    let mode: number | undefined;
    const content = readRegular(target, value => { mode = value; });
    return { path, at: target, chain, content, mode, hash: content === null ? null : contentHash(content) };
  } catch (error) { for (const entry of chain.reverse()) closeSync(entry.fd); throw error; }
}
function verifyTarget(target: Target, expected: string | null): void {
  for (const dir of target.chain) {
    let info;
    try { info = lstatSync(dir.path); }
    catch { return refuse("topology_changed", "A target directory changed during application."); }
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== dir.dev || info.ino !== dir.ino)
      refuse("topology_changed", "A target directory changed during application.");
  }
  const content = readRegular(target.at);
  if ((content === null ? null : contentHash(content)) !== expected)
    refuse("stale_base", "The document changed since its stated base. Read it again; no merge or overwrite was applied.");
}

/** A capture plan: what to write where, and the base it was planned against. */
export interface CapturePlan {
  path: string;
  content: string;
  baseContent: string | null;
  outcome: Record<string, unknown>;
}

/**
 * Evaluates the brain's own code for the application route: capture planning
 * and the index refresh after a commit. Both import the brain's config and
 * whatever it imports, so under the host execution boundary (#1648) they run
 * in a credential-free maintenance worker, and the commit here receives the
 * plan as data. Credential-free on purpose: the turn that applies the change
 * waits for this work, and a running turn never waits on a credentialed one.
 */
export interface ApplicationPlanner {
  planAdd(root: string, input: Record<string, unknown>, readDocument: (path: string) => string | null, signal: AbortSignal): Promise<CapturePlan>;
  index(root: string, signal: AbortSignal): Promise<void>;
}

/** The in-process planner, for a server where no governed turn can run. */
export const inProcessPlanner: ApplicationPlanner = {
  async planAdd(root, input, readDocument) {
    const core = await import("@schlessera/brain/internal");
    const context = await core.initContext({ root });
    const db = core.openDatabase(context.dbPath);
    try {
      const plan = core.prepareIngest(input as unknown as Parameters<typeof core.prepareIngest>[0], db, { root, taxonomy: context.taxonomy, readDocument });
      return { path: plan.path, content: plan.content, baseContent: plan.baseContent, outcome: { ...plan.outcome } };
    } finally { db.close(); }
  },
  async index(root) {
    const core = await import("@schlessera/brain/internal");
    const context = await core.initContext({ root });
    const db = core.openDatabase(context.dbPath);
    try { await core.indexAll(db, { root, taxonomy: context.taxonomy, quiet: true, force: false }); }
    finally { db.close(); }
  },
};

const PLAN_TIMEOUT_MS = 120_000;
const OUTCOME_VALUE = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value)
  || (Array.isArray(value) && value.every(item => typeof item === "string"));

/** A plan from a maintenance worker is untrusted data: exact shape, bounded, nothing executable. */
export function validatePlan(raw: unknown): CapturePlan {
  const plan = raw as Partial<CapturePlan> | null;
  if (!plan || typeof plan !== "object" || typeof plan.path !== "string" || typeof plan.content !== "string"
    || !(plan.baseContent === null || typeof plan.baseContent === "string")
    || !plan.outcome || typeof plan.outcome !== "object" || Array.isArray(plan.outcome)
    || !Object.values(plan.outcome).every(OUTCOME_VALUE)) {
    refuse("application_failed", "The capture plan was not well formed; no change was applied.");
  }
  validatePath(plan.path);
  if (Buffer.byteLength(plan.content, "utf8") > BRAIN_APPLICATION_MAX_BYTES || Buffer.byteLength(JSON.stringify(plan.outcome), "utf8") > 16_384)
    refuse("payload_too_large", "The capture plan exceeds the application byte bound.");
  return { path: plan.path, content: plan.content, baseContent: plan.baseContent ?? null, outcome: { ...plan.outcome } };
}

/** The planner behind a host boundary: in a maintenance worker while the boundary holds, in-process otherwise. */
export function boundaryPlanner(boundary: HostBoundary, options: { afterIndex?: () => void } = {}): ApplicationPlanner {
  const run = async (request: Record<string, unknown>, purpose: string, signal?: AbortSignal) => {
    const result = await boundary.run({ argv: ["bun", MAINTENANCE_ENTRY], env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
      credentials: false, gate: "shared", purpose, stdin: JSON.stringify(request), ...(signal ? { signal } : {}), timeoutMs: PLAN_TIMEOUT_MS });
    let answer: { ok?: boolean; error?: unknown; plan?: unknown } | undefined;
    try { answer = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""); } catch { /* reported below */ }
    if (!answer || typeof answer !== "object") {
      throw new Error(`the maintenance worker gave no answer (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}): ${result.stderr.trim().slice(-400)}`);
    }
    if (answer.ok !== true) throw new Error(typeof answer.error === "string" ? answer.error.slice(0, 2000) : "the maintenance worker failed");
    return answer;
  };
  return {
    async planAdd(root, input, readDocument, signal) {
      if (!boundary.isolated()) return inProcessPlanner.planAdd(root, input, readDocument, signal);
      return validatePlan((await run({ op: "plan-add", root, input }, "application plan", signal)).plan);
    },
    async index(root, signal) {
      if (!boundary.isolated()) return inProcessPlanner.index(root, signal);
      // Markdown has committed: the turn ending or being cancelled does not
      // stop the index refresh that follows it, as in-process indexing never did.
      await run({ op: "index", root }, "application index", undefined);
      // The worker had no provider key, so new chunks wait for vectors; a
      // credentialed reindex runs once no writer holds the gate.
      options.afterIndex?.();
    },
  };
}

/**
 * The host binds identity, live authority, membership, approvals and history.
 * Callers cannot inject commands, tools, grant flags or privileged handles.
 */
export function createBrainApplication(options: {
  root: string;
  principalId: string;
  turnId: string;
  policy: BrainApplicationPolicy;
  /** Captured host admission facts, never a worker-selected list. */
  protectedPaths?: readonly string[];
  signal: AbortSignal;
  isAuthorized(): boolean;
  approve(input: BrainApplicationInput, destructive: boolean): Promise<boolean>;
  record(result: BrainApplicationResult): void;
  /**
   * Where the brain's own code is evaluated. Omitted: a host boundary of its
   * own, so the route is never left evaluating that code on a host that can
   * run a governed turn.
   */
  planner?: ApplicationPlanner;
  /** Internal deterministic race fixture; never wired to a worker or HTTP. */
  beforeCommit?: () => void;
}) {
  const root = realpathSync(options.root);
  const protectedPaths = [...(options.protectedPaths ?? [])];
  const validateTarget = (path: string): void => {
    validatePath(path);
    if (isProtectedTarget(path, protectedPaths)) refuse("policy_denied", "This target is protected by the policy admitted for this turn; no change was applied.");
  };
  const planner = options.planner ?? boundaryPlanner(createHostBoundary({ brainPath: root }));
  function authority(request: BrainApplicationRequest): void {
    if (request.principalId !== options.principalId || request.turnId !== options.turnId || !options.isAuthorized())
      refuse("authority_revoked", "This turn no longer has current principal authority to apply changes.");
    if (options.signal.aborted) refuse("cancelled", "The turn was cancelled; no change was applied.");
  }
  return async (request: BrainApplicationRequest): Promise<BrainApplicationResult> => {
    const committed: BrainApplicationResult["changes"] = [];
    let result: BrainApplicationResult;
    try {
      if (!request || Object.keys(request).some(key => !["principalId", "turnId", "input"].includes(key)))
        refuse("invalid_request", "Use the exact turn-bound application envelope; commands cannot be applied.");
      authority(request);
      if (process.platform !== "linux" || !existsSync("/proc/self/fd"))
        refuse("unsupported_host", "Descriptor-anchored application requires a supported Linux host with procfs.");
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > BRAIN_APPLICATION_MAX_BYTES)
        refuse("payload_too_large", `Application requests are limited to ${BRAIN_APPLICATION_MAX_BYTES} UTF-8 bytes.`);
      const parsed = brainApplicationInput.safeParse(request.input);
      if (!parsed.success) refuse("invalid_request", "Unsupported operation or input. Use the exact structured application schema; commands cannot be applied.");
      const input = parsed.data;
      if (!options.policy.available.includes(input.operation)) refuse("membership_denied", "This turn's membership does not permit this operation.");
      const membership = () => {
        if (!options.policy.available.includes(input.operation)) refuse("membership_denied", "This turn's membership no longer permits this operation.");
      };
      if (input.operation === "update") for (const key of ["deadline", "next_review"] as const) {
        const value = input[key];
        if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) refuse("invalid_request", `${key} must be YYYY-MM-DD or empty to remove it.`);
      }
      const destructive = input.operation === "archive" || (input.operation === "update" && input.status === "archived");
      // A route-owned decision checks exact effects even if the runtime skipped
      // its permission callback. Approval precedes lock admission, then current
      // authority and input/base are rechecked inside the shared lock.
      if ((!options.policy.autoAllowed.includes(input.operation) || destructive) && !await options.approve(input, destructive))
        refuse("permission_denied", "The exact application was not approved; no change was applied.");
      result = await options.policy.lock.withLock(BRAIN_LOCK_KEY, async () => {
        authority(request); membership();
        const core = await import("@schlessera/brain/internal");
        authority(request);
        const targets: Target[] = [];
        const created: string[] = [];
        const changes: Change[] = [];
        let outcome: Record<string, unknown> = {};
        try {
          const targetFor = (path: string, expected: string | null) => {
            validateTarget(path);
            const target = openTarget(root, path, expected === null, created);
            targets.push(target);
            if (target.hash !== expected) refuse("stale_base", "The stated base does not match the current document. Read it again; no change was applied.");
            return target;
          };
          if (input.operation === "add") {
            if (input.target !== undefined) validateTarget(input.target);
            const plan = await planner.planAdd(root, { ...input, path: input.target }, path => {
              validatePath(path); // Protection is read-only; planning may still read it.
              let target: Target;
              try { target = openTarget(root, path, false); }
              catch (error) { if (errno(error) === "ENOENT") return null; throw error; }
              try { return target.content; } finally { closeTarget(target); }
            }, options.signal);
            authority(request);
            const expected = input.expectedBaseHash === undefined
              ? (plan.baseContent === null ? null : contentHash(plan.baseContent)) : input.expectedBaseHash;
            if (input.target !== undefined && input.target !== plan.path) refuse("invalid_target", "The capture plan differs from its requested target.");
            targetFor(plan.path, expected);
            changes.push({ path: plan.path, content: plan.content, expectedBaseHash: expected });
            outcome = { ...plan.outcome };
          } else if (input.operation === "staged") {
            const named = new Set<string>();
            for (const file of input.files) {
              if (named.has(file.path)) refuse("invalid_request", "A staged request must name each file exactly once.");
              named.add(file.path); targetFor(file.path, file.expectedBaseHash); changes.push(file);
            }
          } else {
            const target = targetFor(input.path, input.expectedBaseHash);
            let content: string;
            if (input.operation === "write") content = input.content;
            else {
              if (target.content === null) refuse("missing_document", "This operation requires an existing document.");
              const raw = target.content!;
              if (input.operation === "edit") {
                if (raw.split(input.old_string).length - 1 !== 1) refuse("edit_conflict", "The old string must occur exactly once in the stated base.");
                content = raw.replace(input.old_string, input.new_string);
              } else {
                const updated = new Date().toISOString().slice(0, 10);
                const fields: Record<string, string | string[] | null> = { updated };
                for (const key of ["summary", "status", "relevance", "tags", "deadline", "next_review"] as const) {
                  const value = input.operation === "update" ? input[key] : undefined;
                  if (value !== undefined) fields[key] = value === "" ? null : value;
                }
                if (input.operation === "archive") fields.status = "archived";
                if (fields.status === "archived") {
                  const relevance = core.relevanceOnArchive(raw, typeof fields.relevance === "string" ? fields.relevance : undefined);
                  if (relevance) fields.relevance = relevance;
                }
                const append = input.operation === "update" ? input.append_content : undefined;
                if (input.operation === "update" && Object.keys(fields).length === 1 && !append) refuse("invalid_request", "No changes specified.");
                content = core.updateDocument(raw, fields, append || undefined);
                outcome = { path: input.path, updated, changes: [...Object.keys(fields).filter(k => k !== "updated"), ...(append ? ["content"] : [])] };
                if (input.operation === "archive") {
                  const destination = input.path.startsWith("projects/active/") ? input.path.replace("projects/active/", "projects/archive/") : input.path;
                  outcome = { path: destination, status: "archived", moved: destination !== input.path, updated, ...(input.dry_run ? { dryRun: true } : {}) };
                  if (input.dry_run) return { ok: true, message: "Archive preview; no change applied.", changes: [], outcome };
                  if (destination !== input.path) {
                    targetFor(destination, null);
                    changes.push({ path: input.path, expectedBaseHash: target.hash, content: null });
                    changes.push({ path: destination, expectedBaseHash: null, content });
                  }
                }
              }
            }
            if (!changes.length) changes.push({ path: input.path, expectedBaseHash: input.expectedBaseHash, content });
          }
          if (changes.reduce((n, c) => n + Buffer.byteLength(c.content ?? "", "utf8"), 0) > BRAIN_APPLICATION_MAX_BYTES)
            refuse("payload_too_large", "Proposed Markdown exceeds the application byte bound.");
          // Prepare complete bytes privately. No awaited work occurs between
          // final authority/topology/base validation and the commit burst.
          const prepared: { change: Change; target: Target; temp?: string }[] = [];
          try {
            for (const change of changes) {
              const target = targets.find(t => t.path === change.path)!;
              let temp: string | undefined;
              if (change.content !== null) {
                temp = at(target.chain.at(-1)!, `.brain-apply-${crypto.randomUUID()}.tmp`);
                const mode = target.mode ?? (input.operation === "archive" ? targets.find(t => t.path === input.path)?.mode : undefined);
                const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode ?? 0o644);
                prepared.push({ change, target, temp });
                try { writeFileSync(fd, change.content, "utf8"); if (mode !== undefined) fchmodSync(fd, mode); fsyncSync(fd); }
                finally { closeSync(fd); }
              } else prepared.push({ change, target });
            }
            options.beforeCommit?.();
            authority(request); membership();
            for (const entry of prepared) { validateTarget(entry.change.path); verifyTarget(entry.target, entry.change.expectedBaseHash); }
            // Create destinations first so an archive never loses its source
            // before no-clobber publication. Abort cannot interleave this burst.
            for (const { change, target, temp } of prepared.filter(p => p.change.content !== null)) {
              if (change.expectedBaseHash === null) linkSync(temp!, target.at);
              else renameSync(temp!, target.at);
              committed.push({ path: change.path, contentHash: contentHash(change.content!) });
            }
            for (const { change, target } of prepared.filter(p => p.change.content === null)) {
              unlinkSync(target.at); committed.push({ path: change.path, contentHash: null });
            }
            for (const target of targets) fsyncSync(target.chain.at(-1)!.fd);
          } finally {
            for (const { temp } of prepared) if (temp) { try { unlinkSync(temp); } catch { /* Best-effort cleanup of private temporary bytes. */ } }
          }
        } finally {
          for (const target of targets) closeTarget(target);
          if (!committed.length) for (const path of created.reverse()) { try { rmdirSync(path); } catch { /* Preserve concurrent directory contents. */ } }
        }
        // Markdown has committed. Cancellation during disposable-index work
        // cannot misreport the write as refused or roll back someone else's edit.
        let indexed = false;
        let indexError: string | undefined;
        try { await planner.index(root, options.signal); indexed = true; }
        catch (error) { indexError = error instanceof Error ? error.message : String(error); }
        return { ok: true, message: indexed ? "Applied authoritative Markdown and updated its index." : `Applied authoritative Markdown; index update failed${indexError ? `: ${indexError.slice(0, 300)}` : "."}`,
          changes: [...committed], indexed, outcome: { ...outcome, ...(input.operation === "add" ? { indexed } : {}), ...(indexError ? { indexError } : {}) } };
      }, { signal: options.signal });
    } catch (error) {
      result = { ok: false, code: error instanceof Refusal ? error.code : (error instanceof Error && error.name === "AbortError" ? "cancelled" : "application_failed"), message: error instanceof Error ? error.message : "Application failed.", changes: [...committed] };
    }
    options.record(result);
    return result;
  };
}

/** A contained read supplies the exact base needed by new hosted tool schemas. */
export function readBrainApplicationBase(root: string, path: string): { content: string; expectedBaseHash: string } {
  const target = openTarget(realpathSync(root), path, false);
  try {
    if (target.content === null) refuse("missing_document", "Document not found.");
    verifyTarget(target, target.hash);
    return { content: target.content!, expectedBaseHash: target.hash! };
  } finally { closeTarget(target); }
}
