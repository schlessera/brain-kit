import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { googleHostEnv } from "../src/config/env.js";
import { googleLedgerPath } from "@schlessera/brain-common/internal/google-ledger";

test("Google ephemeral database requires an explicit absolute ledger", () => {
  for (const db of ["", ":memory:"]) {
    expect(googleHostEnv(db, {}).ledgerPath, "GOOGLE_EPHEMERAL_LEDGER_UNSET").toBeUndefined();
    const path = resolve("tmp/ithaca-ledger.sqlite");
    expect(googleHostEnv(db, { BRAIN_GOOGLE_LEDGER: path }).ledgerPath).toBe(path);
    const relative = googleHostEnv(db, { BRAIN_GOOGLE_LEDGER: "ithaca-ledger.sqlite" }).ledgerPath!;
    expect(() => googleLedgerPath(relative, resolve("tmp/ithaca-brain")), "GOOGLE_EPHEMERAL_LEDGER_ABSOLUTE").toThrow("absolute");
  }
  expect(googleHostEnv("tmp/ui.db", {}).ledgerPath).toBe(resolve("tmp/ui.db.google-ledger.sqlite"));
});
