/** Full source/dependency/native byte identity; emitted artifacts contain no local paths. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import { protocol } from "./protocol";
import { semanticCases, prepareSemantic } from "./workload";

export const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const root = new URL("../../../", import.meta.url).pathname;
function fileTree(path: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) Object.assign(out, fileTree(full, rel));
    else if (stat.isFile()) out[rel] = sha(readFileSync(full));
    else throw Error("Runtime contains unsupported special member");
  }
  return out;
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
  const sourceHashes: Record<string, string> = {};
  for (const dir of ["packages/core/src", "scripts/evals/canonical-conflicts"]) for (const [path, hash] of Object.entries(fileTree(join(root, dir))))
    sourceHashes[`${dir}/${path}`] = hash;
  for (const path of ["docs/decisions/example-corpus.md", "docs/decisions/hygiene-review.md", "docs/canonical-conflict-investigation.md", "package.json", "bun.lock", "packages/core/package.json", "packages/core/skills/content-hygiene/SKILL.md", "scripts/measure-sonnet55-cost.ts", "scripts/captures/clock.ts", "packages/ui-kit/fixtures/time.ts",
    "bunfig.toml", "scripts/test.ts", "scripts/test-network-preload.ts", "scripts/test-network-child-preload.ts",
    ...readdirSync(join(root, "tests")).filter(n => n.startsWith("canonical-conflict") && n.endsWith(".test.ts")).map(n => `tests/${n}`)]) sourceHashes[path] = sha(readFileSync(join(root, path)));
  const dependencies = fileTree(join(root, "node_modules"));
  const dependencyLinks = links(join(root, "node_modules"));
  const workspaceTrees = Object.fromEntries(readdirSync(join(root, "packages")).sort().map(name => {
    const files = fileTree(join(root, "packages", name, "src"));
    return [name, { files: Object.keys(files).length, sha: sha(JSON.stringify(files)), manifestSha: sha(readFileSync(join(root, "packages", name, "package.json"))) }];
  }));
  const binary = bundledClaudeBinary(); if (!binary) throw Error("Native missing");
  const sdk = JSON.parse(readFileSync(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
  if (sdk.version !== protocol.runtime.sdk || Bun.version !== protocol.runtime.bun) throw Error("Actual installed runtime differs from fresh comparison");
  const inputs = semanticCases.map(c => { const p = prepareSemantic(c); try { return { case: c, files: p.files, config: p.config }; } finally { p.close(); } });
  const manifest = { sourceHashes: Object.fromEntries(Object.entries(sourceHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), workspaceTrees,
    dependencyFiles: Object.keys(dependencies).length, dependencyTreeSha: sha(JSON.stringify(dependencies)),
    dependencyLinkSha: sha(JSON.stringify(dependencyLinks)), dependencyLinks: Object.keys(dependencyLinks).length,
    sdk: sdk.version, native: { sha: sha(readFileSync(binary)), bytes: lstatSync(binary).size, expectedCli: protocol.runtime.cli },
    bun: { version: Bun.version, sha: sha(readFileSync(process.execPath)) }, fixtureSha: sha(JSON.stringify(inputs)), protocolSha: sha(JSON.stringify(protocol)) };
  return { manifest, freezeSha: sha(JSON.stringify(manifest)), inputs, protocol };
}
if (import.meta.main) console.log(JSON.stringify(freeze(), null, 2));
