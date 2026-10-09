/**
 * The three-family label panel over the experiment corpus.
 *
 *   BRAIN_UI_LIVE_EVALS=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
 *     bun packages/ui-server/evals/triage/experiment/panel.ts --out /tmp/panel-848.json
 *
 * Same opt-in as the donor validator, same rubric, batching and judge logic;
 * the collector adds the per-call receipts the maintainer asked for. The
 * report keeps every physical attempt. Exit 0 means every label is endorsed
 * unanimously; 1 means at least one is contested, relabelled or tied, or the
 * panel stopped early. Nothing here changes a label.
 */
import { resolve } from "node:path";
import { CORPUS, corpusSha } from "./corpus";
import { collectLabelPanel, LABEL_PANEL } from "./label-panel";

if (process.env.BRAIN_UI_LIVE_EVALS !== "1") {
  console.error("Refusing to run: set BRAIN_UI_LIVE_EVALS=1 (calls paid provider APIs).");
  process.exit(2);
}
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
if (args.indexOf("--out") === -1 || !out) { console.error("Refusing to run: --out <report.json> is required."); process.exit(2); }

const rubric = await Bun.file(new URL("../prompt.txt", import.meta.url)).text();
const result = await collectLabelPanel(CORPUS, rubric, fetch, {
  onPhysical: (r) => console.error(`${r.judge} rep ${r.repetition + 1} batch ${r.batch + 1} attempt ${r.attempt}: ${r.status ?? "-"} ${r.error ?? ""}`),
});
await Bun.write(resolve(out), JSON.stringify({ corpusSha: corpusSha(), items: CORPUS.length, panel: LABEL_PANEL, ...result }, null, 2));

const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("item", 6), pad("split", 10), pad("stored", 13), ...LABEL_PANEL.models.map((m) => pad(m.label, 17)), "verdict");
for (const item of CORPUS) {
  const v = result.verdicts.find((x) => x.id === item.id)!;
  console.log(pad(item.id, 6), pad(item.split, 10), pad(item.gold.route, 13), ...v.modals.map((m) => pad(m, 17)),
    v.text + (v.tied.length ? ` (tied: ${v.tied.join(",")})` : "") + (v.unstable.length ? ` (unstable: ${v.unstable.join(",")})` : ""));
}
console.log(`\n${result.verdicts.filter((v) => v.endorsed && !v.tied.length).length}/${CORPUS.length} labels endorsed unanimously.` +
  (result.stopReason ? ` Panel stopped early: ${result.stopReason}.` : ""));
console.log(`Written to ${resolve(out)}`);
process.exit(result.endorsed ? 0 : 1);
