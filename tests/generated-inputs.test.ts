import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectGeneratedProducer } from "../scripts/generated-inputs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const expression = `write("brain.config.ts", "export default {};\\n")`;
const source = `import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os"; import {join} from "node:path";
const root = mkdtempSync(join(tmpdir(), "producer-proof-"));
const write = (path:string,bytes:string) => { writeFileSync(join(root,path),bytes); };
${expression};`;
function fixture(contents: string) { const root = mkdtempSync(join(tmpdir(), "generated-inputs-")); roots.push(root); writeFileSync(join(root, "producer.ts"), contents); return root; }
test("fixed generated producer runs in an owned temporary root; receipt never claims a consumer binding", async () => {
  const root = fixture(source), receipt = inspectGeneratedProducer(root, { owner: "producer.ts", root: "root", expression });
  expect(receipt.relativePath).toBe("brain.config.ts"); expect(receipt.consumerBound).toBe(false);
  writeFileSync(join(root, "producer.ts"), source + `console.log(JSON.stringify({root}));`);
  const child = Bun.spawn([process.execPath, join(root, "producer.ts")], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0);
  const generated = JSON.parse(output).root;
  expect(generated.startsWith(join(tmpdir(), "producer-proof-"))).toBe(true); roots.push(generated);
  expect(readFileSync(join(generated, "brain.config.ts"), "utf8")).toBe("export default {};\n");
});
test("redirected roots, producer drift, escaping paths and unbounded bytes cannot qualify", () => {
  for (const changed of [source.replace(`mkdtempSync(join(tmpdir(), "producer-proof-"))`, "process.env.REDIRECT_ROOT"), source.replace("join(root,path)", "join(external,path)"), source.replace(expression, `write("../brain.config.ts", "fixed")`), source.replace(expression, `write("brain.config.ts", process.env.PAYLOAD)`), source + expression + ";"]) {
    const root = fixture(changed);
    const current = changed.includes(expression) ? expression : changed.includes("../brain") ? `write("../brain.config.ts", "fixed")` : `write("brain.config.ts", process.env.PAYLOAD)`;
    expect(() => inspectGeneratedProducer(root, { owner: "producer.ts", root: "root", expression: current })).toThrow();
  }
});
test("actual hygiene-loop config producer is verified but its CLI consumer stays unbound", () => {
  const root = resolve(import.meta.dir, ".."), owner = "packages/ui-react/tests/browser/hygiene-loop-command.ts";
  const expression = /^\s*(write\("brain\.config\.ts", [^\n]+\));$/m.exec(readFileSync(join(root, owner), "utf8"))?.[1];
  expect(expression).toBeDefined();
  const receipt = inspectGeneratedProducer(root, { owner, root: "root", expression: expression! });
  expect(receipt.relativePath).toBe("brain.config.ts"); expect(receipt.producerDigest).toMatch(/^[0-9a-f]{64}$/); expect(receipt.consumerBound).toBe(false);
});


test("actual core config resolves the generated CLI cwd only when root redirects are absent", async () => {
  const generated = mkdtempSync(join(tmpdir(), "producer-cli-root-")); roots.push(generated);
  writeFileSync(join(generated, "brain.config.ts"), "export default { taxonomy: { types: { note: { dir: \"journeys\", orphanExempt: true } } } };\n");
  const redirect = mkdtempSync(join(tmpdir(), "producer-cli-redirect-")); roots.push(redirect);
  writeFileSync(join(redirect, "brain.config.ts"), "export default { taxonomy: { types: { note: { dir: \"other\" } } } };\n");
  const module = resolve(import.meta.dir, "../packages/core/src/lib/config.ts");
  const code = `import {resolveRoot,loadUserConfig} from ${JSON.stringify(module)}; const root=resolveRoot(); const loaded=await loadUserConfig(root); console.log(JSON.stringify({root,path:loaded.path,dir:loaded.config?.taxonomy?.types?.note?.dir}));`;
  const env = { ...process.env };
  for (const name of ["BRAIN_ROOT", "BRAIN_WORKER_DATA_ROOT", "BRAIN_WORKER_CONFIG_ROOT"]) delete env[name];
  async function read(overrides: Record<string,string>) {
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: generated, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit,error).toBe(0); return JSON.parse(output);
  }
  expect(await read({})).toEqual({ root: generated, path: join(generated,"brain.config.ts"), dir:"journeys" });
  expect(await read({ BRAIN_ROOT: redirect })).toEqual({ root: redirect, path: join(redirect,"brain.config.ts"), dir:"other" });
  expect(await read({ BRAIN_WORKER_DATA_ROOT: generated, BRAIN_WORKER_CONFIG_ROOT: redirect })).toEqual({ root: generated, path: join(generated,"brain.config.ts"), dir:"other" });
});
