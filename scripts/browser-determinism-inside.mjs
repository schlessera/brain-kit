#!/usr/bin/env node
/**
 * The container side of `scripts/browser-determinism.ts` (#4163): repeats the
 * selected project/file pairs as further passes in ONE Vitest process, one
 * project at a time, while one busy loop per CPU runs beside the browser.
 *
 * `scripts/visual.mjs --inside --repeat-plan=<file>` starts this file in the
 * pinned image in place of `vitest run`, so the container, its mounts and its
 * network are exactly the browser suite's. Plain Node ESM for the same reason
 * as that launcher: the image supplies Node, not Bun.
 *
 * Why further passes in one process, and not Vitest's `repeats` option:
 * `repeats` reruns a single test inside one page with every piece of state
 * kept, so a spec that is not idempotent in its own document fails for a
 * reason that is not a race. A further pass reruns the file: Vitest opens a
 * new tester iframe, evaluates the module again and reruns `beforeAll`. The
 * browser process, its context and storage (cookies, `localStorage`,
 * `sessionStorage`, IndexedDB), the Node-side state of browser commands and
 * the Vite server carry over, which is what two consecutive files of an
 * ordinary run already share. Measured with Vitest 4.1.11 in the #4116 spike;
 * policy and evidence: docs/decisions/ci-utility.md, "Changed browser specs
 * repeat under load before merge".
 *
 * Why the burners run here: on a hosted runner the container is its own
 * cgroup beside the job's processes, so the kernel halves the CPUs between
 * the two groups however many burners run outside. Inside, each burner
 * competes with the browser thread for thread.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RESULT_KIND = "brain-browser-determinism-passes";
/** A burner outlives its parent by one slice at most, and never this long. */
const BURNER_LIFETIME_MS = 2 * 60 * 60_000, BURNER_SLICE_MS = 200;
const PINNED = "BRAIN_BROWSER_DETERMINISM_PINNED";

/** A busy loop that exits by itself once its parent is gone or its lifetime ends. */
export function burnerSource(parent, lifetimeMs = BURNER_LIFETIME_MS) {
  return `const parent=${parent},end=Date.now()+${lifetimeMs};for(;;){const slice=Date.now()+${BURNER_SLICE_MS};while(Date.now()<slice);if(process.ppid!==parent||Date.now()>end)process.exit(0);}`;
}

/** One busy loop per requested CPU. `stop` kills exactly the PIDs started here that are still running. */
export function startBurners(count, lifetimeMs = BURNER_LIFETIME_MS) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024) throw new Error("Burners must be a non-negative integer");
  const children = [];
  const stop = () => {
    for (const child of children.splice(0)) {
      // An exited child's PID may already belong to another process.
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { process.kill(child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  };
  try {
    for (let index = 0; index < count; index++) {
      const child = spawn(process.execPath, ["-e", burnerSource(process.pid, lifetimeMs)], { stdio: "ignore" });
      if (!Number.isSafeInteger(child.pid)) throw new Error("A CPU burner did not start");
      child.on("error", () => {});
      children.push(child);
    }
  } catch (error) { stop(); throw error; }
  return { pids: children.map(child => child.pid), stop };
}

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9-]*$/, PATH = /^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/;
const repositoryPath = value => typeof value === "string" && PATH.test(value) && !value.split("/").some(part => part === ".." || part === ".");

/** The host's plan for this container, validated: nothing here is trusted because a script wrote it. */
export function readPassPlan(value) {
  if (!value || typeof value !== "object" || value.kind !== RESULT_KIND || value.version !== 1) throw new Error("Not a browser repetition plan");
  const { root, pairs, repetitions, burners, cpuList, result, deadlineFactor } = value;
  if (!repositoryPath(root) || !repositoryPath(result) || !result.startsWith("tmp/")) throw new Error("The plan's configuration root and result path must be repository paths");
  if (!Array.isArray(pairs) || !pairs.length || pairs.some(pair => !pair || !PROJECT.test(pair.project ?? "") || !repositoryPath(pair.file))) throw new Error("The plan must name at least one project/file pair");
  const keys = pairs.map(pair => `${pair.project}::${pair.file}`);
  if (new Set(keys).size !== keys.length) throw new Error("A project/file pair was selected twice");
  if (!Number.isSafeInteger(repetitions) || repetitions < 2 || repetitions > 100) throw new Error("Repetitions must be an integer of at least two: one run proves nothing about the next");
  if (burners !== null && (!Number.isSafeInteger(burners) || burners < 0 || burners > 1024)) throw new Error("Burners must be null (one per CPU) or a non-negative integer");
  if (cpuList !== null && (typeof cpuList !== "string" || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpuList))) throw new Error("The CPU list must look like 0-3 or 0,2,4");
  if (!Number.isSafeInteger(deadlineFactor) || deadlineFactor < 1 || deadlineFactor > 100) throw new Error("The deadline factor must be a whole number from 1 to 100");
  return { root, result, deadlineFactor, pairs: pairs.map(pair => ({ project: pair.project, file: pair.file })), repetitions, burners, cpuList };
}

/** Collects the modules Vitest reports as ended, so a repetition is judged on what ran in it and never on an earlier result. */
export function passCollector() {
  let ended = [];
  return { reporter: { onTestModuleEnd(module) { ended.push(module); } }, take() { const modules = ended; ended = []; return modules; } };
}

const projectName = name => String(name).replace(/ \((?:chromium|webkit|firefox)\)$/, "");
const brief = value => String(value ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 300);

function moduleFailure(module) {
  for (const test of module.children.allTests("failed")) return { test: test.fullName, detail: brief(test.result().errors?.[0]?.message) };
  return { test: null, detail: brief(module.errors()[0]?.message) || "the file failed outside a test" };
}

/**
 * Runs every selected pair `repetitions` times, pass after pass, and stops at
 * the first failing pass. Within a pass the projects run one after another:
 * each browser then competes with the burners alone, which is the load the
 * #4116 spike measured. Every selected project at once is a heavier and
 * unmeasured load; six of them beside four burners made a green visual spec
 * miss its 5 s screenshot deadline on this gate's first mixed run. A pass is
 * green only when Vitest reported each selected pair exactly once in that pass
 * and every one of them passed.
 */
export async function runPasses({ vitest, collector, pairs, repetitions, repo = REPO, log = console.log, now = () => performance.now() }) {
  const key = pair => `${pair.project}::${pair.file}`;
  const identify = (project, moduleId) => `${projectName(project.name)}::${relative(repo, moduleId).replaceAll("\\", "/")}`;
  const listed = new Map((await vitest.globTestSpecifications()).map(specification => [identify(specification.project, specification.moduleId), specification]));
  const unlisted = pairs.filter(pair => !listed.has(key(pair)));
  if (unlisted.length) {
    return { passes: [], failure: { ...unlisted[0], repetition: null, test: null, reason: "Vitest's own listing has no such project/file pair, so nothing would run" }, alsoFailed: unlisted.slice(1) };
  }
  const projects = [...new Set(pairs.map(pair => pair.project))].map(project => pairs.filter(pair => pair.project === project));
  const passes = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const started = now(), failed = [];
    for (const group of projects) {
      collector.take();
      const { unhandledErrors } = await vitest.runTestSpecifications(group.map(pair => listed.get(key(pair))), true);
      const ended = collector.take();
      for (const pair of group) {
        const modules = ended.filter(module => identify(module.project, module.moduleId) === key(pair));
        if (modules.length !== 1) failed.push({ ...pair, test: null, reason: `Vitest reported ${modules.length} results for this pair in the repetition; a repetition counts only when each pair is reported once` });
        else if (!modules[0].ok()) { const { test, detail } = moduleFailure(modules[0]); failed.push({ ...pair, test, reason: test ? `a test case failed: ${detail}` : detail }); }
      }
      if (!failed.length && unhandledErrors.length) failed.push({ project: null, file: null, test: null, reason: `${unhandledErrors.length} unhandled error(s) outside a test: ${brief(unhandledErrors[0]?.message ?? unhandledErrors[0])}` });
      // The first failing project ends the repetition: what it leaves behind must not decide the next project's result.
      if (failed.length) break;
    }
    const elapsedSeconds = (now() - started) / 1000;
    passes.push({ repetition, elapsedSeconds, ok: !failed.length });
    log(`Repetition ${repetition} of ${repetitions}: ${failed.length ? "FAILED" : "passed"} in ${elapsedSeconds.toFixed(1)} s (${pairs.length} project/file pair(s) in ${projects.length} project(s), one project at a time).`);
    if (failed.length) {
      const [first, ...rest] = failed;
      return { passes, failure: { ...first, repetition }, alsoFailed: rest.map(({ project, file }) => ({ project, file })) };
    }
  }
  return { passes, failure: null, alsoFailed: [] };
}

/**
 * Apply once after createVitest resolves projects and before standalone opens
 * browser servers. Use each resolved project's own defaults, including overrides.
 * Vitest 4.1.11 serializes these values afresh for every pass; test.env is also
 * exposed as import.meta.env to browser specs. Explicit per-test/hook options,
 * expect.poll and vi.waitFor own their deadlines and are intentionally untouched.
 */
export function scaleVitestDeadlines(vitest, factor, log = () => {}) {
  for (const project of vitest.projects) {
    project.config.testTimeout *= factor;
    project.config.hookTimeout *= factor;
    project.config.env = { ...project.config.env, BRAIN_TEST_DEADLINE_FACTOR: String(factor) };
    log(`Deadline factor ${factor}: ${project.name}; testTimeout=${project.config.testTimeout} ms, hookTimeout=${project.config.hookTimeout} ms; BRAIN_TEST_DEADLINE_FACTOR=${factor}.`);
  }
}

async function main(argv) {
  if (argv.length !== 1) throw new Error("usage: node scripts/browser-determinism-inside.mjs <plan.json under the repository>");
  const plan = readPassPlan(JSON.parse(readFileSync(resolve(REPO, argv[0]), "utf8")));
  // A shared host confines the browser, Vitest and the burners to the same CPUs, so the load matches a runner of that size.
  if (plan.cpuList && process.env[PINNED] !== plan.cpuList) {
    const pinned = spawnSync("taskset", ["-c", plan.cpuList, process.execPath, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, [PINNED]: plan.cpuList } });
    if (pinned.error) throw pinned.error;
    process.exit(pinned.status ?? 1);
  }
  // The Storybook plugin registers its stories only under the flag the Vitest CLI sets.
  process.env.VITEST ??= "true";
  process.chdir(resolve(REPO, plan.root));
  const log = line => console.log(`[browser-determinism] ${line}`);
  const cpus = availableParallelism(), started = performance.now();
  let burners, vitest, exiting = false;
  const stopBurners = () => burners?.stop();
  process.on("exit", stopBurners);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(signal, () => { stopBurners(); if (!exiting) { exiting = true; process.exit(code); } });
  let outcome;
  try {
    // Started first: Vitest, Vite and the browser launch under the same load as every pass.
    burners = startBurners(plan.burners ?? cpus);
    log(`${burners.pids.length} CPU burner(s) on ${cpus} CPU(s)${burners.pids.length ? ` (PIDs ${burners.pids.join(", ")})` : ""}; ${plan.pairs.length} project/file pair(s), ${plan.repetitions} repetition(s) each.`);
    const { createVitest } = await import(pathToFileURL(resolve(REPO, "node_modules/vitest/dist/node.js")).href);
    const collector = passCollector();
    vitest = await createVitest("test", { watch: false, project: [...new Set(plan.pairs.map(pair => pair.project))],
      browser: { fileParallelism: false }, reporters: ["default", collector.reporter] });
    scaleVitestDeadlines(vitest, plan.deadlineFactor, log);
    await vitest.standalone();
    outcome = await runPasses({ vitest, collector, pairs: plan.pairs, repetitions: plan.repetitions, log });
  } catch (error) {
    console.error(error);
    outcome = { passes: [], failure: { project: null, file: null, repetition: null, test: null, reason: `the runner stopped before a repetition completed: ${brief(error?.message ?? error)}` }, alsoFailed: [] };
  } finally {
    const load = { burners: burners?.pids.length ?? 0, cpus };
    stopBurners();
    const result = { kind: RESULT_KIND, version: 1, pairs: plan.pairs, repetitions: plan.repetitions, load, elapsedSeconds: (performance.now() - started) / 1000, ...outcome };
    mkdirSync(dirname(resolve(REPO, plan.result)), { recursive: true });
    writeFileSync(resolve(REPO, plan.result), JSON.stringify(result, null, 2) + "\n");
  }
  const { failure } = outcome;
  if (failure) log(`FAILED: ${failure.file ?? "unknown spec"} in project ${failure.project ?? "unknown"}, repetition ${failure.repetition ?? "unknown"} of ${plan.repetitions}${failure.test ? `: ${JSON.stringify(failure.test)}` : ""} (${failure.reason}).`);
  else log(`Passed: ${plan.pairs.length} project/file pair(s), ${plan.repetitions} repetition(s) each.`);
  // A browser that will not close must not turn a judged result into a hung job.
  await Promise.race([vitest?.close().catch(() => {}), new Promise(done => setTimeout(done, 15_000).unref())]);
  process.exit(failure ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
