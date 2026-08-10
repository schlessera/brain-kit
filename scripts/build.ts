import { cpSync, existsSync, rmSync } from "fs";
import { resolve } from "path";

const packages = [
  "core",
  "ui-sdk",
  "ui-backend-claude",
  "ui-backend-pi",
  "ui-render-puppeteer",
  "ui-server",
  "ui-react",
  "module-finance",
  "module-jobs",
  "module-speaking",
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

  if (packageName === "ui-react") {
    // Precompiled stylesheet for consumers without a Tailwind build. The
    // entry pins its scan root to the package src via @source, so the output
    // is identical no matter where the CLI runs from.
    const cssEntry = resolve(packageDir, "src", "styles.css");
    const cssOut = resolve(distDir, "styles.css");
    const css = Bun.spawn(
      [bunx, "@tailwindcss/cli", "-i", cssEntry, "-o", cssOut, "--minify"],
      { cwd: packageDir, stdout: "inherit", stderr: "inherit" }
    );
    const cssExit = await css.exited;
    if (cssExit !== 0) process.exit(cssExit);
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
