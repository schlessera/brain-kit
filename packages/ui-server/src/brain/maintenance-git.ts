/** Frozen Git configuration: read by a worker, never by a host Git process. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { maintenanceGitEntry, runMaintenanceWorker, type MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import type { prepareMaintenanceOutput } from "./maintenance-output.js";

const TARGET = "/tmp/brain-maintenance-git";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const hooks = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive",
  "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change"];

export async function prepareMaintenanceGit(command: MaintenanceCommand, outputs: ReturnType<typeof prepareMaintenanceOutput>): Promise<MaintenanceCommand["git"]> {
  const metadata = join(outputs.view.root, ".git");
  if (!lstatSync(metadata, { throwIfNoEntry: false })?.isDirectory() || !existsSync(join(metadata, "config"))) return undefined;
  const binary = Bun.which("git");
  if (!binary) throw new Error("maintenance needs Git");
  const result = await runMaintenanceWorker({ ...command, startupView: outputs.view,
    command: [binary, "-c", `safe.directory=${command.brainPath}`, "config", "--null", "--list", "--includes"], network: false, timeoutMs: 5000 });
  if (result.exitCode !== 0 || result.killed) throw new Error(`cannot freeze Git configuration: ${result.stderr.slice(-400)}`);
  const config: [string, string][] = result.stdout.split("\0").filter(Boolean).map(record => {
    const separator = record.indexOf("\n");
    return separator < 0 ? [record, "true"] : [record.slice(0, separator), record.slice(separator + 1)];
  });
  const root = join(dirname(outputs.output.source), "git-adapter");
  mkdirSync(join(root, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "hooks"), { mode: 0o700 });
  writeFileSync(join(root, "empty-config"), "", { mode: 0o600 });
  const declaredHooks = config.filter(([key]) => key.toLowerCase() === "core.hookspath").at(-1)?.[1];
  const originalHooks = declaredHooks ? resolve(command.brainPath, declaredHooks) : join(command.brainPath, ".git/hooks");
  // Names inside the brain come only from its immutable private copy. Never
  // enumerate a host path supplied by repository configuration.
  const inBrain = originalHooks === command.brainPath || originalHooks.startsWith(`${command.brainPath}/`);
  const copiedHooks = inBrain ? outputs.view.root + originalHooks.slice(command.brainPath.length) : undefined;
  const names = new Set(hooks);
  if (copiedHooks && lstatSync(copiedHooks, { throwIfNoEntry: false })?.isDirectory()) for (const name of readdirSync(copiedHooks)) names.add(name);
  for (const name of names) writeFileSync(join(root, "hooks", name), `#!/bin/sh\ncd ${quote(command.brainPath)} || exit 125\nhook=${quote(join(originalHooks, name))}\n[ -x "$hook" ] || exit 0\nexec "$hook" "$@"\n`, { mode: 0o755 });
  const entry = maintenanceGitEntry();
  writeFileSync(join(root, "bin/git"), `#!/bin/sh\nexec ${quote(process.execPath)} --config=/dev/null --no-env-file ${quote(entry)} "$@"\n`, { mode: 0o755 });
  const spec = { source: root, target: TARGET, entry, binary };
  const frozen = { binary, brain: command.brainPath, data: outputs.output.target, config, hooks: `${TARGET}/hooks`, attributes: "" };
  writeFileSync(join(root, "config.json"), JSON.stringify(frozen), { mode: 0o600 });
  // Git reads work-tree attributes as configuration too. An attributes-only
  // tree pins both existing bytes and absence without blocking checkout writes.
  const gitRun = async (args: string[], stdin?: string) => {
    const answer = await runMaintenanceWorker({ ...command, startupView: outputs.view, output: outputs.output, git: spec,
      command: [process.execPath, "--config=/dev/null", "--no-env-file", entry, ...args], ...(stdin !== undefined ? { stdin } : {}), network: false, timeoutMs: 5000 });
    if (answer.exitCode !== 0 || answer.killed || !/^[a-f0-9]{40,64}\n?$/.test(answer.stdout)) throw new Error(`cannot freeze Git attributes: ${answer.stderr.slice(-400)}`);
    return answer.stdout.trim();
  };
  async function tree(path: string): Promise<string> {
    const rows: string[] = [];
    for (const name of readdirSync(path)) {
      if (name === ".git" || name === "node_modules") continue;
      const child = join(path, name);
      const info = lstatSync(child);
      if (name === ".gitattributes" && info.isFile()) {
        const oid = await gitRun(["hash-object", "-w", "--stdin", "--no-filters"], readFileSync(child, "utf8"));
        rows.push(`100644 blob ${oid}\t${name}\0`);
      } else if (info.isDirectory()) {
        const oid = await tree(child);
        if (oid !== EMPTY_TREE) rows.push(`040000 tree ${oid}\t${name}\0`);
      }
    }
    return rows.length ? gitRun(["mktree", "-z"], rows.join("")) : EMPTY_TREE;
  }
  const EMPTY_TREE = await gitRun(["mktree", "-z"], "");
  frozen.attributes = await tree(outputs.view.root);
  writeFileSync(join(root, "config.json"), JSON.stringify(frozen), { mode: 0o600 });
  return spec;
}
