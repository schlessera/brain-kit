/** Freeze the complete potential runtime closure, including actual native executables. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { protocol, rubric } from "./protocol";
export const repo = resolve(import.meta.dir, "../../..");
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".git", "dist", "results"].includes(entry.name)) return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  }).sort();
}
function packageRoot(name: string, from: string) {
  let entry: string;
  try { entry = Bun.resolveSync(`${name}/package.json`, from); }
  catch { entry = Bun.resolveSync(name, from); }
  let current = dirname(realpathSync(entry));
  while (current !== dirname(current)) {
    const metadata = join(current, "package.json");
    if (existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).name === name) return current;
    current = dirname(current);
  }
  throw Error(`Cannot locate installed package ${name}`);
}
export function runtimeFreeze() {
  const sources: Record<string, string> = {};
  for (const dir of ["packages/core/src", "packages/core/skills", "packages/ui-backend-claude/src", "scripts/evals/audit-capabilities", "scripts/evals/note-disposition"])
    for (const path of files(join(repo, dir))) sources[relative(repo, path)] = sha(readFileSync(path));
  for (const path of ["package.json", "bun.lock", "bunfig.toml", "packages/core/package.json", "packages/ui-backend-claude/package.json", "scripts/measure-sonnet55-cost.ts", "tests/audit-capability-eval.test.ts", "tests/audit-capability-benchmark.test.ts", "tests/audit-capability-live.test.ts", "scripts/test.ts", "docs/decisions/example-corpus.md", "docs/decisions/hygiene-review.md", "packages/ui-kit/fixtures/README.md"]) sources[path] = sha(readFileSync(join(repo, path)));
  const packages: Record<string, { name: string; version: string; filesSha: string; files: number }> = {};
  const seen = new Set<string>();
  function visit(root: string) {
    root = realpathSync(root); if (seen.has(root)) return; seen.add(root);
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const paths = files(root);
    const hashes = Object.fromEntries(paths.map(path => [relative(root, path), sha(readFileSync(path))]));
    const key = `${metadata.name}@${metadata.version}#${sha(JSON.stringify(hashes)).slice(0, 12)}`;
    packages[key] = { name: metadata.name, version: metadata.version, filesSha: sha(JSON.stringify(hashes)), files: paths.length };
    const required = Object.keys(metadata.dependencies ?? {});
    const optional = Object.keys({ ...metadata.optionalDependencies, ...metadata.peerDependencies });
    for (const name of required) visit(packageRoot(name, root));
    for (const name of optional) {
      let child: string;
      try { child = packageRoot(name, root); } catch { continue; }
      visit(child);
    }
  }
  visit(join(repo, "packages/core"));
  visit(packageRoot("@anthropic-ai/claude-agent-sdk", repo));
  const platform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const nativePath = join(packageRoot(platform, repo), "claude");
  const native = { package: platform, file: "claude", sha256: sha(readFileSync(nativePath)), bytes: statSync(nativePath).size };
  const sdkRoot = packageRoot("@anthropic-ai/claude-agent-sdk", repo);
  const manifest = JSON.parse(readFileSync(join(sdkRoot, "manifest.json"), "utf8"));
  // Native bytes are checked against both freeze and installed vendor manifest before spawn.
  const entry = manifest.platforms?.[`${process.platform}-${process.arch}`];
  if (entry?.checksum !== native.sha256 || entry?.binary !== native.file || entry?.size !== native.bytes) throw Error("Installed native binary does not match exact platform SDK manifest");
  if (!readFileSync(join(sdkRoot, "sdk.mjs"), "utf8").includes("getSettings")) throw Error("Installed SDK lacks required settings handshake");
  const binaries = { bun: { version: Bun.version, sha256: sha(readFileSync(process.execPath)), bytes: statSync(process.execPath).size }, claude: { ...native, cliVersion: manifest.version, sdkVersion: JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version } };
  const freeze = { protocol, rubric, sources: Object.fromEntries(Object.entries(sources).sort()), packages: Object.fromEntries(Object.entries(packages).sort()), binaries, benchmarkSha: sha(readFileSync(join(import.meta.dir, "benchmark.json"))) };
  return { ...freeze, freezeSha: sha(JSON.stringify(freeze)) };
}
export function assertNative(command: string, freeze: ReturnType<typeof runtimeFreeze>) {
  if (sha(readFileSync(realpathSync(command))) !== freeze.binaries.claude.sha256) throw Error("Native executable differs from reviewed runtime freeze");
}
if (import.meta.main) console.log(JSON.stringify(runtimeFreeze(), null, 2));
