/** Bounded Linux directory cursor. Bun 1.4.4's Dir eagerly reads the whole tree. */
import {createRequire} from "node:module";
import {closeSync,constants,openSync} from "node:fs";
let readEntries:((fd:number,buffer:Buffer)=>number)|undefined;
const DIRECTORY_BYTES=4096;
function getEntries(fd:number,buffer:Buffer):number {
  if(!readEntries){
    const {dlopen,ptr,read}=createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
    const api=dlopen("libc.so.6",{getdents64:{args:["i32","ptr","u32"],returns:"i32"},__errno_location:{args:[],returns:"ptr"}});
    readEntries=(directory,bytes)=>{
      const count=api.symbols.getdents64(directory,ptr(bytes),bytes.length);
      if(count<0)throw Object.assign(Error("Bounded journal directory read failed"),{errno:read.i32(api.symbols.__errno_location()!,0)});
      return count;
    };
  }
  return readEntries(fd,buffer);
}
/** One run reads at most 4 KiB of names from the kernel and returns at most `limit` names.
 * Unconsumed records remain in this fixed buffer; the directory offset is held
 * on its no-follow descriptor. End of sweep closes it, so the next run rescans.
 */
export function journalDirectory(root:string){
  let fd:number|undefined,offset=0,end=0;
  const buffer=Buffer.alloc(DIRECTORY_BYTES);
  const close=()=>{if(fd!==undefined){closeSync(fd);fd=undefined;}offset=end=0;};
  return {
    next(limit:number):{names:string[];more:boolean}{
      fd??=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const names:string[]=[];let budget=DIRECTORY_BYTES;
      while(names.length<limit){
        if(offset===end){
          // Leave room for the largest Linux dirent (255-byte name). A
          // short read may leave enough budget for an EOF probe this pass.
          if(budget<280)break;
          end=getEntries(fd,buffer.subarray(0,budget));offset=0;budget-=end;
          if(!end){close();return {names,more:false};}
        }
        if(offset+19>end)throw Error("Invalid journal directory record");
        const length=buffer.readUInt16LE(offset+16);
        if(length<24||offset+length>end)throw Error("Invalid journal directory record length");
        const zero=buffer.indexOf(0,offset+19);
        if(zero<0||zero>=offset+length)throw Error("Invalid journal directory name");
        const raw=buffer.subarray(offset+19,zero);offset+=length;
        // Only canonical ASCII hashes can be orphan objects. Other names still
        // consume the listing budget, without trusting filesystem text encoding.
        const name=raw.toString("latin1");if(name!=="."&&name!=="..")names.push(name);
      }
      return {names,more:true};
    },close,
  };
}
