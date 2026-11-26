/** Real CLI envelopes; no gog, account probe, keyring or network. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { googleBrainId, openGoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import { makeTempBrain, cleanup, runCli } from "./cli-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
test("google approvals and revoke retain the CLI JSON envelopes and exit codes", async () => {
  const brain = makeTempBrain(); cleanups.push(() => cleanup(brain));
  mkdirSync(resolve("tmp"), { recursive: true });
  const home = mkdtempSync(resolve("tmp/google-cli-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const ledger = openGoogleLedger(resolve(home, "approvals.db")); cleanups.push(() => ledger.close());
  const scope = { brain_id: googleBrainId(brain), principal_id: "odysseus", account_identity: "odysseus@example.com" };
  ledger.remember(scope, "gmail.modify", ["archive"], 1);
  ledger.remember({ ...scope, brain_id: "another-brain" }, "gmail.modify", ["archive"], 1);
  const env = { HOME: process.env.HOME!, BRAIN_GOOGLE_LEDGER: resolve(home, "approvals.db"), BRAIN_UI_GOOGLE_HOME: home, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "", BRAIN_UI_GOG_PATH: "" };
  const list = await runCli(brain, ["google", "approvals", "--json"], env);
  expect(list.code, list.stderr).toBe(0);
  const body = JSON.parse(list.stdout);
  expect(body).toEqual({ ok: true, operation: "approvals", data: { approvals: [{ ...scope, id: expect.any(String), operation: "gmail.modify", entity: "archive", approved_at: 1 }] } });
  const id = body.data.approvals[0].id;
  for (const revoked of [true, false]) {
    const result = await runCli(brain, ["google", "revoke", id, "--json"], env);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout), "GOOGLE_CLI_REVOKE_ENVELOPE").toEqual({ ok: true, operation: "revoke", data: { id, revoked } });
  }
  expect(ledger.approvals(scope)).toEqual([]);
  const unset = await runCli(brain, ["google", "approvals", "--json"], { ...env, BRAIN_GOOGLE_LEDGER: "" });
  expect(JSON.parse(unset.stdout)).toMatchObject({ ok: false, error: { reason: "ledger_unset" } });
  const unavailable = await runCli(brain, ["google", "approvals", "--json"], { ...env, BRAIN_GOOGLE_LEDGER: brain });
  expect(unavailable.code, "GOOGLE_CLI_LEDGER_UNAVAILABLE").toBe(1);
  expect(JSON.parse(unavailable.stdout)).toMatchObject({ ok: false, operation: "approvals", error: { code: "unavailable", reason: "ledger_unavailable" } });
});
