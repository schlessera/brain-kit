/** Complete fictional on-disk inputs for the three prospective arms. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initContext } from "../../../packages/core/src/lib/context";
import { benchmarkInput, researchPacket, type BenchmarkCase } from "./benchmark";
import { hash } from "./semantic";
export function materialize(c: BenchmarkCase) {
  const input = benchmarkInput(c), company = researchPacket(c);
  return {
    "career/criteria.md": `---\ntype: note\ntitle: Voyage work criteria\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\n---\n\n${input.criteria}\n`,
    "notes/identity.md": `---\ntype: note\ntitle: Odysseus work identity\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\n---\n\n${input.identity}\n`,
    [`career/opportunities/voyage-role/posting.md`]: `---\ntype: opportunity\ntitle: ${JSON.stringify(c.title)}\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\n---\n\n${input.posting}`,
    [`career/opportunities/voyage-role/status.md`]: `---\ntype: opportunity\ntitle: ${JSON.stringify(c.company)}\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\n---\n\n## Pipeline\n\n| Step | Date | Outcome |\n| --- | --- | --- |\n| Found | 2026-07-12 | Source retained; no application decision |\n`,
    [`career/opportunities/voyage-role/company-packet.md`]: `---\ntype: note\ntitle: Fictional company research\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\n---\n\n${company.source}`,
    "tablets/sentinel.md": "---\ntype: tablet\ntitle: Penelope's unchanged account\ncreated: 2026-07-12\nupdated: 2026-07-12\nstatus: active\n---\n\nThe unrelated account remains unchanged.\n",
    "inputs/metadata.json": JSON.stringify(input.job, null, 2) + "\n",
    "inputs/scoring.json": JSON.stringify(input.config, null, 2) + "\n",
    "settings/jobs.json": JSON.stringify({ scoring: input.config }, null, 2) + "\n",
  };
}
export async function prepare(c: BenchmarkCase) {
  const root = mkdtempSync(join(tmpdir(), "brain-job-fit-fresh-"));
  try {
    for (const [path, raw] of Object.entries(materialize(c))) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), raw); }
    mkdirSync(join(root, "modules/jobs"), { recursive: true });
    const modulePath = new URL("../../../packages/module-jobs/src/module.ts", import.meta.url).pathname;
    writeFileSync(join(root, "modules/jobs/module.ts"), `export { default } from ${JSON.stringify(modulePath)};\n`);
    writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "./modules/jobs": { enabled: true, criteria: "career/criteria.md", boards: [] } }, taxonomy: { types: { tablet: { dir: "tablets" } } } }, null, 2) + "\n");
    mkdirSync(join(root, "assets")); writeFileSync(join(root, "assets/guard.bin"), Buffer.from([0, 255, 128, 13, 10]));
    const brain = await initContext({ root });
    return { root, brain, input: benchmarkInput(c), close: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
/** Whole descendant state, including binary files, links, modes and nanosecond clocks. */
export function observe(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  function walk(path: string, rel: string) {
    const s = lstatSync(path, { bigint: true });
    out[rel] = { mode: Number(s.mode), mtimeNs: String(s.mtimeNs),
      content: s.isFile() ? hash(readFileSync(path)) : s.isSymbolicLink() ? readlinkSync(path) : null,
      kind: s.isFile() ? "file" : s.isSymbolicLink() ? "link" : s.isDirectory() ? "directory" : "unsupported" };
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), rel ? `${rel}/${name}` : name);
    else if (!s.isFile() && !s.isSymbolicLink()) throw Error("Unsupported fixture member");
  }
  for (const name of readdirSync(root).sort()) walk(join(root, name), name);
  return out;
}
