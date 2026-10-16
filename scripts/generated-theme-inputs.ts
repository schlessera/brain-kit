/** Source-audited temporary CSS producer with checked process completion. */
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
import {generatedCssInputs} from "./generated-build-inputs";
import {lockedPackageAsset} from "./locked-browser-assets";
const sources={
  "packages/ui-kit/tests/visual/dictation-motion.ts": "426a9ae556c11ea60ab8563c71ee220a3bb7140638b0ef1062aacf1bb3b65e70",
  "packages/ui-kit/vitest.config.ts": "d15a5d28ec9c4e94fedf836a6eeece71c7963b315e1fc8d51d14a6ca0aa519dc",
  "packages/ui-kit/tests/visual/dictation-theme.css": "dfe3bb18ef30797d9d2ded77a675520035bf0eb8b3d82de180fe640bea84c7c6"
};
export function generatedThemeInputs(root:string,files:readonly string[],importers:BrowserImporters){
  const owner="packages/ui-kit/tests/visual/dictation-motion.ts",caller="packages/ui-kit/vitest.config.ts",entry="packages/ui-kit/tests/visual/dictation-theme.css";
  if(!files.includes(owner)||!files.includes(caller)||[...(importers.get(owner)??[])].some(file=>file!==caller))return;
  for(const [file,expected] of Object.entries(sources)){const path=resolve(root,file);if(!existsSync(path)||realpathSync(path)!==path||createHash("sha256").update(readFileSync(path)).digest("hex")!==expected)return;}
  const theme=generatedCssInputs(root,"packages/ui-react/dist/theme.css"),compiler=lockedPackageAsset(root,"@tailwindcss/cli","dist/index.mjs");
  if(!theme||!compiler)return;
  // The exact command body: owns mkdtemp output, uses this locked CLI and
  // constant entry/arguments, awaits execFile success, then reads and cleans it.
  // Only the precise promisify/createRequire uses below may cross alias checks.
  return {owner,read:'readFile(output, "utf8")',css:[entry,theme.entry],bytes:theme.producer,compiler,
    aliases:new Map([["execFile",new Set(["promisify(execFile)"])],["require",new Set(['require = createRequire(import.meta.url)','require.resolve("@tailwindcss/cli/package.json")'])]])};
}
