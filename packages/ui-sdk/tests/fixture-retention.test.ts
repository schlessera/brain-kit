import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainFixtureStream } from "./fixtures/retained-stream";
import { applicationQualificationSelected, APPLICATION_QUALIFICATION_PHASES, APPLICATION_SKIPPED_CONTROLS } from "./fixtures/application-qualification";

test("fixture retains stdout and stderr before a real bounded child exits, preserving complete final bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-retained-stream-")), out = join(root, "stdout"), err = join(root, "stderr");
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", String.raw`
process.stdout.write("Odysseus partial\n"); process.stderr.write("Athena partial\n");
await new Promise(resolve => process.stdin.once("data", resolve));
const bytes=Buffer.from([0xce,0xb1,0xff]);process.stdout.write(bytes.subarray(0,1));process.stdout.write(bytes.subarray(1));
process.stderr.write("Ithaca complete\n");`], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [outCapture, outReference] = child.stdout.tee(), [errCapture, errReference] = child.stderr.tee();
  const output = retainFixtureStream(outCapture, out), errors = retainFixtureStream(errCapture, err);
  const referenceOutput = new Response(outReference).text(), referenceErrors = new Response(errReference).text();
  try {
    const deadline = Date.now() + 2000;
    const partial = () => existsSync(out) && existsSync(err) && readFileSync(out, "utf8").includes("Odysseus partial") && readFileSync(err, "utf8").includes("Athena partial");
    while (!partial() && Date.now() < deadline) await Bun.sleep(5);
    expect(partial(), "FIXTURE_PARTIAL_OUTPUT_BEFORE_CHILD_EXIT").toBe(true);
    expect(child.exitCode).toBeNull();
    child.stdin.write("release"); child.stdin.end();
    expect(await child.exited).toBe(0);
    const [actualOut, actualErr, expectedOut, expectedErr] = await Promise.all([output, errors, referenceOutput, referenceErrors]);
    expect(actualOut).toEqual({ text: expectedOut }); expect(actualErr).toEqual({ text: expectedErr });
    expect(readFileSync(out)).toEqual(Buffer.from(expectedOut)); expect(readFileSync(err)).toEqual(Buffer.from(expectedErr));
  } finally {
    try { if (child.exitCode === null) { child.stdin.write("release"); child.stdin.end(); } }
    finally {
      try { await child.exited; await Promise.allSettled([output, errors, referenceOutput, referenceErrors]); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("artifact write failure retains drained bytes and the actual child exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-retained-failure-"));
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", 'process.stdout.write("Odysseus retained");process.exit(7);'], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  try {
    const [output, errors, code] = await Promise.all([retainFixtureStream(child.stdout, join(root, "absent", "stdout")), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(7); expect(errors).toBe(""); expect(output.text).toBe("Odysseus retained"); expect(output.failure?.error).toBeInstanceOf(Error);
  } finally { await child.exited; rmSync(root, { recursive: true, force: true }); }
});

test("application qualification is explicit partial proof and cannot select diagnostic/mutant arms", () => {
  const required = ["--shared-git", "--private-git-inputs", "--native-phase-only"], selected = [...required, "--application-qualification"];
  expect(applicationQualificationSelected([])).toBe(false); expect(applicationQualificationSelected(required)).toBe(false);
  expect(applicationQualificationSelected(selected)).toBe(true);
  for (const missing of required) expect(() => applicationQualificationSelected(selected.filter(flag => flag !== missing))).toThrow();
  for (const conflict of ["--collector-inventory", "--probe-state-placement", "--omit-probe-state-placement", "--mutation=sentinel-modes"])
    expect(() => applicationQualificationSelected([...selected, conflict])).toThrow();
  expect(APPLICATION_QUALIFICATION_PHASES).toEqual(["private-positive", "fresh-git", "fresh-app", "warm", "strict"]);
  expect(APPLICATION_SKIPPED_CONTROLS).toEqual(["private-input-adverse-controls", "ordinary-probe-relay-controls", "maintenance-stage-principal-mask-publication-and-adverse-controls"]);
});
