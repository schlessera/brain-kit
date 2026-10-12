/** Lowest executable boundary: records argv, then invokes the real offline CLI.
 * Fault cases return a business outcome without replacing server methods. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MIN_BRAIN_CLI_VERSION } from "../../src/brain/client.js";
const root = process.env.BRAIN_WORKER_DATA_ROOT ?? process.cwd(), args = process.argv.slice(2);
appendFileSync(join(root, "argv.jsonl"), JSON.stringify(args) + "\n");
// The source CLI has the unreleased pin capability; manifests move at release.
if (args.includes("--version")) { console.log(MIN_BRAIN_CLI_VERSION); process.exit(0); }
const mode = existsSync(join(root, "fault.txt")) ? readFileSync(join(root, "fault.txt"), "utf8") : "";
if (args.includes("resolve") && !args.includes("--dry-run") && mode) {
  const id = args.at(-1)!;
  console.log(JSON.stringify({ status: mode, id, code: mode === "check_failed" ? "fixture-post-check" : undefined, reason: mode === "refused" ? "fixture-refusal" : undefined }));
  process.exit(1);
}
const core = resolve(import.meta.dir, "../../../core/src/cli/brain.ts");
const child = Bun.spawn([process.execPath, core, ...args], { cwd: root, env: { ...process.env, BRAIN_ROOT: process.env.BRAIN_ROOT ?? root }, stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
