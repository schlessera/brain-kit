/**
 * Aggregate the app-connection write audit (`BRAIN_UI_APP_WRITE_AUDIT`)
 * into an inventory of calling sites. Usage: bun scripts/app-write-inventory.ts <audit.jsonl>...
 * Prints serving-phase sites first (a hosted app answering requests: each must
 * move to the write worker), then boot-phase sites (createApp before it
 * serves), standalone sites (a component built outside createApp, as tests
 * and the cron runner do) and writes a test fixture made directly, each with
 * its count, changed rows and up to three callers.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
type Entry = { phase: "boot" | "serving" | "standalone"; rows: number; site: string[] };
const groups = new Map<string, { phase: string; count: number; rows: number; callers: Set<string> }>();
const frame = (line: string) => {
  const match = line.match(/^(.*?)\s*\(?((?:\/|[A-Za-z]:)[^()]+?):(\d+):\d+\)?$/);
  if (!match) return line;
  const [, name, path, row] = match;
  return `${relative(root, path!)}:${row}${name ? ` ${name.trim()}` : ""}`;
};
for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as Entry;
    const frames = entry.site.map(frame).filter(f => f.startsWith("packages/"));
    // A write a test makes, or a product call a test makes directly on the
    // app's database, is a fixture, not a hosted-path writer.
    const product = frames.find(f => /^packages\/[^/]+\/src\//.test(f));
    const phase = product && !frames.some(f => f.includes("/tests/")) ? entry.phase : "fixture";
    const site = product ?? frames[0] ?? "(no package frame)";
    const key = `${phase}\t${site}`;
    const group = groups.get(key) ?? { phase, count: 0, rows: 0, callers: new Set<string>() };
    group.count++; group.rows += entry.rows;
    const next = frames[frames.indexOf(site) + 1];
    if (next) group.callers.add(next);
    groups.set(key, group);
  }
}
for (const phase of ["serving", "boot", "standalone", "fixture"]) {
  const rows = [...groups.entries()].filter(([, g]) => g.phase === phase).sort((a, b) => b[1].count - a[1].count);
  console.log(`## ${phase} (${rows.length} sites)`);
  for (const [key, g] of rows) {
    console.log(`${String(g.count).padStart(6)}x ${String(g.rows).padStart(7)} rows  ${key.split("\t")[1]}`);
    for (const caller of [...g.callers].slice(0, 3)) console.log(`${" ".repeat(24)}<- ${caller}`);
  }
}
