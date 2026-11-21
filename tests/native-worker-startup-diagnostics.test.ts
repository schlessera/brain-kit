import { expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { observeNativeWorkerStartup, STARTUP_STDERR_BYTES } from "../packages/ui-sdk/tests/fixtures/native-worker-startup-diagnostics";

async function captured(run:(records:Record<string,unknown>[])=>Promise<void>) {
 const records:Record<string,unknown>[]=[];
 const log=spyOn(console,"error").mockImplementation(value=>records.push(JSON.parse(String(value))));
 try{await run(records);}finally{log.mockRestore();}
}

test("native fixture startup diagnostics use receipt scrubbers across chunks and record exit signal",async()=>{
 await captured(async records=>{
  const stderr=new PassThrough(),secret="odysseus-private-key",token="sk-ant-"+"k".repeat(48);
  observeNativeWorkerStartup({stderr,exited:Promise.resolve(143)},{exitCode:143,signalCode:"SIGTERM"},[secret]);
  stderr.write("startup failure\napi_key="+secret.slice(0,8));
  stderr.end(secret.slice(8)+"\nAuthorization: Bearer "+token+"\npassword=voyage-password\n/tmp/odysseus-private/result.md\n");
  await new Promise(resolve=>setImmediate(resolve));
  const record=records.find(row=>row.kind==="native-fixture-startup-stderr")!;
  expect(record.text).toContain("startup failure");
  for(const value of [secret,token,"voyage-password","/tmp/odysseus-private"])expect(record.text).not.toContain(value);
  expect(record.text).toContain("[redacted");
  expect(record.truncated).toBe(false);
  expect(records.find(row=>row.kind==="native-fixture-worker-exit")).toEqual({kind:"native-fixture-worker-exit",exitCode:143,signal:"SIGTERM",signalScope:"worker-bootstrap",bootstrapExitCode:143});
 });
});

test("native fixture retains only bounded initial stderr and scrubs rejected exits",async()=>{
 await captured(async records=>{
  const stderr=new PassThrough(),secret="odysseus-rejected-secret";
  observeNativeWorkerStartup({stderr,exited:Promise.reject(Error("secret="+secret))},{exitCode:1,signalCode:null},[secret]);
  stderr.write("initial startup failure\n");stderr.end("x".repeat(STARTUP_STDERR_BYTES*2)+"\nlate detail\n");
  await new Promise(resolve=>setImmediate(resolve));
  const record=records.find(row=>row.kind==="native-fixture-startup-stderr")!;
  expect(record.retainedBytes).toBe(STARTUP_STDERR_BYTES);
  expect(record.truncated).toBe(true);
  expect(record.text).toBe("initial startup failure");
  expect(JSON.stringify(records)).not.toContain(secret);
  expect(record.text).not.toContain("late detail");
 });
});
