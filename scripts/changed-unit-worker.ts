/** Observe Bun's selection before reconciling its actual shard reports. */
import { basename, dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

export function changedSelection(output: string, shard: string) {
  output = stripVTControlCharacters(output);
  const affected = /^--changed: \d+ changed files?, running (\d+)\/\d+ test files$/m.exec(output);
  const empty = /^--changed: (?:no changed files, nothing to run|\d+ changed files?, but no test files are affected)\.?$/m.test(output);
  if (!affected && !empty) throw new Error("Bun did not report its changed-file selection");
  const selected = affected ? Number(affected[1]) : 0;
  const assignment = new RegExp(`^--shard=${shard}: running (\\d+)\\/(\\d+) test files$`, "m").exec(output);
  if (selected > 0 && (!assignment || Number(assignment[2]) !== selected)) throw new Error("Bun did not shard its complete changed-file selection");
  const assigned = assignment ? Number(assignment[1]) : 0;
  if (assigned > selected) throw new Error("Invalid Bun changed shard count");
  return { selected, assigned };
}

export function timingSeed(costs: Readonly<Record<string, number>>) {
  if (Object.values(costs).some(seconds => !Number.isFinite(seconds) || seconds <= 0)) throw new Error("Invalid changed-test cost");
  return { version: 1, files: Object.fromEntries(Object.entries(costs).map(([file, seconds]) => [file, seconds * 1000])) };
}

if (import.meta.main) {
  try {
    const [base, shard] = process.argv.slice(2);
    if (!base || !/^[1-9]\d*\/[1-9]\d*$/.test(shard ?? "")) throw new Error("Expected changed worker <merge-base> <i/N>");
    const root = resolve(import.meta.dir, "..");
    const start = performance.now();
    // The whole-tree leakage test must not see machine paths from active logs.
    // This owned sibling survives until the parent copies it to private reports.
    const log = Bun.file(join(dirname(root), `${basename(root)}-output.log`)).writer();
    const child = Bun.spawn([process.execPath, "run", "test", "--internal-full-preparation", `--changed=${base}`, `--shard=${shard}`, "--pass-with-no-tests",
      "--reporter=junit", "--reporter-outfile=tmp/unit-report.xml", "--timings=tmp/unit-timings.json", "--update-timings"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const listeners = signals.map(signal => () => child.kill(signal));
    signals.forEach((signal, index) => process.on(signal, listeners[index]!));
    let stderr = "";
    const relay = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        log.write(chunk); process[channel].write(chunk);
        if (channel === "stderr") stderr += decoder.decode(chunk, { stream: true });
      }
      if (channel === "stderr") stderr += decoder.decode();
    };
    let code: number;
    try { [code] = await Promise.all([child.exited, relay(child.stdout, "stdout"), relay(child.stderr, "stderr")]); }
    finally { await log.end(); signals.forEach((signal, index) => process.off(signal, listeners[index]!)); }
    const failed = code !== 0 || Boolean(child.signalCode);
    let selection: ReturnType<typeof changedSelection> | undefined;
    try { selection = changedSelection(stderr, shard!); }
    catch (error) { if (!failed) throw error; }
    const events = [...stderr.matchAll(/^\{"kind":"test-invocation",.*$/gm)].map(([line]) => JSON.parse(line));
    const preparation = events.find(event => ["build-attested", "build-unattested", "build-copied", "preparation-failed"].includes(event.event));
    const tests = events.find(event => event.event === "tests-complete" && event.pid === preparation?.pid);
    await Bun.write(join(root, "tmp/unit-selection.json"), JSON.stringify({ ...selection, shard, exitCode: failed ? code || 1 : 0,
      elapsedMs: performance.now() - start, preparationMs: preparation?.elapsedMs ?? null, testMs: tests?.elapsedMs ?? null }, null, 2));
    if (failed) process.exit(code || 1);
    // Bun writes no JUnit for a genuinely empty shard. Its timing report must
    // still be empty; the parent validates this explicit zero-file receipt.
    if (selection!.assigned === 0 && !await Bun.file(join(root, "tmp/unit-report.xml")).exists()) {
      await Bun.write(join(root, "tmp/unit-report.xml"), '<testsuites tests="0" failures="0" skipped="0" assertions="0" time="0"></testsuites>\n');
    }
  } catch (error) { console.error(error); process.exit(1); }
}
