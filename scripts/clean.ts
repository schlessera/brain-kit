import { rmSync } from "fs";
import { resolve } from "path";
import { listPublishablePackages } from "./publishable-packages.ts";
import { ensureWorkspaceLease } from "./workspace-lease.mjs";

const coordinated = await ensureWorkspaceLease(resolve(import.meta.dir, ".."), "write");
if (coordinated !== undefined) process.exit(coordinated);

// The same manifest-derived list the build writes dist/ for.
const packages = listPublishablePackages(resolve(import.meta.dir, "..")).map((pkg) => pkg.dir);

for (const packageName of packages) {
  rmSync(resolve(import.meta.dir, "..", "packages", packageName, "dist"), {
    recursive: true,
    force: true,
  });
}
