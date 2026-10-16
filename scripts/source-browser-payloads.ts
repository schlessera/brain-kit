/** Two audited literal payloads contain no scripts, resource URLs, imports or external bytes. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
// Literal SVG rectangle and black/white pixel probe. Exact owner and call
// identities preserve the actual Playwright sink and lexical receiver binding.
// Other HTML (including interpolated fixture payloads) remains unresolved.
const literals:Record<string,{source:string;expression:string}> = {
  "packages/ui-kit/tests/visual/form-browser.ts": {
    "source": "3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
    "expression": "route.fulfill({ status: 200, contentType: \"image/svg+xml\", body: '<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"60\"><rect width=\"100\" height=\"60\" fill=\"teal\"/></svg>' })"
  },
  "packages/ui-kit/tests/visual/ghost-browser.ts": {
    "source": "004c45bd7261997efccc74623ee2f67db4fc832b99039bc2f49cea81e75fb799",
    "expression": "page.setContent('<div id=\"probe\" style=\"height:20px;background:black\"><div style=\"width:100%;height:100%;background:white\"></div></div>')"
  }
};
export function sourceBrowserPayload(root:string,owner:string,expression:string):boolean {
  const declaration=literals[owner];if(!declaration||declaration.expression!==expression) return false;
  const path=resolve(root,owner);
  return existsSync(path)&&realpathSync(path)===path&&createHash("sha256").update(readFileSync(path)).digest("hex")===declaration.source;
}
