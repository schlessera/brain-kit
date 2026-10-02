/** Execute registered pi reads against a CLI index from installed tarballs. */
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const flag = process.argv.indexOf("--root");
if (flag === -1 || !process.argv[flag + 1]) throw new Error("check-pi-query-package requires --root <consumer install>");
const consumer = resolve(process.argv[flag + 1]);
const probeDir = mkdtempSync(join(consumer, ".pi-query-package-probe-"));
const brainPath = mkdtempSync(join(tmpdir(), "pi-query-package-"));
const env: Record<string, string | undefined> = { ...process.env, BRAIN_ROOT: brainPath };
for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "BRAIN_RERANK_MODE"]) delete env[name];

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd: consumer, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Packed pi probe failed: ${err}`);
  console.log(out.trim());
}

try {
  mkdirSync(join(brainPath, "notes"));
  await Bun.write(join(brainPath, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  for (const [name, body] of [["odysseus", "[[ithaca]] [[Unknown Harbour]]"], ["ithaca", "[[odysseus]]"]]) {
    await Bun.write(join(brainPath, `notes/${name}.md`), `---\ntitle: ${name}\ntype: note\nstatus: active\nrelevance: primary\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags: [Ithaca]\n---\n${body}\n`);
  }
  await run([join(consumer, "node_modules/.bin/brain"), "index", "--force", "--json"]);
  const probe = join(probeDir, "probe.ts");
  await Bun.write(probe, `
import { createBrainAccess, createBrainTools, createTurnContext } from "@schlessera/brain-backend-pi";
import * as internal from "@schlessera/brain/internal";
for (const name of ["archiveDocument", "assembleContext", "hybridSearch", "indexAll", "ingest", "loadVecSupport", "openDatabase"]) {
  if (typeof internal[name] !== "function") throw new Error("Packed native helper missing: " + name);
}
const registered = createBrainTools({ brain: createBrainAccess(${JSON.stringify(brainPath)}), turn: createTurnContext(), lock: { withKey: async (_key, fn) => fn() } });
async function call(name, args) {
  const result = await registered.find(t => t.name === name).execute("packed", args, undefined, undefined, {});
  const value = JSON.parse(result.content.filter(p => p.type === "text").map(p => p.text).join(""));
  return { value, details: result.details };
}
const listed = await call("brain_list", { tag: "Ithaca" });
if (listed.value.documents.length !== 2 || listed.details.count !== 2 || !listed.value.documents.every(d => d.tags === "Ithaca" && d.status === "active")) throw new Error("Packed pi listing mapping failed");
const graph = await call("brain_graph", { path: "notes/odysseus.md" });
if (graph.value.nodes.length !== 2 || graph.value.edges.length !== 3 || graph.details.count !== 3 || !graph.value.edges.some(e => e.target === "Unknown Harbour" && e.resolved === false)) throw new Error("Packed pi graph mapping failed");
const absent = await call("brain_graph", { path: "notes/absent.md" });
if (absent.value.nodes.length || absent.value.edges.length) throw new Error("Packed pi absent path mapping failed");
console.log("packed pi graph/list: populated registered tools pass");
`);
  await run([probe]);
  // An ordinary Node bundler selects compiled defaults; Bun supplies the
  // documented native runtime. Third-party dependencies remain external.
  const external = new Set<string>(["bun", "bun:*"]);
  for (const name of ["brain", "brain-backend-pi"]) {
    const manifest = await Bun.file(join(consumer, "node_modules/@schlessera", name, "package.json")).json();
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (dep !== "@schlessera/brain") external.add(dep);
    }
  }
  const built = await Bun.build({ entrypoints: [probe], target: "node", format: "esm", outdir: join(probeDir, "built"), external: [...external], metafile: true });
  if (!built.success) throw new Error(`Pi default consumer build failed: ${built.logs.join("\n")}`);
  const inputs = Object.keys(built.metafile?.inputs ?? {});
  for (const suffix of ["/brain/dist/queries/index.js", "/brain/dist/internal.js", "/brain-backend-pi/dist/brain-access.js"]) {
    if (!inputs.some(path => path.endsWith(suffix))) throw new Error(`Ordinary pi consumer did not select ${suffix}`);
  }
  if (inputs.some(path => /\/brain(?:-backend-pi)?\/src\//.test(path))) throw new Error("Ordinary default pi consumer selected source");
  await run([built.outputs[0].path]);
  console.log("pi package: source and default JavaScript tool runtime checks pass");
} finally {
  rmSync(probeDir, { recursive: true, force: true });
  rmSync(brainPath, { recursive: true, force: true });
}
