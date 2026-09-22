/**
 * Label validation for the triage dataset.
 *
 * Adding an item requires this. Three strong models from different families
 * label each candidate; anything not unanimous is fixed or excluded rather than
 * kept on the author's say-so.
 *
 * This exists because the previous dataset's discriminating power turned out to
 * come almost entirely from items whose labels were quietly contested — it was
 * measuring label agreement and reporting it as capability. A cheap model was
 * written off on that basis and was, on re-measurement, perfect on every
 * uncontested item.
 *
 *   bun run eval:triage:validate
 *
 * A "CONTESTED" verdict means the judges disagree with each other or with the
 * stored label: adjudicate it, do not ship it. A "RELABEL" verdict means all
 * three judges agree on a different route than the stored one — they are usually
 * right, and the label should be re-examined before the item is trusted.
 */

import { ITEMS } from "./dataset.js";
import { judgeItem, recordVotes, type Votes } from "./judge.js";
import { MODELS, callWithRetry } from "./providers.js";
import { parseRows } from "./score.js";

if (process.env.BRAIN_UI_LIVE_EVALS !== "1") {
  console.error("Refusing to run: set BRAIN_UI_LIVE_EVALS=1 (calls paid provider APIs).");
  process.exit(2);
}

const REPS = Number(process.env.VALIDATE_REPS ?? 3);
const BATCH = 4;

/** Deliberately different families: shared blind spots would defeat the point. */
const JUDGE_IDS = ["claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol"];
const JUDGES = JUDGE_IDS.map((id) => {
  const spec = MODELS.find((m) => m.id === id);
  if (!spec) throw new Error(`judge ${id} is not in the model roster`);
  return spec;
});

const SYSTEM = await Bun.file(new URL("./prompt.txt", import.meta.url)).text();

const batches: (typeof ITEMS)[] = [];
for (let i = 0; i < ITEMS.length; i += BATCH) batches.push(ITEMS.slice(i, i + BATCH));

const votes: Votes = {};

for (const judge of JUDGES) {
  console.error(`judging with ${judge.label} ...`);
  for (let rep = 0; rep < REPS; rep++) {
    for (const batch of batches) {
      const user = JSON.stringify(
        batch.map((i) => ({ id: i.id, source: i.source, title: i.title, body: i.body })), null, 1);
      let text: string;
      try {
        text = (await callWithRetry(judge, "high", SYSTEM, user)).text;
      } catch (err) {
        console.error(`  ${judge.label}: ${(err as Error).message.slice(0, 120)}`);
        continue;
      }
      recordVotes(votes, batch, judge.label, parseRows(text) ?? []);
    }
  }
}

const pad = (s: string, n: number) => s.padEnd(n);
const judgeLabels = JUDGES.map((j) => j.label);

let unanimous = 0;
const flagged: string[] = [];

console.log("\n=== label validation ===\n");
console.log(pad("item", 6), pad("pair", 6), pad("stored", 13), ...JUDGES.map((j) => pad(j.label, 13)), "verdict");
for (const item of ITEMS) {
  const v = judgeItem(item, votes, judgeLabels);
  if (v.endorsed) unanimous++;
  else flagged.push(`${item.id} (${v.text})`);
  console.log(
    pad(item.id, 6), pad(item.pair ?? "-", 6), pad(item.gold.route, 13),
    ...v.modals.map((m) => pad(m, 13)), v.text
  );
}

console.log(`\n${unanimous}/${ITEMS.length} labels endorsed unanimously.`);
if (flagged.length > 0) {
  console.log(`needs adjudication: ${flagged.join(", ")}`);
  console.log("An item that is not unanimous should be fixed or excluded before it scores.");
}
