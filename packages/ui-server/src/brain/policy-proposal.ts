/** The only privileged policy writer. Worker input is never approval authority. */
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, openSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { Database } from "bun:sqlite";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { frontmatterBlock } from "@schlessera/brain-common/internal/frontmatter-block";
import { parseGovernancePolicy, GOVERNANCE_POLICY_PATH, GovernancePolicyReadError, openGovernancePolicyAnchored, verifyGovernancePolicyAnchored,
  type AnchoredGovernancePolicy, type GovernancePolicyReadRefusal } from "@schlessera/brain-common/internal/governance-policy";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { PROPOSE_POLICY_CHANGE_INPUT_SCHEMA, type PolicyChangeInput, type PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { admitHeld, AuthorityHeld, retryHeld, type AuthorityHold } from "./authority-hold.js";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import * as proposalWrites from "./policy-proposal-writes.js";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
class Refusal extends Error { constructor(readonly state: "stale" | "invalid" | "refused", message: string) { super(message); } }
type Target = AnchoredGovernancePolicy;
/** The writer's review states and wording for common's anchored-read refusals. */
const REFUSALS: Record<GovernancePolicyReadRefusal, [Refusal["state"], string]> = {
  not_regular: ["refused", "Policy must be an ordinary file with one link. Nothing was written."],
  oversize: ["refused", "Policy exceeds the 1 MiB bound. Nothing was written."],
  changed: ["stale", "Policy changed during review. Nothing was written."],
  ancestry: ["refused", "Policy ancestry changed. Nothing was written."],
  mismatch: ["stale", "The policy changed since this was proposed. Nothing was written. A fresh proposal is required."],
};
function refusing<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof GovernancePolicyReadError) throw new Refusal(...REFUSALS[error.refusal]); throw error; }
}
const open = (root: string, create = false, created: string[] = []): Target => refusing(() => openGovernancePolicyAnchored(root, { create, created }));
const verify = (target: Target, expected: string | null) => { refusing(() => verifyGovernancePolicyAnchored(target, expected)); };
const close = (target: Target) => target.close();
function base(root: string): Buffer | null {
  let target: Target;
  try { target = open(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { verify(target, target.bytes === null ? null : hash(target.bytes)); return target.bytes; }
  finally { close(target); }
}
/** Exact bytes, without a semantic protection classifier. Unchanged lines stay visible. */
function diff(before: string, after: string) {
  if (before === after) return "";
  return before.split("\n").map(line => `- ${line}`).concat(after.split("\n").map(line => `+ ${line}`)).join("\n");
}
/**
 * The review's frontmatter/body split ends the frontmatter where
 * `parseFrontmatter`, and so the policy validator, ends it
 * (`frontmatterBlock`, #2507). The approver then sees every enforced line as
 * frontmatter and no unenforced line as frontmatter: an unclosed block is
 * frontmatter to the end of the file, and a closing `---x` ends it after the
 * dashes. A `...` line does not close it, because the parser does not close
 * there. One rule is kept from the old splitter: when only whitespace follows
 * the closing dashes, the whole closing line and its line ending are
 * frontmatter rather than the start of the body.
 */
function split(text: string) {
  const block = frontmatterBlock(text);
  if (!block) return { frontmatter: "", body: text };
  const rest = block.closed ? /^[ \t]*(?:\r?\n|$)/.exec(text.slice(block.innerEnd + 3)) : null;
  const end = rest ? block.innerEnd + 3 + rest[0].length : block.end;
  return { frontmatter: text.slice(0, end), body: text.slice(end) };
}
function sections(before: string, after: string) {
  let a: Record<string, unknown> = {};
  try { a = parseFrontmatter(before, { dataOnly: true }).data; } catch { /* Invalid current bytes are still reviewed exactly. */ }
  const b = parseFrontmatter(after, { dataOnly: true }).data;
  const changed: string[] = [];
  const walk = (left: unknown, right: unknown, path: string) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    } else changed.push(path);
  };
  walk(a, b, ""); return changed.filter(Boolean);
}
export interface PolicyProposalTurn {
  principalId: string; turnId: string; sessionId(): string | null; signal: AbortSignal;
  /** Whether the policy may publish now; false while a `hold` is active as well as once authority is gone. */
  isAuthorized(): boolean; isAvailable(): boolean;
  /**
   * A scope pause, which stops publication without revoking authority (#2853):
   * waited for, bounded, outside the lock. One the policy's own journal
   * observation raises publishes nothing and lets that observation complete;
   * the wait runs after it, and a fresh attempt checks everything again (#2870).
   */
  hold?: AuthorityHold;
  approve(review: PolicyChangeReview): Promise<boolean>;
  emit(review: PolicyChangeReview): void;
}
export function createPolicyProposals(options: {
  root: string; db: Database; lock: Pick<KeyedLock, "withLock">;
  /** The journal service owns exact user/policy attribution and its live recording window. */
  observeUserPolicy(turnId: string, approvedWrite: () => void): void | Promise<void>;
  /** A returned promise is the event's commit (#2850); its failure is the receipt's. */
  recordEvent(review: PolicyChangeReview, turn: PolicyProposalTurn): unknown;
  /** Where a proposal's writes commit: the app's write worker (#2850). Absent: on `db`, at once. */
  writer?: SqliteWriter;
  /** Deterministic race/revalidation fixtures, never wired to a worker. */
  beforeCommit?(): void;
  validate?: typeof parseGovernancePolicy;
}) {
  const db = options.db;
  const call = procedureCaller(db, proposalWrites, undefined, options.writer);
  let tail: Promise<void> = Promise.resolve();
  const submit = (name: string, ...args: unknown[]) => {
    const done = call(name, ...args);
    tail = done.then(() => {}, () => {});
    return done;
  };
  // App startup also serves hosts whose brain has not been provisioned yet.
  // Keep existing roots canonical; a missing root is resolved at the operation,
  // never created by policy publication.
  let resolvedRoot: string | undefined;
  try { resolvedRoot = realpathSync(options.root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const active = new Map<string, Promise<PolicyChangeReview>>();
  const pendingInputs = new Map<string, { hash: string; principalId: string }>();
  const readReview = (principalId: string, turnId: string, requestId: string, sessionId?: string): PolicyChangeReview | null => {
    const row = db.query("SELECT review, session_id FROM policy_proposals WHERE principal_id = ? AND turn_id = ? AND request_id = ?")
      .get(principalId, turnId, requestId) as { review: string; session_id: string | null } | null;
    if (!row || (sessionId !== undefined && sessionId !== row.session_id)) return null;
    const review = JSON.parse(row.review) as PolicyChangeReview;
    // A crash never reactivates approval or blindly repeats a write.
    return !active.has(`${turnId}:${requestId}`) && ["pending", "writing"].includes(review.state)
      ? { ...review, state: "unknown", message: "The host lost this request's completion receipt. Check again only reads this request; it cannot repeat the write." } : review;
  };
  const save = async (review: PolicyChangeReview, turn: PolicyProposalTurn) => {
    await submit("save", review, turn.sessionId());
    turn.emit(review);
  };
  return {
    read: readReview,
    attachHistory(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
      const rows = db.query("SELECT review FROM policy_proposals WHERE session_id = ?").all(sessionId) as { review: string }[];
      const values = rows.map(row => JSON.parse(row.review) as PolicyChangeReview);
      const reviews = new Map(values.map(review => [`${review.turnId}:${review.requestId}`, review] as const));
      const unique = new Map(values.filter(review => values.filter(value => value.requestId === review.requestId).length === 1).map(review => [review.requestId, review] as const));
      return messages.map(message => ({ ...message, toolCalls: message.toolCalls.map(tool => {
        const review = message.turnId ? reviews.get(`${message.turnId}:${tool.id}`) : unique.get(tool.id);
        return review ? { ...tool, policyChange: review } : tool;
      }) }));
    },
    bind(turnId: string, sessionId: string): Promise<unknown> {
      return submit("bind", turnId, sessionId);
    },
    /** Settles once every write submitted before it has settled: history joins proposals by session. */
    async settled() { let waiting: Promise<void>; do { waiting = tail; await waiting; } while (waiting !== tail); },
    async propose(turn: PolicyProposalTurn, requestId: string, raw: PolicyChangeInput): Promise<PolicyChangeReview> {
      const held = () => !turn.signal.aborted && !turn.isAuthorized() && !!turn.hold?.active();
      const authority = (waits = true) => {
        if (waits && held()) throw new AuthorityHeld();
        if (turn.signal.aborted || !turn.isAuthorized() || !turn.isAvailable()) throw new Refusal("refused", "This request no longer has current interactive authority. Nothing was written.");
      };
      // An attempt that meets a hold has published nothing; it runs again once the hold clears.
      const budget: { deadline?: number } = {};
      const expired = (): never => { throw new Refusal("refused", "This request stayed held by a scope pause past the wait bound. Nothing was written."); };
      const afterHolds = <T>(attempt: () => T | Promise<T>) => retryHeld(turn.hold, turn.signal, attempt, expired, budget);
      const admitted = admitHeld(turn.hold, turn.signal, () => authority(), expired, budget);
      if (admitted) await admitted;
      if (!requestId || requestId.length > 200) throw new Error("Invalid policy request identity.");
      if (process.platform !== "linux") throw new Error("Policy publication requires descriptor-anchored Linux support.");
      const input = PROPOSE_POLICY_CHANGE_INPUT_SCHEMA.parse(raw);
      const inputHash = hash(JSON.stringify(input)), key = `${turn.turnId}:${requestId}`;
      const pending = pendingInputs.get(key);
      if (pending) {
        if (pending.hash !== inputHash || pending.principalId !== turn.principalId) throw new Error("Policy proposal id already belongs to another request.");
        return active.get(key)!;
      }
      const row = db.query("SELECT input_hash FROM policy_proposals WHERE turn_id = ? AND request_id = ?").get(turn.turnId, requestId) as { input_hash: string } | null;
      if (row) {
        if (row.input_hash !== inputHash || !readReview(turn.principalId, turn.turnId, requestId)) throw new Error("Policy proposal id already belongs to another request.");
        return active.get(key) ?? readReview(turn.principalId, turn.turnId, requestId)!;
      }
      const bytes = Buffer.from(input.content, "utf8"), validate = options.validate ?? parseGovernancePolicy;
      const checked = validate(bytes);
      if (!checked.ok || checked.status !== "valid") throw new Error(`Invalid policy: ${checked.errors.join("; ")}`);
      const root = resolvedRoot ??= realpathSync(options.root);
      const before = base(root), beforeText = before?.toString("utf8") ?? "", a = split(beforeText), b = split(input.content);
      const review: PolicyChangeReview = { requestId, turnId: turn.turnId, path: GOVERNANCE_POLICY_PATH,
        state: "pending", rationale: input.rationale, baseHash: before === null ? null : hash(before), proposedHash: hash(bytes),
        frontmatterDiff: diff(a.frontmatter, b.frontmatter), bodyChanged: a.body !== b.body, bodyDiff: diff(a.body, b.body),
        sections: sections(beforeText, input.content), warnings: checked.warnings, message: "Policy change proposed. Review before approving." };
      pendingInputs.set(key, { hash: inputHash, principalId: turn.principalId });
      const work = (async () => {
        await submit("insert", requestId, turn.turnId, turn.principalId, turn.sessionId(), inputHash, review, Date.now());
        let committed = false;
        try {
          if (!await turn.approve(review)) { review.state = "declined"; review.message = "Policy change declined. Nothing was written."; }
          else {
            review.state = "writing"; review.message = "Writing the policy…"; await save(review, turn);
            await afterHolds(() => options.lock.withLock(BRAIN_LOCK_KEY, async () => {
              authority();
              const currentValidation = validate(bytes);
              if (!currentValidation.ok || currentValidation.status !== "valid") throw new Refusal("invalid", `This proposal no longer passes validation: ${currentValidation.errors.join("; ")}. Nothing was written. A fresh proposal is required.`);
              const created: string[] = [];
              let target: Target | undefined, temp: string | undefined, unpublished = false;
              try {
                target = open(root, review.baseHash === null, created); verify(target, review.baseHash);
                options.beforeCommit?.(); authority(); verify(target, review.baseHash);
                // No awaited code between final authority/base/topology check and publication.
                await options.observeUserPolicy(turn.turnId, () => {
                  // Journal observation may precede this callback; recheck at the exact write.
                  // A scope pause that observation raised is not a failed observation: stage
                  // nothing and return, so it completes and the pause can be answered (#2870).
                  if (held()) { unpublished = true; return; }
                  authority(false); verify(target!, review.baseHash);
                  // The operation owns the staging inode for this synchronous
                  // callback only. Both journal observations are outside its
                  // lifetime; no path/prefix ignore can hide real worker files.
                  const staging = `/proc/self/fd/${target!.directories.at(-1)!.fd}/.brain-policy-${crypto.randomUUID()}`;
                  let publicationFailed = false, publicationError: unknown;
                  try {
                    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, target!.mode ?? 0o644);
                    temp = staging; // Only a successfully created inode belongs to this operation.
                    try { writeFileSync(fd, bytes); if (target!.mode !== undefined) fchmodSync(fd, target!.mode); fsyncSync(fd); } finally { closeSync(fd); }
                    if (held()) unpublished = true;
                    else {
                      authority(false); verify(target!, review.baseHash);
                      if (review.baseHash === null) linkSync(temp, target!.at); else renameSync(temp, target!.at);
                      committed = true;
                    }
                  } catch (error) { publicationFailed = true; publicationError = error; }
                  // First publication uses link rather than an overwriting
                  // rename; unlink its remaining name before observation.
                  if (temp) {
                    try { unlinkSync(temp); temp = undefined; }
                    catch (error) {
                      if ((error as NodeJS.ErrnoException).code === "ENOENT") temp = undefined;
                      else { if (!publicationFailed) publicationError = error; publicationFailed = true; }
                    }
                  }
                  if (publicationFailed) throw publicationError;
                  if (unpublished) return;
                  fsyncSync(target!.directories.at(-1)!.fd);
                });
                // Nothing was published and the observation, its hold and (on
                // unwinding) the lock are released: wait out the pause and retry.
                if (unpublished) throw new AuthorityHeld();
                review.state = "updated"; review.message = "Policy updated. Applies from the next turn.";
                await options.recordEvent(review, turn);
              } finally {
                if (temp) { try { unlinkSync(temp); } catch { /* Rename consumed it. */ } }
                if (target) close(target);
                if (!committed) for (const directory of created.reverse()) { try { rmdirSync(directory); } catch { /* Preserve concurrent files. */ } }
              }
            }, { signal: turn.signal }));
          }
        } catch (error) {
          review.state = committed ? "unknown" : error instanceof Refusal ? error.state : "refused";
          review.message = committed ? "Policy bytes were published, but the host could not retain the complete recording receipt. Check again reads this request; it never repeats the write."
            : error instanceof Refusal ? error.message : "The host refused this proposal. Nothing was written. A fresh proposal is required.";
        }
        await save(review, turn); return structuredClone(review);
      })();
      active.set(key, work);
      try { return await work; } finally { active.delete(key); pendingInputs.delete(key); }
    },
  };
}
export type PolicyProposals = ReturnType<typeof createPolicyProposals>;
