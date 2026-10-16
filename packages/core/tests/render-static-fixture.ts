import { afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, makeTempBrain } from "./cli-harness";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
export function fixture() {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  const dir = join(root, "modules/figures"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@odyssey/figures", type: "module", exports: { "./render": "./render.ts" } }));
  writeFileSync(join(dir, "module.ts"), `export default {name:"figures",setup:()=>({renderers:{figure:{fences:["relay"],client:"@odyssey/figures/ui",static:"@odyssey/figures/render"}}})}`);
  writeFileSync(join(dir, "render.ts"), `export const needsBrowser=false; export async function toStatic(source,{theme}) { if(source.includes("broken")) throw new Error("broken relay"); return '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="'+(theme==="print"?"#ffffff":"#000000")+'"/><text x="10" y="35">Raft ready</text></svg>'; }`);
  writeFileSync(join(root,"brain.config.json"),JSON.stringify({modules:{"./modules/figures":{}}}));
  writeFileSync(join(root,"relay.md"),"```relay\nrelay: homecoming\n```");
  writeFileSync(join(root,"raft.svg"),'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text x="10" y="35">Local raft</text></svg>');
  writeFileSync(join(root,"image.md"),"![Raft](raft.svg)");
  return root;
}
