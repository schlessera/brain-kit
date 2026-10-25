/** Independent repository oracle: Bun's resolver + TS's import preprocessor.
 * Production uses its AST walker/TypeScript runtime resolver. No source is executed.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { workspaces } from "../../scripts/ci-plan";
import { discoverTests } from "../../scripts/test-shards";

export interface AuditedImport {
  importer: string;
  specifier: string;
  target: string;
  resolved: boolean;
  workspace: string;
  declared: boolean;
  unitOwners: string[];
  runnerOwners: string[];
}

export function auditUnitConsumers(root: string, browserEntrypoints: readonly string[]): AuditedImport[] {
  const git = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (git.exitCode) throw new Error(new TextDecoder().decode(git.stderr));
  const tracked = new Set(new TextDecoder().decode(git.stdout).split("\0").filter(Boolean));
  const paths = [...tracked].filter(path => /\.[cm]?[jt]sx?$/.test(path));
  const tests = discoverTests(root, ["packages", "tests"]), leaves = new Set(tests);
  const packages = workspaces(root), reverse = new Map<string, Set<string>>();
  const records: Omit<AuditedImport, "unitOwners" | "runnerOwners">[] = [];
  const helpers = paths.filter(path => /^(?:tests\/|packages\/[^/]+\/tests\/)/.test(path) && !leaves.has(path));
  const add = (target: string, owner: string) => {
    const owners = reverse.get(target) ?? new Set<string>(); owners.add(owner); reverse.set(target, owners);
  };
  const helperNames = new Set(helpers.map(file => basename(file).replace(/\.[cm]?[jt]sx?$/, "")));
  for (const file of paths) {
    const text = readFileSync(join(root, file), "utf8");
    const imports = ts.preProcessFile(text, true, true).importedFiles;
    for (const entry of imports) {
      const specifier = entry.fileName;
      let target: string | undefined;
      try { target = relative(root, Bun.resolveSync(specifier.split("?")[0]!, dirname(join(root, file)))).replaceAll("\\", "/"); }
      catch { /* unresolved targets remain a separately tested conservative fallback */ }
      if (target && tracked.has(target)) add(target, file);
      if (!/^packages\/[^/]+\/tests\//.test(file)) continue;
      const owner = packages.find(pkg => pkg.dir === file.split("/")[1])!;
      const intended = target ?? (specifier.startsWith(".") ? relative(root, resolve(root, dirname(file), specifier)) : undefined);
      const dependency = packages.find(pkg => specifier === pkg.name || specifier.startsWith(pkg.name + "/")) ??
        packages.find(pkg => intended?.startsWith(`packages/${pkg.dir}/`));
      if (!dependency || dependency.dir === owner.dir) continue;
      // Missing generated assets and broken relative imports remain explicit
      // inputs. Their runnable owners must pass the same production fallback check.
      if (!intended) throw new Error(`Unresolved audit target: ${file}: ${specifier}`);
      records.push({ importer: file, specifier, target: intended, resolved: !!target && tracked.has(target), workspace: dependency.dir,
        declared: owner.dependencies.includes(dependency.name) });
    }
    // Independent lexical file-reference scan, including shell/Python payloads.
    // Remove resolved import spans so a source index cannot name a fixture index.
    if (/^(?:tests\/|scripts\/|packages\/[^/]+\/(?:tests|scripts)\/)/.test(file)) {
      let references = text;
      for (const entry of [...imports].sort((a, b) => b.pos - a.pos))
        references = references.slice(0, entry.pos) + " ".repeat(entry.end - entry.pos) + references.slice(entry.end);
      for (const match of references.matchAll(/["'`]([./\w-]+)["'`]|(?:^|[\s"'`])([./\w-]+\.[cm]?[jt]sx?)(?=$|[\s"'`?])/g)) {
        const value = (match[1] ?? match[2])!;
        const name = basename(value).replace(/\.[cm]?[jt]sx?$/, "");
        const specifier = value.startsWith(".") ? value : `./${value}`;
        // Only helpers can contribute a lexical edge. Impossible relative
        // lookups otherwise fill Bun's native resolver cache with arbitrary
        // quoted words from every test, retaining gigabytes until VM exit.
        // Existing paths include directories and symlink aliases; helper stems
        // include extension-appended/replaced source files and name fallbacks.
        if (!helperNames.has(name) && !existsSync(resolve(root, dirname(file), specifier))) continue;
        let target: string | undefined;
        try { target = relative(root, Bun.resolveSync(specifier, dirname(join(root, file)))); }
        catch { /* split join arguments / root-relative payload: inspect candidates */ }
        for (const helper of helpers) if (target ? target === helper :
          basename(helper).replace(/\.[cm]?[jt]sx?$/, "") === name) add(helper, file);
      }
    }
  }
  const owners = (input: string) => {
    const visited = new Set([input]), pending = [input];
    for (let i = 0; i < pending.length; i++) for (const owner of reverse.get(pending[i]!) ?? [])
      if (!visited.has(owner)) { visited.add(owner); pending.push(owner); }
    return visited;
  };
  const runners = [...browserEntrypoints, "packages/ui-kit/vitest.config.ts",
    "scripts/prove-worker-identity.ts", "scripts/prove-native-host.ts",
    // Explicit manual/compile entrypoints, not automated unit coverage.
    "packages/ui-backend-pi/scripts/measure-startup.ts",
    "packages/ui-react/tests/render/streaming-bench.tsx",
    "packages/ui-react/tests/block-contract.test-d.ts",
    "packages/ui-server/tests/maintenance-temp-shared-uid-proof.ts"];
  return records.map(record => {
    const closure = owners(record.importer);
    return { ...record, unitOwners: tests.filter(file => closure.has(file)),
      runnerOwners: runners.filter(file => closure.has(file)) };
  }).sort((a, b) => `${a.importer}:${a.specifier}`.localeCompare(`${b.importer}:${b.specifier}`));
}
