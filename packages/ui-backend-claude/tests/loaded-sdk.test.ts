import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const backendRoot = resolve(import.meta.dir, "..");
const workspace = resolve(backendRoot, "../..");
const sdkRoot = dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
function fixture(version: unknown, name = "@anthropic-ai/claude-agent-sdk") {
  const dir = mkdtempSync(join(tmpdir(), "loaded-claude-")); scratch.push(dir);
  // A satisfying hoisted copy exists, but the backend imports its nested one.
  symlinkSync(join(workspace, "node_modules"), join(dir, "node_modules"));
  const own = join(dir, "backend"); mkdirSync(own);
  cpSync(join(backendRoot, "src"), join(own, "src"), { recursive: true });
  cpSync(join(backendRoot, "package.json"), join(own, "package.json"));
  const sdk = join(own, "node_modules/@anthropic-ai/claude-agent-sdk"); mkdirSync(sdk, { recursive: true });
  // Use real SDK code without any binary or provider. Its manifest is the test identity.
  cpSync(join(sdkRoot, "sdk.mjs"), join(sdk, "sdk.mjs"));
  const data = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ ...data, name, version }));
  const cli = join(dir, "claude"); writeFileSync(cli, "#!/bin/sh\necho '2.1.999 (Claude Code)'\n"); chmodSync(cli, 0o755);
  return { dir, own, cli };
}
async function run(f: ReturnType<typeof fixture>, minimum?: string, descriptor: boolean | "probe" = false) {
  const script = join(f.dir, "check.ts");
  writeFileSync(script, `import { createClaudeBackend } from "./backend/src/backend.ts";
import { backendModule } from "./backend/src/module.ts";
const options = { brainPath: ${JSON.stringify(f.dir)}, versionRequirements: ${JSON.stringify(minimum === undefined ? {} : { sdk: minimum })} };
try { ${descriptor === "probe" ? `globalThis.report = await backendModule.probeRuntime({ ...options, config: {claudeCodePath:${JSON.stringify(f.cli)}}, profiles: [], confirmBashPatterns: null, settings: {} });` : descriptor ? `const result = await backendModule.resolveFromEnv({ ...options, config: {}, profiles: [], confirmBashPatterns: null, settings: {} }); if (!result.ok) throw result.error;` : `createClaudeBackend(options);`} console.log(JSON.stringify({ok:true, ${descriptor === "probe" ? "report:globalThis.report" : ""}})); }
catch (error) { console.log(JSON.stringify({ok:false,error:String(error)})); }
`);
  const proc = Bun.spawn([process.execPath, script], { cwd: f.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" }); // load errors do not count as refusal
  return JSON.parse(stdout) as { ok: boolean; error?: string; report?: { sdk: { version: string }; runtime: { version: string }; measured: { matches: boolean } } };
}
for (const descriptor of [false, true]) {
  for (const [version, minimum, expected] of [
    ["0.3.240", undefined, "incompatible"],
    ["0.4.0", undefined, "incompatible"],
    ["0.3.282", "0.3.283", "incompatible"],
    ["0.3.283-beta.1", undefined, "incompatible"],
    ["v0.3.283", undefined, "unknown"],
    ["0.03.283", undefined, "unknown"],
    [null, undefined, "unknown"],
  ] as const) {
    test(`${descriptor ? "descriptor" : "direct factory"} refuses nested SDK ${version} despite compatible hoisted copy`, async () => {
      const result = await run(fixture(version), minimum, descriptor);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(expected);
      expect(result.error).toContain("@schlessera/brain-backend-claude");
      expect(result.error).toContain("^0.3.292");
      expect(result.error).toContain("backend construction");
      expect(result.error).toContain("Install");
    });
  }
  test(`${descriptor ? "descriptor" : "direct factory"} accepts supported unmeasured loaded SDK and weaker host floor`, async () => {
    expect(await run(fixture("0.3.999"), "0.3.250", descriptor)).toEqual({ ok: true });
  });
}
test("wrong-name loaded manifest refuses with identity and action", async () => {
  const result = await run(fixture("0.3.999", "unrelated-sdk"));
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/detected unknown.*expected manifest name.*unrelated-sdk/);
});

test("startup probe rejects the loaded SDK before checking a runtime", async () => {
  const f = fixture("0.4.0"); rmSync(f.cli);
  const result = await run(f, undefined, "probe");
  expect(result.ok).toBe(false);
  expect(result.error).toContain('detected "0.4.0"');
  expect(result.error).toContain('range "^0.3.292"');
  expect(result.error).toContain("startup probe");
});
test("compatible unmeasured imported SDK passes startup while reporting its true identity", async () => {
  const result = await run(fixture("0.3.999"), "0.3.250", "probe");
  expect(result.ok).toBe(true);
  expect(result.report?.sdk.version).toBe("0.3.999");
  expect(result.report?.runtime.version).toBe("2.1.999");
  expect(result.report?.measured.matches).toBe(false);
});
