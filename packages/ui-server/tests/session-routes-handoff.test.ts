import { describe, expect, test } from "bun:test";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import { createSessionRoutes } from "../src/routes/sessions";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";

const listed = (id: string, title: string) => ({ id, title, createdAt: 1, lastActiveAt: id === "dst" ? 3 : 2, totalCostUsd: 0, numTurns: 0 });

describe("GET /sessions handoff links (#61)", () => {
  test("a destination names its source, the source's title and backend, and where the source stood", async () => {
    const db = createUiDb(":memory:");
    const catalog = createSessionCatalog(() => db);
    catalog.persistSessionStub("src", "Plan the return", "claude", "claude");
    catalog.persistSessionStub("dst", "Odysseus is sailing home", "pi", "pi");
    expect(catalog.recordHandoff!("dst", "h-ithaca-0001", "src", 4)).toBe(true);
    const registry = createStaticBackendRegistry([
      makeFakeBackend({ id: "claude", sessions: [listed("src", "Ithaca return")] }),
      makeFakeBackend({ id: "pi", sessions: [listed("dst", "Odysseus is sailing home")] }),
    ], "claude");
    const res = await createSessionRoutes({ registry, db }).request("/sessions");
    const body = await res.json() as { sessions: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    expect(byId.dst!.handoffFrom).toEqual({ sessionId: "src", title: "Ithaca return", backendId: "claude", afterTurns: 4 });
    expect(byId.src!.handoffFrom).toBeUndefined();
    expect(catalog.findHandoff!("h-ithaca-0001")).toBe("dst");
    // The key is unique: a second destination cannot claim it.
    catalog.persistSessionStub("dst2", "again", "pi", "pi");
    expect(catalog.recordHandoff!("dst2", "h-ithaca-0001", "src", 4)).toBe(false);
    // A destination whose stub never persisted has no row: not recorded.
    expect(catalog.recordHandoff!("never-stored", "h-ithaca-0002", "src", 1)).toBe(false);
    expect(catalog.findHandoff!("h-ithaca-0002")).toBeNull();
    db.close();
  });
});
