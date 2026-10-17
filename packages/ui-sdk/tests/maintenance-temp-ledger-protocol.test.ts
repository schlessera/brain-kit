import { afterEach, expect, test } from "bun:test";
import { ledgerChildLine, ledgerLine } from "./maintenance-temp-ledger-protocol";

const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGKILL"); await child.exited; }
});
function spawn(program: string) {
  const child = Bun.spawn([process.execPath, "-e", program], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.push(child); return child;
}
async function failure(child: ReturnType<typeof spawn>) {
  try { await ledgerChildLine(child, "controlled recovery"); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    const observed = error as Error;
    expect(String(observed.cause)).toContain("owned ledger child");
    return JSON.parse(observed.message.slice(observed.message.indexOf("{")!)) as {
      phase: string; pid: number; exitStatus: number | null; exitCode: number | null; signalCode: string | null; stdout: string; stderr: string;
    };
  }
  throw new Error("child unexpectedly produced a receipt");
}

for (const exitCode of [0, 23]) test(`EOF retains original exit ${exitCode}, partial stdout and startup stderr`, async () => {
  const child = spawn(`const {writeSync}=require("node:fs"); writeSync(1,"partial"); writeSync(2,"phase=db-open; controlled startup failure"); process.exit(${exitCode});`);
  expect(await failure(child)).toEqual({ phase: "controlled recovery", pid: child.pid, exitStatus: exitCode, exitCode, signalCode: null,
    stdout: "partial", stderr: "phase=db-open; controlled startup failure" });
  expect(await child.exited).toBe(exitCode);
});

test("signal EOF retains SIGKILL and diagnostics before caller cleanup", async () => {
  const child = spawn('require("node:fs").writeSync(2,"phase=before-receipt"); process.kill(process.pid,"SIGKILL");');
  const evidence = await failure(child);
  expect(evidence.signalCode).toBe("SIGKILL");
  expect(evidence.exitCode).toBeNull();
  expect(evidence.exitStatus).toBe(await child.exited);
  expect(evidence.stderr).toBe("phase=before-receipt");
  expect(evidence.stdout).toBe("");
});

test("stderr larger than pipe capacity drains and retains only a bounded tail", async () => {
  const child = spawn('const {writeSync}=require("node:fs"); for(let i=0;i<256;i++) writeSync(2,"x".repeat(4096)); writeSync(2,"diagnostic-tail"); process.exit(31);');
  const evidence = await failure(child);
  expect(evidence.exitCode).toBe(31);
  expect(Buffer.byteLength(evidence.stderr)).toBe(8192);
  expect(evidence.stderr.endsWith("diagnostic-tail")).toBe(true);
  expect(await child.exited).toBe(31);
});

test("a real child receipt survives split writes and UTF-8 framing", async () => {
  const child = spawn('const {writeSync}=require("node:fs"); writeSync(1,Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xce])); setTimeout(()=>{writeSync(1,Buffer.from([0xb1,0x22,0x7d,0x0a]));},10);');
  expect(await ledgerChildLine(child, "split receipt")).toBe('{"a":"α"}');
  expect(await child.exited).toBe(0);
});

test("later receipt failures reuse the stderr observer and retain earlier diagnostics", async () => {
  const child = spawn('const {writeSync}=require("node:fs"); process.on("SIGUSR1",()=>{writeSync(2,"later phase"); process.exit(23)}); writeSync(2,"first phase; "); writeSync(1,"ready\\n"); setInterval(()=>{},1000);');
  expect(await ledgerChildLine(child, "first receipt")).toBe("ready");
  child.kill("SIGUSR1");
  const evidence = await failure(child);
  expect(evidence.stderr).toBe("first phase; later phase");
  expect(evidence.exitStatus).toBe(23);
  expect(await child.exited).toBe(23);
});

test("excessive stdout fails with bounded diagnostics", async () => {
  const child = spawn('const {writeSync}=require("node:fs"); writeSync(1,"x".repeat(128*1024));');
  const evidence = await failure(child);
  expect(Buffer.byteLength(evidence.stdout)).toBe(8192);
});

test("closed stdout from a live child keeps the original five-second deadline and caller cleanup", async () => {
  const child = spawn('const {writeSync,closeSync}=require("node:fs"); writeSync(2,"stdout closed, child alive"); closeSync(1); setInterval(()=>{},1000);');
  const started = performance.now();
  const evidence = await failure(child);
  expect(performance.now() - started).toBeLessThan(6000);
  expect(evidence.exitStatus).toBeNull();
  expect(evidence.signalCode).toBeNull();
  expect(evidence.stderr).toBe("stdout closed, child alive");
  child.kill("SIGKILL");
  expect(await child.exited).toBe(137);
});

test("the original stream reader reproduces identical empty EOF for distinct exit causes", async () => {
  for (const program of ['process.exit(0)', 'process.exit(23)', 'process.kill(process.pid,"SIGKILL")']) {
    const child = spawn(program);
    await expect(ledgerLine(child.stdout)).rejects.toThrow("owned ledger child exited before its receipt: ");
    await child.exited;
  }
});
