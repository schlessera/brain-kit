import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("real browser discovery needs no workspace build outputs", async () => {
  const root = resolve(import.meta.dir, "..");
  // Hide outputs only in this child's mount namespace. Never remove or rename
  // another test's build, and exercise ordinary Node package export resolution.
  const child = Bun.spawn([
    "unshare", "--user", "--map-current-user", "--keep-caps", "--mount", "--propagation=private", "--",
    "bash", "-euc", `
      for output in packages/*/dist; do
        if [ -d "$output" ]; then mount -t tmpfs -o size=64k tmpfs "$output"; fi
      done
      exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"
    `, "cold-browser-discovery", process.execPath, "-e", `
      import { existsSync } from "node:fs";
      import { browserInventory } from "./scripts/proof-inputs.ts";
      if (existsSync("packages/ui-sdk/dist/schemas.js")) throw new Error("SDK build output is visible");
      console.log(JSON.stringify(await browserInventory(process.cwd())));
    `,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const inventory = JSON.parse(stdout) as Array<{ project: string; file: string }>;
  expect(inventory).toContainEqual({
    project: "ui-react-layout", file: "packages/ui-react/tests/browser/hygiene-lifecycle.layout.tsx",
  });
  expect(inventory.some(spec => spec.project === "ui-react-endurance")).toBe(true);
}, 60000);
