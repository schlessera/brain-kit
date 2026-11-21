import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnGuardFixture } from "./helpers/native-receipt-fixture";
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
  const values=["short-secret", "plain-secret", "short-password", "json-secret", "tiny-token", "camel-secret"];
  const text='ANTHROPIC_AUTH_TOKEN=short-secret\nANTHROPIC_API_KEY=plain-secret\nMY_PASSWORD=short-password\n{"apiKey":"json-secret","token": "tiny-token","authToken":"camel-secret"}\n';
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
