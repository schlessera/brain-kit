// Validate every pending changeset, independently of the contribution gate's
// diff/release exemptions. Use the installed CLI's own reader and workspace
// discovery so YAML and package identity match `changeset status`.
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve("@changesets/cli/package.json"));
const { default: readChangesets } = cliRequire("@changesets/read") as {
  default(root: string): Promise<{
    id: string;
    releases: { name: string; type: string }[];
  }[]>;
};
const { getPackages } = cliRequire("@manypkg/get-packages") as {
  getPackages(root: string): Promise<{
    packages: { packageJson: { name: string } }[];
  }>;
};

export async function pendingChangesetPackageErrors(root: string): Promise<string[]> {
  const [changesets, workspace] = await Promise.all([
    readChangesets(root), getPackages(root),
  ]);
  const names = new Set(workspace.packages.map(p => p.packageJson.name));
  return changesets.flatMap(changeset => changeset.releases
    .filter(release => !names.has(release.name))
    .map(release => `.changeset/${changeset.id}.md: unknown workspace package "${release.name}"`))
    .sort();
}

if (import.meta.main) {
  try {
    const errors = await pendingChangesetPackageErrors(
      resolve(process.argv[2] ?? resolve(import.meta.dir, ".."))
    );
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("All pending changeset package references resolve to workspace manifests.");
    }
  } catch (error) {
    console.error("Cannot validate pending changeset packages:", error);
    process.exitCode = 1;
  }
}
