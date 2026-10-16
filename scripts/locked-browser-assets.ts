/** Bounded installed asset identity; matching locked install remains required. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
export interface LockedBrowserAsset { package: string; version: string; asset: string; sha256: string; mode: number; }
const readers: Record<string,string> = {
  "packages/ui-react/tests/browser/offline/cold-capture/commands.ts": "f0d6d9512b1de67f1804d808dded17e29ee344be22283a734e07f3233fc340ee",
  "packages/ui-react/tests/browser/share-review/commands.ts": "a5f25033f06d388d2e0c83446f5cb7340d22626ea9afe1f7b6c3af92cc86f8ad"
};
export function lockedBrowserAsset(root:string,owner:string,literal:string):LockedBrowserAsset|undefined {
  if(literal!=="../../node_modules/axe-core/axe.min.js"||!readers[owner]) return undefined;
  const source=resolve(root,owner);
  if(!existsSync(source)||realpathSync(source)!==source||createHash("sha256").update(readFileSync(source)).digest("hex")!==readers[owner]) return undefined;
  if(!existsSync(join(root,"bun.lock"))||!existsSync(join(root,"package.json"))) return undefined;
  const directory=join(root,"node_modules/axe-core"),asset=join(directory,"axe.min.js"),manifest=join(directory,"package.json");
  if(!existsSync(asset)||!existsSync(manifest)) return undefined;
  const base=realpathSync(directory),real=realpathSync(asset),stat=lstatSync(asset);
  if(!real.startsWith(base+sep)||!stat.isFile()||stat.isSymbolicLink()||lstatSync(manifest).isSymbolicLink()) return undefined;
  const data=JSON.parse(readFileSync(manifest,"utf8"));
  if(data.name!=="axe-core"||typeof data.version!=="string"||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)) return undefined;
  return {package:"axe-core",version:data.version,asset:"axe.min.js",sha256:createHash("sha256").update(readFileSync(asset)).digest("hex"),mode:stat.mode&0o777};
}
