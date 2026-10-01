// Offline only: fixture baselines and the proposal guard, not a JEV measurement.
import { fixtures, prepare, deterministic, oracle } from "./fixture";
import { validateProposal } from "./guard";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function controlReport() {
  let baselineCorrect = 0;
  let oracleAccepted = 0;
  for (const f of fixtures) {
    const prepared = prepare(f);
    try {
      baselineCorrect += Number(deterministic(f, prepared.env).action === f.expected);
      oracleAccepted += Number(validateProposal(oracle(f, prepared.env), prepared.env).ok);
    } finally { prepared.close(); }
  }
  return {
    mode: "keyless-controls",
    fixtureSha256: createHash("sha256").update(readFileSync(new URL("./fixtures.json", import.meta.url))).digest("hex"),
    cases: fixtures.length,
    splits: { tuning: fixtures.filter(f => f.split === "tuning").length, heldOut: fixtures.filter(f => f.split === "held-out").length },
    deterministic: { correct: baselineCorrect, total: fixtures.length },
    oracleGuard: { accepted: oracleAccepted, total: fixtures.length },
    live: { dispositionPrecision: null, targetPrecision: null, escalationRate: null, contentRetention: null, malformedOperations: null, modelWorkSaved: null, billedCostUsd: null, effectiveCostUsd: null, p50Ms: null, p95Ms: null },
    adoption: "not measured",
  };
}

if (import.meta.main) console.log(JSON.stringify(controlReport(), null, 2));
