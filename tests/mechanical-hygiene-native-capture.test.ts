import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureNative, drainOwned } from "../scripts/evals/mechanical-hygiene/native-capture";

test("real stdout splits Unicode at an acknowledged byte boundary and retains final error receipt after consumer throw",async()=>{
  const root=mkdtempSync("/tmp/hygiene-utf8-");
  const path=join(root,"stdout.jsonl");writeFileSync(path,"");
  const expected={type:"result",subtype:"error_μ",is_error:true};
  const code=`const text=${JSON.stringify(JSON.stringify(expected))};const bytes=Buffer.from(text);const at=bytes.indexOf(0xce);process.stdout.write(bytes.subarray(0,at+1));for await(const chunk of Bun.stdin.stream()){process.stdout.write(bytes.subarray(at+1));break;}`;
  const child=spawn(process.execPath,["-e",code],{stdio:["pipe","pipe","pipe"]});
  const frames:any[]=[];let ended=false, consumerFailed=false;const chunks:Buffer[]=[];
  const capture=captureNative(path,line=>frames.push(JSON.parse(line)),()=>ended=true);
  capture.on("data",chunk=>{
    chunks.push(Buffer.from(chunk));
    if(!consumerFailed){try{throw Error("Controlled SDK consumer throw");}catch{consumerFailed=true;}child.stdin!.end("ack");}
  });child.stdout!.pipe(capture);
  const errors=new Promise<string>(resolve=>{let result="";child.stderr!.on("data",chunk=>result+=String(chunk));child.stderr!.on("end",()=>resolve(result));});
  const close=new Promise<number|null>(resolve=>child.once("close",resolve));
  try{
    expect(await close,await errors).toBe(0);
    expect(chunks[0].at(-1),"actual first native chunk ends inside the Greek codepoint").toBe(0xce);
    expect(consumerFailed).toBe(true);expect(ended).toBe(true);
    expect(frames).toEqual([expected]);expect(readFileSync(path,"utf8")).toBe(JSON.stringify(expected));
  }finally{child.kill("SIGKILL");rmSync(root,{recursive:true,force:true});}
},30000);

test("owned child ignoring termination is force-killed and true stdout close is awaited",async()=>{
  const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);'],{stdio:["pipe","pipe","pipe"]});
  child.stderr!.resume();await new Promise<void>(resolve=>child.stdout!.once("data",()=>resolve()));
  let stdoutEnded=false;child.stdout!.on("end",()=>stdoutEnded=true);
  const close=new Promise<void>(resolve=>child.once("close",()=>resolve()));
  child.kill("SIGTERM");let watchdog=false;
  const timer=setTimeout(()=>{watchdog=true;child.kill("SIGKILL");},500);
  try{
    const result=await drainOwned(child,close,20);
    expect(watchdog,"owned force-kill must finish before the bounded leak watchdog").toBe(false);
    expect(result.forcedKill).toBe(true);expect(stdoutEnded).toBe(true);
  }finally{clearTimeout(timer);child.kill("SIGKILL");await close;}
},30000);
