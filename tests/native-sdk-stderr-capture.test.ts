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
