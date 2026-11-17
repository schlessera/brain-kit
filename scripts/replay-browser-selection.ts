/** Read-only replay over immutable squash diffs; no historical source speedup is implied.
 * Given the report another tree produced from the same snapshot, it also lists every
 * category that tree's rule selected and this one omits: the qualification a change
 * to browser selection attaches (docs/process/proof-domains.md). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changedFiles, planChecks, selectBrowserClosures, workspaces } from "./ci-plan";
import { discoverBrowserClosures } from "./browser-input-closure";
const CATEGORIES = ["browser", "layout", "endurance", "captures"] as const;
export interface ReplayBaseline { plans: { number: number; changedSha256: string; after: Record<string, boolean> }[]; }
export function replayBrowserSelection(root: string, snapshot: { prs: { number: number; mergeCommit: string; changed: string[] }[] }, baseline?: ReplayBaseline) {
  if (snapshot.prs.length !== 100 || new Set(snapshot.prs.map(pr => pr.number)).size !== 100) throw new Error("Replay requires exactly 100 distinct PRs");
  const packages = workspaces(root), closures = discoverBrowserClosures(root);
  const plans = snapshot.prs.map(pr => {
    if (!/^[a-f0-9]{40}$/.test(pr.mergeCommit)) throw new Error("Replay requires immutable merge commits");
    const changed = changedFiles(root, `${pr.mergeCommit}^`, pr.mergeCommit, false);
    if (JSON.stringify(changed) !== JSON.stringify([...pr.changed].sort())) throw new Error(`Incomplete immutable squash diff: #${pr.number}`);
    const before = planChecks(changed, packages), after = selectBrowserClosures(before, closures);
    return { number: pr.number, mergeCommit: pr.mergeCommit, changedSha256: createHash("sha256").update(JSON.stringify(changed)).digest("hex"), before: before.local, after: after.local };
  });
  const omittedSinceBaseline = baseline ? plans.flatMap(pr => {
    const earlier = baseline.plans.find(plan => plan.number === pr.number);
    if (!earlier || earlier.changedSha256 !== pr.changedSha256) throw new Error(`Baseline does not replay the same change: #${pr.number}`);
    return CATEGORIES.filter(category => earlier.after[category] && !pr.after[category]).map(category => ({ number: pr.number, category }));
  }) : undefined;
  if (baseline && baseline.plans.length !== plans.length) throw new Error("Baseline replays a different PR set");
  return { version: 1, plans, noLongerBrowser: plans.filter(pr => pr.before.browser && !pr.after.browser).map(pr => pr.number),
    ...(omittedSinceBaseline ? { omittedSinceBaseline } : {}),
    domains: Object.fromEntries(Object.entries(closures).map(([category, closure]) => [category, {
      files: closure.files.length, directories: closure.directories?.length ?? 0, unresolved: closure.unresolved.length,
      closureSha256: createHash("sha256").update(JSON.stringify(closure)).digest("hex"),
      runtimeVariableExamples: closure.unresolved.filter(edge => edge.startsWith("Computed import ")).slice(0, 5),
    }])), closures };
}
if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const input = process.argv[2], output = process.argv[3], earlier = process.argv[4];
  if (!input || !output) throw new Error("Usage: bun scripts/replay-browser-selection.ts <100-PR-snapshot.json> <report.json> [baseline-report.json]");
  const snapshot = JSON.parse(readFileSync(input, "utf8"));
  const report = replayBrowserSelection(root, snapshot, earlier ? JSON.parse(readFileSync(earlier, "utf8")) : undefined);
  await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ browserBefore: report.plans.filter(pr => pr.before.browser).length,
    browserAfter: report.plans.filter(pr => pr.after.browser).length, noLongerBrowser: report.noLongerBrowser,
    ...(report.omittedSinceBaseline ? { omittedSinceBaseline: report.omittedSinceBaseline } : {}), domains: report.domains }, null, 2));
}
