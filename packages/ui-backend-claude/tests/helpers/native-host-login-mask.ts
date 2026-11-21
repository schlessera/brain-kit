/** Inspect the product's original argv, before the test guard changes its view. */
export function workerPlanMasksHostLogin(argv:readonly string[],path:string):boolean {
 let payload=argv;
 if(argv.length===6&&argv[1]==="-I"&&argv[2]==="-S"&&argv[3]==="-c"){
  try{const config=JSON.parse(argv[5]!);if(!Array.isArray(config.argv))return false;payload=config.argv;}catch{return false;}
 }
 return payload.some((arg,index)=>arg==="--ro-bind"&&payload[index+1]==="/dev/null"&&payload[index+2]===path);
}
