/** Real tracer lifecycle, with a synthetic Bun child only; never launches Claude. */
import { expect, test } from "bun:test";
import { auditNativeLaunch } from "../scripts/test-native-guard";
import { watchdogMs } from "../scripts/test-deadlines";

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`native audit ${signal} cancellation terminates tracer and synthetic child and closes pipes`, async () => {
  expect(Bun.which("strace"), "strace is required for audit lifecycle proof").toBeTruthy();
  const audit = auditNativeLaunch([process.execPath, "-e", 'console.log(process.pid);setInterval(()=>{},1000)'], [process.execPath], () => {});
  const child = Bun.spawn(audit.argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let fixturePid: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    fixturePid = Number(new TextDecoder().decode(ready.value).trim());
    expect(Number.isSafeInteger(fixturePid) && fixturePid! > 1).toBe(true);
    child.kill(signal);
    const completion = Promise.all([child.exited, reader.read(), new Response(child.stderr).text()]);
    const [code, tail] = await Promise.race([completion, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("AUDIT_CANCELLATION_STALLED")), watchdogMs(3000));
    })]);
    expect(code).not.toBe(0);
    expect(tail.done).toBe(true);
    expect(audit.receipt()).toMatchObject({ nativeLaunched: true, success: true });
  } finally {
    if (timer) clearTimeout(timer);
    // Exact fixture PID only; a broken tracer must not leave the mutant alive.
    if (fixturePid && Number.isSafeInteger(fixturePid) && fixturePid > 1) {
      try { process.kill(fixturePid, "SIGKILL"); } catch { /* Already reaped. */ }
    }
    child.kill("SIGKILL"); child.stdin.end(); audit.dispose();
  }
}, watchdogMs(15000));

test("live native audit supplies exact successful exec PIDs without finishing the audit",async()=>{
 const {realpathSync,readFileSync}=await import("node:fs");
 const executable=realpathSync("/usr/bin/python3");
 const audit=auditNativeLaunch([executable,"-I","-S","-c","import os,time;print(os.getpid(),flush=True);time.sleep(30)"],[executable],()=>{});
 const child=Bun.spawn(audit.argv,{stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 try{
  const reader=child.stdout.getReader(),ready=await reader.read();reader.releaseLock();
  const pid=Number(new TextDecoder().decode(ready.value).trim());
  const start=readFileSync(`/proc/${pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;
  expect([...audit.liveExecs()],"LIVE_AUDIT_EXACT_PAYLOAD_IDENTITY").toEqual([[pid,start]]);
  expect([...audit.liveExecs()],"LIVE_AUDIT_IS_REPEATABLE_BEFORE_FINISH").toEqual([[pid,start]]);
 }finally{child.kill();await child.exited;await new Response(child.stderr).text();audit.dispose();}
},watchdogMs(15000));
