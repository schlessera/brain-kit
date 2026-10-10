import {test,expect} from "bun:test";
import {factorBrains,expandBrain,factorNative,expandNative} from "../scripts/evals/candidate-extraction/packet";
import {materialize} from "../scripts/evals/candidate-extraction/disk-fixture";
import {workload} from "../scripts/evals/candidate-extraction/workload";
test("every whole brain, binary/context/source and field order reconstruct exactly",()=>{
 const cases=workload.map(c=>({case:c,brain:materialize(c)})),factor=factorBrains(cases);expect(Object.keys(factor.commonBrainFiles).length).toBeGreaterThan(20);
 for(let i=0;i<cases.length;i++){expect(JSON.stringify(expandBrain(factor.cases[i],factor.commonBrainFiles))).toBe(JSON.stringify(cases[i]));expect(expandBrain(factor.cases[i],factor.commonBrainFiles).brain.files["sources/notice.txt"]).toBe(workload[i]!.source);}
 const changed=structuredClone(factor.commonBrainFiles);changed["owner/letter.md"]="changed";expect(JSON.stringify(expandBrain(factor.cases[0],changed))).not.toBe(JSON.stringify(cases[0]));
});
test("complete native checkpoints factor only equal snapshots and retain changed disk bytes",()=>{
 const proof={runs:[{before:{owner:{bytes:"AQ==",mode:420}},after:{owner:{bytes:"AQ==",mode:420}},rawStdoutBase64:"literal"},{before:{owner:{bytes:"AQ==",mode:420}},after:{owner:{bytes:"Ag==",mode:420}},rawStdoutBase64:"error retained"}]};
 const f=factorNative(proof);expect(f.nativeCheckpointTables).toHaveLength(2);expect(JSON.stringify(expandNative(f.nativeProof,f.nativeCheckpointTables))).toBe(JSON.stringify(proof));
});
