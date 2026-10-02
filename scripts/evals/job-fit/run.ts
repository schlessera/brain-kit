import { createHash } from "node:crypto";
import { fixtures, input, scripted, ordinal, CONTROL_GATE } from "./fixtures";
import { assess, ranking } from "./prototype";

export async function controlReport() {
  const rows = [];
  for (const f of fixtures) {
    const row = await assess(input(f), scripted(f), f.preference === null ? null : ordinal(f.preference), CONTROL_GATE);
    rows.push({ ...row, expected: f.decision, controlMatches: row.decision === f.decision, split: f.split, family: f.family, company: f.company });
  }
  return {
    fixtureSha256: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"),
    cases: rows.length, rows, scriptedRanking: ranking(rows),
    live: { confusion: null, dealbreakerMisses: null, rankingAgreement: null, unknownCalibration: null, reviewEffort: null, totalCost: null, latency: null },
    calibration: null, adoption: "not measured", effects: "none", scoreTransport: "not implemented",
  };
}
if (import.meta.main) console.log(JSON.stringify(await controlReport(), null, 2));
