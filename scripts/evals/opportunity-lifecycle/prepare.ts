/** Export complete new review inputs. Writes only an explicitly fresh output directory; no provider call. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { freshCases, referenceFiles } from "./fresh-corpus";
import { eventSchema } from "./prototype";
import { currentPrompt, protocol } from "./protocol";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function prepare(destination: string) {
  const output = resolve(destination), root = resolve(import.meta.dir, "../../..");
  if (output === root || output.startsWith(root + "/")) throw new Error("review output must be an owned separate artifact directory");
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const corpus = freshCases.map(fixture => ({ ...fixture,
    binaryInputs: { "attachments/fixture.bin": "AP/DgA==" }, symlinkInputs: { "attachments/pointer": "manifest.txt" },
    checkpoints: fixture.checkpoints.map(checkpoint => ({ ...checkpoint, referenceFiles: referenceFiles(fixture, checkpoint),
      currentPrompt: currentPrompt(fixture, checkpoint) })) }));
  const documents: Record<string, string> = { "corpus.json": JSON.stringify(corpus, null, 2) + "\n",
    "schema.json": JSON.stringify(eventSchema.toJSONSchema(), null, 2) + "\n", "protocol.json": JSON.stringify(protocol, null, 2) + "\n" };
  const inputs: Record<string, string> = {};
  for (const [name,text] of Object.entries(documents)) { writeFileSync(join(output, name), text); inputs[name] = sha(text); }
  const sources: Record<string, string> = {}, runtime: Record<string, string> = {};
  // Bind every actual repository/runtime byte that could affect CLI/module/native execution.
  function walk(path: string, result: Record<string, string>, runtimeTree: boolean) {
    for (const name of readdirSync(join(root,path)).sort()) {
      if (name === ".git" || name === "dist" && !runtimeTree || name === "node_modules" && !runtimeTree) continue;
      const relative = path ? `${path}/${name}` : name, full = join(root, relative), stat = lstatSync(full);
      if (stat.isSymbolicLink()) result[relative] = "symlink:" + readlinkSync(full);
      else if (stat.isDirectory()) walk(relative,result,runtimeTree);
      else if (stat.isFile()) result[relative] = sha(readFileSync(full));
    }
  }
  walk("",sources,false); walk("node_modules",runtime,true);
  const sdk = JSON.parse(readFileSync(join(root,"node_modules/@anthropic-ai/claude-agent-sdk/package.json"),"utf8"));
  const payload = { mode: "new author-provisional review freeze; no historical freeze identity", dispatchAllowed: false,
    runtime: { bun: Bun.version, bunBinarySHA256: sha(readFileSync(process.execPath)), sdk: sdk.version,
      nativeCLI: "2.1.293 observed in isolated native fixture control; not a live result" }, inputs, sources,
    installedRuntimeFiles: runtime, sourceCount: Object.keys(sources).length, runtimeCount: Object.keys(runtime).length };
  const digest = sha(JSON.stringify(payload));
  writeFileSync(join(output,"manifest.json"),JSON.stringify({ ...payload,digest },null,2)+"\n");
  return { digest, inputHashes: inputs, sourceCount: payload.sourceCount, runtimeCount: payload.runtimeCount, dispatchAllowed: false };
}
if (import.meta.main) { if (!process.argv[2]) throw new Error("fresh owned artifact output required"); console.log(JSON.stringify(prepare(process.argv[2]))); }
