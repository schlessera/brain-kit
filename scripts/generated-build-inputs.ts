/** Exact source binding for freshly compiled browser CSS; never reads dist. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
// These sources establish: tracked source entry, cleaned package dist, locked
// Tailwind CLI, build-before-browser order, checked exits and post-success receipt.
// This deliberately supports one audited producer, not arbitrary build tools.
const auditedProducer: Record<string,string> = {
  "scripts/build.ts": "025ca01230e8dc9737d96e2d6f31f4d70da7aefb6e53930044ea7a0d2d7df756",
  "scripts/build-receipt.ts": "567c3d13b5e3e1295f597e4f57a9d0d9912685f2669cf3872daa26c2931bd1e6",
  "scripts/bin-modes.ts": "5e412f4743b388558a00d1068881ff6d6a0916e852e9ed2e973bc0a97a83c8ce",
  "scripts/publishable-packages.ts": "c43a3fbea72217fc42c3514313dcb16d1b337242fc251b61d7f1a3c83ca25740",
  "scripts/workspace-lease.mjs": "dc6dc975e6abdb3fb193b368b79544bc98c60c624f0fd9c9985358284bb07df0",
  "scripts/ci-proof.ts": "14eed5d2f28570afc19a546cc405d6f7706405577cec059ceac30132256b6509",
  "scripts/check-pr.ts": "ed29d8dbb2e8b9982b502ad663045992339088dd8db766335b0b7ed2ba2436f6",
  "scripts/ci-runner.ts": "e6b9da9fdf92cb7ade402c620a8f58727bf5a09725bed03000a862866a6f9262",
  ".github/workflows/ci.yml": "0664eae990558d400c8b34b8d1fe9d687ff2b9e82e906ad2480e10bf42d9fc32",
  "package.json": "0d2ba2667eed49f4b686e57e54578d5f51e6c1b93605de0e1f5c8d08f8d0b188"
};
export function generatedCssInputs(root: string, artifact: string): { entry: string; producer: string[] } | undefined {
  const normalized=relative(root,resolve(root,artifact)).replaceAll("\\","/");
  if(isAbsolute(normalized)||normalized.startsWith("../")) return undefined;
  const match=/^packages\/(ui-kit|ui-react)\/dist\/(styles|theme|tokens)\.css$/.exec(normalized);
  if(!match || match[1] === "ui-react" && match[2] === "tokens") return undefined;
  for(const [file,digest] of Object.entries(auditedProducer)) {
    const path=resolve(root,file);
    if(!existsSync(path)||realpathSync(path)!==path||createHash("sha256").update(readFileSync(path)).digest("hex")!==digest) return undefined;
  }
  const entry=`packages/${match[1]}/src/${match[2]}.css`,absolute=resolve(root,entry);
  if(!existsSync(absolute)||realpathSync(absolute)!==absolute) return undefined;
  return {entry,producer:[...Object.keys(auditedProducer),`packages/${match[1]}/package.json`]};
}

// These commands run with the audited browser runner's packages/ui-kit cwd.
const auditedReaders: Record<string,string> = {
  "packages/ui-kit/tests/visual/form-browser.ts": "3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
  "packages/ui-react/tests/browser/offline/cold-capture/commands.ts": "f0d6d9512b1de67f1804d808dded17e29ee344be22283a734e07f3233fc340ee",
  "packages/ui-react/tests/browser/share-review/commands.ts": "a5f25033f06d388d2e0c83446f5cb7340d22626ea9afe1f7b6c3af92cc86f8ad"
};
export function generatedCssReadInputs(root:string,owner:string,literal:string) {
  const expected=auditedReaders[owner],path=resolve(root,owner);
  if(!expected||!existsSync(path)||realpathSync(path)!==path||createHash("sha256").update(readFileSync(path)).digest("hex")!==expected) return undefined;
  return generatedCssInputs(root,resolve(root,"packages/ui-kit",literal));
}
