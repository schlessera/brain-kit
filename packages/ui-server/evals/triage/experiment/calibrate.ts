/**
 * Recompute the 2026-10-09 calibration from the raw answers, with no network:
 *
 *   bun packages/ui-server/evals/triage/experiment/calibrate.ts
 *
 * For every Choice repetition of the provisional run, it prints the raw errors
 * with their confidence, then each split's accuracy, fallbacks and missed
 * escalations at floors from 0 to 0.8. The Noul summary shows the range of
 * each question's answer per gold route. `docs/decisions/triage-classifier.md`
 * quotes these numbers.
 */
import { CORPUS, corpusSha } from "./corpus";

type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
type Repetition = { repetition: number; answers: Record<string, ChoiceAnswer | { type: "noul"; noul: number }> };
type Run = { corpusSha: string; configurations: { shape: string; batchSize: number; repetitions: Repetition[] }[] };

const report = await Bun.file(new URL("./results/2026-10-09-answers.json", import.meta.url)).json() as { runs: Record<string, Run> };
const run = report.runs["provisional-0.8"]!;
if (run.corpusSha !== corpusSha()) throw new Error(`answers were recorded on corpus ${run.corpusSha}, not ${corpusSha()}`);

const FLOORS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const SPLITS = ["tuning", "held-out", "reference"] as const;

for (const configuration of run.configurations.filter((c) => c.shape === "choice")) {
  for (const rep of configuration.repetitions) {
    console.log(`\nchoice/${configuration.batchSize} repetition ${rep.repetition}`);
    for (const item of CORPUS) {
      const a = rep.answers[`${item.id}.route`] as ChoiceAnswer | undefined;
      if (a && a.choice !== item.gold.route) {
        console.log(`  wrong: ${item.id} (${item.split}) expected ${item.gold.route}, chose ${a.choice} at confidence ${a.confidence}, p ${a.probabilities[a.choice]}`);
      }
    }
    for (const floor of FLOORS) {
      const cells = SPLITS.map((split) => {
        let ok = 0, total = 0, fallbacks = 0, missed = 0;
        for (const item of CORPUS.filter((i) => i.split === split)) {
          const a = rep.answers[`${item.id}.route`] as ChoiceAnswer | undefined;
          let route = a?.choice ?? "needs_user";
          if (!a || a.confidence < floor || (a.probabilities[a.choice] ?? 0) < floor) { route = "needs_user"; fallbacks++; }
          total++;
          if (route === item.gold.route) ok++;
          if (item.gold.route === "needs_user" && route !== "needs_user") missed++;
        }
        return `${split} ${ok}/${total} fallback ${fallbacks} missed ${missed}`;
      });
      console.log(`  floor ${floor.toFixed(1)}: ${cells.join(" | ")}`);
    }
  }
}

console.log("\nNoul answer ranges by gold route (all provisional repetitions)");
const ranges = new Map<string, number[]>();
for (const configuration of run.configurations.filter((c) => c.shape === "ordered-noul")) {
  for (const rep of configuration.repetitions) {
    for (const item of CORPUS) {
      for (const question of ["human", "agent", "durable"]) {
        const a = rep.answers[`${item.id}.${question}`];
        if (a?.type !== "noul") continue;
        const key = `${item.gold.route} ${question}`;
        ranges.set(key, [...(ranges.get(key) ?? []), a.noul]);
      }
    }
  }
}
for (const [key, values] of [...ranges].sort()) console.log(`  ${key.padEnd(22)} ${Math.min(...values).toFixed(2)}–${Math.max(...values).toFixed(2)}`);
