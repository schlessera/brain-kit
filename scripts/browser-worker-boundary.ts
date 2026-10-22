/** Internal test boundary; product Worker behavior is never changed. */
export function installWorkerBoundary(target:object){
  const original=Object.getOwnPropertyDescriptor(target,"Worker");
  if(!original||typeof original.value!=="function")throw new Error("Unsupported browser Worker descriptor");
  const attempts:string[]=[];
  const guarded=new Proxy(original.value,{construct(_constructor,args){
    attempts.push("<unresolved URL>");
    try{attempts[attempts.length-1]=String(args[0]);}catch{/* Even a throwing URL conversion remains an attempt. */}
    throw new Error("Selected browser proof forbids Worker resource loads");
  }});
  const expected={...original,value:guarded};Object.defineProperty(target,"Worker",expected);
  return {
    assert(stage:string){
      const current=Object.getOwnPropertyDescriptor(target,"Worker");
      if(!current||["value","get","set","writable","enumerable","configurable"].some(key=>current[key as keyof PropertyDescriptor]!==expected[key as keyof PropertyDescriptor]))throw new Error(`Browser Worker boundary changed (${stage})`);
      if(attempts.length)throw new Error(`Browser Worker attempt (${stage}): ${attempts.join(", ")}`);
    },
    restore(){Object.defineProperty(target,"Worker",original);},
    count(){return attempts.length;},
  };
}
