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
import { createIndexBatch, IndexFlushError, type IndexBatch } from "./index-batch.js";
import { subprocessEnv } from "../config/env.js";
import { isProtectedTarget } from "./protected-target.js";
import { admitHeld, AuthorityHeld, retryHeld, type AuthorityHold } from "./authority-hold.js";
import { isProviderMasked, ProviderMaskRefusedError, type ProviderMaskGuard } from "./provider-mask-refusal.js";

export const contentHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export interface BrainApplicationRequest {
  principalId: string;
  turnId: string;
  input: BrainApplicationInput;
}
interface Change { path: string; expectedBaseHash: string | null; content: string | null; /** An archive destination's source: its bytes derive from that base. */ from?: string }
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

/** Where an archive moves an active project document; anything else stays in place. */
const archiveDestination = (path: string): string =>
  path.startsWith("projects/active/") ? path.replace("projects/active/", "projects/archive/") : path;

/** A capture plan: what to write where, and the base it was planned against. */
export interface CapturePlan {
  path: string;
  content: string;
  baseContent: string | null;
  outcome: Record<string, unknown>;
}

/**
 * Evaluates the brain's own code for the application route: capture planning
 * and the batched index updates after commits. Both import the brain's config
 * and whatever it imports, so under the host execution boundary (#1648) they
 * run in a credential-free maintenance worker, and the commit here receives
 * the plan as data. Credential-free on purpose: the turn that applies the
 * change waits for this work, at its next index-dependent read or its end, and
 * a running turn never waits on a credentialed one.
 */
export interface ApplicationPlanner {
  /**
   * `masked` names the turn's provider-masked folders (#2690): planning sees
   * their documents as absent, wherever it runs, so it never reads them.
   */
  planAdd(root: string, input: Record<string, unknown>, readDocument: (path: string) => string | null, signal: AbortSignal, masked?: readonly string[]): Promise<CapturePlan>;
  /**
   * Bring the index up to date with Markdown already committed. `paths` names
   * exactly what changed, for a targeted update; without it, or when the index
   * cannot be trusted for one, the whole brain is indexed.
   */
  index(root: string, signal: AbortSignal | undefined, paths?: readonly string[]): Promise<void>;
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
  async index(root, _signal, paths) {
    const core = await import("@schlessera/brain/internal");
    const context = await core.initContext({ root });
    const db = core.openDatabase(context.dbPath);
    try { await core.indexAll(db, { root, taxonomy: context.taxonomy, quiet: true, force: false, ...(paths ? { paths: [...paths] } : {}) }); }
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
    async planAdd(root, input, readDocument, signal, masked) {
      if (!boundary.isolated()) return inProcessPlanner.planAdd(root, input, readDocument, signal, masked);
      return validatePlan((await run({ op: "plan-add", root, input, ...(masked?.length ? { masked: [...masked] } : {}) }, "application plan", signal)).plan);
    },
    async index(root, signal, paths) {
      if (!boundary.isolated()) return inProcessPlanner.index(root, signal, paths);
      // Markdown has committed: the turn ending or being cancelled does not
      // stop the index refresh that follows it, as in-process indexing never did.
      await run({ op: "index", root, ...(paths ? { paths: [...paths] } : {}) }, "application index", undefined);
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
  /** The admitted turn's provider masks (#2690); `tool` names an operation as the agent called it. */
  providerMasks?: { guard: ProviderMaskGuard; tool(operation: BrainApplicationInput["operation"]): string };
  signal: AbortSignal;
  /** Whether a change may commit now; false while a `hold` is active as well as once authority is gone. */
  isAuthorized(): boolean;
  /**
   * Holds that stop changes without revoking authority (#2853). While one is
   * active the route waits for it, bounded, and checks again rather than
   * refusing. Omitted: every failed check refuses as revoked.
   */
  hold?: AuthorityHold;
  approve(input: BrainApplicationInput, destructive: boolean): Promise<boolean>;
  /** Records the result; a returned string names its record for later index outcomes. */
  record(result: BrainApplicationResult): unknown;
  /**
   * Where the brain's own code is evaluated. Omitted: a host boundary of its
   * own, so the route is never left evaluating that code on a host that can
   * run a governed turn.
   */
  planner?: ApplicationPlanner;
  /**
   * The host's deferred index updates, shared with every reader that must
   * wait for them (#2835). Omitted: a batch of this route's own, over its planner.
   */
  indexBatch?: IndexBatch;
  /** Each deferred index outcome for an application this route committed. */
  recordIndex?(outcome: BrainApplicationIndexOutcome): void;
  /**
   * The turn's data tree (#2848): every committed effect, with the live base
   * it replaced, inside the commit boundary. A masked turn's capture planning
   * reads it too, through `planner`, and waits for its index (#2846).
   */
  turnTree?: { commit(effects: readonly { path: string; content: string | null; base: string | null; from?: string }[]): void; barrier(signal?: AbortSignal): Promise<void> };
  /** Where a masked turn plans captures: on its own tree and index, never the live brain (#2846). */
  turnPlanner?: ApplicationPlanner["planAdd"];
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
  const indexBatch = options.indexBatch ?? createIndexBatch({ index: paths => planner.index(root, undefined, paths) });
  function authority(request: BrainApplicationRequest): void {
    if (request.principalId !== options.principalId || request.turnId !== options.turnId)
      refuse("authority_revoked", "This turn no longer has current principal authority to apply changes.");
    if (!options.isAuthorized()) {
      if (options.signal.aborted) refuse("cancelled", "The turn was cancelled; no change was applied.");
      if (options.hold?.active()) throw new AuthorityHeld();
      refuse("authority_revoked", "This turn no longer has current principal authority to apply changes.");
    }
    if (options.signal.aborted) refuse("cancelled", "The turn was cancelled; no change was applied.");
  }
  // Every attempt that meets a hold has committed nothing; it runs again once
  // the hold clears. A hold that outlasts the bound is not revocation.
  const expired = (): never => {
    if (options.signal.aborted) refuse("cancelled", "The turn was cancelled; no change was applied.");
    refuse("application_failed", "This turn's changes stayed held by a journal observation or a scope pause past the wait bound; no change was applied.");
  };
  const afterHolds = <T>(budget: { deadline?: number }, attempt: () => T | Promise<T>) => retryHeld(options.hold, options.signal, attempt, expired, budget);
  const apply = async (request: BrainApplicationRequest): Promise<BrainApplicationResult> => {
    const committed: BrainApplicationResult["changes"] = [];
    // A deferred outcome names the application record it follows, even one
    // that settles before that record is written.
    const early: BrainApplicationIndexOutcome[] = [];
    let recorded: { id: unknown } | undefined;
    const receipt = { report(outcome: BrainApplicationIndexOutcome) {
      if (!recorded) early.push(outcome);
      else options.recordIndex?.({ ...outcome, ...(typeof recorded.id === "string" ? { applicationId: recorded.id } : {}) });
    } };
    // Every committed effect is queued once, including those of a partial failure.
    let queued = false;
    const queue = () => {
      if (queued || !committed.length) return;
      queued = true;
      const applied = [...committed];
      indexBatch.queue(applied.map(change => change.path), settled => receipt.report({ changes: applied, indexed: settled.indexed, ...(settled.indexError ? { indexError: settled.indexError } : {}) }));
    };
    let result: BrainApplicationResult;
    // One wait bound for every hold this application meets.
    const budget: { deadline?: number } = {};
    try {
      if (!request || Object.keys(request).some(key => !["principalId", "turnId", "input"].includes(key)))
        refuse("invalid_request", "Use the exact turn-bound application envelope; commands cannot be applied.");
      const admitted = admitHeld(options.hold, options.signal, () => authority(request), expired, budget);
      if (admitted) await admitted;
      if (process.platform !== "linux" || !existsSync("/proc/self/fd"))
        refuse("unsupported_host", "Descriptor-anchored application requires a supported Linux host with procfs.");
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > BRAIN_APPLICATION_MAX_BYTES)
        refuse("payload_too_large", `Application requests are limited to ${BRAIN_APPLICATION_MAX_BYTES} UTF-8 bytes.`);
      const parsed = brainApplicationInput.safeParse(request.input);
      if (!parsed.success) refuse("invalid_request", "Unsupported operation or input. Use the exact structured application schema; commands cannot be applied.");
      const input = parsed.data;
      // Masked targets, including an archive's destination, refuse before
      // approval, planning or any file effect. A planned capture destination
      // is checked where it is opened, and planning cannot read a masked one.
      const assertVisible = (paths: string[]) => options.providerMasks?.guard.assert(options.providerMasks.tool(input.operation), paths);
      assertVisible(input.operation === "staged" ? input.files.map(file => file.path)
        : input.operation === "add" ? (input.target === undefined ? [] : [input.target])
        : input.operation === "archive" ? [input.path, archiveDestination(input.path)] : [input.path]);
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
      // A hold met inside the lock releases it: the attempt waits outside and
      // runs again from the barrier, so a hold never keeps other writers out.
      result = await afterHolds(budget, async () => {
        // Capture planning reads the index (title matches, appends): it waits
        // for earlier writes like any other reader, before the lock they share.
        if (input.operation === "add") {
          try { await (options.turnPlanner && options.turnTree ? options.turnTree : indexBatch).barrier(options.signal); }
          catch (error) {
            if (error instanceof IndexFlushError) refuse("index_stale", `${error.message} No change was applied.`);
            throw error;
          }
        }
        return options.policy.lock.withLock(BRAIN_LOCK_KEY, async () => {
          authority(request); membership();
          const core = await import("@schlessera/brain/internal");
          authority(request);
          const targets: Target[] = [];
          const created: string[] = [];
          const changes: Change[] = [];
          let outcome: Record<string, unknown> = {};
          try {
            const targetFor = (path: string, expected: string | null) => {
              validateTarget(path); assertVisible([path]);
              const target = openTarget(root, path, expected === null, created);
              targets.push(target);
              if (target.hash !== expected) refuse("stale_base", "The stated base does not match the current document. Read it again; no change was applied.");
              return target;
            };
            if (input.operation === "add") {
              if (input.target !== undefined) validateTarget(input.target);
              const plan = await (options.turnPlanner ?? planner.planAdd)(root, { ...input, path: input.target }, path => {
                validatePath(path); // Protection is read-only; planning may still read it.
                // A masked document is absent to planning; a destination it
                // chooses there still refuses by name when it is opened.
                if (options.providerMasks && isProviderMasked(path, options.providerMasks.guard.folders)) return null;
                let target: Target;
                try { target = openTarget(root, path, false); }
                catch (error) { if (errno(error) === "ENOENT") return null; throw error; }
                try { return target.content; } finally { closeTarget(target); }
              }, options.signal, options.providerMasks?.guard.folders);
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
                    const destination = archiveDestination(input.path);
                    outcome = { path: destination, status: "archived", moved: destination !== input.path, updated, ...(input.dry_run ? { dryRun: true } : {}) };
                    if (input.dry_run) return { ok: true, message: "Archive preview; no change applied.", changes: [], outcome };
                    if (destination !== input.path) {
                      targetFor(destination, null);
                      changes.push({ path: input.path, expectedBaseHash: target.hash, content: null });
                      changes.push({ path: destination, expectedBaseHash: null, content, from: input.path });
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
            // What the turn's data tree receives: each committed effect and the live base it replaced.
            const effects: { path: string; content: string | null; base: string | null; from?: string }[] = [];
            const baseOf = (change: Change, target: Target) => change.from ? { base: targets.find(t => t.path === change.from)!.content, from: change.from } : { base: target.content };
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
                effects.push({ path: change.path, content: change.content, ...baseOf(change, target) });
              }
              for (const { change, target } of prepared.filter(p => p.change.content === null)) {
                unlinkSync(target.at); committed.push({ path: change.path, contentHash: null });
                effects.push({ path: change.path, content: null, base: target.content });
              }
              for (const target of targets) fsyncSync(target.chain.at(-1)!.fd);
            } finally {
              // Partial failures included: the tree follows exactly what committed.
              options.turnTree?.commit(effects);
              for (const { temp } of prepared) if (temp) { try { unlinkSync(temp); } catch { /* Best-effort cleanup of private temporary bytes. */ } }
            }
          } finally {
            for (const target of targets) closeTarget(target);
            if (!committed.length) for (const path of created.reverse()) { try { rmdirSync(path); } catch { /* Preserve concurrent directory contents. */ } }
          }
          // Markdown has committed. Its index update waits, batched with every
          // other committed path, for the next index-dependent read or the end
          // of the turn (#2835); cancellation cannot drop it or misreport the
          // write as refused. Its outcome is recorded when an update settles.
          queue();
          return { ok: true, message: "Applied authoritative Markdown. Its index update is queued: the next search or read that needs the index waits for it.",
            changes: [...committed], indexed: false, indexStatus: "pending" as const,
            outcome: { ...outcome, ...(input.operation === "add" ? { indexed: false, indexStatus: "pending" } : {}) } };
        }, { signal: options.signal });
      });
    } catch (error) {
      queue();
      result = { ok: false, code: error instanceof Refusal || error instanceof ProviderMaskRefusedError ? error.code : (error instanceof Error && error.name === "AbortError" ? "cancelled" : "application_failed"), message: error instanceof Error ? error.message : "Application failed.", changes: [...committed] };
    }
    recorded = { id: options.record(result) };
    for (const outcome of early.splice(0)) receipt.report(outcome);
    return result;
  };
  return Object.assign(apply, { indexBatch });
}

/** A deferred index outcome for one committed application (#2835). */
export interface BrainApplicationIndexOutcome {
  /** The application record this outcome follows, when the recorder named one. */
  applicationId?: string;
  changes: BrainApplicationResult["changes"];
  indexed: boolean;
  indexError?: string;
}

/**
 * A contained read supplies the exact base needed by new hosted tool schemas.
 * A turn's provider masks refuse before anything is opened (#2690).
 */
export function readBrainApplicationBase(root: string, path: string, masks?: { guard: ProviderMaskGuard; tool: string }): { content: string; expectedBaseHash: string } {
  masks?.guard.assert(masks.tool, [path]);
  const target = openTarget(realpathSync(root), path, false);
  try {
    if (target.content === null) refuse("missing_document", "Document not found.");
    verifyTarget(target, target.hash);
    return { content: target.content!, expectedBaseHash: target.hash! };
  } finally { closeTarget(target); }
}
