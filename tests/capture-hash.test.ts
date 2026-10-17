import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { sha256 } from "../scripts/captures/hash";
import { sha256 as provenanceHash } from "../scripts/captures/provenance";
import { readFontLock } from "../scripts/captures/fonts";
import { discoverInputClosure } from "../scripts/browser-input-closure";
const root=resolve(import.meta.dir,"..");
test("font and provenance hash callers retain exact public function and digest bytes",async()=>{
  expect(provenanceHash).toBe(sha256);
  expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const abc="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  expect(sha256("abc")).toBe(abc); expect(provenanceHash(new Uint8Array([97,98,99]))).toBe(abc);
  const result=await readFontLock(root);
  const expected=Buffer.from(await crypto.subtle.digest("SHA-256",await Bun.file(resolve(root,"scripts/captures/font-lock.json")).arrayBuffer())).toString("hex");
  expect(result.hash).toBe(expected); expect(result.css.byteLength).toBeGreaterThan(0);
});
test("font closure owns the pure hash while active provenance callers retain their real inputs",()=>{
  const fonts=discoverInputClosure(root,["scripts/captures/fonts.ts"]);
  expect(fonts.files).toContain("scripts/captures/hash.ts"); expect(fonts.files).not.toContain("scripts/captures/provenance.ts"); expect(fonts.files).not.toContain("scripts/captures/prepare-fonts.ts");
  const provenance=discoverInputClosure(root,["scripts/captures/provenance.ts"]);
  expect(provenance.files).toContain("scripts/captures/hash.ts");
  expect(provenance.unresolved.some(value=>value.includes("execFileSync"))).toBe(true);
  expect(provenance.unresolved.some(value=>value.includes("readFile(next)"))).toBe(true);
});

test("active capture entry still includes every font preparation reader",()=>{
  const capture=discoverInputClosure(root,["scripts/capture.ts"]);
  expect(capture.files).toContain("scripts/captures/prepare-fonts.ts");
  expect(capture.unresolved.some(value=>value.includes("readFile(target)"))).toBe(true);
  expect(capture.files).toContain("scripts/captures/fonts.ts");
});
