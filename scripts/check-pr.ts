/** Full required local proof before PR creation/readiness; no CI-only shortcuts. */
import { resolve } from "node:path";
import { changedFiles, planChecks, workspaces, type CheckPlan } from "./ci-plan";
import { runCommands, type Command } from "./ci-runner";
import { checkPackages } from "./check-packages";

export function localChecks(plan: CheckPlan): Command[] {
  const bun = process.execPath;
  const checks: Command[] = [
    { name: "all lint and leakage gates", argv: [bun, "run", "lint"] },
    { name: "environment documentation", argv: [bun, "scripts/env-docs.ts", "--check"] },
    { name: "pending changeset package names", argv: [bun, "scripts/check-changeset-packages.ts"] },
  ];
  if (plan.typecheck) checks.push({ name: "strict typecheck", argv: [bun, "run", "typecheck"],
    env: { NODE_OPTIONS: "--max-old-space-size=4096" } });
  if (plan.local.fullTests) checks.push({ name: "complete unit and integration suite", argv: [bun, "run", "test"],
    env: { BRAIN_REQUIRE_CHROME: "1" } });
  else if (plan.tests.length) checks.push({ name: "affected fast invariants", argv: [bun, "run", "test", ...plan.tests.map(path => `./${path}`)] });
  if (plan.local.browser || plan.local.layout) checks.push({ name: "workspace build for real browser checks", argv: [bun, "run", "build"] });
  if (plan.local.browser) checks.push({ name: "complete pinned visual/accessibility/pointer suite", argv: [bun, "run", "test:browser"] });
  if (plan.local.layout) checks.push({ name: "complete pinned layout/offline/endurance suite", argv: [bun, "run", "test:layout"] });
  if (plan.local.captures) checks.push({ name: "editorial provenance and reproducibility", argv: [bun, "run", "capture:verify"] });
  if (plan.local.runtime) {
    // Retain the production probes which used to run automatically, in the
    // same loopback-only namespace. The real renderer is also required by the
    // complete test suite above; a fake allowlist check cannot replace it.
    for (const script of ["measure-claude-runtime", "measure-claude-enforcement"]) checks.push({ name: script,
      argv: ["unshare", "--user", "--map-root-user", "--net", "sh", "-c",
        `ip link set lo up && bun scripts/${script}.ts --out tmp/${script}.json`] });
    checks.push({ name: "native delegation, capabilities and measurement isolation",
      argv: ["unshare", "--user", "--map-current-user", "--keep-caps", "--net", "sh", "-c",
        "ip link set lo up && bun scripts/measure-claude-delegation.ts --out tmp/delegation-probe.json && bun scripts/measure-claude-capability.ts > tmp/capability-probe.json && bun scripts/measure-claude-haiku.ts > tmp/haiku-probe.json && bun run test ./tests/measurement-isolation.test.ts"] });
    checks.push({ name: "shared-process Chrome then child cleanup", argv: [bun, "run", "test", "--shard=1/1",
      "packages/ui-react/tests/chat-focus-runtime.test.ts", "packages/ui-react/tests/external-speech-runtime.test.ts"],
      env: { BRAIN_REQUIRE_CHROME: "1" } });
  }
  return checks;
}

export function requireRuntimeTools(plan: CheckPlan): string | undefined {
  if (!Bun.semver.satisfies(Bun.version, ">=1.4.0")) throw new Error("Local checks require Bun >=1.4.0 (CI pins 1.4.2)");
  if (plan.local.browser || plan.local.layout || plan.local.captures) {
    if (!Bun.which("docker")) throw new Error("Pinned local browser checks require Docker");
  }
  if (!plan.local.fullTests) return undefined;
  const chrome = process.env.PUPPETEER_EXECUTABLE_PATH ??
    ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"].map(name => Bun.which(name)).find(Boolean);
  if (!chrome || !Bun.file(chrome).size) throw new Error("Local runtime proof requires real Chrome; set PUPPETEER_EXECUTABLE_PATH");
  if (process.platform !== "linux") throw new Error("Full local runtime proof requires the Linux namespace harness; use a Linux checkout/runner");
  for (const name of ["bwrap", "unshare", "ip"]) if (!Bun.which(name)) throw new Error(`Local runtime proof requires ${name}`);
  const namespace = Bun.spawnSync(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"]);
  if (namespace.exitCode !== 0) throw new Error("Local runtime proof requires permitted user/network namespaces; do not accept skipped tests");
  return chrome;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2); let base = "origin/main"; let all = false; let print = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--base" && args[i + 1]) base = args[++i]!;
      else if (args[i] === "--all") all = true;
      else if (args[i] === "--plan") print = true;
      else throw new Error("usage: bun run check:pr [--base <ref>] [--all] [--plan]");
    }
    const root = resolve(import.meta.dir, "..");
    const changed = all ? ["package.json"] : changedFiles(root, base, "HEAD", true, true);
    const plan = planChecks(changed, workspaces(root));
    const commands = localChecks(plan);
    console.log(JSON.stringify({ ...plan, commands: commands.map(command => command.name), packedConsumerChecks: plan.pack }, null, 2));
    if (print) process.exit(0);
    const chrome = requireRuntimeTools(plan);
    // Setup/metadata are ordered. Full Bun tests and strict types are the only
    // independent memory-bounded pair; browser jobs stay sequential to retain
    // the measured scheduling/isolation behavior and diagnostic artifacts.
    const env: Record<string, string> = chrome ? { PUPPETEER_EXECUTABLE_PATH: chrome } : {};
    const withEnv = (command: Command) => ({ ...command, env: { ...env, ...command.env } });
    const parallel = commands.filter(command => command.name === "strict typecheck" || command.name === "complete unit and integration suite");
    for (const command of commands.slice(0, 3)) await runCommands([withEnv(command)], root);
    await runCommands([{ name: "contribution changeset", argv: [process.execPath, "scripts/check-changeset.ts", base] }], root);
    if (plan.local.captures) await runCommands([{ name: "pinned capture fonts and original notices",
      argv: [process.execPath, "run", "capture:fonts"] }], root);
    if (chrome) await runCommands([{ name: "first real Chrome launch and render",
      argv: [process.execPath, "packages/ui-render-puppeteer/tests/cold-start.ts", chrome], env }], root);
    await runCommands(parallel.map(withEnv), root);
    for (const command of commands.slice(3).filter(command => !parallel.includes(command))) await runCommands([withEnv(command)], root);
    if (plan.pack) await checkPackages(root);
    console.log("All required local pre-PR checks passed. Record the base/head and commands in the PR proof.");
  } catch (error) { console.error(error); process.exit(1); }
}
