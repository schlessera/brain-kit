import { rmSync } from "fs";
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
  "module-travel",
];

for (const packageName of packages) {
  rmSync(resolve(import.meta.dir, "..", "packages", packageName, "dist"), {
    recursive: true,
    force: true,
  });
}
