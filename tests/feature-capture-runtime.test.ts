import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureSearchFixture } from "../scripts/captures/core-fixture.ts";
import { comparableApproval } from "../scripts/captures/verify.ts";
const root=resolve(import.meta.dir,".."),temporary:string[]=[];
afterEach(async()=>{await Promise.all(temporary.splice(0).map((path)=>rm(path,{recursive:true,force:true})));});

test("actual capture writes dated Markdown and retrieves that same nonempty note via FTS",async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),"odysseus-capture-test-"));temporary.push(directory);
  const evidence=await captureSearchFixture(root,directory) as {add:{path:string;indexed:boolean};markdown:string;search:{results:Array<{path:string;snippet:string}>}};
  expect(evidence.markdown).toContain("Raft supplies: timber, rope and fresh water");
  expect(evidence.markdown).toContain("created: 2026-07-12");
  expect(await readFile(resolve(directory,evidence.add.path),"utf8")).toBe(evidence.markdown);
  expect(evidence.add.indexed).toBe(true);
  const result=evidence.search.results.find((result)=>result.path===evidence.add.path);
  expect(result?.snippet).toContain(">>>supplies<<<");
});

test("reproducibility keeps real approval effects while bounding only a correlated principal nonce",()=>{
  const record=(principal:string)=>({allow:{decision:{principalId:principal,decision:"allow"},effect:{content:"timber"}},deny:{decision:{principalId:principal,decision:"deny"},effect:{content:null}}});
  expect(comparableApproval(record("one"))).toEqual(comparableApproval(record("two")));
  const changed=record("two");changed.allow.effect.content="rope";
  expect(comparableApproval(changed)).not.toEqual(comparableApproval(record("one")));
  const uncorrelated=record("one");uncorrelated.deny.decision.principalId="two";
  expect(()=>comparableApproval(uncorrelated)).toThrow("correlated nonempty principal");
  expect(()=>comparableApproval({allow:{decision:{}},deny:{decision:{}}})).toThrow("correlated nonempty principal");
});
