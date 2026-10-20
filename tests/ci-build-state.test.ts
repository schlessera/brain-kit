import { expect, test } from "bun:test";
import { matchingBuildReceipt, operationFor, sameBuildMaterial, successfulBuildProducer, type BuildMaterial } from "../scripts/ci-build-state";
import { digest } from "../scripts/ci-build-boundary";
function candidate() {
  const session = "00000000-0000-4000-8000-000000000001", key = digest("Odysseus's captured ledger"), output = digest("Ithaca"), receipt = digest("actual receipt bytes fixture");
  const node = { path: "/usr/bin/node", sha256: digest("image-owned Node fixture") }, bun = digest("captured Bun fixture");
  const producer = { version: 1, code: 0, runtime: { bun, node }, topology: "checked-after-child-exit", receipts: [{ value: {kind:"workspace-build",state:"complete",success:true,code:0,packages:[{name:"common",state:"complete",children:[{compiler:"tsc",code:0}]}]}}] };
  const prior = { version:1,purpose:"qualification",domain:session,operation:operationFor("qualification"),session,key,image:"immutable image fixture",drained:true,removed:true,compiled:["common"],outputs:{common:output},producer };
  const stamp = {version:1,purpose:"qualification",domain:session,operation:prior.operation,key,output,producerSession:session,receipt};
  const expected = {purpose:"qualification" as const,domain:session,key,image:prior.image,pkg:"common",node,bun};
  return {prior,stamp,receipt,expected};
}
test("shared necessary validator keeps proof receipts outside production even when copied", () => {
  const c = candidate();
  expect(matchingBuildReceipt(c.stamp,c.prior,c.receipt,c.expected), "fixture exercises necessary predicates only, not policy authority").toBe(true);
  expect(matchingBuildReceipt(c.stamp,c.prior,c.receipt,{...c.expected,purpose:"production"}), "CI_BUILD_PROOF_RECEIPT_CANNOT_AUTHORIZE_PRODUCTION").toBe(false);
  expect(matchingBuildReceipt(c.stamp,c.prior,c.receipt,{...c.expected,domain:"different-owned-session"}), "CI_BUILD_FOREIGN_PROOF_DOMAIN_REFUSED").toBe(false);
});
test("failed, unremoved, wrong-child and altered-input producers refuse necessary reuse", () => {
  for (const mutate of [
    (c:ReturnType<typeof candidate>)=>{c.prior.drained=false;},
    (c:ReturnType<typeof candidate>)=>{c.prior.removed=false;},
    (c:ReturnType<typeof candidate>)=>{c.prior.producer.code=1;},
    (c:ReturnType<typeof candidate>)=>{c.prior.producer.receipts[0]!.value.packages[0]!.children[0]!.code=2;},
    (c:ReturnType<typeof candidate>)=>{c.stamp.key=digest("Pylos");},
    (c:ReturnType<typeof candidate>)=>{c.stamp.receipt=digest("altered receipt");},
  ]) { const c=candidate();mutate(c);expect(matchingBuildReceipt(c.stamp,c.prior,c.receipt,c.expected),"CI_BUILD_INCOMPLETE_OR_DRIFT_REFUSES_REUSE").toBe(false); }
});
test("shared producer validator preserves expected TypeScript and stylesheet children", () => {
  const c=candidate();expect(successfulBuildProducer(c.prior.producer,["common"],c.expected.node,c.expected.bun)).toBe(true);
  c.prior.producer.receipts[0]!.value.packages[0]!.name="ui-react";
  expect(successfulBuildProducer(c.prior.producer,["ui-react"],c.expected.node,c.expected.bun),"CI_BUILD_MISSING_CSS_CHILD_REFUSES_SUCCESS").toBe(false);
});
test("effective producer, installed input and configuration drift refuse the same material", () => {
  const base:BuildMaterial={producer:{"scripts/build.ts":digest("Ithaca")},configuration:{"tsconfig.json":digest("Ithaca config")},installation:digest("toolchain"),bun:digest("Bun")};
  expect(sameBuildMaterial(base,base)).toBe(true);
  for(const changed of [{...base,producer:{"scripts/build.ts":digest("Pylos")}}, {...base,configuration:{"tsconfig.json":digest("new effective alias")}}, {...base,installation:digest("native/compiler drift")}, {...base,bun:digest("other runtime")}]) expect(sameBuildMaterial(changed,base),"CI_BUILD_EFFECTIVE_INPUT_DRIFT_REFUSED").toBe(false);
});
