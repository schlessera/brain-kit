import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createUiDb } from "../src/db/client";
import {
  LAST_SEEN_WRITE_INTERVAL_MS,
  PRINCIPAL_RETENTION_MS,
  countLivePrincipals,
  createPrincipal,
  isUsablePrincipal,
  MAX_LIVE_PRINCIPALS,
  PrincipalLimitError,
  prunePrincipals,
  resolveAmbientPrincipal,
  resolvePrincipal,
  resolveSystemPrincipal,
  revokeAllPrincipals,
  revokeByCredential,
  revokePrincipal,
  touchLastSeen,
} from "../src/db/principals";

const DB_PATH = join(tmpdir(), `principals-test-${process.pid}.db`);
const BASE_NOW = 2_000_000_000_000;

let db: Database;

beforeAll(() => {
  db = createUiDb(DB_PATH);
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(DB_PATH + suffix, { force: true });
  }
});

beforeEach(() => {
  db.exec("DELETE FROM principals; DELETE FROM passkey_credentials");
});

function create(overrides: Partial<Parameters<typeof createPrincipal>[1]> = {}) {
  return createPrincipal(db, {
    authMethod: "password",
    label: "Test browser",
    ttlSeconds: 3_600,
    ...overrides,
  });
}

function seedCredential(id: string): void {
  db.prepare(
    `INSERT INTO passkey_credentials
       (id, public_key, counter, rp_id, backed_up, label, created_at)
     VALUES (?, ?, 0, 'example.test', 0, 'Test key', ?)`
  ).run(id, new Uint8Array([1, 2, 3]), BASE_NOW);
}

function setTimes(
  id: string,
  values: { expiresAt?: number; revokedAt?: number | null; lastSeenAt?: number | null }
): void {
  if (values.expiresAt !== undefined) {
    db.prepare("UPDATE principals SET expires_at = ? WHERE id = ?").run(
      values.expiresAt,
      id
    );
  }
  if (values.revokedAt !== undefined) {
    db.prepare("UPDATE principals SET revoked_at = ? WHERE id = ?").run(
      values.revokedAt,
      id
    );
  }
  if (values.lastSeenAt !== undefined) {
    db.prepare("UPDATE principals SET last_seen_at = ? WHERE id = ?").run(
      values.lastSeenAt,
      id
    );
  }
}

describe("principal store", () => {
  test("kind is derived from auth method and a principal round-trips as usable", () => {
    const ttlSeconds = 3_600;
    const principal = create({
      authMethod: "delegated",
      label: "Build agent",
      createdBy: "owner-1",
      ttlSeconds,
    });

    expect(
      db
        .prepare("SELECT 1 FROM _migrations WHERE filename = ?")
        .get("011_principals.sql")
    ).not.toBeNull();
    expect(principal.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const resolved = resolvePrincipal(db, principal.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("agent");
    expect(resolved!.authMethod).toBe("delegated");
    expect(resolved!.label).toBe("Build agent");
    expect(resolved!.credentialId).toBeNull();
    expect(resolved!.createdBy).toBe("owner-1");
    expect(resolved!.lastSeenAt).toBeNull();
    expect(resolved!.revokedAt).toBeNull();
    expect(resolved!.expiresAt - resolved!.createdAt).toBe(ttlSeconds * 1_000);
    expect(isUsablePrincipal(principal, principal.createdAt)).toBe(true);
  });

  test("ids are unique random 16-byte values rather than a sequence", () => {
    const ids = Array.from({ length: 64 }, (_, i) => create({ label: `Device ${i}` }).id);

    expect(new Set(ids).size).toBe(ids.length);
    const values = ids.map((id) => Buffer.from(id, "base64url"));
    expect(values.every((value) => value.length === 16)).toBe(true);
    const deltas = values.slice(1).map((value, i) => {
      const current = BigInt(`0x${value.toString("hex")}`);
      const previous = BigInt(`0x${values[i]!.toString("hex")}`);
      return current - previous;
    });
    expect(deltas.every((delta) => delta === 1n)).toBe(false);
  });

  test("each id encodes a fresh request for exactly 16 random bytes", () => {
    const entropy = [Buffer.alloc(16, 0x12), Buffer.alloc(16, 0xa7)];
    let call = 0;
    const randomBytes = spyOn(crypto, "randomBytes").mockImplementation(
      ((size: number) => {
        expect(size).toBe(16);
        return Buffer.from(entropy[call++]!);
      }) as typeof crypto.randomBytes
    );

    try {
      const first = create({ label: "First deterministic id" });
      const second = create({ label: "Second deterministic id" });

      expect(randomBytes).toHaveBeenCalledTimes(2);
      expect(first.id).toBe(entropy[0]!.toString("base64url"));
      expect(second.id).toBe(entropy[1]!.toString("base64url"));
    } finally {
      randomBytes.mockRestore();
    }
  });

  test("the principal primary key rejects NULL explicitly", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO principals
             (id, kind, auth_method, label, created_at, expires_at)
           VALUES (NULL, 'owner', 'password', 'Broken', ?, ?)`
        )
        .run(BASE_NOW, BASE_NOW + 1_000)
    ).toThrow();
  });

  test("revoked, expired, and boundary-expired principals are unusable", () => {
    const revoked = create({ label: "Revoked" });
    const expired = create({ label: "Expired" });
    const boundaryExpired = create({ label: "Boundary expired" });
    const both = create({ label: "Both" });
    setTimes(revoked.id, { expiresAt: BASE_NOW + 1 });
    expect(isUsablePrincipal(resolvePrincipal(db, revoked.id)!, BASE_NOW)).toBe(true);
    revokePrincipal(db, revoked.id, BASE_NOW);
    setTimes(expired.id, { expiresAt: BASE_NOW - 1 });
    setTimes(boundaryExpired.id, { expiresAt: BASE_NOW });
    setTimes(both.id, { expiresAt: BASE_NOW - 1, revokedAt: BASE_NOW });

    expect(isUsablePrincipal(resolvePrincipal(db, revoked.id)!, BASE_NOW)).toBe(false);
    expect(isUsablePrincipal(resolvePrincipal(db, expired.id)!, BASE_NOW)).toBe(false);
    expect(isUsablePrincipal(resolvePrincipal(db, boundaryExpired.id)!, BASE_NOW)).toBe(
      false
    );
    expect(isUsablePrincipal(resolvePrincipal(db, both.id)!, BASE_NOW)).toBe(false);
  });

  test("revokeByCredential revokes only every row carrying that credential", () => {
    seedCredential("credential-a");
    seedCredential("credential-b");
    const first = create({ credentialId: "credential-a", label: "First" });
    const second = create({ credentialId: "credential-a", label: "Second" });
    const other = create({ credentialId: "credential-b", label: "Other" });
    const password = create({ label: "Password" });

    expect(new Set(revokeByCredential(db, "credential-a", BASE_NOW))).toEqual(
      new Set([first.id, second.id])
    );
    expect(resolvePrincipal(db, first.id)!.revokedAt).toBe(BASE_NOW);
    expect(resolvePrincipal(db, second.id)!.revokedAt).toBe(BASE_NOW);
    expect(resolvePrincipal(db, other.id)!.revokedAt).toBeNull();
    expect(resolvePrincipal(db, password.id)!.revokedAt).toBeNull();
  });

  test("revokeAllPrincipals returns every newly revoked id and is idempotent", () => {
    const principals = [create({ label: "One" }), create({ label: "Two" })];
    const alreadyRevoked = create({ label: "Already revoked" });
    revokePrincipal(db, alreadyRevoked.id, BASE_NOW - 1);

    expect(new Set(revokeAllPrincipals(db, BASE_NOW))).toEqual(
      new Set(principals.map(({ id }) => id))
    );
    expect(revokeAllPrincipals(db, BASE_NOW + 1)).toEqual([]);
  });

  test("ambient and system principals use dedicated resolvers and cannot be revoked", () => {
    const ambient = resolveAmbientPrincipal(
      db,
      "none",
      "No authentication",
      "No authentication"
    );
    expect(revokePrincipal(db, ambient.id, BASE_NOW)).toEqual([]);
    expect(revokeAllPrincipals(db, BASE_NOW)).toEqual([]);
    expect(resolvePrincipal(db, ambient.id)?.revokedAt).toBeNull();

    const system = resolveSystemPrincipal(db, {
      identity: "scheduled-jobs",
      label: "Scheduled jobs",
    });
    expect(system).toMatchObject({ kind: "system", authMethod: "ambient" });
    expect(revokePrincipal(db, system.id, BASE_NOW)).toEqual([]);
    expect(countLivePrincipals(db, BASE_NOW)).toBe(0);
  });

  test("ambient resolution performs no write for a fresh hit", () => {
    const now = spyOn(Date, "now").mockReturnValue(BASE_NOW);
    try {
      const first = resolveAmbientPrincipal(db, "proxy", "alex", "Alex Example");
      const before = db.query("SELECT total_changes() AS count").get() as {
        count: number;
      };

      const second = resolveAmbientPrincipal(db, "proxy", "alex", "Alex Example");
      const after = db.query("SELECT total_changes() AS count").get() as {
        count: number;
      };

      expect(second.id).toBe(first.id);
      expect(after.count).toBe(before.count);

      // total_changes() cannot see a write transaction that changed no rows,
      // and the throttle's WHERE made the UPDATE a no-op — so the counter stays
      // equal whether or not a write transaction was opened. query_only can
      // see it: under it, ANY write statement throws.
      db.exec("PRAGMA query_only = ON");
      try {
        const third = resolveAmbientPrincipal(db, "proxy", "alex", "Alex Example");
        expect(third.id).toBe(first.id);
      } finally {
        db.exec("PRAGMA query_only = OFF");
      }

      // A stale hit does write, and the timestamp advances.
      now.mockReturnValue(BASE_NOW + LAST_SEEN_WRITE_INTERVAL_MS + 1);
      const fourth = resolveAmbientPrincipal(db, "proxy", "alex", "Alex Example");
      expect(fourth.lastSeenAt).toBe(BASE_NOW + LAST_SEEN_WRITE_INTERVAL_MS + 1);
      const afterStale = db.query("SELECT total_changes() AS count").get() as {
        count: number;
      };
      expect(afterStale.count).toBeGreaterThan(after.count);
    } finally {
      now.mockRestore();
    }
  });

  test("principal creation refuses a deleted passkey credential", () => {
    expect(() =>
      create({
        authMethod: "passkey",
        credentialId: "deleted-credential",
      })
    ).toThrow(/no longer exists/);
    expect(db.query("SELECT COUNT(*) AS count FROM principals").get()).toEqual({
      count: 0,
    });
  });

  test("touchLastSeen writes only when the stored value is more than 60 seconds stale", () => {
    const principal = create();
    touchLastSeen(db, principal.id, BASE_NOW);
    expect(resolvePrincipal(db, principal.id)!.lastSeenAt).toBe(BASE_NOW);

    touchLastSeen(db, principal.id, BASE_NOW + 60_000);
    expect(resolvePrincipal(db, principal.id)!.lastSeenAt).toBe(BASE_NOW);

    touchLastSeen(db, principal.id, BASE_NOW + 60_001);
    expect(resolvePrincipal(db, principal.id)!.lastSeenAt).toBe(BASE_NOW + 60_001);
  });

  test("prunePrincipals removes only terminal rows beyond the retention window", () => {
    const revokedOld = create({ label: "Revoked old" });
    const revokedRecent = create({ label: "Revoked recent" });
    const expiredOld = create({ label: "Expired old" });
    const expiredRecent = create({ label: "Expired recent" });
    const live = create({ label: "Live" });
    const ambientOld = resolveAmbientPrincipal(
      db,
      "proxy",
      "inactive@example.test",
      "Inactive proxy user"
    );
    const ambientRecent = resolveAmbientPrincipal(
      db,
      "proxy",
      "recent@example.test",
      "Recent proxy user"
    );
    const old = BASE_NOW - PRINCIPAL_RETENTION_MS - 1;
    const recent = BASE_NOW - PRINCIPAL_RETENTION_MS + 1;
    setTimes(revokedOld.id, { revokedAt: old, expiresAt: BASE_NOW + 1 });
    setTimes(revokedRecent.id, { revokedAt: recent, expiresAt: BASE_NOW + 1 });
    setTimes(expiredOld.id, { expiresAt: old });
    setTimes(expiredRecent.id, { expiresAt: recent });
    setTimes(live.id, { expiresAt: BASE_NOW + 1 });
    setTimes(ambientOld.id, {
      lastSeenAt: BASE_NOW - PRINCIPAL_RETENTION_MS - 1,
    });
    setTimes(ambientRecent.id, {
      lastSeenAt: BASE_NOW - PRINCIPAL_RETENTION_MS + 1,
    });

    prunePrincipals(db, BASE_NOW);

    expect(resolvePrincipal(db, revokedOld.id)).toBeNull();
    expect(resolvePrincipal(db, expiredOld.id)).toBeNull();
    expect(resolvePrincipal(db, revokedRecent.id)).not.toBeNull();
    expect(resolvePrincipal(db, expiredRecent.id)).not.toBeNull();
    expect(resolvePrincipal(db, live.id)).not.toBeNull();
    expect(resolvePrincipal(db, ambientOld.id)).toBeNull();
    expect(resolvePrincipal(db, ambientRecent.id)).not.toBeNull();
  });

  test("more than 100 historical ambient identities do not consume credential admission", () => {
    for (let i = 0; i <= MAX_LIVE_PRINCIPALS; i++) {
      resolveAmbientPrincipal(db, "proxy", `proxy-user-${i}`, `Proxy user ${i}`);
    }

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM principals WHERE kind = 'ambient'").get()
    ).toEqual({ count: MAX_LIVE_PRINCIPALS + 1 });
    expect(countLivePrincipals(db, Date.now())).toBe(0);
    expect(create({ label: "Credential after ambient history" })).toBeDefined();
  });

  test("the live-principal cap rejects overflow and revocation makes room", () => {
    const principals = Array.from({ length: MAX_LIVE_PRINCIPALS }, (_, i) =>
      create({ label: `Principal ${i}` })
    );

    expect(() => create({ label: "Over limit" })).toThrow(PrincipalLimitError);
    revokePrincipal(db, principals[0]!.id, Date.now());
    expect(create({ label: "Replacement" })).toBeDefined();
  });

  test("database CHECK constraints reject unknown kinds and auth methods", () => {
    const insert = db.prepare(
      `INSERT INTO principals
         (id, kind, auth_method, label, created_at, expires_at)
       VALUES (?, ?, ?, 'Invalid', ?, ?)`
    );
    expect(() =>
      insert.run("invalid-kind", "visitor", "password", BASE_NOW, BASE_NOW + 1_000)
    ).toThrow();
    expect(() =>
      insert.run("invalid-auth", "owner", "token", BASE_NOW, BASE_NOW + 1_000)
    ).toThrow();
  });

  test("labels keep renderable input but reject overlong and control text", () => {
    expect(create({ label: "<b>literal label</b>" }).label).toBe("<b>literal label</b>");
    expect(() => create({ label: "x".repeat(65) })).toThrow(RangeError);
    expect(() => create({ label: "line\nbreak" })).toThrow(RangeError);
  });
});
