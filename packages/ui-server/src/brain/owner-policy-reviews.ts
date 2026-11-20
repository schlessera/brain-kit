/**
 * Host-owned policy reviews that no agent proposes: Settings › Apify (#3163)
 * and an incoming policy change from a sync's pull (#4256).
 *
 * This adds no policy writer. A review hands complete proposed
 * `governance.md` content to the existing policy proposals
 * (`createPolicyProposals`), the only privileged policy writer. The owner who
 * opened the review approves or declines that exact review, and only an
 * approval writes it, inside a `user` journal window like any other
 * user-history operation. Agents never reach these reviews.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOVERNANCE_POLICY_PATH } from "@schlessera/brain-common/internal/governance-policy";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { PolicyProposals, PolicyProposalTurn } from "./policy-proposal.js";

/** The `user` journal window a host-owned review's approved write happens in. */
export interface OwnerPolicyJournal {
  begin(turnId: string, metadata: { sessionId: null; actor: "user"; model: null; profile: "strict"; policyHash: string | null }, stop: (error: Error) => void, signal?: AbortSignal): Promise<void>;
  finish(turnId: string): Promise<void>;
}

/** A review the owner can decide: its identity and the review as first shown. */
export interface OwnerPolicyProposal { turn_id: string; request_id: string; review: PolicyChangeReview }

export type OwnerPolicyRefusal = "not_authorized" | "busy" | "stale" | "policy_invalid" | "not_found";

/** A refused review request, with its HTTP status and a fixed message; it never carries policy text. */
export class OwnerPolicyReviewError extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: OwnerPolicyRefusal, message: string) {
    super(message);
    this.name = "OwnerPolicyReviewError";
  }
}

export interface OwnerPolicyReviewOptions {
  root: string;
  proposals: PolicyProposals;
  journal: OwnerPolicyJournal;
  /** The live human-owner check; a review loses its approval the moment it fails. */
  authorized(principalId: string): boolean;
  /** Synthetic turn and request id prefixes, naming where the review came from. */
  turnPrefix: string;
  requestPrefix: string;
  /** The caller's refusal, with its HTTP status and fixed message. */
  fail(status: 404 | 409 | 422, code: OwnerPolicyRefusal, message: string): Error;
  /** How long an unanswered review stays open before it is declined. */
  timeoutMs?: number;
}

/** At most this many unanswered reviews per owner, per review family. */
const MAX_PENDING = 4;

export function readGovernancePolicy(root: string): string | null {
  try { return readFileSync(join(root, GOVERNANCE_POLICY_PATH), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export const policyHash = (text: string | null) => text === null ? null : createHash("sha256").update(text, "utf8").digest("hex");

export function createOwnerPolicyReviews(options: OwnerPolicyReviewOptions) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pending = new Map<string, { principalId: string; answer(approve: boolean): void; done: Promise<PolicyChangeReview> }>();
  return {
    /**
     * Open one review of the complete content `next` makes from the current
     * policy. With a `baseHash`, the current policy must still be that
     * version. Resolves once the review is pending.
     */
    async propose(principalId: string, next: (current: string | null) => string, baseHash: string | null | undefined, rationale: string,
      invalid: string): Promise<OwnerPolicyProposal> {
      if (!options.authorized(principalId)) throw options.fail(409, "not_authorized", "This owner no longer has current authority. Nothing was proposed.");
      if ([...pending.values()].filter(entry => entry.principalId === principalId).length >= MAX_PENDING)
        throw options.fail(409, "busy", "Answer the open policy reviews first. Nothing was proposed.");
      const current = readGovernancePolicy(options.root);
      if (baseHash !== undefined && policyHash(current) !== baseHash) throw options.fail(409, "stale", "The policy changed since it was read. Reload; nothing was proposed.");
      const content = next(current);
      const turnId = `${options.turnPrefix}-${randomUUID()}`, requestId = `${options.requestPrefix}-${randomUUID()}`, key = `${turnId}:${requestId}`;
      const controller = new AbortController();
      let answer!: (approve: boolean) => void;
      const decision = new Promise<boolean>(resolve => { answer = resolve; });
      let shown!: (review: PolicyChangeReview) => void, failed!: (error: unknown) => void;
      const first = new Promise<PolicyChangeReview>((resolve, reject) => { shown = resolve; failed = reject; });
      let journaled = false;
      const timer = setTimeout(() => answer(false), timeoutMs);
      timer.unref?.();
      const turn: PolicyProposalTurn = {
        principalId, turnId, sessionId: () => null, signal: controller.signal,
        isAuthorized: () => options.authorized(principalId), isAvailable: () => true,
        approve: async review => {
          shown(structuredClone(review));
          if (!await decision) return false;
          // Approved: the write happens inside a user journal window, like a revert or a removal.
          await options.journal.begin(turnId, { sessionId: null, actor: "user", model: null, profile: "strict", policyHash: review.baseHash },
            () => controller.abort(), controller.signal);
          journaled = true;
          return true;
        },
        emit: () => undefined,
      };
      const done = options.proposals.propose(turn, requestId, { content, rationale }).finally(async () => {
        clearTimeout(timer);
        pending.delete(key);
        if (journaled) await options.journal.finish(turnId).catch(() => undefined);
      });
      done.then(review => shown(review), failed);
      pending.set(key, { principalId, answer, done });
      try { return { turn_id: turnId, request_id: requestId, review: await first }; }
      catch (error) {
        answer(false);
        throw options.fail(422, "policy_invalid", `${invalid}: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`);
      }
    },
    /**
     * The owner's one answer to a review they opened. A repeated or late
     * answer reads the recorded outcome; it never writes again.
     */
    async decide(principalId: string, turnId: string, requestId: string, approve: boolean): Promise<PolicyChangeReview> {
      const entry = pending.get(`${turnId}:${requestId}`);
      if (entry && entry.principalId === principalId) {
        entry.answer(approve);
        return structuredClone(await entry.done);
      }
      const recorded = turnId.startsWith(`${options.turnPrefix}-`) ? options.proposals.read(principalId, turnId, requestId) : null;
      if (!recorded) throw options.fail(404, "not_found", "No policy review is open for this request.");
      return recorded;
    },
    /** Decline every open review: shutdown or test teardown. */
    close() { for (const entry of pending.values()) entry.answer(false); },
  };
}
export type OwnerPolicyReviews = ReturnType<typeof createOwnerPolicyReviews>;
