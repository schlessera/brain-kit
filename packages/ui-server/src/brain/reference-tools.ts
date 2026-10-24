/**
 * The agent tools over shared reference source and managed worktrees (#2432).
 *
 * - Authority comes from the turn. The host records, when a turn starts, its
 *   principal and what its workers actually bind: the public view, the
 *   principal's private view and the turn's worker generation. A call names a
 *   repository, a revision or a worktree identity, never a principal, path or
 *   generation, and every operation runs through the services of #2429-#2431
 *   with their own authority checks.
 * - A path is reported only where this turn's workers can reach it: a source
 *   whose view the turn binds, a worktree its generation holds.
 * - Results are bounded and carry live facts once; the guidance they carry is
 *   fixed per action.
 * See docs/decisions/managed-worktrees.md#agent-tools.
 */
import { dirname } from "node:path";
import { ZodError } from "zod";
import type { Logger } from "@opentelemetry/api-logs";
import { WORKER_REFERENCE_ROOT, WORKER_WORKTREE_ROOT } from "@schlessera/brain-ui-sdk/internal";
import {
  REFERENCE_SOURCE_INPUT_SCHEMA, REFERENCE_WORKTREE_INPUT_SCHEMA, REFERENCE_WORKTREE_LIST_LIMIT,
  type ReferenceSourceView, type ReferenceToolCall, type ReferenceToolRefusalCode, type ReferenceToolResult, type ReferenceWorktreeView,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import { ReferenceSourceError, type ReferenceSourceLease, type ReferenceSources } from "./reference-source.js";
import { ReferenceWorktreeError, type ReferenceWorktree, type ReferenceWorktreeGeneration, type ReferenceWorktrees } from "./reference-worktrees.js";

/** Distinct sources one turn keeps protected from capacity eviction while it reads them. */
const TURN_LEASES = 32;
const MESSAGE_BYTES = 500;

const SOURCE_GUIDANCE = "Read only under path. Shared source is read-only and moves: a later read may see a newer commit. To edit it, or to read one fixed commit across several steps, request a managed worktree.";
const WORKTREE_GUIDANCE: Record<"request" | "access" | "renew" | "release", string> = {
  request: "Work only under path. The starting commit never moves. Edits are journaled and count toward this turn's scope limits. Only access or renewal resets the inactivity clock; release the worktree when you are done.",
  access: "Work only under path. The starting commit never moves. Edits are journaled and count toward this turn's scope limits. Only access or renewal resets the inactivity clock; release the worktree when you are done.",
  renew: "The inactivity clock restarts now. Renewal does not make the worktree available to this turn; access it to work in it.",
  release: "Released for good: it cannot be accessed, renewed or resumed again. Unfinished work in it is kept for the user to decide.",
};
const LIST_GUIDANCE = "Access a worktree to work in it this turn. Expired worktrees resume on access; released ones cannot.";

/** What one turn's workers bind, recorded when its sandbox is built. */
interface TurnAccess {
  principalId: string;
  posture: "interactive" | "voice";
  views: { public: string; private: string } | null;
  generation: ReferenceWorktreeGeneration | null;
  leases: Map<string, ReferenceSourceLease>;
}

export function createReferenceTools(options: {
  sources: Pick<ReferenceSources, "request" | "bindable">;
  worktrees?: Pick<ReferenceWorktrees, "allocate" | "access" | "renew" | "release" | "list">;
  /** Host roots whose paths never reach a result. */
  redact?: readonly string[];
  log?: Logger;
}) {
  const turns = new Map<string, TurnAccess>();
  const hidden = new Set(options.redact ?? []);

  function refusal(error: unknown): ReferenceToolResult {
    if (error instanceof ZodError) return { ok: false, code: "invalid", message: scrub(error.issues.map(issue => issue.message).join("; ")) };
    if (error instanceof ReferenceSourceError || error instanceof ReferenceWorktreeError)
      return { ok: false, code: error.code as ReferenceToolRefusalCode, message: scrub(error.message) };
    options.log?.emit({ severityText: "WARN", body: `reference tool failed: ${error instanceof Error ? error.message : String(error)}` });
    return { ok: false, code: "unavailable", message: "The reference service could not complete this request." };
  }
  /**
   * Bounded, and without host paths: the pool's and brain's roots, and any
   * other absolute path a service error carried. A `file://` repository the
   * caller named stays readable.
   */
  function scrub(text: string): string {
    let out = text;
    for (const root of hidden) if (root) out = out.split(root).join("<host>");
    out = out.replace(/(?<![\w:/.])\/(?!\/)[^\s'"`,;)]+/g, match => /^\/tmp\/brain-(?:reference\/(?:public|private)|worktrees)(?:\/|$)/.test(match) && !match.includes("/../") ? match : "<host path>");
    return Buffer.byteLength(out) > MESSAGE_BYTES ? `${Buffer.from(out).subarray(0, MESSAGE_BYTES - 3).toString().replace(/\uFFFD$/, "")}...` : out;
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const ended = (): ReferenceToolResult => ({ ok: false, code: "cancelled", message: "This turn ended before the call finished." });

  function source(access: TurnAccess, lease: ReferenceSourceLease): ReferenceSourceView {
    const bound = access.views?.[lease.domain];
    return { repository: lease.repository, revision: lease.revision, domain: lease.domain, commit: lease.commit,
      path: bound && lease.viewPath === bound ? `${WORKER_REFERENCE_ROOT}/${lease.domain}/${lease.name}` : null,
      freshness: lease.stale ? "stale" : "fresh", refreshedAt: iso(lease.refreshedAt), validatedAt: iso(lease.validatedAt),
      error: lease.error === null ? null : scrub(lease.error) };
  }
  function worktree(access: TurnAccess, item: ReferenceWorktree, turnId?: string): ReferenceWorktreeView {
    const reachable = (turnId === undefined || current(turnId, access)) && access.generation && item.generation === access.generation.id && item.state !== "released";
    return { id: item.id, repository: item.repository, revision: item.revision, domain: item.domain, startingCommit: item.commit, state: item.state,
      path: reachable ? `${WORKER_WORKTREE_ROOT}/${item.id}` : null,
      lastActivityAt: iso(item.accessedAt), expiresAt: iso(item.expiresAt), releasedAt: item.releasedAt === null ? null : iso(item.releasedAt),
      allowanceBytes: item.allowanceBytes };
  }
  /**
   * One reader per source for the rest of the turn. A turn that already holds
   * the limit of distinct sources is refused another: dropping an earlier
   * reader would end protection the turn may still rely on.
   */
  function keep(access: TurnAccess, lease: ReferenceSourceLease): boolean {
    const key = `${lease.domain}\u0000${lease.repository}\u0000${lease.revision}`;
    const held = access.leases.get(key);
    if (!held && access.leases.size >= TURN_LEASES) { lease.release(); return false; }
    held?.release();
    access.leases.set(key, lease);
    return true;
  }
  /** A call that finished after its turn ended reports nothing a worker could use. */
  const current = (turnId: string, access: TurnAccess) => turns.get(turnId) === access;

  return {
    /**
     * Record one turn's reference access before its workers start. Opens the
     * principal's views so the sandbox can bind them; a generation is passed
     * only when the sandbox binds it too.
     */
    async begin(turnId: string, input: { principalId: string; posture: "interactive" | "voice"; generation: ReferenceWorktreeGeneration | null; signal?: AbortSignal }): Promise<{ public: string; private: string } | null> {
      let views: { public: string; private: string } | null = null;
      try {
        views = await options.sources.bindable(input.principalId, input.signal);
        for (const path of [views.public, views.private]) hidden.add(dirname(dirname(path)));
      } catch (error) {
        input.signal?.throwIfAborted();
        options.log?.emit({ severityText: "WARN", body: `reference source views unavailable for this turn: ${error instanceof Error ? error.message : String(error)}` });
      }
      turns.set(turnId, { principalId: input.principalId, posture: input.posture, views, generation: input.generation, leases: new Map() });
      return views;
    },
    /** The turn ended: its readers stop protecting their sources. */
    end(turnId: string): void {
      const access = turns.get(turnId);
      turns.delete(turnId);
      for (const lease of access?.leases.values() ?? []) lease.release();
    },
    async call(turnId: string, principalId: string, call: ReferenceToolCall, signal?: AbortSignal): Promise<ReferenceToolResult> {
      const access = turns.get(turnId);
      // Only a turn whose workers were prepared for reference access, and only its own principal.
      if (!access || access.principalId !== principalId)
        return { ok: false, code: "unavailable", message: "This turn's workers have no managed reference access; it is available to interactive governed and strict turns only." };
      try {
        if (call.tool === "reference_source") {
          const input = REFERENCE_SOURCE_INPUT_SCHEMA.parse(call.input);
          if (!access.views) return { ok: false, code: "unavailable", message: "Shared reference source cannot be bound into this turn's workers." };
          const lease = await options.sources.request({ principalId: access.principalId, repository: input.repository, revision: input.revision, signal });
          if (!current(turnId, access)) { lease.release(); return ended(); }
          if (!keep(access, lease)) return { ok: false, code: "busy", message: `This turn already reads ${TURN_LEASES} reference sources; use one of them, or request a worktree.` };
          return { ok: true, source: source(access, lease), guidance: SOURCE_GUIDANCE };
        }
        const input = REFERENCE_WORKTREE_INPUT_SCHEMA.parse(call.input);
        const worktrees = options.worktrees;
        if (!worktrees) return { ok: false, code: "unavailable", message: "Managed worktrees are unavailable on this host." };
        if (input.action === "list") {
          const all = worktrees.list(access.principalId).sort((a, b) => b.accessedAt - a.accessedAt || a.id.localeCompare(b.id));
          return { ok: true, action: "list", worktrees: all.slice(0, REFERENCE_WORKTREE_LIST_LIMIT).map(item => worktree(access, item)),
            truncated: all.length > REFERENCE_WORKTREE_LIST_LIMIT, guidance: LIST_GUIDANCE };
        }
        if (access.posture === "voice") return { ok: false, code: "unavailable", message: "Managed worktrees cannot be changed from a voice turn." };
        // A call whose turn ended while it waited changes nothing.
        if (!current(turnId, access)) return ended();
        if (input.action === "renew") {
          const item = await worktrees.renew({ worktreeId: input.worktreeId!, principalId: access.principalId });
          return { ok: true, action: "renew", worktree: worktree(access, item, turnId), guidance: WORKTREE_GUIDANCE.renew };
        }
        if (input.action === "release") {
          const item = await worktrees.release({ worktreeId: input.worktreeId!, principalId: access.principalId, signal });
          return { ok: true, action: "release", worktree: worktree(access, item, turnId), guidance: WORKTREE_GUIDANCE.release };
        }
        // Requesting and accessing grant to this turn's generation: without one, nothing is allocated.
        const generation = access.generation;
        if (!generation) return { ok: false, code: "unavailable", message: "This turn's workers hold no worktree generation, so no worktree can be made available to them; its change journal may not be recording." };
        if (input.action === "access") {
          const item = await worktrees.access({ worktreeId: input.worktreeId!, principalId: access.principalId, generation: generation.id, signal });
          return { ok: true, action: "access", worktree: worktree(access, item, turnId), guidance: WORKTREE_GUIDANCE.access };
        }
        const allocated = await worktrees.allocate({ principalId: access.principalId, repository: input.repository, revision: input.revision, signal });
        try {
          if (!current(turnId, access)) throw new ReferenceWorktreeError("unavailable", "This turn ended before the worktree could be made available to it.");
          const item = await worktrees.access({ worktreeId: allocated.id, principalId: access.principalId, generation: generation.id, signal });
          return { ok: true, action: "request", worktree: worktree(access, item, turnId), guidance: WORKTREE_GUIDANCE.request };
        } catch (error) {
          // Nothing reached a worker: release the untouched worktree rather than leave it to expire.
          await worktrees.release({ worktreeId: allocated.id, principalId: access.principalId })
            .catch(cleanup => options.log?.emit({ severityText: "WARN", body: `unreachable worktree was not released: ${String(cleanup)}` }));
          throw error;
        }
      } catch (error) { return refusal(error); }
    },
  };
}
export type ReferenceTools = ReturnType<typeof createReferenceTools>;
