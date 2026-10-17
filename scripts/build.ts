import { cpSync, existsSync, rmSync } from "fs";
import { resolve } from "path";
import { markBinsExecutable } from "./bin-modes.ts";
import { selectBuildPackages } from "./publishable-packages.ts";
import { ensureWorkspaceLease } from "./workspace-lease.mjs";

// Build order is not load-bearing: each package's tsconfig.build.json extends
// the root tsconfig, whose customConditions ["bun"] resolve cross-package
// imports to the sibling's src/, never to emitted .d.ts. What consumers get
// from dist is checked separately, after this script, by
// scripts/check-dist-types.ts. The packages come from their manifests, in the
// same dependency-first order the release publishes them
// (scripts/publishable-packages.ts), so a future resolution change fails
// loudly instead of subtly.
//
//   bun scripts/build.ts [--for <dir>[,<dir>…]] [--dry-run [root]]
//
// --for includes each named package and its forward workspace dependencies.
// --dry-run prints that order without building or removing anything.
const args = process.argv.slice(2);
let dryRun = false, dryRoot: string | undefined, directories: string[] | undefined;
let packages: ReturnType<typeof selectBuildPackages>;
let root: string;
try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--for" && directories === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--for requires comma-separated package directories");
      directories = value.split(",");
    } else if (!arg.startsWith("--") && dryRoot === undefined) dryRoot = arg;
    else throw new Error(`Unexpected build argument: ${arg}`);
  }
  if (dryRoot !== undefined && !dryRun) throw new Error("A root argument is accepted only with --dry-run");
  root = resolve(dryRoot ?? resolve(import.meta.dir, ".."));
  packages = selectBuildPackages(root, directories);
} catch (error) {
  console.error(`Build failed: ${(error as Error).message}`);
  process.exit(1);
}
if (dryRun) {
  for (const { dir } of packages) console.log(`Would build packages/${dir}`);
  process.exit(0);
}

const coordinated = await ensureWorkspaceLease(root, "write");
if (coordinated !== undefined) process.exit(coordinated);
const bunx = Bun.which("bunx");
if (!bunx) {
  console.error(
    "Build failed: could not find `bunx` on PATH. Install Bun >= 1.3 from https://bun.sh."
  );
  process.exit(1);
}

for (const { dir: packageName, manifest } of packages) {
  const packageDir = resolve(root, "packages", packageName);
  const distDir = resolve(packageDir, "dist");
  rmSync(distDir, { recursive: true, force: true });

  console.log(`Building packages/${packageName}...`);
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn([bunx, "tsc", "-p", resolve(packageDir, "tsconfig.build.json")], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    console.error(
      `Build failed: could not spawn \`bunx tsc\` for packages/${packageName}: ${(error as Error).message}`
    );
    process.exit(1);
  }
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) process.exit(exitCode);

  if (packageName === "ui-react" || packageName === "ui-kit") {
    // Precompiled stylesheet for consumers without a Tailwind build. The
    // entry pins its scan root to the package src via @source, so the output
    // is identical no matter where the CLI runs from.
    const cssEntry = resolve(packageDir, "src", "styles.css");
    const cssOut = resolve(distDir, "styles.css");
    const css = Bun.spawn(
      [bunx, "-p", "@tailwindcss/cli", "tailwindcss", "-i", cssEntry, "-o", cssOut, "--minify"],
      { cwd: packageDir, stdout: "inherit", stderr: "inherit" }
    );
    const cssExit = await css.exited;
    if (cssExit !== 0) process.exit(cssExit);

    // The Tailwind-consumer theme entry ships from dist like every other
    // export target, so a dist-only tarball keeps both CSS exports working.
    // It is copied verbatim: consumers' Tailwind builds process it themselves.
    cpSync(resolve(packageDir, "src", "theme.css"), resolve(distDir, "theme.css"), {
      preserveTimestamps: true,
    });
    // The kit's theme.css imports its tokens.css; both ship, and tokens.css is
    // also the entry a consumer with its own Tailwind scale imports directly.
    if (packageName === "ui-kit") {
      cpSync(resolve(packageDir, "src", "tokens.css"), resolve(distDir, "tokens.css"), {
        preserveTimestamps: true,
      });
    }
  }

  if (packageName === "core") {
    const hooksSource = resolve(packageDir, "src", "hooks");
    if (!existsSync(hooksSource)) {
      console.error(`Build failed: core hooks source directory is missing: ${hooksSource}`);
      process.exit(1);
    }
    cpSync(hooksSource, resolve(distDir, "hooks"), {
      recursive: true,
      preserveTimestamps: true,
    });
  }

  // tsc writes the bin targets 0644; node_modules/.bin links straight to them.
  try {
    markBinsExecutable(packageDir, manifest);
  } catch (error) {
    console.error(`Build failed: packages/${packageName} declares a bin the build did not produce: ${(error as Error).message}`);
    process.exit(1);
  }
}
