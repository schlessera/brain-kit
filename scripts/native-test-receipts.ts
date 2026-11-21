/** Test-owned receipt files/descriptors stay separate from protocol stderr. */
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
const KEY="BRAIN_NATIVE_RECEIPT",OWNER=Symbol.for("brain-kit.test.native-receipt-owner");
interface Sink {fd:number;dev:string;ino:string;ownerPid:number;ownerStart:string;ownerFd:number;report:boolean}
interface State {sink?:Sink;directory?:string;offset:number;pending:Buffer}
function start(pid:number):string{return readFileSync(`/proc/${pid}/stat`,"utf8").replace(/^.*\) /s,"").split(" ")[19]!;}
function identity(fd:number){const info=fstatSync(fd,{bigint:true});return {dev:String(info.dev),ino:String(info.ino)};}
function same(sink:Sink):boolean{try{const info=identity(sink.fd);return info.dev===sink.dev&&info.ino===sink.ino;}catch{return false;}}
function verify(value:string):Sink {
 const sink=JSON.parse(value) as Sink;
 if(!Number.isSafeInteger(sink.fd)||sink.fd<0||!Number.isSafeInteger(sink.ownerPid)||!Number.isSafeInteger(sink.ownerFd))throw Error("Native receipt descriptor is unavailable");
 if(same(sink))return sink;
 // Bun's package-script launcher can close inherited extra descriptors.
 // Reopen only the still-live ancestor's exact private append-only file.
 let pid=process.pid,ancestor=false;
 for(let depth=0;pid>1&&depth<64;depth++){
  if(pid===sink.ownerPid){ancestor=true;break;}
  const match=/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`,"utf8"));if(!match)break;pid=Number(match[1]);
 }
 if(!ancestor||start(sink.ownerPid)!==sink.ownerStart)throw Error("Native receipt owner is unavailable");
 const fd=openSync(`/proc/${sink.ownerPid}/fd/${sink.ownerFd}`,constants.O_WRONLY|constants.O_APPEND);
 const reopened={...sink,fd};if(!same(reopened)){closeSync(fd);throw Error("Native receipt descriptor identity changed");}
 return reopened;
}
const inherited=process.env[KEY];delete process.env[KEY];
const globals=globalThis as typeof globalThis&{[key:symbol]:State|undefined};
const state=globals[OWNER]??{sink:inherited?verify(inherited):undefined,offset:0,pending:Buffer.alloc(0)};
if(!globals[OWNER])Object.defineProperty(globalThis,OWNER,{value:state,writable:false,configurable:false});
function createSink(report:boolean):{sink:Sink;directory:string;file:string}{
 const directory=mkdtempSync(join(tmpdir(),"odysseus-native-receipts-")),file=join(directory,"records"),fd=openSync(file,"ax+",0o600);
 return {sink:{fd,...identity(fd),ownerPid:process.pid,ownerStart:start(process.pid),ownerFd:fd,report},directory,file};
}
function owner():Sink {
 if(state.sink)return state.sink;
 const created=createSink(true);state.sink=created.sink;state.directory=created.directory;
 process.once("exit",()=>{try{flushNativeReceipts();}catch{process.exitCode=1;}finally{closeSync(created.sink.fd);rmSync(created.directory,{recursive:true,force:true});}});
 return created.sink;
}
export function flushNativeReceipts():void {
 const sink=state.sink;if(!sink||sink.ownerPid!==process.pid||!sink.report)return;
 if(!same(sink))throw Error("Native receipt owner changed");
 const buffer=Buffer.alloc(65536);let size:number;
 while((size=readSync(sink.fd,buffer,0,buffer.length,state.offset))>0){
  state.offset+=size;state.pending=Buffer.concat([state.pending,buffer.subarray(0,size)]);
  const end=state.pending.lastIndexOf(10);if(end>=0){writeSync(2,state.pending.subarray(0,end+1));state.pending=Buffer.from(state.pending.subarray(end+1));}
  if(state.pending.length>1048576)throw Error("Native receipt exceeded its bound");
 }
}
export function nativeReceipt(value:Record<string,unknown>):void {
 const sink=owner();if(!same(sink))throw Error("Native receipt descriptor identity changed");
 writeSync(sink.fd,JSON.stringify(value)+"\n");flushNativeReceipts();
}
/** Only trusted fixture interpreters inherit this channel, never native/worker payloads. */
export function inheritNativeReceipts(options:Record<string,any>,argv:readonly string[],defaultStderr:string):{options:Record<string,any>&{env:Record<string,string|undefined>};argv:string[]} {
 const sink=options.env?.[KEY]?verify(options.env[KEY]):owner();
 const {stdin,stdout,stderr,...rest}=options;
 const stdio=options.stdio?[...options.stdio]:[stdin??"ignore",stdout??"pipe",stderr??defaultStderr];
 while(stdio.length<3)stdio.push("ignore");
 const fd=stdio.length;stdio.push(sink.fd);
 const token=JSON.stringify({...sink,fd}),command=[...argv];
 if(basename(command[0]??"")==="bwrap"){
  let end=command.indexOf("--");
  for(let at=0;at<(end<0?command.length:end);at++)if(command[at]==="--clearenv"){
   command.splice(at+1,0,"--setenv",KEY,token);if(end>=0)end+=3;at+=3;
  }
 }
 return {options:{...rest,stdio,env:{...(options.env??process.env),[KEY]:token}},argv:command};
}
export function captureNativeReceipts():{env:Record<string,string>;read():string;dispose():void} {
 const {sink,directory,file}=createSink(false);let closed=false;
 return {env:{[KEY]:JSON.stringify(sink)},read(){if(!same(sink))throw Error("Native receipt capture changed");return readFileSync(file,"utf8");},dispose(){if(closed)return;closed=true;closeSync(sink.fd);rmSync(directory,{recursive:true,force:true});}};
}
export function withoutNativeReceipts(options:Record<string,any>):Record<string,any>&{env:Record<string,string|undefined>}{
 const env={...(options.env??process.env)};delete env[KEY];return {...options,env};
}
