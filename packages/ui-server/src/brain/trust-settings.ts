/** Human Settings operations. Markdown is authoritative; these rows are bounded
 * request/audit receipts, never a second policy source or an agent turn. */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync, rmdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { openGovernancePolicyAnchored, verifyGovernancePolicyAnchored, parseGovernancePolicy, TrustedSourcesSchema, TrustRuleSchema,
  TRUST_RUNTIME_CAPABILITIES, type TrustRule, type AnchoredGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import { publishProtectedPolicy } from "./policy-publication.js";
import * as writes from "./trust-settings-writes.js";
import type { createTrustGitHubIdentity, TrustGitHubIdentity } from "./trust-github-identity.js";
import { ReferenceTransportError } from "./reference-transport.js";
const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const id = () => randomBytes(24).toString("base64url");
const exactDiff = (before: string | null, after: string) => (before ?? "").split("\n").map(line => `- ${line}`).concat(after.split("\n").map(line => `+ ${line}`)).join("\n");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const MAX_TRUST_REVISION = 18446744073709551615n;
const revision = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine(value => /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= MAX_TRUST_REVISION, "Revision exhausted");
const ruleId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const TrustPrepareSchema = z.strictObject({ version: z.literal(1), expectedTrustRevision: revision,
  expectedPolicyHash: digest.nullable(), change: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("create"), rule: TrustRuleSchema }),
    z.strictObject({ action: z.literal("edit"), rule: TrustRuleSchema }),
    z.strictObject({ action: z.literal("remove"), ruleId }),
  ]) });
const TrustCommitSchema = z.strictObject({ version: z.literal(1), requestId: ruleId, reviewId: ruleId, reviewedBytesHash: digest });
type Prepare = z.output<typeof TrustPrepareSchema>;
type Commit = z.output<typeof TrustCommitSchema>;
export class TrustSettingsError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503 = 409) { super(code); }
}
interface Projection { revision: string; rules: TrustRule[]; policyHash: string | null; error: string | null }
interface Receipt {
  version: 1; requestId: string; operationId: string; stage: "prepared" | "file_published" | "committed" | "partial" | "unknown" | "refused";
  publication: "not_published" | "proved" | "unknown"; ruleId: string; publishedTrustRevision: string | null;
  currentRule: "present" | "removed" | "changed" | "unknown"; enforcement: "unavailable" | "enforced"; reason: string | null;
}
interface Payload { input: Prepare; reviewId: string; proposed: string; proposedHash: string; base: string | null; topology: string; rule: TrustRule | null; githubIdentity?: TrustGitHubIdentity }
interface Row { principal_id: string; brain_id: string; authority: string; expires_at: number; retain_until: number; payload: string; stage: string; proof: string | null; receipt: string }
const topology = (root: string) => [root, join(root, "context"), join(root, "context/policies"), join(root, "context/policies/governance.md")].map((path, i) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (i < 3 && !stat.isDirectory()) throw new TrustSettingsError("stale_base");
  return i < 3 ? [stat.dev, stat.ino] : [stat.dev, stat.ino, stat.ctimeMs];
});
const matchesTopology = (root: string, expected: string, created: boolean) => {
  const a = JSON.parse(expected) as unknown[], b = topology(root);
  return a.every((entry, i) => created && i < 3 && entry === null || JSON.stringify(entry) === JSON.stringify(b[i]));
};
/** Only the taint block changes. Parse-back equality refuses aliases, merge keys
 * or exotic layouts that would alter any unrelated setting. Review shows exact bytes. */
function edit(text: string | null, rules: TrustRule[]): string {
  const before = text ?? "---\nschema_version: 1\n---\n";
  const m = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?\r?\n)?((?:---|\.\.\.)[ \t]*(?:\r?\n|$))/u.exec(before);
  if (!m) throw new TrustSettingsError("unsupported_layout");
  const data = parseFrontmatter(before, { dataOnly: true }).data;
  const taint = { ...data.taint, trusted_sources: rules };
  const lines = (m[2] ?? "").split(/\r?\n/u); if (lines.at(-1) === "") lines.pop();
  const start = lines.findIndex(line => /^taint[ \t]*:/u.test(line));
  const block = `taint: ${JSON.stringify(taint)}`;
  if (start < 0) lines.push(block);
  else { let end = start + 1; while (end < lines.length && !/^[^\s#]/u.test(lines[end]!)) end++;
    while (end > start + 1 && /^\s*(?:#.*)?$/u.test(lines[end - 1]!)) end--;
    lines.splice(start, end - start, block); }
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const after = m[1] + lines.join(newline) + newline + m[3] + before.slice(m[0].length);
  const expected = { ...data, taint };
  if (JSON.stringify(parseFrontmatter(after, { dataOnly: true }).data) !== JSON.stringify(expected) || !parseGovernancePolicy(Buffer.from(after)).ok)
    throw new TrustSettingsError("unsupported_layout");
  return after;
}
export function createTrustSettings(options: {
  root: string; db: Database; writer?: SqliteWriter; lock: Pick<KeyedLock, "withLock">;
  /** Null unless the current password-mode human principal remains usable. The
   * fingerprint includes credential/lifetime identity, never a body/channel claim. */
  authority(principalId: string): string | null;
  observe(operationId: string, operation: (publish?: (write: () => void) => Promise<void>) => void | Promise<void>): Promise<void>;
  /** The composed host has installed the origin admission and stream fences. */
  originEnforcement?: true;
  github?: ReturnType<typeof createTrustGitHubIdentity>;
  now?: () => number;
  /** Host-only deterministic crash/race injection, never wired from HTTP. */
  checkpoint?(stage: string): void | Promise<void>;
}) {
  let root: string;
  try { root = realpathSync(options.root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; root = resolve(options.root); }
  const brain = hash(root);
  const capabilities = { ...TRUST_RUNTIME_CAPABILITIES, repositoryIdentity: !!options.github,
    originRules: options.originEnforcement === true, recipientRules: options.originEnforcement === true, readOnlyReason: options.originEnforcement ? null : "Runtime trust enforcement is unavailable" };
  const call = procedureCaller(options.db, writes, undefined, options.writer), now = options.now ?? Date.now;
  const authority = (principal: string, expected?: string) => {
    const value = options.authority(principal);
    if (!value || (expected !== undefined && expected !== value)) throw new TrustSettingsError("unauthorized", 403);
    return value;
  };
  const projection = (): Projection => {
    const row = options.db.query("SELECT * FROM trust_settings_projection WHERE brain_id=?").get(brain) as { revision: string; rules: string; policy_hash: string | null; error: string | null } | null;
    return row ? { revision: row.revision, rules: JSON.parse(row.rules), policyHash: row.policy_hash, error: row.error } : { revision: "0", rules: [], policyHash: null, error: null };
  };
  const listeners = new Set<() => void>();
  const freshProjection = () => {
    const p = projection(); let target: AnchoredGovernancePolicy | undefined;
    try {
      target = openGovernancePolicyAnchored(root); verifyGovernancePolicyAnchored(target, target.bytes === null ? null : hash(target.bytes));
      const checked = target.bytes === null ? null : parseGovernancePolicy(target.bytes);
      if (checked && !checked.ok) return p; // Retain last-valid policy, never adopt invalid bytes.
      if (JSON.stringify(checked?.effective.taint.trusted_sources ?? []) !== JSON.stringify(p.rules)) throw new TrustSettingsError("stale_revision");
      return { ...p, policyHash: target.bytes === null ? null : hash(target.bytes) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && p.rules.length === 0) return { ...p, policyHash: null };
      if (error instanceof TrustSettingsError) throw error; // A valid changed rule list must fence.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TrustSettingsError("stale_revision");
      return { ...p, error: "policy_unavailable" }; // Unreadable/invalid publication retains last-valid rules.
    } finally { target?.close(); }
  };
  const live = { read: freshProjection, revision: () => freshProjection().revision,
    refresh: () => options.lock.withLock(BRAIN_LOCK_KEY, refresh), subscribe(changed: () => void) { listeners.add(changed); return () => { listeners.delete(changed); }; } };
  const refresh = async (): Promise<Projection> => {
    const old = projection(); let target: AnchoredGovernancePolicy | undefined;
    let rules: TrustRule[], policyHash: string | null;
    try {
      target = openGovernancePolicyAnchored(root);
      policyHash = target.bytes === null ? null : hash(target.bytes); verifyGovernancePolicyAnchored(target, policyHash);
      const checked = target.bytes === null ? null : parseGovernancePolicy(target.bytes);
      if (checked && !checked.ok) throw new Error("invalid");
      rules = checked?.effective.taint.trusted_sources ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { rules = []; policyHash = null; }
      else { await call("projection", brain, old.revision, JSON.stringify(old.rules), old.policyHash, "policy_unavailable"); return { ...old, error: "policy_unavailable" }; }
    } finally { target?.close(); }
    const changed = JSON.stringify(old.rules) !== JSON.stringify(rules);
    if (changed && BigInt(old.revision) >= MAX_TRUST_REVISION) throw new TrustSettingsError("capacity", 503);
    const next = { revision: changed ? String(BigInt(old.revision) + 1n) : old.revision, rules, policyHash, error: null };
    await call("projection", brain, next.revision, JSON.stringify(rules), policyHash, null);
    if (changed) for (const listener of listeners) listener();
    return next;
  };
  const row = (principal: string, request: string): Row => {
    authority(principal);
    const r = options.db.query("SELECT * FROM trust_settings_operations WHERE request_id=? AND brain_id=? AND principal_id=?").get(request, brain, principal) as Row | null;
    if (!r || r.retain_until < now()) throw new TrustSettingsError("unavailable", 404);
    authority(principal, r.authority); return r;
  };
  const current = (receipt: Receipt, payload: Payload, p: Projection): Receipt => {
    const rule = p.rules.find(rule => rule.id === receipt.ruleId);
    return { ...receipt, currentRule: p.error ? "unknown" : !rule ? "removed" : JSON.stringify(rule) === JSON.stringify(payload.rule) ? "present" : "changed" };
  };
  const read = async (principal: string, request: string) => {
    row(principal, request);
    return options.lock.withLock(BRAIN_LOCK_KEY, async () => {
      const p = await refresh();
      const r = row(principal, request), payload = JSON.parse(r.payload) as Payload;
      let receipt = JSON.parse(r.receipt) as Receipt;
      if (r.stage === "writing") receipt = { ...receipt, stage: "unknown", publication: "unknown", reason: "publication_completion_unknown" };
      if (r.stage === "file_published") receipt = { ...receipt, stage: "partial", publication: r.proof ? "proved" : "unknown", reason: "publication_recorded_completion_incomplete" };
      return { receipt: current(receipt, payload, p), review: { reviewId: payload.reviewId, base: payload.base, proposed: payload.proposed,
        diff: exactDiff(payload.base, payload.proposed), reviewedBytesHash: payload.proposedHash, expiresAt: r.expires_at,
        repositoryIdentity: payload.githubIdentity ?? null,
        includesFutureRepositories: payload.rule?.selector.kind === "github_owner" }, policy: p, capabilities };
    });
  };
  return {
    live,
    /** The other protected publisher already owns the shared brain lock. */
    refreshLocked: refresh,
    /** Live trust-only projection for future admissions. Ordinary policy snapshots
     * remain owned by their admitted turn; this never mutates them. */
    async snapshot() { return options.lock.withLock(BRAIN_LOCK_KEY, refresh); },
    /** Historical host publication evidence, not a current identity or source-trust grant. */
    async repositoryApproval(ruleId: string) { return options.lock.withLock(BRAIN_LOCK_KEY, async () => {
      const p = await refresh();
      if (p.error) return null;
      const rule = p.rules.find(value => value.id === ruleId);
      if (!rule || (rule.selector.kind !== "github_owner" && rule.selector.kind !== "github_repository")) return null;
      const row = options.db.query("SELECT selector,identity,proof FROM trust_settings_github_boundaries WHERE brain_id=? AND rule_id=?").get(brain, ruleId) as { selector: string; identity: string; proof: string } | null;
      return row && row.selector === JSON.stringify(rule.selector) ? { identity: JSON.parse(row.identity) as TrustGitHubIdentity, proof: JSON.parse(row.proof) as unknown } : null;
    }); },
    async list(principal: string) { authority(principal); const p = await options.lock.withLock(BRAIN_LOCK_KEY, refresh); authority(principal);
      return { ...p, origins: p.rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: p.rules.filter(r => r.selector.kind.startsWith("github_")), capabilities }; },
    read,
    async prepare(principal: string, raw: unknown, signal?: AbortSignal) {
      const auth = authority(principal), input = TrustPrepareSchema.parse(raw);
      if (process.platform !== "linux") throw new TrustSettingsError("unavailable", 503);
      // Names/IDs supplied by browsers cannot create repository identity proof.
      // Removal remains possible even while repository qualification is unavailable.
      if (input.change.action !== "remove" && input.change.rule.selector.kind.startsWith("github_") && !options.github) throw new TrustSettingsError("repository_identity_unavailable", 503);
      const request = await options.lock.withLock(BRAIN_LOCK_KEY, async () => {
        authority(principal, auth); const p = await refresh(); authority(principal, auth);
        if (p.error) throw new TrustSettingsError("unavailable", 503);
        if (BigInt(p.revision) >= MAX_TRUST_REVISION) throw new TrustSettingsError("capacity", 503);
        if (p.revision !== input.expectedTrustRevision) throw new TrustSettingsError("stale_revision");
        if (p.policyHash !== input.expectedPolicyHash) throw new TrustSettingsError("stale_base");
        const change = input.change, ruleId = change.action === "remove" ? change.ruleId : change.rule.id;
        const existing = p.rules.find(rule => rule.id === ruleId);
        if ((change.action === "create") === !!existing) throw new TrustSettingsError("request_conflict");
        if (change.action === "edit" && JSON.stringify(existing!.selector) !== JSON.stringify(change.rule.selector)) throw new TrustSettingsError("target_requires_remove_add");
        if (change.action === "edit" && JSON.stringify(existing) === JSON.stringify(change.rule)) throw new TrustSettingsError("request_conflict");
        const rules = TrustedSourcesSchema.parse(change.action === "create" ? [...p.rules, change.rule] : change.action === "remove" ? p.rules.filter(r => r.id !== ruleId) : p.rules.map(r => r.id === ruleId ? change.rule : r));
        let target: AnchoredGovernancePolicy | undefined; let base: string | null = null; const identity = JSON.stringify(topology(root));
        try { target = openGovernancePolicyAnchored(root); verifyGovernancePolicyAnchored(target, p.policyHash); base = target.bytes?.toString("utf8") ?? null; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || p.policyHash !== null) throw error; }
        finally { target?.close(); }
        const proposed = edit(base, rules), requestId = id(), operationId = id();
        let githubIdentity: TrustGitHubIdentity | undefined;
        if (change.action !== "remove" && (change.rule.selector.kind === "github_repository" || change.rule.selector.kind === "github_owner")) {
          try {
            const observed = await options.github!.resolve({ principalId: principal, selector: change.rule.selector, policyHash: p.policyHash, signal,
              current: () => options.authority(principal) === auth });
            authority(principal, auth); observed.assertAuthority(); githubIdentity = observed.identity;
          } catch { throw new TrustSettingsError("repository_identity_unavailable", 503); }
        }
        if (Buffer.byteLength(JSON.stringify({ base, proposed, diff: exactDiff(base, proposed) })) > 196608) throw new TrustSettingsError("capacity", 503);
        const payload: Payload = { input, reviewId: id(), proposed, proposedHash: hash(proposed), base, topology: identity,
          rule: change.action === "remove" ? null : change.rule, ...(githubIdentity ? { githubIdentity } : {}) };
        const receipt: Receipt = { version: 1, requestId, operationId, stage: "prepared", publication: "not_published", ruleId,
          publishedTrustRevision: null, currentRule: "unknown", enforcement: "unavailable", reason: null };
        const inserted = await call<string>("insert", { requestId, brainId: brain, principalId: principal, authority: auth, expires: now() + 900000, retain: now() + 86400000,
          payload: JSON.stringify(payload), receipt: JSON.stringify(receipt) }, now());
        if (inserted === "capacity") throw new TrustSettingsError("capacity", 503);
        await options.checkpoint?.("prepared"); return requestId;
      });
      return read(principal, request);
    },
    async commit(principal: string, raw: unknown, signal?: AbortSignal) {
      const input: Commit = TrustCommitSchema.parse(raw); row(principal, input.requestId);
      await options.lock.withLock(BRAIN_LOCK_KEY, async () => {
        const r = row(principal, input.requestId), payload = JSON.parse(r.payload) as Payload;
        if (payload.reviewId !== input.reviewId || payload.proposedHash !== input.reviewedBytesHash) throw new TrustSettingsError("request_conflict");
        if (r.stage !== "prepared") return; // Readback only, including uncertain writes.
        if (r.expires_at < now()) throw new TrustSettingsError("request_expired");
        const receipt = JSON.parse(r.receipt) as Receipt;
        let published = false, proved = false, publicationOpen = true;
        const created: string[] = []; let target: AnchoredGovernancePolicy | undefined;
        const save = (stage: string, proof: string | null = null,
          boundary?: { brain: string; ruleId: string; selector: string; identity: string }) =>
          call("stage", input.requestId, stage, JSON.stringify(receipt), proof, now(), boundary);
        try {
          const p = await refresh(); row(principal, input.requestId);
          if (p.error || p.revision !== payload.input.expectedTrustRevision) throw new TrustSettingsError("stale_revision");
          if (p.policyHash !== payload.input.expectedPolicyHash) throw new TrustSettingsError("stale_base");
          if (BigInt(p.revision) >= MAX_TRUST_REVISION) throw new TrustSettingsError("capacity", 503);
          await save("writing"); await options.checkpoint?.("writing");
          if (!matchesTopology(root, payload.topology, false)) throw new TrustSettingsError("stale_base");
          target = openGovernancePolicyAnchored(root, { create: p.policyHash === null, created });
          let identityAuthority: (() => void) | undefined;
          const check = () => { signal?.throwIfAborted();
            if (!publicationOpen) throw new TrustSettingsError("publication_failed");
            row(principal, input.requestId); identityAuthority?.(); if (r.expires_at < now()) throw new TrustSettingsError("request_expired");
            if (!matchesTopology(root, payload.topology, true)) throw new TrustSettingsError("stale_base");
            verifyGovernancePolicyAnchored(target!, p.policyHash); };
          let publication: Promise<void> | undefined;
          await options.observe(receipt.operationId, (publish = async write => { write(); }) => {
            if (publication || !publicationOpen) throw new TrustSettingsError("request_conflict");
            publication = (async () => {
              // The journal's own queue/observation waits precede the fresh
              // metadata read. Journal attribution then checkpoints intervening
              // edits before the synchronous authority/publication fence.
              if (payload.rule && (payload.rule.selector.kind === "github_repository" || payload.rule.selector.kind === "github_owner")) {
                if (!payload.githubIdentity || !options.github) throw new TrustSettingsError("repository_identity_unavailable", 503);
                const observed = await options.github.resolve({ principalId: principal, selector: payload.rule.selector, policyHash: p.policyHash, signal,
                  current: () => publicationOpen && options.authority(principal) === r.authority && r.expires_at >= now() });
                if (JSON.stringify(observed.identity) !== JSON.stringify(payload.githubIdentity)) throw new TrustSettingsError("repository_identity_changed");
                identityAuthority = observed.assertAuthority;
              }
              await publish(() => {
                identityAuthority?.();
                publishProtectedPolicy(target!, Buffer.from(payload.proposed), p.policyHash, check, () => { published = true; });
              });
            })();
            // Preserve a rejected callback even if an older host observer
            // forgets to await it; this invocation still joins it below.
            void publication.catch(() => {});
            return publication;
          });
          if (!publication) throw new TrustSettingsError("publication_failed");
          await publication;
          if (!published) throw new TrustSettingsError("publication_failed");
          await options.checkpoint?.("renamed");
          // The proof is written only after THIS invocation's atomic publication
          // and directory fsync, never inferred by comparing current bytes.
          receipt.stage = "file_published"; receipt.publication = "proved";
          receipt.publishedTrustRevision = String(BigInt(p.revision) + 1n);
          await save("file_published", JSON.stringify({ operationId: receipt.operationId, principal, brain, authority: r.authority,
            baseHash: p.policyHash, expectedTrustRevision: p.revision, publishedTrustRevision: receipt.publishedTrustRevision, reviewedBytesHash: payload.proposedHash,
            ...(payload.githubIdentity ? { githubIdentity: payload.githubIdentity } : {}) }), payload.githubIdentity && payload.rule
              ? { brain, ruleId: payload.rule.id, selector: JSON.stringify(payload.rule.selector), identity: JSON.stringify(payload.githubIdentity) } : undefined); proved = true;
          await options.checkpoint?.("file_published");
          const latest = await refresh(); row(principal, input.requestId);
          if (latest.policyHash === payload.proposedHash) receipt.publishedTrustRevision = latest.revision;
          const changedRule = payload.rule ?? p.rules.find(rule => rule.id === receipt.ruleId);
          const supported = options.originEnforcement === true && !latest.error && latest.policyHash === payload.proposedHash && (changedRule?.selector.kind === "web_origin" || changedRule?.selector.kind === "tunnel_authority");
          receipt.enforcement = supported ? "enforced" : "unavailable";
          receipt.stage = supported ? "committed" : "partial";
          receipt.reason = supported ? null : "policy_saved_runtime_enforcement_unavailable";
          await save("committed"); await options.checkpoint?.("committed");
        } catch (error) {
          publicationOpen = false;
          receipt.stage = proved ? "partial" : published ? "unknown" : "refused";
          receipt.publication = proved ? "proved" : published ? "unknown" : "not_published";
          receipt.reason = error instanceof TrustSettingsError ? error.code : error instanceof ReferenceTransportError && !published
            ? "repository_identity_unavailable" : published ? "recording_failed" : "publication_failed";
          await save(receipt.stage);
        } finally { publicationOpen = false; target?.close(); if (!published) for (const path of created.reverse()) { try { rmdirSync(path); } catch { /* Concurrent content remains. */ } } }
      });
      return read(principal, input.requestId);
    },
  };
}
export type TrustSettings = ReturnType<typeof createTrustSettings>;
