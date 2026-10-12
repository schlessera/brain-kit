/** Trusted Git adapter. Git state is an output; configuration and its programs are startup inputs. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { maintenanceGitEnvironment } from "../config/env.js";

interface FrozenGit { binary: string; brain: string; data: string; config: [string, string][]; hooks: string; attributes?: string }
async function main(): Promise<void> {
  const inherited = maintenanceGitEnvironment();
  const source = inherited.path;
  if (!source) throw new Error("Git needs the host's frozen configuration");
  const frozen = JSON.parse(readFileSync(source, "utf8")) as FrozenGit;
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const config: string[] = [];
  for (const [key, original] of frozen.config) {
    let value = original;
    // Includes have already been expanded against the immutable startup view.
    if (/^include(?:if)?\./i.test(key)) continue;
    if (/^core\.hookspath$/i.test(key)) continue;
    if (/^filter\..*\.(clean|smudge|process)$/i.test(key) || /^merge\..*\.driver$/i.test(key)
      || /^diff\..*\.(command|textconv)$/i.test(key) || /^core\.(sshcommand|editor|askpass)$/i.test(key)
      || (/^core\.fsmonitor$/i.test(key) && !/^(true|false|0|1)$/i.test(value))) {
      value = `cd ${quote(frozen.brain)} && ${value}`;
    } else if (/^alias\./i.test(key) && value.startsWith("!")) {
      value = `!cd ${quote(frozen.brain)} && ${value.slice(1)}`;
    } else if (/^core\.(attributesfile|excludesfile)$/i.test(key) && !value.startsWith("~")) {
      value = resolve(frozen.brain, value);
    }
    config.push("-c", `${key}=${value}`);
  }
  config.push("-c", `core.hooksPath=${frozen.hooks}`);
  const env = { ...inherited.env, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    ...(frozen.attributes ? { GIT_ATTR_SOURCE: frozen.attributes } : {}) };
  // -C supplied by a core caller names the output root already; the default
  // cwd is the brain's read-only configuration view, so Git gets its state root explicitly.
  const args = process.argv.slice(2);
  const proc = Bun.spawn([frozen.binary, "-C", frozen.data, ...config, ...args], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}
await main();
