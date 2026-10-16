import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
for(const volume of ["objects","brain"] as const)test(`a genuinely full ${volume} volume preserves the source or retained Undo original`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"odysseus-removal-space-"));mkdirSync(join(root,volume));
  const entry=join(import.meta.dir,"helpers/storage-removal-fixture.ts");
  const source=`
import {chmodSync,mkdirSync,writeFileSync,readFileSync,openSync,closeSync,writeSync,statfsSync,existsSync} from "node:fs";
import {storageRemovalFixture} from ${JSON.stringify(entry)};
const root=${JSON.stringify(root)},volume=${JSON.stringify(volume)},target=root+"/brain/attachments/chart.pdf";
chmodSync(root+"/"+volume,0o700);mkdirSync(root+"/brain/attachments",{recursive:true});const original=Buffer.from([37,80,68,70,0,255,13,10]);writeFileSync(target,original);
const f=storageRemovalFixture(root);
const full=()=>{const fd=openSync(root+"/"+volume+"/occupied","wx");let refused=false;try{for(let i=0;i<4096;i++)writeSync(fd,Buffer.alloc(4096));}catch(error){if(error.code!=="ENOSPC")throw error;refused=true;}finally{closeSync(fd);}if(!refused||statfsSync(root+"/"+volume).bavail!==0)throw Error("STORAGE_SPACE_CONTROL_NOT_FULL");};
try{
if(volume==="objects")full();
const review=await f.removal.review("odysseus","odysseus-space-0001",["attachments/chart.pdf"]);f.removal.start("odysseus",review.review.id,review.review.fingerprint);await f.removal.idle();
if(volume==="objects"){
if(!readFileSync(target).equals(original))throw Error("STORAGE_ENOSPC_ORIGINAL_MUST_SURVIVE");
if(f.removal.receipt("odysseus",review.review.id).items[0].state!=="failed")throw Error("STORAGE_ENOSPC_MUST_REFUSE");
}else{
if(existsSync(target))throw Error("STORAGE_UNDO_SPACE_CONTROL_NOT_REMOVED");full();
const undo=await f.removal.review("odysseus","odysseus-space-undo",["attachments/chart.pdf"],review.review.id);f.removal.start("odysseus",undo.review.id,undo.review.fingerprint);await f.removal.idle();
if(existsSync(target))throw Error("STORAGE_UNDO_ENOSPC_PARTIAL_MUST_NOT_SURVIVE");
if(!f.removal.receipt("odysseus",review.review.id).items[0].undoAvailable)throw Error("STORAGE_UNDO_ENOSPC_RETAINED_ORIGINAL_MUST_SURVIVE");
}
console.log("STORAGE_REAL_ENOSPC_PRESERVED");
}finally{await f.close();}
`;
  try{
    const child=Bun.spawn(["bwrap","--unshare-user","--unshare-net","--bind","/","/","--size","1048576","--tmpfs",join(root,volume),"--proc","/proc","--dev","/dev",process.execPath,"--config=/dev/null","--no-env-file","-e",source],{stdout:"pipe",stderr:"pipe"});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code,stderr).toBe(0);expect(stdout,"STORAGE_REAL_ENOSPC_PROOF").toContain("STORAGE_REAL_ENOSPC_PRESERVED");
  }finally{rmSync(root,{recursive:true,force:true});}
});
