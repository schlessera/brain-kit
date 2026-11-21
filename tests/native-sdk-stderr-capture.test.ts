import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
import { redactNativeDiagnosticAssignments } from "../scripts/test-native-guard";
import { SDK_STDERR_WINDOW_BYTES } from "../packages/ui-sdk/tests/fixtures/native-sdk-stderr-capture";

const helper = join(import.meta.dir, "../packages/ui-sdk/tests/fixtures/native-sdk-stderr-capture.ts");
test("SDK stderr failure capture keeps bounded scrubbed first and tail windows on nonzero exit", async () => {
  const child = spawnGuardFixture([process.execPath, "-e", `
    import {captureNativeSdkStderr,SDK_STDERR_WINDOW_BYTES} from ${JSON.stringify(helper)};
    const secret="odysseus-generated-secret",token="sk-ant-"+"k".repeat(48);
    const capture=captureNativeSdkStderr([secret]);
    try {
      capture.stderr("FIRST_FAILURE\\nArgs: SIRENS_PRIVATE_ARGUMENT\\nEnvironment: SIRENS_PRIVATE_ENVIRONMENT\\napi_key="+secret.slice(0,8));
      capture.stderr(secret.slice(8)+"\\nAuthorization: Bearer "+token+"\\n/home/odysseus/private.json\\nhttps://provider.invalid/v1/messages\\n");
      capture.stderr("x".repeat(SDK_STDERR_WINDOW_BYTES*4)+"\\n");
      capture.stderr("TAIL_FAILURE\\npassword=voyage-password\\n/home/odysseus/settings.json\\nhttps://endpoint.invalid/api\\n");
      throw Error("synthetic SDK nonzero exit");
    } catch { process.exitCode=1; }
    finally { capture.flush();capture.flush(); }
  `], { env: { PATH: "/usr/bin:/bin" } });
  const [code, output] = await Promise.all([child.exited, child.guardOutput()]);
  expect(code).toBe(1);
  const records = output.split("\n").filter(line => line.startsWith('{"kind":"native-fixture-sdk-stderr"')).map(line => JSON.parse(line));
  expect(records, "SDK_FAILURE_FLUSHED_ONCE").toHaveLength(1);
  const record = records[0];
  expect(record.first, "FIRST_WINDOW_RETAINED").toContain("FIRST_FAILURE");
  expect(record.tail, "TAIL_WINDOW_RETAINED").toContain("TAIL_FAILURE");
  expect(record.retainedBytes).toBeLessThanOrEqual(SDK_STDERR_WINDOW_BYTES*2);
  expect(record.observedBytes).toBeGreaterThan(SDK_STDERR_WINDOW_BYTES*4);
  expect(record.first.length+record.tail.length, "DIAGNOSTIC_OUTPUT_IS_BOUNDED").toBeLessThanOrEqual(SDK_STDERR_WINDOW_BYTES*2);
  expect(record.truncated).toBe(true);
  for (const value of ["odysseus-generated-secret", "sk-ant-"+"k".repeat(48), "voyage-password", "/home/odysseus", "provider.invalid", "endpoint.invalid", "SIRENS_PRIVATE_ARGUMENT", "SIRENS_PRIVATE_ENVIRONMENT"])
    expect(output, "SDK_STDERR_IS_SCRUBBED").not.toContain(value);
});

test("hosted file-tool fixture installs SDK capture before query and flushes in finally", () => {
  const source = readFileSync(join(import.meta.dir, "../packages/ui-backend-claude/tests/native-hosted-runtime.test.ts"), "utf8");
  expect(source.indexOf("const sdkStderr = captureNativeSdkStderr")).toBeLessThan(source.indexOf("for await (const message of query("));
  expect(source).toContain("stderr: sdkStderr.stderr");
  expect(source).toContain("} finally {\n    sdkStderr.flush();");
});


test("SDK stderr scrubs short named credentials in environment and quoted JSON forms", async () => {
  const values=["short-secret", "plain-secret", "short-password", "json-secret", "tiny-token", "camel-secret", "short-bearer", "short-basic"];
  const text='ANTHROPIC_AUTH_TOKEN=short-secret\nANTHROPIC_API_KEY=plain-secret\nMY_PASSWORD=short-password\nAuthorization: Bearer short-bearer\nAUTH=Basic short-basic\n{"apiKey":"json-secret","token": "tiny-token","authToken":"camel-secret"}\n';
  const child=spawnGuardFixture([process.execPath,"-e",`import {captureNativeSdkStderr} from ${JSON.stringify(helper)};const c=captureNativeSdkStderr([]);c.stderr(${JSON.stringify(text)});c.flush();`],{env:{PATH:"/usr/bin:/bin"}});
  const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
  for(const value of values)expect(output,"SHORT_NAMED_CREDENTIAL_REDACTED").not.toContain(value);
});

for(const edge of ["first","tail"] as const)test(`SDK stderr drops a token split across the ${edge} byte boundary`,async()=>{
 const token="SIRENS_BOUNDARY_ITHACA_TAIL_SECRET",marker=edge==="first"?"SIRENS_BOUNDARY":"SECRET";
 const window=SDK_STDERR_WINDOW_BYTES;
 const text=edge==="first"?"a".repeat(window-16)+"\n"+token+"\n"+"b".repeat(window*3)+"\nend\n":
  "start\n"+"a".repeat(window*3)+token+"\n"+"b".repeat(window-16)+"\nend\n";
 const child=spawnGuardFixture([process.execPath,"-e",`import {captureNativeSdkStderr} from ${JSON.stringify(helper)};const c=captureNativeSdkStderr([]);c.stderr(${JSON.stringify(text)});c.flush();`],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 expect(output,"CUT_TOKEN_LINE_OMITTED").not.toContain(marker);
});


for(const [label,text,secret] of [
 ["digit-leading-token","2FA_TOKEN=digit-token-value","digit-token-value"],
 ["digit-leading-secret","1PASSWORD_SECRET=digit-secret-value","digit-secret-value"],
 ["digit-token","9token=digit-short-value","digit-short-value"],
 ["digit-dotted-key","3rd.api.key: digit-dotted-value","digit-dotted-value"],
 ["error-prefix","Error: ANTHROPIC_AUTH_TOKEN=error-auth-value","error-auth-value"],
 ["failure-prefix","failed: MY_PASSWORD=failure-password-value","failure-password-value"],
 ["nested-env",'{"env":{"apiKey":"nested-api-value"}}',"nested-api-value"],
 ["nested-header",'headers: {"x-api-key":"nested-header-value"}',"nested-header-value"],
 ["nested-config",'config={"token":"nested-config-value"}',"nested-config-value"],
] as const)test(`SDK credential matching ignores non-credential wrappers: ${label}`,async()=>{
 expect(redactNativeDiagnosticAssignments(text),"NAMED_CREDENTIAL_MATCHER_REDACTED").not.toContain(secret);
 const child=spawnGuardFixture([process.execPath,"-e",`import {captureNativeSdkStderr} from ${JSON.stringify(helper)};const capture=captureNativeSdkStderr([]);capture.stderr(${JSON.stringify(text+"\n")});capture.flush();`],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 expect(output,"NESTED_NAMED_CREDENTIAL_REDACTED").not.toContain(secret);
});

test("native diagnostic source context preserves JS members and basenames while hiding network addresses",async()=>{
 const child=spawnGuardFixture([process.execPath,"-e",`
  import {captureNativeSdkStderr} from ${JSON.stringify(helper)};
  import {recordNativeGuardChild} from ${JSON.stringify(join(import.meta.dir,"../scripts/test-native-guard.ts"))};
  const source='const upstream={pipe(){throw Error("egress-worker-entry.ts egress-worker-entry.test.ts api.ithaca.test 127.0.0.1 localhost:8123 [::1]")}}; const peer={}; const server={on(){upstream.pipe(peer)}}; server.on("error");';
  const failed=Bun.spawn([process.execPath,"-e",source],{env:{PATH:"/usr/bin:/bin"},stdout:"ignore",stderr:"pipe"});
  const text=await new Response(failed.stderr).text();await failed.exited;
  const capture=captureNativeSdkStderr([]);capture.stderr(text);capture.flush();
  await recordNativeGuardChild(failed,true,{drained:Promise.resolve(),snapshot:()=>text});
 `],{env:{PATH:"/usr/bin:/bin"}});
 const [code,output]=await Promise.all([child.exited,child.guardOutput()]);expect(code,output).toBe(0);
 const records=output.split("\n").filter(line=>line.startsWith('{"kind":"native-fixture-sdk-stderr"')||line.startsWith('{"kind":"native-offline-bootstrap-failure"')).map(line=>JSON.parse(line));
 expect(records).toHaveLength(2);
 for(const record of records){const text=record.reason??record.first;for(const member of ["server.on","upstream.pipe","egress-worker-entry.ts","egress-worker-entry.test.ts"])expect(text,"SOURCE_CONTEXT_REMAINS_READABLE").toContain(member);for(const address of ["api.ithaca.test","127.0.0.1","localhost","[::1]"])expect(text,"DIAGNOSTIC_HOST_REDACTED").not.toContain(address);}
});
