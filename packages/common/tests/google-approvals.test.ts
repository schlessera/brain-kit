import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openGoogleLedger } from "../src/google/ledger.js";
import { createGogTransport } from "../src/google/gog/index.js";
import { createFakeGog } from "./support/fake-gog.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function scratch() {
  mkdirSync(resolve("tmp"), { recursive: true });
  const root = mkdtempSync(resolve("tmp/google-common-")); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root;
}
test("Google ledger persists scoped approvals and revokes across connections", () => {
  const path = resolve(scratch(), "approvals.db"), first = openGoogleLedger(path), second = openGoogleLedger(path);
  cleanups.push(() => first.close(), () => second.close());
  const scope = { brain_id: "ithaca", principal_id: "odysseus", account_identity: "odysseus@example.com" };
  first.remember(scope, "gmail.modify", ["archive"], 1);
  expect(second.approvals(scope)).toMatchObject([{ ...scope, operation: "gmail.modify", entity: "archive", approved_at: 1 }]);
  for (const field of ["brain_id", "principal_id", "account_identity"]) expect(second.approvals({ ...scope, [field]: "aeaea" }), "GOOGLE_LEDGER_SCOPE").toHaveLength(0);
  const id = first.list("ithaca")[0]!.id;
  expect(second.revoke("ithaca", id, "penelope")).toBe(false);
  expect(second.revoke("ithaca", id, "odysseus")).toBe(true);
  expect(first.approvals(scope), "GOOGLE_LEDGER_REVOKED").toHaveLength(0);
});
test("Google identity comes from the alias-list answer and is reread without cache", async () => {
  const fake = createFakeGog({ "auth.alias.list": { stdout: { aliases: { ithaca: "Odysseus@EXAMPLE.COM" } } } }); cleanups.push(() => fake.dispose());
  fake.environment.home = scratch();
  const transport = createGogTransport({ binary: fake.binary, account: "ithaca", environment: fake.environment });
  expect(await transport.resolveAccount(), "GOOGLE_RESOLVED_ADDRESS").toEqual({ ok: true, value: "odysseus@example.com" });
  fake.setScenario({ "auth.alias.list": { stdout: { aliases: { ithaca: "penelope@example.com" } } } });
  expect(await transport.resolveAccount()).toEqual({ ok: true, value: "penelope@example.com" });
  fake.setScenario({ "auth.alias.list": { stdout: { aliases: {} } } });
  expect(await transport.resolveAccount(), "GOOGLE_MISSING_ALIAS_REFUSED").toMatchObject({ ok: false, error: { code: "unavailable", reason: "account_unresolved" } });
  fake.setScenario({ "auth.alias.list": { stdout: { aliases: { ithaca: 12 } } } });
  expect(await transport.resolveAccount()).toMatchObject({ ok: false, error: { code: "transport_incompatible" } });
  expect(fake.calls().every(call => call.command === "auth.alias.list")).toBe(true);
});
