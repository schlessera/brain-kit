/** Frozen Git configuration: read by a worker, never by a host Git process. */
import { existsSync, lstatSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { maintenanceGitEntry, nativeWorkerStartupInput, workerIdentityHelper, prepareMaintenanceGitInput, runMaintenanceWorker, type MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import type { prepareMaintenanceOutput } from "./maintenance-output.js";
import { collectOwnedGitAttributes, parseMaintenanceGitSources, reportMaintenanceGitFailure, reportOwnedGitFailure, type MaintenanceGitSources } from "./maintenance-git-source.js";

const TARGET = "/tmp/brain-maintenance-git";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const hooks = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive",
  "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change"];

/** Worker-identity collection, then the owner read for withheld server-owned directories. */
export async function privateGitSources(command: MaintenanceCommand, outputs: Awaited<ReturnType<typeof prepareMaintenanceOutput>>, binary: string | undefined, signal?: AbortSignal, log?: import("@opentelemetry/api-logs").Logger): Promise<MaintenanceGitSources> {
  const view = outputs.view, native = nativeWorkerStartupInput(view), storage = outputs.output.storage;
  const checkpoint = JSON.stringify(native.checkpoint), source = outputs.output.source, target = outputs.output.target;
  const context = () => JSON.stringify({ brain: command.brainPath, command: command.command, env: command.env,
    credentials: command.credentials, network: command.network, home: command.home, readPaths: command.readPaths, maskPaths: command.maskPaths, gitConfig: command.gitConfig, tempLimits: command.tempLimits, tempDomain: command.tempDomain, writeFiles: command.writeFiles, writeDirectories: command.writeDirectories, transport: command.transport,
    viewRoot: view.root, viewBrain: view.brain, source: outputs.output.source, target: outputs.output.target,
    root: storage.root, mount: storage.mount, namespacePid: storage.namespacePid, namespaceStart: storage.namespaceStart, ticket: storage.identityTicketFd, allowanceBytes: storage.allowanceBytes });
  const original = context(), rootInfo = statSync(view.root), stageInfo = statSync(storage.root), expectedRoot = `${rootInfo.dev}:${rootInfo.ino}`;
  const validate = () => {
    signal?.throwIfAborted();
    const current = nativeWorkerStartupInput(view), root = statSync(view.root), stage = statSync(storage.root);
    if (outputs.view !== view || outputs.output.storage !== storage || outputs.output.source !== source || outputs.output.target !== target
      || view.brain !== command.brainPath || view.root !== native.checkpoint.path || current.manager !== native.manager
      || JSON.stringify(current.checkpoint) !== checkpoint || context() !== original || root.dev !== rootInfo.dev || root.ino !== rootInfo.ino
      || stage.dev !== stageInfo.dev || stage.ino !== stageInfo.ino) throw Error("Changed or foreign concrete Git source preparation");
  };
  validate();
  const entry = Bun.resolveSync("./maintenance-git-source", import.meta.dir), maximum = storage.allowanceBytes;
  const result = await runMaintenanceWorker({ ...command, startupView: view, output: undefined, git: undefined,
    command: [process.execPath, "--config=/dev/null", "--no-env-file", entry, binary ?? "", String(maximum), expectedRoot],
    readPaths: [...(command.readPaths ?? []), entry, ...(binary ? [binary] : [])], network: false, timeoutMs: 30000, ...(signal ? { signal } : {}) });
  validate();
  if (result.exitCode !== 0 || result.killed) {
    reportMaintenanceGitFailure(log, result);
    throw Error("Cannot freeze retained concrete Git sources");
  }
  const sources = parseMaintenanceGitSources(result.stdout.trim(), maximum, expectedRoot);
  if (!sources.withheld.length) return sources;
  // Server-owned private output (a strict worker's published 0700/0600 nodes)
  // is read by its owner, never by widening modes or the worker's authority.
  let owned: MaintenanceGitSources;
  try { owned = collectOwnedGitAttributes(view.root, sources, maximum, expectedRoot); }
  catch (error) { reportOwnedGitFailure(log, error); throw Error("Cannot freeze retained concrete Git sources"); }
  validate();
  return owned;
}

export async function prepareMaintenanceGit(command: MaintenanceCommand, outputs: Awaited<ReturnType<typeof prepareMaintenanceOutput>>, signal?: AbortSignal, log?: import("@opentelemetry/api-logs").Logger): Promise<MaintenanceCommand["git"]> {
  signal?.throwIfAborted();
  const binary = Bun.which("git") ?? undefined;
  const privateInputs = !command.credentials && workerIdentityHelper() ? await privateGitSources(command, outputs, binary, signal, log) : undefined;
  const metadata = join(outputs.view.root, ".git");
  if (privateInputs ? !privateInputs.repository : !lstatSync(metadata, { throwIfNoEntry: false })?.isDirectory() || !existsSync(join(metadata, "config"))) return undefined;
  if (!binary) throw new Error("maintenance needs Git");
  let config: [string, string][];
  if (privateInputs) config = privateInputs.config;
  else {
    const result = await runMaintenanceWorker({ ...command, startupView: outputs.view,
      command: [binary, "-c", `safe.directory=${command.brainPath}`, "config", "--null", "--list", "--includes"], network: false, timeoutMs: 5000, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0 || result.killed) throw new Error(`cannot freeze Git configuration: ${result.stderr.slice(-400)}`);
    config = result.stdout.split("\0").filter(Boolean).map(record => { const separator = record.indexOf("\n");
      return separator < 0 ? [record, "true"] : [record.slice(0, separator), record.slice(separator + 1)]; });
  }
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
  if (privateInputs) for (const name of privateInputs.hookNames) names.add(name);
  else if (copiedHooks && lstatSync(copiedHooks, { throwIfNoEntry: false })?.isDirectory()) for (const name of readdirSync(copiedHooks)) names.add(name);
  for (const name of names) writeFileSync(join(root, "hooks", name), `#!/bin/sh\ncd ${quote(command.brainPath)} || exit 125\nhook=${quote(join(originalHooks, name))}\n[ -x "$hook" ] || exit 0\nexec "$hook" "$@"\n`, { mode: 0o755 });
  const entry = maintenanceGitEntry();
  writeFileSync(join(root, "bin/git"), `#!/bin/sh\nexec ${quote(process.execPath)} --config=/dev/null --no-env-file ${quote(entry)} "$@"\n`, { mode: 0o755 });
  let spec = { source: root, target: TARGET, entry, binary };
  const frozen = { binary, brain: command.brainPath, data: outputs.output.target, config, hooks: `${TARGET}/hooks`, attributes: "" };
  writeFileSync(join(root, "config.json"), JSON.stringify(frozen), { mode: 0o600 });
  // Git reads work-tree attributes as configuration too. An attributes-only
  // tree pins both existing bytes and absence without blocking checkout writes.
  const refreshInput = async () => {
    if (!command.credentials) spec = await prepareMaintenanceGitInput({ ...command, startupView: outputs.view, output: outputs.output, git: spec }, signal);
  };
  // Work-tree attribute bytes come from the private collection or the
  // immutable copy; `.git` and `node_modules` are never entered.
  const attributes = privateInputs ? privateInputs.attributes : [];
  if (!privateInputs) (function collect(path: string, prefix: string) {
    for (const name of readdirSync(path)) {
      if (name === ".git" || name === "node_modules") continue;
      const child = join(path, name), info = lstatSync(child);
      if (name === ".gitattributes" && info.isFile()) attributes.push({ path: prefix + name, data: readFileSync(child, "utf8") });
      else if (info.isDirectory()) collect(child, `${prefix}${name}/`);
    }
  })(outputs.view.root, "");
  // One launch writes every object through the frozen adapter. Its deadline
  // is the sum of the per-object launches it replaces (#2622).
  const directories = new Set(attributes.flatMap(({ path }) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  const freezer = Bun.resolveSync("./maintenance-git-attributes", import.meta.dir);
  await refreshInput();
  const answer = await runMaintenanceWorker({ ...command, startupView: outputs.view, output: outputs.output, git: spec,
    command: [process.execPath, "--config=/dev/null", "--no-env-file", freezer, entry], stdin: JSON.stringify(attributes),
    readPaths: [...(command.readPaths ?? []), freezer], network: false,
    timeoutMs: 5000 * (1 + attributes.length + (attributes.length ? 1 + directories.size : 0)), ...(signal ? { signal } : {}) });
  if (answer.exitCode !== 0 || answer.killed || !/^[a-f0-9]{40,64}\n?$/.test(answer.stdout)) throw new Error(`cannot freeze Git attributes: ${answer.stderr.slice(-400)}`);
  frozen.attributes = answer.stdout.trim();
  writeFileSync(join(root, "config.json"), JSON.stringify(frozen), { mode: 0o600 });
  await refreshInput();
  return spec;
}
