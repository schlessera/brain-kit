/** Lossless factoring only. Every case expands to its complete ordered brain files. */
export function factorBrains(cases:Array<{brain:{files:Record<string,string>};[key:string]:any}>){
 const first=cases[0]?.brain.files??{},commonBrainFiles=Object.fromEntries(Object.entries(first).filter(([p,v])=>cases.every(c=>c.brain.files[p]===v)));
 const factoredCases=cases.map(c=>({...c,brain:{...c.brain,files:Object.fromEntries(Object.entries(c.brain.files).filter(([p])=>!Object.hasOwn(commonBrainFiles,p))),fileOrder:Object.keys(c.brain.files)}}));
 return {commonBrainFiles,cases:factoredCases};
}
export function expandBrain(c:any,common:Record<string,string>){
 const {fileOrder,files,...rest}=c.brain;return {...c,brain:{files:Object.fromEntries(fileOrder.map((p:string)=>[p,Object.hasOwn(files,p)?files[p]:common[p]])),...rest}};
}
export function factorNative(proof:any){
 const nativeCheckpointTables:any[]=[],keys:string[]=[];
 const reference=(value:any)=>{const key=JSON.stringify(value),index=keys.indexOf(key);if(index>=0)return index;keys.push(key);nativeCheckpointTables.push(value);return keys.length-1;};
 return {nativeCheckpointTables,nativeProof:{...proof,runs:proof.runs.map((r:any)=>({...r,before:{checkpointTable:reference(r.before)},after:{checkpointTable:reference(r.after)}}))}};
}
export function expandNative(proof:any,tables:any[]){return {...proof,runs:proof.runs.map((r:any)=>({...r,before:tables[r.before.checkpointTable],after:tables[r.after.checkpointTable]}))};}
