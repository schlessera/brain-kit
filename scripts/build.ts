const packages = [
  "core",
  "ui-sdk",
  "ui-backend-claude",
  "ui-backend-pi",
  "ui-render-puppeteer",
  "module-finance",
  "module-jobs",
  "module-speaking",
];

for (const packageName of packages) {
  console.log(`Building @endoxa/${packageName}...`);
  const subprocess = Bun.spawn(
    ["tsc", "-p", `packages/${packageName}/tsconfig.build.json`],
    { stdout: "inherit", stderr: "inherit" }
  );
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
