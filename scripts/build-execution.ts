/** Shared execution body of the ordinary builder and fixed CI operation. */
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildReceipt } from "./build-receipt";
import { markBinsExecutable } from "./bin-modes";
import type { PublishablePackage } from "./publishable-packages";

export async function executeBuild(root: string, packages: PublishablePackage[], jobs: 1 | 2, subset = true, generation?: string): Promise<number> {
  const receipt = buildReceipt(root, { jobs, subset, generation, packages: packages.map(pkg => pkg.dir) });
  const bunx = Bun.which("bunx");
  if (!bunx) {
    console.error(
      "Build failed: could not find `bunx` on PATH. Install Bun >= 1.3 from https://bun.sh."
    );
    receipt.finish(1);
    return 1;
  }

  const compilerLauncher = bunx;
  class PackageBuildFailure extends Error {
    constructor(readonly packageName: string, readonly code: number, detail: string) {
      super(`Build failed: packages/${packageName}: ${detail}`);
    }
  }

  async function buildPackageBody({ dir: packageName, manifest }: PublishablePackage): Promise<void> {
    const packageDir = resolve(root, "packages", packageName);
    const distDir = resolve(packageDir, "dist");
    rmSync(distDir, { recursive: true, force: true });

    console.log(`Building packages/${packageName}...`);
    let subprocess: ReturnType<typeof Bun.spawn>;
    try {
      subprocess = Bun.spawn([compilerLauncher, "tsc", "-p", resolve(packageDir, "tsconfig.build.json")], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      console.error(
        `Build failed: could not spawn \`bunx tsc\` for packages/${packageName}: ${(error as Error).message}`
      );
      throw new PackageBuildFailure(packageName, 1, "could not spawn compiler");
    }
    receipt.childStart(packageName, "tsc", subprocess.pid);
    const exitCode = await subprocess.exited;
    receipt.childExit(packageName, "tsc", exitCode);
    if (exitCode !== 0) throw new PackageBuildFailure(packageName, exitCode, `compiler exited ${exitCode}`);

    if (packageName === "ui-react" || packageName === "ui-kit") {
      // Precompiled stylesheet for consumers without a Tailwind build. The
      // entry pins its scan root to the package src via @source, so the output
      // is identical no matter where the CLI runs from.
      const cssEntry = resolve(packageDir, "src", "styles.css");
      const cssOut = resolve(distDir, "styles.css");
      const css = Bun.spawn(
        [compilerLauncher, "-p", "@tailwindcss/cli", "tailwindcss", "-i", cssEntry, "-o", cssOut, "--minify"],
        { cwd: packageDir, stdout: "inherit", stderr: "inherit" }
      );
      receipt.childStart(packageName, "css", css.pid);
      const cssExit = await css.exited;
      receipt.childExit(packageName, "css", cssExit);
      if (cssExit !== 0) throw new PackageBuildFailure(packageName, cssExit, `stylesheet compiler exited ${cssExit}`);

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
        throw new PackageBuildFailure(packageName, 1, "hooks source directory is missing");
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
      throw new PackageBuildFailure(packageName, 1, "declared bin output is missing");
    }
  }


  async function buildPackage(pkg: PublishablePackage): Promise<void> {
    receipt.packageStart(pkg.dir);
    try {
      await buildPackageBody(pkg);
      receipt.packageEnd(pkg.dir, true);
    } catch (error) {
      receipt.packageEnd(pkg.dir, false);
      throw error;
    }
  }

  let code = 0;
  try {
    if (jobs === 1) {
      for (const pkg of packages) await buildPackage(pkg);
    } else {
      const pending = new Set(packages.map(pkg => pkg.name));
      const selected = new Set(pending);
      while (pending.size) {
        const level = packages.filter(pkg => pending.has(pkg.name) &&
          Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies })
            .every(name => name === pkg.name || !selected.has(name) || !pending.has(name)));
        if (!level.length) throw new Error("Cannot schedule cyclic build dependencies");
        for (let index = 0; index < level.length; index += jobs) {
          const batch = level.slice(index, index + jobs);
          // Never exit/reject while a started peer still owns output/compiler work.
          const results = await Promise.allSettled(batch.map(buildPackage));
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (errors.length) {
            for (const error of errors.slice(1)) console.error(String(error.reason));
            throw errors[0]!.reason;
          }
          for (const pkg of batch) pending.delete(pkg.name);
        }
      }
    }
  } catch (error) {
    console.error(String(error));
    code = error instanceof PackageBuildFailure ? error.code : 1;
  }
  receipt.finish(code);
  return code;
}
