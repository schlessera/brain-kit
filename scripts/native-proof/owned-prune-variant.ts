/** Fixed test-only observation of the existing owned scratch-prune operation. */
import { createHash } from "node:crypto";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function ownedPruneVariant(cronSource: string, boundarySource: string) {
  const substitutions: Array<{ source: "cron" | "boundary"; before: string; after: string }> = [];
  const replace = (source: "cron" | "boundary", text: string, before: string, after: string) => {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw Error("Owned prune fixture anchor changed");
    substitutions.push({ source, before, after }); return text.replace(before, after);
  };
  const observer = (key: string, condition = "") => `const fixtureStarted = performance.now();
  const fixtureStage = (stage: string) => { try { ${condition}console.log(JSON.stringify({ ${key}: { stage, elapsedMs: performance.now() - fixtureStarted } })); } catch { /* Observation cannot replace the operation. */ } };`;
  let cron = replace("cron", cronSource, "  const { brain, log } = options;", "  const { brain, log } = options;\n  " + observer("fixtureOwnedPrune"));
  cron = replace("cron", cron, "    if (tickFlight) return tickFlight;", '    if (tickFlight) { fixtureStage("tick:join-existing"); return tickFlight; }');
  cron = replace("cron", cron, "    const controller = new AbortController();", '    fixtureStage("tick:start-new");\n    const controller = new AbortController();');
  cron = replace("cron", cron, "        try { await options.pins.refresh(controller.signal); }", '        try { fixtureStage("pins:start"); await options.pins.refresh(controller.signal); fixtureStage("pins:done"); }');
  cron = replace("cron", cron, '      return brain.scratchPrune({ ...(request ?? {}), signal: controller.signal, ...(options.pins ? { pinsFile: options.pins.file } : {}) });', '      fixtureStage("cli:start");\n      const result = await brain.scratchPrune({ ...(request ?? {}), signal: controller.signal, ...(options.pins ? { pinsFile: options.pins.file } : {}) });\n      fixtureStage("cli:done"); return result;');
  cron = replace("cron", cron, "    tickFlight = run().then(() => undefined).catch((error: unknown) => {", '    tickFlight = run().then(() => undefined).catch((error: unknown) => {\n      fixtureStage("pass:error");');
  cron = replace("cron", cron, "      .finally(() => {", '      .finally(() => {\n        fixtureStage("pass:settled");');
  let boundary = replace("boundary", boundarySource, "    async run(execution) {", '    async run(execution) {\n      ' + observer("fixtureOwnedPruneBoundary", 'if (execution.purpose !== "brain scratch prune") return; ') + '\n      fixtureStage("entry");');
  const runStart = boundary.indexOf("    async run(execution) {"), runEnd = boundary.indexOf("    async launch(execution) {", runStart);
  if (runStart < 0 || runEnd < 0) throw Error("Owned prune fixture run boundary changed");
  let run = boundary.slice(runStart, runEnd);
  run = replace("boundary", run, "      return gated(admission, async hold => {", '      return gated(admission, async hold => {\n        fixtureStage("gate:admitted");');
  run = replace("boundary", run, "          const run = async () => {", '          const run = async () => {\n            fixtureStage("output-lock:admitted");\n            fixtureStage("view:start");');
  const mark = (before: string, start: string, done: string) => { run = replace("boundary", run, before, `            fixtureStage("${start}");\n${before}\n            fixtureStage("${done}");`); };
  run = replace("boundary", run, "            const view = await prepareInput(execution.signal);", '            const view = await prepareInput(execution.signal);\n            fixtureStage("view:done");');
  mark("              outputs = await prepareMaintenanceOutput(brain, { startupView: view, folderPaths: hold?.folderPaths, signal: execution.signal, areas: execution.outputAreas });", "output:start", "output:done");
  mark("              const git = await prepareMaintenanceGit(launch, outputs, execution.signal, options.log);", "git:start", "git:done");
  mark(`              const result = await runMaintenanceWorker({ ...launch, startupView: outputs.view, output: outputs.output, ...(git ? { git } : {}), stdin: execution.stdin,
                ...(execution.signal ? { signal: execution.signal } : {}), ...(execution.timeoutMs ? { timeoutMs: execution.timeoutMs } : {}), ...(execution.outputBytes ? { outputBytes: execution.outputBytes } : {}) },
              () => { execution.assertAuthorized?.(); execution.onExecute?.(); });`, "worker:start", "worker:done");
  run = replace("boundary", run, "              if (!result.killed && execution.publish !== false) {", '              if (!result.killed && execution.publish !== false) {\n                fixtureStage("publish:start");');
  run = replace("boundary", run, "                else await outputs.publish();", '                else await outputs.publish();\n                fixtureStage("publish:done");');
  run = replace("boundary", run, "            } finally { await relay?.stop(); try { await outputs?.cleanup(); } finally { await view.cleanup(); } }", '            } finally { await relay?.stop(); try { fixtureStage("output-cleanup:start"); await outputs?.cleanup(); fixtureStage("output-cleanup:done"); } finally { fixtureStage("view-cleanup:start"); await view.cleanup(); fixtureStage("view-cleanup:done"); } }');
  run = replace("boundary", run, "          return outputLock.withLock(brain, () => execution.lock", '          fixtureStage("output-lock:wait");\n          return outputLock.withLock(brain, () => execution.lock');
  boundary = boundary.slice(0, runStart) + run + boundary.slice(runEnd);
  return { cron, boundary, substitutions, hashes: { originalCron: hash(cronSource), originalBoundary: hash(boundarySource), variantCron: hash(cron), variantBoundary: hash(boundary) } };
}
export function ownedPruneDiagnosticSelected(options: readonly string[], applicationQualification: boolean) {
  const selected = options.includes("--owned-prune-diagnostic");
  if (selected && !applicationQualification) throw Error("Owned prune diagnostics require application qualification");
  return selected;
}

/** One fixed boot-site substitution; no timer, manual tick or product API change. */
export function bootPruneCaptureVariant(cronSource: string) {
  const before = "  void tick();";
  if (!cronSource.includes(before) || cronSource.indexOf(before) !== cronSource.lastIndexOf(before)) throw Error("Boot prune fixture anchor changed");
  const after = `  const fixtureBootPromise = tick();
  const fixtureBootSlot = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("brain-kit.fixture.boot-prune"));
  if (!fixtureBootSlot || !("value" in fixtureBootSlot) || !fixtureBootSlot.value || fixtureBootSlot.value.promise !== undefined)
    throw Error("BOOT_PRUNE_CAPTURE_OWNER_MISSING");
  fixtureBootSlot.value.promise = fixtureBootPromise;`;
  const cron = cronSource.replace(before, after);
  return { cron, substitution: { before, after }, hashes: { originalCron: hash(cronSource), variantCron: hash(cron) } };
}
export function bootPruneCaptureSelected(options: readonly string[], applicationQualification: boolean) {
  const selected = options.includes("--boot-prune-capture");
  if (selected && !applicationQualification) throw Error("Boot prune capture requires application qualification");
  return selected;
}
