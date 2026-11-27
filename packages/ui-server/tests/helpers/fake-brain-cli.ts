/**
 * A fake `brain` CLI where the host looks for one: `node_modules/.bin/brain`
 * under the brain root (#4839).
 *
 * The script runs under the Bun this test runs under (`#!${process.execPath}`),
 * never one found through the fixture's `PATH`, and by default answers the
 * host's boot probe, `brain --version`, with `MIN_BRAIN_CLI_VERSION`, so a
 * change to the minimum reaches every fake at once.
 *
 *   installFakeBrain(root);                                    // answers --version only
 *   installFakeBrain(root, { body: 'console.log("{}");' });    // and everything else
 *   installFakeBrain(root, { version: "0.40.0" });             // an older CLI
 *   installFakeBrain(root, { version: null, body });           // the body answers --version too
 *   installFakeBrain(root, { real: true });                    // the real core CLI
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { MIN_BRAIN_CLI_VERSION } from "../../src/brain/client.js";

/** The real CLI the `real` mode imports. */
export const CORE_CLI_ENTRY = resolve(import.meta.dir, "../../../core/src/cli/brain.ts");

export interface FakeBrainOptions {
  /** What `brain --version` prints. `null` leaves `--version` to `body`. Default: `MIN_BRAIN_CLI_VERSION`. */
  version?: string | null;
  /**
   * Append each call's arguments as one JSON line to this file. Inside a
   * masked worker, which cannot write the brain, the line goes to the file of
   * the same name under `BRAIN_WORKER_DATA_ROOT`.
   */
  argvLog?: string;
  /** Script source run after the version answer; `args` holds the arguments after the executable. */
  body?: string;
  /** Run the real core CLI with the same arguments instead of a body. */
  real?: boolean;
}

/** Write the fake at `root/node_modules/.bin/brain` (mode 0755) and return its path. */
export function installFakeBrain(root: string, options: FakeBrainOptions = {}): string {
  if (options.real && (options.body !== undefined || options.version !== undefined)) {
    throw new Error("installFakeBrain: the real CLI answers for itself; give it neither a body nor a version");
  }
  const dir = join(root, "node_modules", ".bin");
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "brain");
  const version = options.real ? null : options.version === undefined ? MIN_BRAIN_CLI_VERSION : options.version;
  const lines = [`#!${process.execPath}`, "const args = process.argv.slice(2);"];
  if (options.argvLog !== undefined) {
    const name = JSON.stringify(`/${basename(options.argvLog)}`);
    lines.push(`(await import("node:fs")).appendFileSync(process.env.BRAIN_WORKER_DATA_ROOT ? process.env.BRAIN_WORKER_DATA_ROOT + ${name} : ${JSON.stringify(options.argvLog)}, JSON.stringify(args) + "\\n");`);
  }
  if (version !== null) lines.push(`if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }`);
  if (options.real) lines.push(`await import(${JSON.stringify(CORE_CLI_ENTRY)});`);
  if (options.body !== undefined) lines.push(options.body);
  writeFileSync(bin, lines.join("\n") + "\n");
  chmodSync(bin, 0o755);
  return bin;
}
