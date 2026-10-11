import { writeFileSync } from "fs";
import { join } from "path";
import { BRAIN_BIN, keylessEnv, type CliResult } from "./cli-harness";

/** Child-only Date shim; explicit dates and real timers keep their semantics. */
export function writeHygieneClock(path: string, instant: string): void {
  writeFileSync(path, `
    const RealDate = Date;
    const instant = RealDate.parse(${JSON.stringify(instant)});
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [instant], newTarget); },
      apply() { return new RealDate(instant).toString(); },
      get(target, key, receiver) { return key === "now" ? () => instant : Reflect.get(target, key, receiver); },
    });
  `);
}

/** Caller owns/cleans scratch outside the brain whose durable bytes it checks. */
export function hygieneCliClock(scratch: string) {
  const hostClock = join(scratch, "host-clock.ts");
  const corpusClock = join(scratch, "corpus-clock.ts");
  return async (root: string, args: string[], instant: string, hostInstant = instant): Promise<CliResult> => {
    writeHygieneClock(hostClock, hostInstant);
    writeHygieneClock(corpusClock, instant);
    const proc = Bun.spawn([process.execPath, "--preload", hostClock, "--preload", corpusClock, BRAIN_BIN, ...args], {
      env: keylessEnv(root), stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { stdout, stderr, code };
  };
}
