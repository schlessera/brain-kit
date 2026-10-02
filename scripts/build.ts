import { cpSync, existsSync, rmSync } from "fs";
import { resolve } from "path";

// Build order is not load-bearing: each package's tsconfig.build.json extends
// the root tsconfig, whose customConditions ["bun"] resolve cross-package
// imports to the sibling's src/, never to emitted .d.ts. What consumers get
// from dist is checked separately, after this script, by
// scripts/check-dist-types.ts. Dependencies are listed before dependents
// anyway, so a future resolution change fails loudly instead of subtly.
const packages = [
  "geo",
  "render-template",
  "core",
  // Ahead of ui-sdk, whose `show_block` handler classifies links with the
  // kit's `./links` export (#43), and of ui-react, which renders the kit.
  "ui-kit",
  "ui-sdk",
  "ui-backend-claude",
  "ui-backend-pi",
  "ui-render-puppeteer",
  "scrape",
  "ui-server",
  "ui-react",
  "module-finance",
  "module-images",
  "module-jobs",
  "module-speaking",
  "module-travel",
];

const root = resolve(import.meta.dir, "..");
const bunx = Bun.which("bunx");
if (!bunx) {
  console.error(
    "Build failed: could not find `bunx` on PATH. Install Bun >= 1.3 from https://bun.sh."
  );
  process.exit(1);
}

for (const packageName of packages) {
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
}
