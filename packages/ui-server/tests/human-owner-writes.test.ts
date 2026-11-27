// Write-procedure human-owner checks (#4757). The off-loop writer runs these
// procedures with their own default authority check, so no caller-supplied
// predicate stands in front of them there. Each is called directly against a
// real UI database with a delegated agent and with its owner.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";

import { tempDirs } from "../../../tests/helpers/temp";
import { createUiDb } from "../src/db/client";
import { createPrincipal, type Principal } from "../src/db/principals";
import { HygieneAuthorityError, setup as hygieneWrites } from "../src/inbox/hygiene-writes";
import { StorageUnavailable } from "../src/storage/coordinator";
import { setup as maintenanceWrites } from "../src/storage/maintenance-writes";
import { setup as scanWrites } from "../src/storage/shared-scan-writes";

const SELF = { pid: process.pid, start: "odysseus-fixture" };
const BRAIN = "/srv/ithaca/brain";

let db: Database;
let owner: Principal;
let agent: Principal;

beforeAll(() => {
  db = createUiDb(join(tempDirs({ scope: "file" })("human-owner-writes-"), "ui.db"));
  owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  agent = createPrincipal(db, { authMethod: "delegated", createdBy: owner.id, label: "Athena", ttlSeconds: 3600 });
});

afterAll(() => db.close());

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return undefined;
}

describe("write procedures refuse a delegated agent through their default authority", () => {
  test("storage/maintenance-writes.ts", () => {
    const procedures = maintenanceWrites(db, { brain: BRAIN, self: SELF });
    const receipt = { id: "odysseus-cleanup-001", operation: "cleanup-staging", state: "waiting", requestedAt: Date.now() } as never;
    const refused = thrown(() => procedures.start(agent.id, receipt));
    expect(refused).toBeInstanceOf(StorageUnavailable);
    expect((refused as StorageUnavailable).status).toBe(403);
    expect((refused as Error).message).toBe("Storage maintenance requires current human-owner access.");
    const admitted = thrown(() => procedures.start(owner.id, receipt));
    expect((admitted as Error | undefined)?.message).not.toBe("Storage maintenance requires current human-owner access.");
  });

  test("storage/shared-scan-writes.ts", () => {
    const procedures = scanWrites(db, { brain: BRAIN, self: SELF });
    const refused = thrown(() => procedures.acquire(agent.id, "not-a-uuid", "0".repeat(32), "full" as never, true));
    expect((refused as Error).message).toBe("storage-scan-owner-revoked");
    const admitted = thrown(() => procedures.acquire(owner.id, "not-a-uuid", "0".repeat(32), "full" as never, true));
    expect((admitted as Error).message).toBe("storage-scan-identity-invalid");
  });

  test("inbox/hygiene-writes.ts", () => {
    const procedures = hygieneWrites(db, {}) as unknown as { refresh(...args: unknown[]): unknown };
    const refused = thrown(() => procedures.refresh(Date.now(), agent.id, { id: "missing" }, {}, null, [], {}));
    expect(refused).toBeInstanceOf(HygieneAuthorityError);
    expect((refused as Error).message).toBe("Human review authority is required");
    const admitted = thrown(() => procedures.refresh(Date.now(), owner.id, { id: "missing" }, {}, null, [], {}));
    expect(admitted).not.toBeInstanceOf(HygieneAuthorityError);
  });
});
