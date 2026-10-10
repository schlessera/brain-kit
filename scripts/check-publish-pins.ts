// Workspace-pin probe: verifies what `bun publish` would actually write for
// the `workspace:*` cross-dependencies.
//
// bun resolves workspace pins from the INSTALLED workspace state, so a
// `changeset version` bump without a fresh `bun install` publishes manifests
// pinning the PREVIOUS version — which was never published, making every
// dependent uninstallable (this shipped in 0.2.0). Packing needs no registry
// access and no build: the probe packs each package that has internal deps and
// asserts the pins match the current workspace versions.
//
// Two callers, one implementation so they cannot drift:
//   - scripts/publish.ts refuses the release when the probe fails;
//   - CI's pack job runs it on every PR (`bun scripts/check-publish-pins.ts`),
//     where the smoke test's file: overrides would otherwise mask a wrong pin.

import { join, resolve } from "path";
import { listPublishablePackages } from "./publishable-packages.ts";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}

export interface PinFinding {
  package: string;
  dep: string;
  pinned: string | undefined;
  expected: string;
}

/**
 * Packs each package with internal deps and returns every pin that does not
 * match the current workspace version. Throws when packing itself fails.
 */
export function checkPublishPins(root: string): PinFinding[] {
  const publishable = listPublishablePackages(root);
  const dirs = publishable.map((pkg) => pkg.dir);
  const manifests = new Map<string, Manifest>(publishable.map((pkg) => [pkg.dir, pkg.manifest]));
  const versions = new Map<string, string>(publishable.map((pkg) => [pkg.name, pkg.version]));

  const findings: PinFinding[] = [];
  for (const dir of dirs) {
    const manifest = manifests.get(dir)!;
    const internal = Object.keys(manifest.dependencies ?? {}).filter((d) =>
      versions.has(d)
    );
    if (internal.length === 0) continue;
    const tarball = join(root, "node_modules", ".pin-probe.tgz");
    const pack = Bun.spawnSync(
      [process.execPath, "pm", "pack", "--filename", tarball],
      { cwd: join(root, "packages", dir) }
    );
    if (pack.exitCode !== 0) {
      throw new Error(
        `Pin probe failed: could not pack ${manifest.name}:\n` +
          new TextDecoder().decode(pack.stderr)
      );
    }
    const tar = Bun.spawnSync(["tar", "-xzOf", tarball, "package/package.json"]);
    const packed = JSON.parse(new TextDecoder().decode(tar.stdout)) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of internal) {
      const pinned = packed.dependencies?.[dep];
      const expected = versions.get(dep)!;
      if (pinned !== expected) {
        findings.push({ package: manifest.name, dep, pinned, expected });
      }
    }
  }
  return findings;
}

/** Runs the probe and exits the process with the operator-facing message on failure. */
export function assertPublishPins(root: string): void {
  const findings = checkPublishPins(root);
  if (findings.length === 0) {
    console.log("Workspace pins match the packed manifests.");
    return;
  }
  for (const f of findings) {
    console.error(
      `Publish refused: ${f.package} would ship ${f.dep}@${f.pinned}, ` +
        `but the workspace version is ${f.expected}.`
    );
  }
  console.error(
    "bun.lock still records the old workspace versions (a plain — or even " +
      "--force — install does not refresh them): run `rm bun.lock && bun " +
      "install` after versioning, then release again."
  );
  process.exit(1);
}

if (import.meta.main) {
  assertPublishPins(resolve(process.argv[2] ?? join(import.meta.dir, "..")));
}
