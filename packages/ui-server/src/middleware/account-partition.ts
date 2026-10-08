import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Principal } from "../db/principals.js";
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
export function createAccountPartitionKeys(db: Database, brainPath: string, authMode: AuthMode) {
  let root: string | null = null;
  let seed: string | null = null;
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
