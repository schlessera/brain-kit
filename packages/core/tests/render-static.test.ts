import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runCli, makeTempBrain, cleanup } from "./cli-harness";
import { fixture } from "./render-static-fixture";
test("configured static fence reaches CLI HTML in print theme",async()=>{
 const root=fixture(); const result=await runCli(root,["render","relay.md","--format","html","--json"]);
 expect(result.code).toBe(0); const html=readFileSync(join(root,"relay.html"),"utf8");
 expect(html).toContain('<rect width="240" height="80" fill="#ffffff"/>'); expect(html).not.toContain("language-relay");
 expect(JSON.parse(result.stdout).warnings).toEqual([]);
});
test("throwing static entry reports a fence diagnostic and retains code",async()=>{
 const root=fixture();writeFileSync(join(root,"relay.md"),"```relay\nbroken\n```");
 const result=await runCli(root,["render","relay.md","--format","html","--json"]);expect(result.code).toBe(0);
 expect(readFileSync(join(root,"relay.html"),"utf8")).toContain("language-relay");
 expect(JSON.parse(result.stdout).warnings[0]).toContain("Fence 1 (relay)");
});
test("local SVG embeds before remote-image substitution",async()=>{
 const root=fixture();const result=await runCli(root,["render","image.md","--format","html","--json"]);expect(result.code).toBe(0);
 expect(readFileSync(join(root,"image.html"),"utf8")).toContain("data:image/svg+xml;base64,");
 expect(JSON.parse(result.stdout).warnings).toEqual([]);
});

test("malformed local SVG URI remains a placeholder without aborting",async()=>{
 const root=fixture();writeFileSync(join(root,"image.md"),"![Raft](bad%xx.svg)");
 const result=await runCli(root,["render","image.md","--format","html","--json"]);expect(result.code).toBe(0);expect(JSON.parse(result.stdout).warnings[0]).toContain("not embedded");
});

test("local SVG refuses escaping links and resource-bearing content", async () => {
 const root=fixture(), outside=makeTempBrain({empty:true});
 try {
  writeFileSync(join(outside,"outside.svg"),'<svg><text>Outside must not embed</text></svg>');symlinkSync(join(outside,"outside.svg"),join(root,"escape.svg"));
  writeFileSync(join(root,"unsafe.svg"),'<svg><script>alert(1)</script></svg>');
  for(const path of ["escape.svg","unsafe.svg"]) {
   writeFileSync(join(root,"image.md"),`![Raft](${path})`);
   const result=await runCli(root,["render","image.md","--format","html","--json"]);expect(result.code).toBe(0);
   const html=readFileSync(join(root,"image.html"),"utf8");expect(html).not.toContain("data:image/svg+xml;base64,");expect(JSON.parse(result.stdout).warnings[0]).toContain("not embedded");
  }
 } finally {cleanup(outside);}
});
