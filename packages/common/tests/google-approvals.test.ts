import { Database } from "bun:sqlite";
import { decideGoogleCall } from "../src/google/decision.js";
import { resolveGooglePolicy } from "../src/google/policy.js";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, renameSync } from "node:fs";
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

test("Google ledger deletion and replacement never retain old authority", () => {
  const root = scratch(), path = resolve(root, "ledger.sqlite"), ledger = openGoogleLedger(path);
  cleanups.push(() => ledger.close());
  const scope = { brain_id: "ithaca", principal_id: "odysseus", account_identity: "odysseus@example.com" };
  ledger.remember(scope, "gmail.modify", ["archive"], 1);
  expect(ledger.approvals(scope)).toHaveLength(1);
  rmSync(path);
  expect(ledger.approvals(scope), "GOOGLE_DELETED_LEDGER_EMPTY").toEqual([]);
  expect(existsSync(path)).toBe(false);
  ledger.remember(scope, "gmail.modify", ["label:STARRED"], 2);
  const replacement = resolve(root, "replacement.sqlite"), other = openGoogleLedger(replacement);
  other.remember(scope, "gmail.modify", ["label:IMPORTANT"], 3); other.close();
  renameSync(replacement, path);
  expect(ledger.approvals(scope).map(r => r.entity), "GOOGLE_REPLACED_LEDGER_CURRENT").toEqual(["label:IMPORTANT"]);
});
test("Google ledger refuses incompatible schema versions", () => {
  const path = resolve(scratch(), "ledger.sqlite"), ledger = openGoogleLedger(path);
  cleanups.push(() => ledger.close());
  ledger.remember({ brain_id: "ithaca", principal_id: "odysseus", account_identity: "odysseus@example.com" }, "gmail.modify", ["archive"], 1);
  const db = new Database(path); db.query("UPDATE meta SET value='999' WHERE key='schema_version'").run(); db.close();
  expect(() => ledger.list("ithaca"), "GOOGLE_LEDGER_SCHEMA_GATE").toThrow("schema version");
});
test("Google decision independently ignores remembered grants under taint", () => {
  const decision = decideGoogleCall(resolveGooglePolicy({ enabled: true, account: "ithaca", services: ["gmail"] }),
    { operation: "gmail.modify", input: { message_ids: ["19a0c3d2e4f50601"], remove_label_ids: ["INBOX"] } },
    { principal: "owner", posture: "voice", tainted: true, routing: "allowed", turn_reversible_items: 0,
      remembered_approvals: [{ operation: "gmail.modify", entity: "archive" }] });
  expect(decision, "GOOGLE_DECISION_TAINT_GUARD").toMatchObject({ outcome: "refused", error: { reason: "voice_posture" } });
});

test("Google missing ledger reads do not create state", () => {
  const path = resolve(scratch(), "absent/ledger.sqlite"), ledger = openGoogleLedger(path);
  expect(ledger.list("ithaca")).toEqual([]);
  expect(existsSync(path), "GOOGLE_READ_NEVER_CREATES").toBe(false);
  ledger.close();
});
