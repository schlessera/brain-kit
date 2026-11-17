import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { resolvePrincipal, type Principal } from "../db/principals.js";
import type { AuthMode } from "./auth.js";

/**
 * The account partition key (#1014): which device-local partition a browser
 * may open for the account it is signed in as.
 *
 * It names "the same account on the same host and root", not a login. The
 * host has one owner and mints a new principal at every sign-in
 * (`docs/decisions/session-principals.md`), so a principal id cannot be it:
 * signing out and back in as the owner must reopen the same partition.
 *
 * - **Host.** A random seed kept in this host's UI database, made once. A
 *   different host has a different database, so a different seed. A fresh
 *   database gives a new key, which locks the old partitions: the safe way
 *   round.
 * - **Root.** The brain root's real path, so two roots sharing one database
 *   still differ.
 * - **Account.** Every owner login, passkey or password, is the one owner.
 *   The ambient modes have no login: `none` and `tailscale` admit the
 *   operator, so they are the owner too. `proxy` passes on an upstream user,
 *   and each user keeps its own partition. An agent principal never gets a
 *   key, so it can never open the owner's partition.
 *
 * The key is a one-way digest: it is a partition name, not a secret, and
 * holding it unlocks nothing on the host.
 */

const SEED_KEY = "account.partitionSeed";
const SEED_PATTERN = /^[0-9a-f]{64}$/;

function readSeed(db: Database): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(SEED_KEY) as { value: string } | null;
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value);
    return typeof value === "string" && SEED_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** This host's seed, made on first use. A corrupt one is replaced, which locks the partitions it named. */
export function accountPartitionSeed(db: Database): string {
  const existing = readSeed(db);
  if (existing) return existing;
  return db.transaction(() => {
    const raced = readSeed(db);
    if (raced) return raced;
    const seed = randomBytes(32).toString("hex");
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(SEED_KEY, JSON.stringify(seed), Date.now());
    return seed;
  }).immediate();
}

/** Which account a principal is, for partitioning; null for one that must never hold a partition. */
export function accountScope(principal: Principal, authMode: AuthMode): string | null {
  if (principal.kind === "owner") return "owner";
  if (principal.kind !== "ambient") return null;
  // A proxy names its upstream user; the ambient id is a digest of it.
  return authMode === "proxy" ? `proxy\u0000${principal.id}` : "owner";
}

// A record keeps who made it, not the auth mode it was made under.
const EVERY_AUTH_MODE: Record<AuthMode, true> = { password: true, tailscale: true, proxy: true, none: true };

/**
 * The account a principal is in every auth mode, or null when it has none
 * that holds across modes (#3962). Only this can be stored as a record's
 * durable account: today that is "owner" for an owner login. An ambient
 * principal's account depends on the mode, and an agent or system principal
 * has none, so each of those stays only itself.
 */
export function durableAccount(principal: Principal): string | null {
  const scopes = new Set((Object.keys(EVERY_AUTH_MODE) as AuthMode[]).map(mode => accountScope(principal, mode)));
  const [only] = scopes;
  return scopes.size === 1 && only !== undefined ? only : null;
}

/** Every value `durableAccount` can return. Anything else stored is corrupt. */
const DURABLE_ACCOUNTS: ReadonlySet<string> = new Set(["owner"]);

/**
 * The durable account to store beside a record's `principal_id` when the
 * server writes it (#3962): read from that principal's own row, never taken
 * from a request, a client or a model. Null for an unknown principal.
 */
export function principalAccount(db: Database, principalId: string | null | undefined): string | null {
  const principal = principalId ? resolvePrincipal(db, principalId) : null;
  return principal ? durableAccount(principal) : null;
}

/** A stored record's principal, with the durable account written beside it. */
export interface AccountRecord { principalId: string | null | undefined; account: string | null | undefined }
/** A bare id is a principal with no stored evidence: a caller, or a legacy record. */
export type AccountParty = AccountRecord | string | null | undefined;

/** What a party proves about its account; null when it is missing or its evidence is corrupt or contradictory. */
function accountEvidence(db: Database, party: AccountParty): { id: string; account: string | null } | null {
  const { principalId: id, account: stored } = typeof party === "object" && party !== null ? party : { principalId: party, account: null };
  if (!id) return null;
  if (stored !== null && stored !== undefined && !DURABLE_ACCOUNTS.has(stored)) return null;
  const principal = resolvePrincipal(db, id);
  if (!principal) return { id, account: stored ?? null };
  const account = durableAccount(principal);
  // A live row that disagrees with the stored account: neither is believed.
  if (stored !== null && stored !== undefined && stored !== account) return null;
  return { id, account };
}

/**
 * Whether `principal` is the same account as the principal a record is bound
 * to (#3952): a chat's safety history, for one, belongs to the account, so
 * another device's login continues it. A principal id always matches itself.
 * Two different ids match only when both are in the same durable account,
 * the account `accountScope` puts them in in every auth mode, which today
 * means two owner logins: the one owner mints a principal at every sign-in.
 * An ambient principal shares the owner's partition only in some modes, and
 * an agent or system principal holds none, so each matches only itself.
 *
 * A record passed with its stored account keeps that account after its
 * principal row is pruned (#3962), so a later owner login continues the
 * history the first login wrote. A bare id has no stored evidence: a missing
 * or unresolvable principal is then unknown and matches no other id. Stored
 * evidence that is corrupt, or that a live principal row contradicts, matches
 * nobody. The account is never a credential: a caller is passed as a bare id
 * and proves its account only by its own current row.
 */
export function sameAccount(db: Database, bound: AccountParty, principal: AccountParty): boolean {
  const a = accountEvidence(db, bound), b = accountEvidence(db, principal);
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  return a.account !== null && a.account === b.account;
}

export function deriveAccountPartitionKey(seed: string, root: string, scope: string): string {
  return createHash("sha256")
    .update("brain-ui:account-partition:v1\u0000")
    .update(seed)
    .update("\u0000")
    .update(root)
    .update("\u0000")
    .update(scope)
    .digest("base64url")
    .slice(0, 22);
}

/** The key for each request's principal, on one host: the seed is read once. */
export function createAccountPartitionKeys(db: Database, brainPath: string, authMode: AuthMode, hostSeed?: string) {
  let root: string | null = null;
  let seed: string | null = hostSeed ?? null;
  return (principal: Principal | undefined): string | null => {
    if (!principal) return null;
    const scope = accountScope(principal, authMode);
    if (scope === null) return null;
    if (root === null) {
      try { root = realpathSync(brainPath); } catch { root = resolve(brainPath); }
    }
    seed ??= accountPartitionSeed(db);
    return deriveAccountPartitionKey(seed, root, scope);
  };
}
