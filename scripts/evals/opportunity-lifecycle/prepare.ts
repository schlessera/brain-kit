/** Export complete new review inputs. Writes only an explicitly fresh output directory; no provider call. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { freshCases, referenceFiles } from "./fresh-corpus";
import { eventSchema } from "./prototype";
import { currentPrompt, protocol } from "./protocol";
import { ownedClosure } from "./closure";

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
  const closure = ownedClosure(root);
  const sources = Object.fromEntries(Object.entries(closure).filter(([path]) => path !== "node_modules" && !path.startsWith("node_modules/")));
  const runtime = Object.fromEntries(Object.entries(closure).filter(([path]) => path === "node_modules" || path.startsWith("node_modules/")));
  const workspaces = readdirSync(join(root,"packages")).sort().filter(name => statSync(join(root,"packages",name)).isDirectory()).map(name => {
    const path = `packages/${name}`;
    if (!closure[`${path}/package.json`]) throw new Error(`workspace manifest absent: ${name}`);
    return { root: path, rootIdentity: closure[path], manifest: closure[`${path}/package.json`] };
  });
  // Re-audited after main introduced the shared internal common package (#1453).
  const reviewedRoots = ["packages/common", "packages/core", "packages/geo", "packages/module-finance", "packages/module-images", "packages/module-jobs", "packages/module-speaking", "packages/module-travel", "packages/module-video", "packages/render-template", "packages/scrape", "packages/ui-backend-claude", "packages/ui-backend-pi", "packages/ui-kit", "packages/ui-react", "packages/ui-render-puppeteer", "packages/ui-sdk", "packages/ui-server"];
  if (JSON.stringify(workspaces.map(workspace => workspace.root)) !== JSON.stringify(reviewedRoots))
    throw new Error("workspace inventory changed; re-audit complete scope");
  const sdk = JSON.parse(readFileSync(join(root,"node_modules/@anthropic-ai/claude-agent-sdk/package.json"),"utf8"));
  const payload = { mode: "new author-provisional review freeze; no historical freeze identity", dispatchAllowed: false,
    runtime: { bun: Bun.version, bunBinarySHA256: sha(readFileSync(process.execPath)), sdk: sdk.version,
      bunBinaryMode: statSync(process.execPath).mode,
      nativeCLI: "2.1.293 observed in isolated native fixture control; not a live result" }, inputs, sources, workspaces,
    closureSemantics: "literal modes/device/inode/mtime/size/content plus owned resolved links and target subtree bytes; copies require new identity freeze; root Git administration excluded",
    installedRuntimeFiles: runtime, sourceCount: Object.keys(sources).length, runtimeCount: Object.keys(runtime).length };
  const digest = sha(JSON.stringify(payload));
  writeFileSync(join(output,"manifest.json"),JSON.stringify({ ...payload,digest },null,2)+"\n");
  return { digest, inputHashes: inputs, sourceCount: payload.sourceCount, runtimeCount: payload.runtimeCount, dispatchAllowed: false };
}
if (import.meta.main) { if (!process.argv[2]) throw new Error("fresh owned artifact output required"); console.log(JSON.stringify(prepare(process.argv[2]))); }
