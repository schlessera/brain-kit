import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./render-static-fixture";
import { keylessEnv, runCli } from "./cli-harness";
import { inflateSync } from "node:zlib";
const utilityRoots: string[] = [];
afterEach(() => { for (const root of utilityRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Chrome's installed shell wrapper needs these tools; keep ambient commands out. */
function renderEnv(root: string): Record<string, string> {
 const tools = mkdtempSync(join(tmpdir(), "odysseus-render-tools-"));
 utilityRoots.push(tools);
 for (const name of ["readlink", "dirname", "mkdir", "cat"]) {
   const executable = Bun.which(name, { PATH: "/usr/bin:/bin" });
   if (!executable) throw new Error(`Static render fixture requires ${name}`);
   symlinkSync(executable, join(tools, name));
 }
 return { PATH: [keylessEnv(root).PATH, tools].join(delimiter),
   PUPPETEER_EXECUTABLE_PATH: Bun.which("google-chrome-stable") ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/missing-chrome" };
}
function firstPixel(bytes: Buffer): number[] {
 expect(bytes.subarray(1,4).toString()).toBe("PNG");expect(bytes[24]).toBe(8);expect([2,6]).toContain(bytes[25]);
 const chunks: Buffer[]=[];
 for(let offset=8;offset<bytes.length;) {const size=bytes.readUInt32BE(offset);if(bytes.subarray(offset+4,offset+8).toString()==="IDAT") chunks.push(bytes.subarray(offset+8,offset+8+size));offset+=size+12;}
 // The first pixel's left/above predictors are zero for every PNG row filter.
 const row=inflateSync(Buffer.concat(chunks));expect(row[0]).toBeLessThanOrEqual(4);return [...row.subarray(1,4)];
}

test("actual CLI PNG/PDF preserve white print SVG and local SVG reaches PDF", async () => {
 const root=fixture();
 for(const format of ["png","pdf"]) {
   const result=await runCli(root,["render","relay.md","--format",format,"--json"],renderEnv(root));
   expect(result.code, result.stderr).toBe(0);
   const bytes=readFileSync(join(root,`relay.${format}`));
   if(format==="png") {expect(firstPixel(bytes)).toEqual([255,255,255]);}
   else {
     const text=Bun.spawnSync(["pdftotext",join(root,"relay.pdf"),"-"],{stdout:"pipe",stderr:"pipe"});
     expect(text.exitCode).toBe(0);expect(text.stdout.toString()).toContain("Raft ready");
     const raster=Bun.spawnSync(["pdftoppm","-png","-singlefile",join(root,"relay.pdf")],{stdout:"pipe",stderr:"pipe"});
     expect(raster.exitCode).toBe(0);expect(firstPixel(Buffer.from(raster.stdout))).toEqual([255,255,255]);
   }
 }
});

test("local SVG appears as vector text in the actual network-denied PDF", async () => {
 const root=fixture();
 const local=await runCli(root,["render","image.md","--format","pdf","--json"],renderEnv(root));
 expect(local.code,local.stderr).toBe(0);
 const text=Bun.spawnSync(["pdftotext",join(root,"image.pdf"),"-"],{stdout:"pipe",stderr:"pipe"});
 expect(text.exitCode).toBe(0);expect(text.stdout.toString()).toContain("Local raft");
});
