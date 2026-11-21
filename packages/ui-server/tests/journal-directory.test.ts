import {expect,spyOn,test} from "bun:test";
import * as fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {journalDirectory} from "../src/brain/journal-directory.js";

test("journal directory enumeration retains only its bounded native buffer on the installed runtime",()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-directory-bound-")),cursor=journalDirectory(root);
 const names=Array.from({length:1500},(_,n)=>n.toString(16).padStart(64,"0"));
 try {
  for(const name of names)fs.writeFileSync(join(root,name),"");
  const readdir=spyOn(fs,"readdirSync").mockImplementation(()=>{throw Error("eager readdir forbidden");});
  const opendir=spyOn(fs,"opendirSync").mockImplementation(()=>{throw Error("Bun Dir eagerly enumerates");});
  try {
   const first=cursor.next(32);expect(first.names).toHaveLength(32);expect(first.more).toBe(true);
   for(const name of names)fs.unlinkSync(join(root,name));
   const retained:string[]=[];
   for(let n=0;n<100;n++){const next=cursor.next(32);expect(next.names.length).toBeLessThanOrEqual(32);retained.push(...next.names);if(!next.more)break;}
   expect(retained.length,"DIRECTORY_NATIVE_BUFFER_IS_BOUNDED").toBeLessThan(64);
   expect(readdir).not.toHaveBeenCalled();expect(opendir).not.toHaveBeenCalled();
  }finally{opendir.mockRestore();readdir.mockRestore();}
 }finally{cursor.close();fs.rmSync(root,{recursive:true,force:true});}
});
test("bounded directory cursor reaches every name and restarts a completed sweep",()=>{
 const root=fs.mkdtempSync(join(tmpdir(),"odysseus-directory-progress-")),cursor=journalDirectory(root);
 const names=Array.from({length:1500},(_,n)=>n.toString(16).padStart(64,"0"));
 try {
  for(const name of names)fs.writeFileSync(join(root,name),"");
  const found:string[]=[];let more=true;
  for(let n=0;n<100&&more;n++){const next=cursor.next(32);found.push(...next.names);more=next.more;}
  expect(more,"DIRECTORY_CURSOR_REACHES_EOF").toBe(false);
  expect(found.sort(),"DIRECTORY_CURSOR_PRESERVES_ALL_NAMES").toEqual(names);
  expect(cursor.next(32).names).toHaveLength(32);
 }finally{cursor.close();fs.rmSync(root,{recursive:true,force:true});}
});
