import { watchdogMs } from "../../../scripts/test-deadlines.js";
/** Real CLI and fake gog only; the ledger is outside the fixture brain. */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFakeGog } from "../../common/tests/support/fake-gog.js";
import { FIRST, SECOND, DRAFT, writesScenario } from "../../common/tests/support/gmail-write-fixtures.js";
import { makeTempBrain, cleanup, runCli } from "./cli-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(allow = true) {
  const brain = makeTempBrain(); cleanups.push(() => cleanup(brain));
  mkdirSync(resolve("tmp"), { recursive: true });
  const root = mkdtempSync(resolve("tmp/google-write-cli-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = resolve(root, "home"); mkdirSync(home, { mode: 0o700 });
  mkdirSync(resolve(brain, "context/policies"), { recursive: true });
  writeFileSync(resolve(brain, "context/policies/governance.md"), `---\nschema_version: 1\ngoogle:\n  enabled: true\n  account: ithaca\n  services: [gmail]\n  modes: { reversible: allow }\n  standalone: { reversible: ${allow ? "allow" : "deny"} }\n---\n`);
  const fake = createFakeGog(writesScenario()); cleanups.push(() => fake.dispose());
  const ledger = resolve(root, "ledger.sqlite");
  return { fake, ledger, run: (args: string[]) => runCli(brain, ["google", "gmail", ...args, "--json"], {
    HOME: process.env.HOME!, BRAIN_TEST_FAKE_GOG: fake.executable, BRAIN_GOOGLE_HOME: home, BRAIN_UI_GOOGLE_HOME: "",
    BRAIN_GOOGLE_KEYRING_PASSWORD: "penelope-weaves-by-day", BRAIN_GOOGLE_ROOT_UID: String(statSync("/").uid), BRAIN_GOOGLE_LEDGER: ledger,
  }, { preload: resolve(import.meta.dir, "helpers/google-fake-gog-preload.ts") }) };
}
test("google standalone modify contract records a confirmed body-free inverse", async () => {
  const f = fixture();
  const scenario = writesScenario();
  f.fake.setScenario({ ...scenario, "gmail.batch.modify": { ...scenario["gmail.batch.modify"], wait_for: f.fake.path("dispatch") } });
  const pending = f.run(["modify", FIRST, SECOND, "--remove", "INBOX"]);
  let before: unknown;
  try {
    const deadline = Date.now() + watchdogMs(10_000);
    while (!f.fake.callsOf("gmail.batch.modify").length && Date.now() < deadline) await Bun.sleep(5);
    expect(f.fake.callsOf("gmail.batch.modify")).toHaveLength(1);
    expect(existsSync(f.ledger), "CLI_INVERSE_BEFORE_DISPATCH").toBe(true);
    const db = new Database(f.ledger, { readonly: true });
    try { before = db.query("SELECT state FROM standalone_inverses").get(); } finally { db.close(); }
  } finally { await Bun.write(f.fake.path("dispatch"), ""); await pending; }
  expect(before, "CLI_PREPARED_INVERSE").toEqual({ state: "prepared" });
  const result = await pending;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout), "CLI_MODIFY_ENVELOPE").toEqual({ ok: true, operation: "gmail.modify", data: { message_ids: [FIRST], add_label_ids: [], remove_label_ids: ["INBOX"] } });
  const db = new Database(f.ledger, { readonly: true });
  try {
    const row = db.query("SELECT state,account_identity,inverse_json FROM standalone_inverses").get() as { state: string; account_identity: string; inverse_json: string };
    expect(row.state, "CLI_INVERSE_CONFIRMED").toBe("confirmed"); expect(row.account_identity).toBe("odysseus@example.com");
    expect(JSON.parse(row.inverse_json).changes).toEqual([{ message_id: FIRST, add_label_ids: ["INBOX"], remove_label_ids: [] }]);
  } finally { db.close(); }
  expect(f.fake.callsOf("gmail.batch.modify")).toHaveLength(1);
});
test("google standalone draft create contract returns only id and fingerprint", async () => {
  const f = fixture(); const result = await f.run(["draft", "create", "--to", "penelope@example.com", "--subject", "Ithaca", "--body", "The ship is ready."]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout), "CLI_DRAFT_ENVELOPE").toEqual({ ok: true, operation: "gmail.draft.save", data: { draft_id: DRAFT, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  const db = new Database(f.ledger, { readonly: true });
  try {
    const row = db.query("SELECT state,inverse_json,precondition_json FROM standalone_inverses").get() as { state: string; inverse_json: string; precondition_json: string };
    expect(row.state).toBe("confirmed"); expect(row.inverse_json).not.toContain("The ship");
    expect(JSON.parse(row.inverse_json)).toMatchObject({ kind: "gmail.draft.delete", result: { id: DRAFT, fingerprint: expect.any(String) } });
  } finally { db.close(); }
});
test("google standalone update and default-deny writes refuse with no Google call", async () => {
  const f = fixture(); const update = await f.run(["draft", "update", DRAFT, "--body", "Homeward."]);
  expect(update.code).toBe(1); expect(JSON.parse(update.stdout), "CLI_UPDATE_REFUSAL").toMatchObject({ ok: false, operation: "gmail.draft.save", error: { code: "policy_denied", reason: "standalone_update_requires_card" } });
  expect(f.fake.calls()).toHaveLength(0);
  const denied = fixture(false); const modify = await denied.run(["modify", FIRST, "--remove", "INBOX"]);
  expect(modify.code).toBe(1); expect(JSON.parse(modify.stdout), "CLI_STANDALONE_DENY").toMatchObject({ ok: false, error: { code: "policy_denied" } });
  expect(denied.fake.calls()).toHaveLength(0);
});
