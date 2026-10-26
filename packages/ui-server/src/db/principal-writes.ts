/**
 * Principal writes on the request path, off the event loop (#2850). The
 * hosted server's authentication touches a principal's `last_seen_at`,
 * prunes terminal principals, resolves ambient principals and creates a
 * login's principal on every few requests; each of those commits on the
 * `ui.db` write worker at `synchronous=FULL` instead of the app connection.
 * The procedures are the synchronous writers in `principals.ts`, run on the
 * write connection. Account administration uses `account-writes.ts` on the
 * same worker.
 */
import type { Database } from "bun:sqlite";

import { procedureCaller, type SqliteWriter, type WireError, type WriteProcedures } from "./write-worker.js";
import {
  createPrincipal, isLastSeenStale, isUsablePrincipal, PRINCIPAL_PRUNE_INTERVAL_MS, PrincipalCreatorNotUsableError,
  PrincipalCredentialNotFoundError, PrincipalLimitError, prunePrincipals, resolveAmbientPrincipal, resolvePrincipal,
  touchLastSeen, ambientPrincipalId, type AmbientPrincipalSource, type CreatePrincipalInput, type Principal,
} from "./principals.js";

export const url = import.meta.url;

export function setup(db: Database): WriteProcedures {
  return {
    touch: (id: string, now: number) => touchLastSeen(db, id, now),
    prune: (now: number) => prunePrincipals(db, now),
    ambient: (source: AmbientPrincipalSource, identity: string, label: string) => resolveAmbientPrincipal(db, source, identity, label),
    // A login prunes first, so expired rows never count against its cap.
    login(input: CreatePrincipalInput, now: number) { prunePrincipals(db, now); return createPrincipal(db, input); },
  };
}

/** A refusal keeps its class across the worker. */
function revive(error: WireError): Error | undefined {
  const as = <E extends Error>(made: E) => Object.assign(made, { message: error.message });
  switch (error.name) {
    case "PrincipalLimitError": return as(new PrincipalLimitError());
    case "PrincipalCredentialNotFoundError": return as(new PrincipalCredentialNotFoundError(""));
    case "PrincipalCreatorNotUsableError": return as(new PrincipalCreatorNotUsableError(undefined));
    default: return undefined;
  }
}

export interface PrincipalWrites {
  /** Records that `id` was seen at `now`, at most once a minute; never waits. */
  touch(principal: Principal, now: number): Principal;
  /** Prunes terminal principals at most once an interval; never waits. */
  pruneIfDue(now: number): void;
  /** The ambient principal for an identity: read at once when it is current, created or relabelled where it commits. */
  ambient(source: AmbientPrincipalSource, identity: string, label: string): Principal | Promise<Principal>;
  /** A verified login's new principal, once it has committed. */
  login(input: CreatePrincipalInput): Promise<Principal>;
}

const registered = new WeakMap<Database, PrincipalWrites>();

/** The principal writes for `db`: the ones the app registered with its writer, else inline on `db`. */
export function principalWrites(db: Database): PrincipalWrites {
  let writes = registered.get(db);
  if (!writes) { writes = createPrincipalWrites(db); registered.set(db, writes); }
  return writes;
}

/** Registers `db`'s principal writes on `writer` (#2850). */
export function registerPrincipalWrites(db: Database, writer: SqliteWriter): PrincipalWrites {
  const writes = createPrincipalWrites(db, writer);
  registered.set(db, writes);
  return writes;
}

function createPrincipalWrites(db: Database, writer?: SqliteWriter): PrincipalWrites {
  const call = procedureCaller(db, { url, setup }, undefined, writer, revive);
  // A touch submitted and not yet settled: the next request does not submit another.
  const touching = new Set<string>();
  let lastPrunedAt: number | undefined;
  const quietly = (done: Promise<unknown>) => { done.catch(() => { /* Advisory bookkeeping: the next interval tries again. */ }); return done; };
  const touch = (principal: Principal, now: number): Principal => {
    if (!isLastSeenStale(principal.lastSeenAt, now) || touching.has(principal.id)) return principal;
    touching.add(principal.id);
    void quietly(call("touch", principal.id, now)).finally(() => touching.delete(principal.id));
    return { ...principal, lastSeenAt: now };
  };
  return {
    touch,
    pruneIfDue(now) {
      if (lastPrunedAt !== undefined && now >= lastPrunedAt && now - lastPrunedAt < PRINCIPAL_PRUNE_INTERVAL_MS) return;
      lastPrunedAt = now;
      void quietly(call("prune", now));
    },
    ambient(source, identity, label) {
      // The common case writes nothing but the throttled touch.
      const existing = resolvePrincipal(db, ambientPrincipalId(source, identity));
      if (existing && existing.label === label && existing.kind === "ambient" && existing.authMethod === "ambient" && isUsablePrincipal(existing, Date.now()))
        return touch(existing, Date.now());
      return call<Principal>("ambient", source, identity, label);
    },
    login: input => call<Principal>("login", input, Date.now()),
  };
}
