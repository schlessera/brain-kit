import { rmSync } from "fs";
import { resolve } from "path";

const packages = [
  "geo",
  "render-template",
  "core",
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
  "module-video",
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
