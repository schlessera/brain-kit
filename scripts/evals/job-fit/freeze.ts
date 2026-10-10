/** Full source/dependency/native byte identity; emitted artifacts contain no local paths. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import {hashFrozenFile} from "./frozen-file";
import { protocol } from "./protocol";
import { benchmark, benchmarkInput, researchPacket } from "./benchmark";
import { materialize } from "./brain";
import { semanticRequest } from "./semantic";
import { rubric } from "./rubric";

export const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const root = new URL("../../../", import.meta.url).pathname;
/** Observe actual modes and refuse dependency inodes shared outside this owned tree. */
export function observeTree(path: string, rejectExternalHardlinks = false) {
  const hashes: Record<string, string> = {}, modes: Record<string, number> = {};
  const inodes = new Map<string, { occurrences: number; links: number }>();
  function walk(directory: string, prefix: string) {
    modes[prefix ? `${prefix}/` : "./"] = lstatSync(directory).mode & 0o7777;
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(full);
      if (stat.isSymbolicLink()) { modes[rel] = stat.mode & 0o7777; continue; }
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) {
        hashes[rel] = hashFrozenFile(full); modes[rel] = stat.mode & 0o7777;
        const key = `${stat.dev}:${stat.ino}`, previous = inodes.get(key);
        inodes.set(key, { occurrences: (previous?.occurrences ?? 0) + 1, links: stat.nlink });
      } else throw Error("Runtime contains unsupported special member");
    }
  }
  walk(path, "");
  if (rejectExternalHardlinks && [...inodes.values()].some(v => v.links > v.occurrences))
    throw Error("Installed dependency inode has external hardlinks");
  return { hashes, modes };
}
function links(path: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const resolved = relative(root, realpathSync(full));
      if (resolved.startsWith("../") || resolved === "..") throw Error("Runtime link leaves owned source/dependencies");
      out[rel] = readlinkSync(full);
    } else if (stat.isDirectory()) Object.assign(out, links(full, rel));
  }
  return out;
}
export function freeze() {
  const sourceHashes: Record<string, string> = {}, sourceModes: Record<string, number> = {};
  for (const dir of ["packages/core/src", "packages/common/src", "packages/module-jobs/src", "scripts/evals/job-fit"]) {
    const tree = observeTree(join(root, dir));
    for (const [path, hash] of Object.entries(tree.hashes)) sourceHashes[`${dir}/${path}`] = hash;
    for (const [path, mode] of Object.entries(tree.modes)) sourceModes[`${dir}/${path}`] = mode;
  }
  for (const path of ["docs/decisions/example-corpus.md", "docs/decisions/hygiene-review.md", "docs/job-fit-investigation.md", "package.json", "bun.lock", "packages/core/package.json", "packages/module-jobs/skills/research-opportunity/SKILL.md", "packages/module-jobs/skills/jobs-review/SKILL.md", "packages/module-jobs/skills/interview-scheduled/SKILL.md", "packages/module-jobs/package.json", "docs/decisions/jobs-board-defaults.md", "scripts/measure-sonnet55-cost.ts", "scripts/captures/clock.ts", "packages/ui-kit/fixtures/time.ts",
    "scripts/evals/native-paid-entry.ts","scripts/evals/native-paid-policy.ts","scripts/evals/native-grant.ts","scripts/evals/native-pricing.ts","tests/native-grant.test.ts","tests/native-paid-policy.test.ts",
    "bunfig.toml", "scripts/test.ts", "scripts/test-network-preload.ts", "scripts/test-network-child-preload.ts",
    ...readdirSync(join(root, "tests")).filter(n => n.startsWith("job-fit") && n.endsWith(".test.ts")).map(n => `tests/${n}`)]) { sourceHashes[path] = sha(readFileSync(join(root, path))); sourceModes[path] = lstatSync(join(root, path)).mode & 0o7777; }
  const dependencyTree = observeTree(join(root, "node_modules"), true), dependencies = dependencyTree.hashes;
  const dependencyLinks = links(join(root, "node_modules"));
  const workspaceTrees = Object.fromEntries(readdirSync(join(root, "packages")).sort().map(name => {
    const tree = observeTree(join(root, "packages", name, "src")), files = tree.hashes;
    const manifestPath = join(root, "packages", name, "package.json");
    return [name, { files: Object.keys(files).length, sha: sha(JSON.stringify(files)), modeSha: sha(JSON.stringify(tree.modes)),
      manifestSha: sha(readFileSync(manifestPath)), manifestMode: lstatSync(manifestPath).mode & 0o7777 }];
  }));
  const binary = bundledClaudeBinary(); if (!binary) throw Error("Native missing");
  const sdk = JSON.parse(readFileSync(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
  if (sdk.version !== protocol.runtime.sdk || Bun.version !== protocol.runtime.bun) throw Error("Actual installed runtime differs from fresh comparison");
  const inputs = benchmark.map(c => ({ case: c, input: benchmarkInput(c), request: semanticRequest(benchmarkInput(c)), research: researchPacket(c),
    files: materialize(c), expectedWithoutAuthority: { inputFiles: materialize(c), opportunityDecision: null, applied: false, writes: [] },
    generatedModuleBinding: { file: "modules/jobs/module.ts", source: "packages/module-jobs/src/module.ts", pathOnlyRuntimeBinding: true },
    binarySentinelBase64: Buffer.from([0, 255, 128, 13, 10]).toString("base64") }));
  const manifest = { sourceHashes: Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), sourceModes: Object.fromEntries(Object.entries(sourceModes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), workspaceTrees,
    dependencyModeSha: sha(JSON.stringify(dependencyTree.modes)), externalDependencyHardlinks: "refused", dependencyFiles: Object.keys(dependencies).length, dependencyTreeSha: sha(JSON.stringify(dependencies)),
    dependencyLinkSha: sha(JSON.stringify(dependencyLinks)), dependencyLinks: Object.keys(dependencyLinks).length,
    sdk: sdk.version, native: { sha: hashFrozenFile(binary), bytes: lstatSync(binary).size, mode: lstatSync(binary).mode & 0o7777, expectedCli: protocol.runtime.cli },
    bun: { version: Bun.version, sha: hashFrozenFile(process.execPath), mode: lstatSync(process.execPath).mode & 0o7777 }, fixtureSha: sha(JSON.stringify(inputs)), protocolSha: sha(JSON.stringify(protocol)) };
  return { manifest, freezeSha: sha(JSON.stringify(manifest)), inputs, protocol, rubric };
}
if (import.meta.main) console.log(JSON.stringify(freeze(), null, 2));
