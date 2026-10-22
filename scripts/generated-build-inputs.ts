/** Exact source binding for freshly compiled browser CSS; never reads dist. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
// These sources establish: tracked source entry, cleaned package dist, locked
// Tailwind CLI, build-before-browser order, checked exits and post-success receipt.
// This deliberately supports one audited producer, not arbitrary build tools.
const auditedProducer: Record<string,string> = {
  "scripts/build.ts": "6e83f426cf6a084e531f7e1aacc6d1574600dedfca890747df33199e2b3c9fd7",
  "scripts/build-execution.ts": "89571c3af89489abe25f2b1113411c128c51a06fcd5f5b948e0899e4f6df8e89",
  "scripts/build-receipt.ts": "b22743a8a943cd63d56519f4551715c4bbf2ff05e17ae8bd65cca2aeed88fa68",
  "scripts/build-repeat-observation.ts": "8c497d87eddbc5682441574674b178960b54352a319228527a62fedff3279047",
  "scripts/bin-modes.ts": "5e412f4743b388558a00d1068881ff6d6a0916e852e9ed2e973bc0a97a83c8ce",
  "scripts/publishable-packages.ts": "c43a3fbea72217fc42c3514313dcb16d1b337242fc251b61d7f1a3c83ca25740",
  "scripts/workspace-lease.mjs": "d1e427171a70f906f219b43ea6e47f69c628e60c126a2bb7ac30ff5e2c9a81ad",
  "scripts/ci-proof.ts": "094977e01d5549bc518a6aa74ef6ba6ee9267d79fcb841f4fd439c84de202931",
  "scripts/check-pr.ts": "44edfa9c7da42c301988fda62e9f2bf9e72eb56d9eedfb2bf1b4c77af9764bd0",
  "scripts/ci-runner.ts": "e6b9da9fdf92cb7ade402c620a8f58727bf5a09725bed03000a862866a6f9262",
  ".github/workflows/ci.yml": "ba93d519013905c8bbd943bf8887733a45911e5309a622f34827f70fdef94427",
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
