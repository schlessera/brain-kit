import { watchdogMs } from "../../../scripts/test-deadlines.js";
/** Real CLI and fake gog only; the ledger is outside the fixture brain. */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, symlinkSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const ledgerRoot = resolve(root, "ledger"); mkdirSync(ledgerRoot, { mode: 0o700 });
  const ledger = resolve(ledgerRoot, "ledger.sqlite");
  return { fake, ledger, root, ledgerRoot, run: (args: string[], env: Record<string, string> = {}) => runCli(brain, ["google", "gmail", ...args, "--json"], {
    HOME: process.env.HOME!, BRAIN_TEST_FAKE_GOG: fake.executable, BRAIN_GOOGLE_HOME: home, BRAIN_UI_GOOGLE_HOME: "",
    BRAIN_GOOGLE_KEYRING_PASSWORD: "penelope-weaves-by-day", BRAIN_GOOGLE_ROOT_UID: String(statSync("/").uid), BRAIN_GOOGLE_LEDGER: ledger, ...env,
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

const modifyArgs = ["modify", FIRST, SECOND, "--remove", "INBOX"];
for (const kind of ["directory", "symlink", "mode", "corrupt"]) test(`google standalone unsafe lock ${kind} refuses before credential and recovers after owner repair`, async () => {
  const f = fixture(), lock = f.ledger + ".write-lock.sqlite", target = resolve(f.root, "untouched");
  if (kind === "directory") chmodSync(f.ledgerRoot, 0o777);
  if (kind === "symlink") symlinkSync(target, lock);
  if (kind === "mode") writeFileSync(lock, "", { mode: 0o644 });
  if (kind === "corrupt") writeFileSync(lock, "Ithaca is not a SQLite file", { mode: 0o600 });
  const result = await f.run(modifyArgs);
  expect(result.code, "LOCK_REFUSAL_EXIT").toBe(1);
  expect(JSON.parse(result.stdout), `LOCK_${kind.toUpperCase()}_REFUSAL`).toMatchObject({ ok: false, error: { code: "unavailable", reason: kind === "corrupt" ? "write_lock_corrupt" : "write_lock_unsafe" } });
  expect(f.fake.calls(), "LOCK_BEFORE_CREDENTIAL").toHaveLength(0);
  expect(existsSync(target), "LOCK_SYMLINK_TARGET_UNTOUCHED").toBe(false);
  if (kind === "directory") expect(existsSync(lock), "LOCK_DIRECTORY_CHECK_FIRST").toBe(false);
  if (kind === "corrupt") expect(readFileSync(lock, "utf8"), "LOCK_CORRUPTION_NOT_OVERWRITTEN").toBe("Ithaca is not a SQLite file");
  chmodSync(f.ledgerRoot, 0o700); rmSync(lock, { force: true });
  expect((await f.run(modifyArgs)).code, "LOCK_OWNER_REPAIR_RECOVERS").toBe(0);
});

test("google standalone ledger unset refuses without a credential read", async () => {
  const f = fixture(); const result = await f.run(modifyArgs, { BRAIN_GOOGLE_LEDGER: "" });
  expect(JSON.parse(result.stdout), "CLI_LEDGER_UNSET").toMatchObject({ ok: false, error: { reason: "ledger_unset" } });
  expect(f.fake.calls()).toHaveLength(0);
});

test("google standalone blank body and reply refuse before write admission", async () => {
  const f = fixture();
  for (const body of ["", " \n\t"]) {
    const result = await f.run(["draft", "create", "--to", "penelope@example.com", "--subject", "Ithaca", "--body", body]);
    expect(JSON.parse(result.stdout), "CLI_BLANK_BODY").toMatchObject({ ok: false, error: { code: "invalid_input", reason: "draft_body_blank" } });
  }
  const reply = await f.run(["draft", "reply", FIRST, "--body", "Home"]);
  expect(JSON.parse(reply.stdout), "CLI_REPLY_REASON").toMatchObject({ ok: false, error: { reason: "standalone_reply_unsupported" } });
  expect(f.fake.callsOf("gmail.drafts.create")).toHaveLength(0);
  expect(existsSync(f.ledger), "CLI_NO_BLANK_BODY_INVERSE").toBe(false);
});

test("google standalone unknown write retains unknown inverse without retry", async () => {
  const f = fixture(); f.fake.setScenario({ ...writesScenario(), "gmail.batch.modify": { exit: 1 } });
  const result = await f.run(modifyArgs);
  expect(JSON.parse(result.stdout), "CLI_UNKNOWN_RESULT").toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(f.fake.callsOf("gmail.batch.modify")).toHaveLength(1);
  const db = new Database(f.ledger, { readonly: true });
  try { expect(db.query("SELECT state FROM standalone_inverses").get(), "CLI_UNKNOWN_INVERSE").toEqual({ state: "unknown" }); } finally { db.close(); }
});

test("google standalone upgrades the original approvals ledger without losing approvals", async () => {
  const f = fixture(); writeFileSync(f.ledger, "", { mode: 0o600 });
  const old = new Database(f.ledger);
  old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','1');
    CREATE TABLE remembered_approvals(id TEXT PRIMARY KEY,principal_id TEXT,brain_id TEXT,account_identity TEXT,operation TEXT,entity TEXT,approved_at INTEGER,
    UNIQUE(principal_id,brain_id,account_identity,operation,entity));
    INSERT INTO remembered_approvals VALUES('kept','odysseus','ithaca','odysseus@example.com','gmail.modify','archive',1);`);
  old.close();
  expect((await f.run(modifyArgs)).code, "CLI_OLD_LEDGER_UPGRADE").toBe(0);
  const db = new Database(f.ledger, { readonly: true });
  try { expect(db.query("SELECT id FROM remembered_approvals").all()).toEqual([{ id: "kept" }]);
    expect(db.query("SELECT state FROM standalone_inverses").get()).toEqual({ state: "confirmed" }); } finally { db.close(); }
});

test("google standalone busy lock refuses and releases for the next call", async () => {
  const f = fixture(), lock = f.ledger + ".write-lock.sqlite";
  writeFileSync(lock, "", { mode: 0o600 }); const db = new Database(lock); db.exec("BEGIN IMMEDIATE");
  try {
    const result = await f.run(modifyArgs);
    expect(JSON.parse(result.stdout), "CLI_WRITE_BUSY").toMatchObject({ ok: false, error: { reason: "write_busy" } });
    expect(f.fake.calls()).toHaveLength(0);
  } finally { db.exec("ROLLBACK"); db.close(); }
  expect((await f.run(modifyArgs)).code, "CLI_BUSY_RECOVERY").toBe(0);
}, 60_000);

for (const [args, operation] of [
  [["send", DRAFT], "gmail.draft.send"],
  [["draft", "delete", DRAFT], "gmail.draft.delete"],
  [["trash", FIRST], "gmail.trash"],
] as const) test(`google standalone ${operation} refuses before any credential access`, async () => {
  const f = fixture();
  const result = await f.run([...args]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout), "CLI_IRREVERSIBLE_REFUSAL").toMatchObject({ ok: false, operation, error: { code: "policy_denied", reason: "standalone_irreversible" } });
  expect(f.fake.calls(), "CLI_IRREVERSIBLE_NO_CREDENTIAL").toHaveLength(0);
  expect(existsSync(f.ledger)).toBe(false);
});
