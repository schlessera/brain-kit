/** Account/security administration on the shared FULL write worker (#3002). */
import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter, type WireError } from "./write-worker.js";
import { createPrincipal, revokePrincipal, revokeAllPrincipals, revokeByCredential, PrincipalLimitError,
  PrincipalCredentialNotFoundError, PrincipalCreatorNotUsableError, type CreatePrincipalInput } from "./principals.js";
import { createReferenceGrant, revokeReferenceGrant, ReferenceRepositoryError, ReferenceGrantPrincipalError,
  ReferenceGrantDuplicateError, ReferenceGrantLimitError } from "./reference-grants.js";
import { accountPartitionSeed } from "../middleware/account-partition.js";

export const url = import.meta.url;

export interface PasskeyRegistration {
  id: string; publicKey: Uint8Array; counter: number; transports: string | null; rpId: string;
  aaguid: string | null; deviceType: string; backedUp: number; label: string | null; createdAt: number;
}

export function setup(db: Database) {
  return {
    createPrincipal: (input: CreatePrincipalInput) => createPrincipal(db, input),
    revokePrincipal: (id: string, now: number) => revokePrincipal(db, id, now),
    revokeAll: (now: number) => revokeAllPrincipals(db, now),
    createGrant: (input: Parameters<typeof createReferenceGrant>[1]) => createReferenceGrant(db, input),
    revokeGrant: (input: Parameters<typeof revokeReferenceGrant>[1]) => revokeReferenceGrant(db, input),
    passkeyCounter(id: string, rpId: string, counter: number, at: number) {
      const row = db.query("SELECT rp_id FROM passkey_credentials WHERE id = ?").get(id) as { rp_id: string } | null;
      if (!row || row.rp_id !== rpId) return false;
      db.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, at, id);
      return true;
    },
    registerPasskey(input: PasskeyRegistration) {
      db.prepare(`INSERT INTO passkey_credentials
        (id, public_key, counter, transports, rp_id, aaguid, device_type, backed_up, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.publicKey, input.counter, input.transports, input.rpId, input.aaguid,
          input.deviceType, input.backedUp, input.label, input.createdAt);
    },
    labelPasskey(id: string, label: string | null) {
      return db.prepare("UPDATE passkey_credentials SET label = ? WHERE id = ?").run(label, id).changes;
    },
    deletePasskey(id: string, at: number) {
      const changes = db.prepare("DELETE FROM passkey_credentials WHERE id = ?").run(id).changes;
      // Keep the original two autocommits and their order: delete first, then
      // revoke the credential's sessions, before runtime invalidation/HTTP.
      return { changes, revokedIds: changes ? revokeByCredential(db, id, at) : [] };
    },
    partitionSeed: () => accountPartitionSeed(db),
  };
}

function revive(error: WireError): Error | undefined {
  const as = <E extends Error>(made: E) => Object.assign(made, { message: error.message });
  switch (error.name) {
    case "PrincipalLimitError": return as(new PrincipalLimitError());
    case "PrincipalCredentialNotFoundError": return as(new PrincipalCredentialNotFoundError(""));
    case "PrincipalCreatorNotUsableError": return as(new PrincipalCreatorNotUsableError(undefined));
    case "ReferenceRepositoryError": return new ReferenceRepositoryError(error.message);
    case "ReferenceGrantPrincipalError": return as(new ReferenceGrantPrincipalError());
    case "ReferenceGrantDuplicateError": return as(new ReferenceGrantDuplicateError());
    case "ReferenceGrantLimitError": return as(new ReferenceGrantLimitError());
    case "TypeError": return new TypeError(error.message);
    case "RangeError": return new RangeError(error.message);
    default: return undefined;
  }
}

type Procedures = ReturnType<typeof setup>;
type AccountWrites = { [K in keyof Procedures]: (...args: Parameters<Procedures[K]>) => Promise<ReturnType<Procedures[K]>> };
const registered = new WeakMap<Database, AccountWrites>();

/** Standalone callers use the same procedures inline; hosted callers register their shared writer. */
export function accountWrites(db: Database): AccountWrites {
  let writes = registered.get(db);
  if (!writes) { writes = createAccountWrites(db); registered.set(db, writes); }
  return writes;
}

export function registerAccountWrites(db: Database, writer: SqliteWriter): AccountWrites {
  const writes = createAccountWrites(db, writer);
  registered.set(db, writes);
  return writes;
}

function createAccountWrites(db: Database, writer?: SqliteWriter): AccountWrites {
  const call = procedureCaller(db, { url, setup }, undefined, writer, revive);
  return {
    createPrincipal: input => call("createPrincipal", input),
    revokePrincipal: (id, now) => call("revokePrincipal", id, now),
    revokeAll: now => call("revokeAll", now),
    createGrant: input => call("createGrant", input),
    revokeGrant: input => call("revokeGrant", input),
    passkeyCounter: (id, rpId, counter, at) => call("passkeyCounter", id, rpId, counter, at),
    registerPasskey: input => call("registerPasskey", input),
    labelPasskey: (id, label) => call("labelPasskey", id, label),
    deletePasskey: (id, at) => call("deletePasskey", id, at),
    partitionSeed: () => call("partitionSeed"),
  };
}
