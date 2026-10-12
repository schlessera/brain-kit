/** The only privileged policy writer. Worker input is never approval authority. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { Database } from "bun:sqlite";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { parseGovernancePolicy, GOVERNANCE_POLICY_PATH, GOVERNANCE_POLICY_MAX_BYTES } from "@schlessera/brain-common/internal/governance-policy";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { PROPOSE_POLICY_CHANGE_INPUT_SCHEMA, type PolicyChangeInput, type PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
class Refusal extends Error { constructor(readonly state: "stale" | "invalid" | "refused", message: string) { super(message); } }
interface Dir { fd: number; path: string; dev: number; ino: number }
interface Target { chain: Dir[]; at: string; bytes: Buffer | null; mode?: number }
const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
function read(at: string): { bytes: Buffer | null; mode?: number } {
  let fd: number;
  try { fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null }; throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Refusal("refused", "Policy must be an ordinary file with one link. Nothing was written.");
    if (info.size > GOVERNANCE_POLICY_MAX_BYTES) throw new Refusal("refused", "Policy exceeds the 1 MiB bound. Nothing was written.");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length > GOVERNANCE_POLICY_MAX_BYTES || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new Refusal("stale", "Policy changed during review. Nothing was written.");
    return { bytes, mode: info.mode & 0o7777 };
  } finally { closeSync(fd); }
}
function close(target: Target) { for (const dir of target.chain.reverse()) closeSync(dir.fd); }
function open(root: string, create = false, created: string[] = []): Target {
  const chain: Dir[] = [];
  try {
    let visible = root;
    const parts = GOVERNANCE_POLICY_PATH.split("/");
    for (let i = 0; i < parts.length; i++) {
      const anchored = i === 0 ? root : `/proc/self/fd/${chain.at(-1)!.fd}/${parts[i - 1]}`;
      if (create && i > 0) {
        try { mkdirSync(anchored, { mode: 0o755 }); created.push(visible); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const fd = openSync(anchored, flags), info = fstatSync(fd);
      chain.push({ fd, path: visible, dev: info.dev, ino: info.ino });
      visible = join(visible, parts[i]!);
    }
    const at = `/proc/self/fd/${chain.at(-1)!.fd}/governance.md`;
    return { chain, at, ...read(at) };
  } catch (error) { for (const dir of chain.reverse()) closeSync(dir.fd); throw error; }
}
function verify(target: Target, expected: string | null) {
  for (const dir of target.chain) {
    const named = lstatSync(dir.path, { throwIfNoEntry: false });
    if (!named?.isDirectory() || named.isSymbolicLink() || named.dev !== dir.dev || named.ino !== dir.ino)
      throw new Refusal("refused", "Policy ancestry changed. Nothing was written.");
  }
  const current = read(target.at).bytes;
  if ((current === null ? null : hash(current)) !== expected)
    throw new Refusal("stale", "The policy changed since this was proposed. Nothing was written. A fresh proposal is required.");
}
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
function split(text: string) {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? { frontmatter: match[0], body: text.slice(match[0].length) } : { frontmatter: "", body: text };
}
function sections(before: string, after: string) {
  let a: Record<string, unknown> = {};
  try { a = parseFrontmatter(before).data; } catch { /* Invalid current bytes are still reviewed exactly. */ }
  const b = parseFrontmatter(after).data;
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
  isAuthorized(): boolean; isAvailable(): boolean;
  approve(review: PolicyChangeReview): Promise<boolean>;
  emit(review: PolicyChangeReview): void;
}
export function createPolicyProposals(options: {
  root: string; db: Database; lock: Pick<KeyedLock, "withLock">;
  /** The journal service owns exact user/policy attribution and its live recording window. */
  observeUserPolicy(turnId: string, approvedWrite: () => void): void;
  recordEvent(review: PolicyChangeReview, turn: PolicyProposalTurn): void;
  /** Deterministic race/revalidation fixtures, never wired to a worker. */
  beforeCommit?(): void;
  validate?: typeof parseGovernancePolicy;
}) {
  const root = realpathSync(options.root), db = options.db;
  const active = new Map<string, Promise<PolicyChangeReview>>();
  const readReview = (principalId: string, turnId: string, requestId: string, sessionId?: string): PolicyChangeReview | null => {
    const row = db.query("SELECT review, session_id FROM policy_proposals WHERE principal_id = ? AND turn_id = ? AND request_id = ?")
      .get(principalId, turnId, requestId) as { review: string; session_id: string | null } | null;
    if (!row || (sessionId !== undefined && sessionId !== row.session_id)) return null;
    const review = JSON.parse(row.review) as PolicyChangeReview;
    // A crash never reactivates approval or blindly repeats a write.
    return !active.has(`${turnId}:${requestId}`) && ["pending", "writing"].includes(review.state)
      ? { ...review, state: "unknown", message: "The host lost this request's completion receipt. Check again only reads this request; it cannot repeat the write." } : review;
  };
  const save = (review: PolicyChangeReview, turn: PolicyProposalTurn) => {
    db.query("UPDATE policy_proposals SET review = ?, session_id = (SELECT id FROM sessions WHERE id = ?) WHERE turn_id = ? AND request_id = ?")
      .run(JSON.stringify(review), turn.sessionId(), review.turnId, review.requestId);
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
    bind(turnId: string, sessionId: string) { db.query("UPDATE policy_proposals SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId); },
    async propose(turn: PolicyProposalTurn, requestId: string, raw: PolicyChangeInput): Promise<PolicyChangeReview> {
      const authority = () => {
        if (turn.signal.aborted || !turn.isAuthorized() || !turn.isAvailable()) throw new Refusal("refused", "This request no longer has current interactive authority. Nothing was written.");
      };
      authority();
      if (!requestId || requestId.length > 200) throw new Error("Invalid policy request identity.");
      if (process.platform !== "linux") throw new Error("Policy publication requires descriptor-anchored Linux support.");
      const input = PROPOSE_POLICY_CHANGE_INPUT_SCHEMA.parse(raw);
      const inputHash = hash(JSON.stringify(input)), key = `${turn.turnId}:${requestId}`;
      const row = db.query("SELECT input_hash FROM policy_proposals WHERE turn_id = ? AND request_id = ?").get(turn.turnId, requestId) as { input_hash: string } | null;
      if (row) {
        if (row.input_hash !== inputHash || !readReview(turn.principalId, turn.turnId, requestId)) throw new Error("Policy proposal id already belongs to another request.");
        return active.get(key) ?? readReview(turn.principalId, turn.turnId, requestId)!;
      }
      const bytes = Buffer.from(input.content, "utf8"), validate = options.validate ?? parseGovernancePolicy;
      const checked = validate(bytes);
      if (!checked.ok || checked.status !== "valid") throw new Error(`Invalid policy: ${checked.errors.join("; ")}`);
      const before = base(root), beforeText = before?.toString("utf8") ?? "", a = split(beforeText), b = split(input.content);
      const review: PolicyChangeReview = { requestId, turnId: turn.turnId, path: GOVERNANCE_POLICY_PATH,
        state: "pending", rationale: input.rationale, baseHash: before === null ? null : hash(before), proposedHash: hash(bytes),
        frontmatterDiff: diff(a.frontmatter, b.frontmatter), bodyChanged: a.body !== b.body, bodyDiff: diff(a.body, b.body),
        sections: sections(beforeText, input.content), warnings: checked.warnings, message: "Policy change proposed. Review before approving." };
      db.query(`INSERT INTO policy_proposals (request_id, turn_id, principal_id, session_id, input_hash, review, created_at)
        VALUES (?, ?, ?, (SELECT id FROM sessions WHERE id = ?), ?, ?, ?)`)
        .run(requestId, turn.turnId, turn.principalId, turn.sessionId(), inputHash, JSON.stringify(review), Date.now());
      const work = (async () => {
        let committed = false;
        try {
          if (!await turn.approve(review)) { review.state = "declined"; review.message = "Policy change declined. Nothing was written."; }
          else {
            review.state = "writing"; review.message = "Writing the policy…"; save(review, turn);
            await options.lock.withLock(BRAIN_LOCK_KEY, async () => {
              authority();
              const currentValidation = validate(bytes);
              if (!currentValidation.ok || currentValidation.status !== "valid") throw new Refusal("invalid", `This proposal no longer passes validation: ${currentValidation.errors.join("; ")}. Nothing was written. A fresh proposal is required.`);
              const created: string[] = [];
              let target: Target | undefined, temp: string | undefined;
              try {
                target = open(root, review.baseHash === null, created); verify(target, review.baseHash);
                temp = `/proc/self/fd/${target.chain.at(-1)!.fd}/.brain-policy-${crypto.randomUUID()}`;
                const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, target.mode ?? 0o644);
                try { writeFileSync(fd, bytes); if (target.mode !== undefined) fchmodSync(fd, target.mode); fsyncSync(fd); } finally { closeSync(fd); }
                options.beforeCommit?.(); authority(); verify(target, review.baseHash);
                // No awaited code between final authority/base/topology check and publication.
                options.observeUserPolicy(turn.turnId, () => {
                  // Journal observation may precede this callback; recheck at the exact write.
                  authority(); verify(target!, review.baseHash);
                  if (review.baseHash === null) linkSync(temp!, target!.at); else renameSync(temp!, target!.at);
                  committed = true; fsyncSync(target!.chain.at(-1)!.fd);
                });
                review.state = "updated"; review.message = "Policy updated. Applies from the next turn.";
                options.recordEvent(review, turn);
              } finally {
                if (temp) { try { unlinkSync(temp); } catch { /* Rename consumed it. */ } }
                if (target) close(target);
                if (!committed) for (const directory of created.reverse()) { try { rmdirSync(directory); } catch { /* Preserve concurrent files. */ } }
              }
            }, { signal: turn.signal });
          }
        } catch (error) {
          review.state = committed ? "unknown" : error instanceof Refusal ? error.state : "refused";
          review.message = committed ? "Policy bytes were published, but the host could not retain the complete recording receipt. Check again reads this request; it never repeats the write."
            : error instanceof Refusal ? error.message : "The host refused this proposal. Nothing was written. A fresh proposal is required.";
        }
        save(review, turn); return structuredClone(review);
      })();
      active.set(key, work);
      try { return await work; } finally { active.delete(key); }
    },
  };
}
export type PolicyProposals = ReturnType<typeof createPolicyProposals>;
