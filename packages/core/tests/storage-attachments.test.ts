import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync, symlinkSync, chmodSync, writeSync, renameSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectStorageAttachment, removeStorageAttachment, restoreStorageAttachment } from "../src/lib/storage-attachments";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-attachment-")), path = "attachments/chart.pdf", file = join(root, path), bytes = Buffer.from("%PDF-1.7\nIthaca\0chart\xff", "latin1");
  mkdirSync(join(root, "attachments")); writeFileSync(file, bytes);
  return { root, path, file, bytes, close() { rmSync(root, { recursive: true, force: true }); } };
}
test("exact raw attachment removal and original-byte restoration preserve independent content", async () => {
  const f = fixture();
  try {
    const expected = await inspectStorageAttachment(f.root, f.path);
    await removeStorageAttachment(f.root, f.path, expected);
    expect(existsSync(f.file)).toBe(false);
    restoreStorageAttachment(f.root, f.path, expected, fd => { writeSync(fd, f.bytes); });
    expect(readFileSync(f.file), "STORAGE_UNDO_ORIGINAL_BYTES").toEqual(f.bytes);
  } finally { f.close(); }
});
test("changed attachments and occupied Undo never modify replacements", async () => {
  const f = fixture();
  try {
    const expected = await inspectStorageAttachment(f.root, f.path); writeFileSync(f.file, "replacement");
    await expect(removeStorageAttachment(f.root, f.path, expected), "STORAGE_REMOVE_STALE_FILE").rejects.toThrow("changed");
    expect(() => restoreStorageAttachment(f.root, f.path, expected, fd => { writeSync(fd, f.bytes); }), "STORAGE_UNDO_NEVER_OVERWRITES").toThrow("occupied");
    expect(readFileSync(f.file, "utf8")).toBe("replacement");
  } finally { f.close(); }
});
test("aliases, executable attachments and protected paths remain ineligible", async () => {
  const f = fixture();
  try {
    linkSync(f.file, join(f.root, "attachments", "alias.pdf"));
    await expect(inspectStorageAttachment(f.root, f.path)).rejects.toThrow("protected");
    rmSync(join(f.root, "attachments", "alias.pdf")); chmodSync(f.file, 0o700);
    await expect(inspectStorageAttachment(f.root, f.path)).rejects.toThrow("protected");
    chmodSync(f.file, 0o600); symlinkSync(f.file, join(f.root, "attachments", "link.pdf"));
    await expect(inspectStorageAttachment(f.root, "attachments/link.pdf")).rejects.toThrow();
    for (const path of [".brain/cache.pdf", "workspaces/harbor/chart.pdf", "context/policies/chart.pdf", "../chart.pdf", "attachments/script.ts"])
      await expect(inspectStorageAttachment(f.root, path)).rejects.toThrow("protected");
    expect(readFileSync(f.file)).toEqual(f.bytes);
  } finally { f.close(); }
});


test("same-byte replacements, cancellation and oversized sparse attachments cannot cross the reviewed boundary",async()=>{
  const f=fixture();
  try{
    const expected=await inspectStorageAttachment(f.root,f.path);
    renameSync(join(f.root,"attachments"),join(f.root,"prior-attachments"));mkdirSync(join(f.root,"attachments"));writeFileSync(f.file,f.bytes);
    await expect(removeStorageAttachment(f.root,f.path,expected),"STORAGE_REMOVAL_PARENT_IDENTITY").rejects.toThrow("changed");
    const current=await inspectStorageAttachment(f.root,f.path),controller=new AbortController();controller.abort(Error("cancelled"));
    await expect(removeStorageAttachment(f.root,f.path,current,controller.signal),"STORAGE_REMOVAL_ABORT_BEFORE_EFFECT").rejects.toThrow("cancelled");
    expect(readFileSync(f.file)).toEqual(f.bytes);
    truncateSync(f.file,64*1024*1024+1);
    await expect(inspectStorageAttachment(f.root,f.path),"STORAGE_REMOVAL_FILE_BYTE_CEILING").rejects.toThrow("too_large");
  }finally{f.close();}
});

test("failed Undo copies remove only their own partial inode and preserve a concurrent replacement",async()=>{
  const f=fixture();
  try{
    const expected=await inspectStorageAttachment(f.root,f.path);await removeStorageAttachment(f.root,f.path,expected);
    expect(()=>restoreStorageAttachment(f.root,f.path,expected,fd=>{writeSync(fd,"wrong bytes");}),"STORAGE_UNDO_VERIFIES_COPIED_BYTES").toThrow("changed");
    expect(existsSync(f.file)).toBe(false);
    expect(()=>restoreStorageAttachment(f.root,f.path,expected,fd=>{writeSync(fd,f.bytes);renameSync(f.file,join(f.root,"moved-original.pdf"));writeFileSync(f.file,"Penelope's concurrent replacement");}),"STORAGE_UNDO_REPLACEMENT_DURING_COPY").toThrow("changed");
    expect(readFileSync(f.file,"utf8")).toBe("Penelope's concurrent replacement");
  }finally{f.close();}
});

test("a real same-filesystem nested bind mount remains ineligible",async()=>{
  const f=fixture(),source=join(f.root,"mounted-source");mkdirSync(source);writeFileSync(join(source,"chart.pdf"),f.bytes);
  const entry=join(import.meta.dir,"../src/lib/storage-attachments.ts"),script=`import {inspectStorageAttachment} from ${JSON.stringify(entry)};let refused=false;try{await inspectStorageAttachment(${JSON.stringify(f.root)},${JSON.stringify(f.path)});}catch(error){if(error.reason!=="protected")throw error;refused=true;}if(!refused)throw Error("STORAGE_BIND_MOUNT_MUST_BE_REFUSED");console.log("protected nested mount");`;
  try{
    const child=Bun.spawn(["bwrap","--unshare-user","--unshare-net","--bind","/","/","--bind",source,join(f.root,"attachments"),"--proc","/proc","--dev","/dev",process.execPath,"--config=/dev/null","--no-env-file","-e",script],{stdout:"pipe",stderr:"pipe"});
    const [code,stderr,stdout]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);
    expect(code,stderr).toBe(0);expect(stdout,"STORAGE_BIND_MOUNT_REAL_CONTROL").toContain("protected nested mount");expect(readFileSync(f.file)).toEqual(f.bytes);
  }finally{f.close();}
});
