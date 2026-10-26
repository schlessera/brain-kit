import { expect, test } from "bun:test";
import { getSetting, setSetting } from "../src/db/settings.js";
import { httpContractApp } from "./helpers/http-contract-app.js";

/** Settles `close()` and returns what it threw, without `.rejects` (docs/process/testing.md). */
async function closing(app: { close(): Promise<void> }): Promise<string | null> {
  try { await app.close(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

test("the hosted-app guard names a server-code write on the app connection once the app serves", async () => {
  const t = await httpContractApp();
  // A hosted path that still committed on the app connection, as before #2850:
  // the timer calls the product writer itself, so no test frame is on its stack.
  await new Promise<void>(done => { setTimeout(setSetting, 0, t.app.db, "odysseus.guard.probe", { harbor: "Ithaca" }); setTimeout(done, 20); });
  expect(getSetting<unknown>(t.app.db, "odysseus.guard.probe", null), "APP_WRITE_GUARD_PROBE_WRITE_LANDED").toEqual({ harbor: "Ithaca" });
  const failure = await closing(t);
  expect(failure, "APP_WRITE_GUARD_NAMES_SERVING_WRITE").toContain("APP_CONNECTION_WRITE_WHILE_SERVING");
  expect(failure, "APP_WRITE_GUARD_NAMES_THE_SITE").toContain("packages/ui-server/src/db/settings.ts");
});

test("the guard ignores a test fixture's own direct write and the app's boot writes", async () => {
  const t = await httpContractApp();
  t.app.db.query("INSERT INTO settings (key, value, updated_at) VALUES ('odysseus.fixture', '\"Penelope\"', 0)").run();
  expect(getSetting<unknown>(t.app.db, "odysseus.fixture", null), "APP_WRITE_GUARD_FIXTURE_WRITE_LANDED").toBe("Penelope");
  expect(await closing(t), "APP_WRITE_GUARD_FIXTURE_AND_BOOT_WRITES_ALLOWED").toBeNull();
});
