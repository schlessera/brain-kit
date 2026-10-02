import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiBackend } from "../src/backend";
import { backendModule } from "../src/module";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const backendRoot = resolve(import.meta.dir, "..");
const workspace = resolve(backendRoot, "../..");
const names = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
function fixture(name: string, version: string, nested = false) {
  const dir = mkdtempSync(join(tmpdir(), "loaded-pi-")); scratch.push(dir);
  symlinkSync(join(workspace, "node_modules"), join(dir, "node_modules"));
  const own = join(dir, "backend"); mkdirSync(own);
  cpSync(join(backendRoot, "src"), join(own, "src"), { recursive: true });
  cpSync(join(backendRoot, "package.json"), join(own, "package.json"));
  const copy = (id: string, parent: string, override?: string) => {
    const actual = resolve(dirname(fileURLToPath(import.meta.resolve(id))), "..");
    const dest = join(parent, "node_modules", id); mkdirSync(dest, { recursive: true });
    cpSync(join(actual, "dist"), join(dest, "dist"), { recursive: true });
    const data = JSON.parse(readFileSync(join(actual, "package.json"), "utf8"));
    writeFileSync(join(dest, "package.json"), JSON.stringify({ ...data, ...(override ? { version: override } : {}) }));
    return dest;
  };
  if (nested) {
    const primary = copy(names[0]!, own);
    copy(name, primary, version);
  } else copy(name, own, version);
  return { dir };
}
async function run(f: ReturnType<typeof fixture>, boundary: "factory" | "resolve" | "probe") {
  const script = join(f.dir, "check.ts");
  writeFileSync(script, `import { createPiBackend } from "./backend/src/backend.ts";
import { backendModule } from "./backend/src/module.ts";
const context = {brainPath:${JSON.stringify(f.dir)}, config:{}, profiles:[], settings:{}, confirmBashPatterns:null};
try { ${boundary === "factory" ? "createPiBackend(context);" : boundary === "probe" ? "await backendModule.probeRuntime(context);" : "const result=await backendModule.resolveFromEnv(context);if(!result.ok)throw result.error;"} console.log(JSON.stringify({ok:true})); }
catch(error){console.log(JSON.stringify({ok:false,error:String(error)}));}`);
  const proc = Bun.spawn([process.execPath, script], { cwd: f.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return JSON.parse(stdout) as { ok: boolean; error?: string };
}
for (const name of names) for (const boundary of ["factory", "resolve", "probe"] as const) {
  test(`${boundary} checks actual ${name} against its exact owning declaration`, async () => {
    const result = await run(fixture(name, "0.99.3"), boundary);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(name);
    expect(result.error).toContain('range "0.99.2"');
    expect(result.error).toContain('detected "0.99.3"');
    expect(result.error).toContain("Install");
  });
}
for (const name of names.slice(1)) test(`nested ${name} used by coding-agent cannot borrow a compatible hoisted identity`, async () => {
  const result = await run(fixture(name, "0.99.3", true), "factory");
  expect(result.ok).toBe(false);
  expect(result.error).toContain(name);
  expect(result.error).toContain('detected "0.99.3"');
});
test("Pi reports primary SDK only, with a satisfied optional minimum", async () => {
  const report = await backendModule.probeRuntime!({ brainPath: "/unused", config: {}, profiles: [], settings: {}, confirmBashPatterns: null, versionRequirements: { sdk: "0.99.1" } });
  expect(report).toEqual({ sdk: { name: names[0], version: "0.99.2" } });
  expect(createPiBackend({ brainPath: "/unused", versionRequirements: { sdk: "0.99.1" } }).id).toBe("pi");
});
test("Pi direct factory rejects a conflicting primary floor and an unsupported runtime identity", () => {
  expect(() => createPiBackend({ brainPath: "/unused", versionRequirements: { sdk: "1.0.0" } })).toThrow(/No version satisfies/);
  expect(() => createPiBackend({ brainPath: "/unused", versionRequirements: { runtime: "1.0.0" } })).toThrow(/detected unknown.*no separate runtime identity/);
});
