import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, fixtures, prepare, YES } from "../scripts/evals/canonical-conflicts/fixtures";
import { inspect, pairs } from "../scripts/evals/canonical-conflicts/prototype";
import { readHygieneLog, reconcile } from "../packages/core/src/lib/hygiene";

const scope = (subject = "Odysseus", attribute = "sealed jars", date = DAY, event = "raft provisioning", cardinality = "single-valued") =>
  `\nSubject: ${subject}\nAttribute: ${attribute}\nObservation date: ${date}\nEvent scope: ${event}\nCardinality: ${cardinality}\n`;

for (const field of ["Count", "Date"] as const) {
  const values = field === "Count" ? ["12", "13"] : ["2026-07-10", "2026-06-10"];
  const attribute = field === "Count" ? "sealed jars" : "departure date";
  for (const [name, left, right] of [
    ["missing scope", "", ""],
    ["different attributes", scope("Odysseus", attribute), scope("Odysseus", "water jars")],
    ["different events", scope("Odysseus", attribute), scope("Odysseus", attribute, DAY, "harbor return")],
    ["historical observations", scope("Odysseus", attribute), scope("Odysseus", attribute, "2026-06-01")],
    ["future observations", scope("Odysseus", attribute, "2026-07-13"), scope("Odysseus", attribute, "2026-07-13")],
    ["missing cardinality", scope("Odysseus", attribute).replace("Cardinality: single-valued\n", ""), scope("Odysseus", attribute)],
    ["multiple values", scope("Odysseus", attribute), scope("Odysseus", attribute, DAY, "raft provisioning", "multiple-valued")],
    ["multiple values in both records", scope("Odysseus", attribute, DAY, "raft provisioning", "multiple-valued"), scope("Odysseus", attribute, DAY, "raft provisioning", "multiple-valued")],
    ["subject mismatch", scope("Penelope", attribute), scope("Penelope", attribute)],
    ["duplicate authority", scope("Odysseus", attribute) + "Attribute: other cargo\n", scope("Odysseus", attribute)],
  ] as const) test(`${field}: ${name} cannot persist a speculative conflict`, async () => {
    const p = prepare({ ...fixtures[0]!, anchor: `Odysseus: ${field} = ${values[0]}`, other: `Odysseus: ${field} = ${values[1]}` });
    try {
      writeFileSync(join(p.root, "me/anchor.md"), p.files["me/anchor.md"]! + left);
      writeFileSync(join(p.root, "profiles/record.md"), p.files["profiles/record.md"]! + right);
      const found = pairs(p.root, p.taxonomy, DAY); expect(found).toHaveLength(1);
      const judgment = await inspect(p.root, p.taxonomy, found[0]!, DAY, async () => YES);
      reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: judgment ? [judgment.candidate] : [], failedChecks: ["canonical-conflicts"] });
      expect(readHygieneLog(p.root).filter(e => e.id.startsWith("conflict-"))).toEqual([]);
      expect(judgment).toBeNull();
    } finally { p.close(); }
  });

  test(`${field}: identical literal single-valued scope permits a report with exact source spans`, async () => {
    const p = prepare({ ...fixtures[0]!, anchor: `Odysseus: ${field} = ${values[0]}`, other: `Odysseus: ${field} = ${values[1]}` });
    try {
      for (const [path, raw] of Object.entries(p.files)) writeFileSync(join(p.root, path), raw + scope("Odysseus", attribute));
      const pair = pairs(p.root, p.taxonomy, DAY)[0]!;
      const judgment = await inspect(p.root, p.taxonomy, pair, DAY, async () => ({ sameSubject: "yes", contradiction: "unknown" }));
      reconcile(p.root, [], new Map(), { now: new Date(DAY), extra: judgment ? [judgment.candidate] : [], failedChecks: ["canonical-conflicts"] });
      expect(readHygieneLog(p.root).filter(e => e.id.startsWith("conflict-"))).toHaveLength(1);
      expect(judgment!.replacement).toBeNull();
      expect(pair.canonical.raw.slice(pair.anchor.start, pair.anchor.end)).toBe(pair.anchor.text);
    } finally { p.close(); }
  });
}
