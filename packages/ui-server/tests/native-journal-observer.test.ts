import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeJournalObserver, NativeJournalObservationError, type NativeJournalManager } from "../src/brain/native-journal-observer.js";

type Entry = { path: string; ino: number; kind: string; mode: number; size: number; sha256?: string };
const warmStream = Buffer.from("YnRyZnMtc3RyZWFtAAEAAABPAAAAAgDqvW00DwALAHdhcm0tODAwMC0wAQAQANEC0Ek2Vs1Ek6SKUp+teD8CAAgATwAAAAAAAAAUABAASziH678uVkGhaToa8/usdRUACABPAAAAAAAAAAAAAAAVAFBsyZ0=", "base64");
// Runtime namespace fixtures paired with actual qualified native stream bytes.
const cases = [{"name":"directory-cycle-child-changes","stream":"YnRyZnMtc3RyZWFtAAEAAABnAAAAAgBMwB0hDwAjAGRpcmVjdG9yeS1jeWNsZS1jaGlsZC1jaGFuZ2VzLWFmdGVyAQAQAA1iQUAqXw1Csy3heD+9rAYCAAgACAAAAAAAAAAUABAAzHfpd/unDU2ofDYLjsa/jhUACAAHAAAAAAAAABEAAAAJAPR5z/QPAAEAYhAACABvMjYxLTctMAoAAAAJAE0pXhAPAAEAYRAAAQBiFgAAAAkAPpypwA8ABwBiL2NoaWxkEAAHAGIvb3RoZXIWAAAACwBdqV+uDwASAGIvb3RoZXIvZGVsZXRlZC5tZC8AAAAWADDsJkwPABMAYi9vdGhlci9tb2RpZmllZC5tZBIACAAAAAAAAAAAAAQACAAdAAAAAAAAACMAAAARAHvppQAPABMAYi9vdGhlci9tb2RpZmllZC5tZAQACAAdAAAAAAAAAEcAAAAUAKPagL4PABMAYi9vdGhlci9tb2RpZmllZC5tZAsADABkws5qAAAAAIMr2QAKAAwAZMLOagAAAAAeL3ABCQAMAGTCzmoAAAAAHi9wAREAAAAJAIOSaf4PAAgAbzI2MS03LTAQAAEAYTUAAAAUANUuYgIPAAEAYQsADABkws5qAAAAAP3B2gAKAAwAZMLOagAAAAD9wdoACQAMAGTCzmoAAAAA9KskATQAAAAUAAzjXGoPAAAACwAMAGTCzmoAAAAA2Q6HAAoADABkws5qAAAAAPSrJAEJAAwAZMLOagAAAAD0qyQBOwAAABQAcbPbQQ8ABwBiL290aGVyCwAMAGTCzmoAAAAA2Q6HAAoADABkws5qAAAAAPSrJAEJAAwAZMLOagAAAAAeL3ABNQAAABQAxxrkyQ8AAQBiCwAMAGTCzmoAAAAA2Q6HAAoADABkws5qAAAAAB4vcAEJAAwAZMLOagAAAAAeL3ABAAAAABUAUGzJnQ==","before":[{"path":"a","ino":257,"mode":493,"size":10,"kind":"directory"},{"path":"b","ino":261,"mode":493,"size":14,"kind":"directory"},{"path":"a/child","ino":258,"mode":493,"size":42,"kind":"directory"},{"path":"a/child/deleted.md","ino":259,"mode":420,"size":39,"kind":"file","sha256":"39e8b914b7e4d263e734b62a35ecd673fb5d27a1447ee4d384644d4dab2960b2"},{"path":"a/child/modified.md","ino":260,"mode":420,"size":30,"kind":"file","sha256":"f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"},{"path":"b/note.md","ino":262,"mode":420,"size":28,"kind":"file","sha256":"26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"}],"after":[{"path":"a","ino":261,"mode":493,"size":14,"kind":"directory"},{"path":"b","ino":257,"mode":493,"size":10,"kind":"directory"},{"path":"a/note.md","ino":262,"mode":420,"size":28,"kind":"file","sha256":"26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"},{"path":"b/other","ino":258,"mode":493,"size":22,"kind":"directory"},{"path":"b/other/modified.md","ino":260,"mode":420,"size":29,"kind":"file","sha256":"8eb260c92a5278b53d72e3ac8880e6fb8dd413df324fb2eaabd1293939831119"}]},{"name":"synthetic-parent-child-edits","stream":"YnRyZnMtc3RyZWFtAAEAAABmAAAAAgAo4ws2DwAiAHN5bnRoZXRpYy1wYXJlbnQtY2hpbGQtZWRpdHMtYWZ0ZXIBABAAYfZZySBRdkKROKmKwLMd0wIACAAKAAAAAAAAABQAEAAHIBqECQbHQosfOWOwx26FFQAIAAkAAAAAAAAAEQAAAAkAJrEvHQ8AAQBiEAAIAG8yNjEtOS0wCgAAAAkATSleEA8AAQBhEAABAGIdAAAACwC/p5qoDwAZAG8yNjEtOS0wL2Vhcmx5LWRlbGV0ZWQubWQ2AAAAFgDsjkHYDwAaAG8yNjEtOS0wL2Vhcmx5LW1vZGlmaWVkLm1kEgAIAAAAAAAAAAAABAAIADYAAAAAAAAATgAAABQAeEz6OQ8AGgBvMjYxLTktMC9lYXJseS1tb2RpZmllZC5tZAsADABkws5qAAAAAEEELQIKAAwAZMLOagAAAACOxr0CCQAMAGTCzmoAAAAAjsa9AhEAAAAJAHruNw8PAAgAbzI2MS05LTAQAAEAYTUAAAAUAJ57WboPAAEAYQsADABkws5qAAAAAN6ULgIKAAwAZMLOagAAAAAFXm8CCQAMAGTCzmoAAAAABV5vAjQAAAAUANN9t34PAAAACwAMAGTCzmoAAAAAfWkfAgoADABkws5qAAAAAAVebwIJAAwAZMLOagAAAAAFXm8CNQAAABQAqxt7rg8AAQBiCwAMAGTCzmoAAAAAfWkfAgoADABkws5qAAAAAAi7LQIJAAwAZMLOagAAAAAFXm8CAAAAABUAUGzJnQ==","before":[{"path":"a","ino":257,"mode":493,"size":18,"kind":"directory"},{"path":"b","ino":261,"mode":493,"size":84,"kind":"directory"},{"path":"a/stable.md","ino":260,"mode":420,"size":30,"kind":"file","sha256":"f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"},{"path":"b/early-deleted.md","ino":258,"mode":420,"size":46,"kind":"file","sha256":"04cd1ac8380a5637d330cfaac248d806be85ee50b2907d456c7962566c734175"},{"path":"b/early-modified.md","ino":259,"mode":420,"size":44,"kind":"file","sha256":"27f646f05cb1f1e331d4ea6b2734d3f570d68df970f62ad8de2ea168e6956c23"},{"path":"b/stable.md","ino":262,"mode":420,"size":28,"kind":"file","sha256":"26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"}],"after":[{"path":"a","ino":261,"mode":493,"size":52,"kind":"directory"},{"path":"b","ino":257,"mode":493,"size":18,"kind":"directory"},{"path":"a/early-modified.md","ino":259,"mode":420,"size":54,"kind":"file","sha256":"e7b2bc8eb6b4a64ee13e5d8f867dcada3bdfe546ae9cc2800556e9d42227b884"},{"path":"a/stable.md","ino":262,"mode":420,"size":28,"kind":"file","sha256":"26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"},{"path":"b/stable.md","ino":260,"mode":420,"size":30,"kind":"file","sha256":"f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"}]},{"name":"directory-parent-child-reversal","stream":"YnRyZnMtc3RyZWFtAAEAAABpAAAAAgB873fGDwAlAGRpcmVjdG9yeS1wYXJlbnQtY2hpbGQtcmV2ZXJzYWwtYWZ0ZXIBABAA7gXctc71hkGEQxx+q9AB2AIACAAMAAAAAAAAABQAEADzibY+sLllSJgKFSiAugM9FQAIAAsAAAAAAAAAFAAAAAsAgBJ0MA8AEABhL2IvYy9kZWxldGVkLm1kLQAAABYAtQSLaA8AEQBhL2IvYy9tb2RpZmllZC5tZBIACAAAAAAAAAAAAAQACAAcAAAAAAAAACEAAAARAMj5EsAPABEAYS9iL2MvbW9kaWZpZWQubWQEAAgAHAAAAAAAAABFAAAAFAA1xppyDwARAGEvYi9jL21vZGlmaWVkLm1kCwAMAGTCzmoAAAAAkdlRAwoADABkws5qAAAAAOOs4gMJAAwAZMLOagAAAADjrOIDGAAAAAkAXRlqGA8ABwBhL2IvYy9kEAAJAGEvYi9jMi9kMhkAAAAJAGPmHvkPAAUAYS9iL2MQAAwAYS9iL2MyL2QyL2NjOgAAABQAad3+NA8ABgBhL2IvYzILAAwAZMLOagAAAACqOFMDCgAMAGTCzmoAAAAAgI+gAwkADABkws5qAAAAAICPoAM9AAAAFADpC7peDwAJAGEvYi9jMi9kMgsADABkws5qAAAAANWbUgMKAAwAZMLOagAAAACAj6ADCQAMAGTCzmoAAAAAgI+gAzcAAAAUAOJUY9IPAAMAYS9iCwAMAGTCzmoAAAAAMNBEAwoADABkws5qAAAAAICPoAMJAAwAZMLOagAAAACAj6ADQAAAABQAXlIDfA8ADABhL2IvYzIvZDIvY2MLAAwAZMLOagAAAAAw0EQDCgAMAGTCzmoAAAAAgI+gAwkADABkws5qAAAAAICPoAMAAAAAFQBQbMmd","before":[{"path":"a","ino":257,"mode":493,"size":2,"kind":"directory"},{"path":"a/b","ino":258,"mode":493,"size":6,"kind":"directory"},{"path":"a/b/c","ino":259,"mode":493,"size":44,"kind":"directory"},{"path":"a/b/c2","ino":264,"mode":493,"size":0,"kind":"directory"},{"path":"a/b/c/d","ino":262,"mode":493,"size":14,"kind":"directory"},{"path":"a/b/c/deleted.md","ino":260,"mode":420,"size":39,"kind":"file","sha256":"39e8b914b7e4d263e734b62a35ecd673fb5d27a1447ee4d384644d4dab2960b2"},{"path":"a/b/c/modified.md","ino":261,"mode":420,"size":30,"kind":"file","sha256":"f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"},{"path":"a/b/c/d/note.md","ino":263,"mode":420,"size":28,"kind":"file","sha256":"26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"}],"after":[{"path":"a","ino":257,"mode":493,"size":2,"kind":"directory"},{"path":"a/b","ino":258,"mode":493,"size":4,"kind":"directory"},{"path":"a/b/c2","ino":264,"mode":493,"size":4,"kind":"directory"},{"path":"a/b/c2/d2","ino":262,"mode":493,"size":18,"kind":"directory"},{"path":"a/b/c2/d2/cc","ino":259,"mode":493,"size":22,"kind":"directory"},{"path":"a/b/c2/d2/note.md","ino":263,"mode":420,"size":28,"kind":"file","sha256":"26ddc0bb8c569a4394ca3b95048f12cf66652559ed0eea3c80ffeb123b873bb8"},{"path":"a/b/c2/d2/cc/modified.md","ino":261,"mode":420,"size":28,"kind":"file","sha256":"d89592c7e7770d6a5baecafd87f90dcc1ecb08f505abd840e0d2aeb3998ac373"}]},{"name":"preexisting-hardlink-content-update","stream":"YnRyZnMtc3RyZWFtAAEAAABtAAAAAgCU2vcpDwApAHByZWV4aXN0aW5nLWhhcmRsaW5rLWNvbnRlbnQtdXBkYXRlLWFmdGVyAQAQACQg4N+IqvVCsk+N1UvM7ogCAAgADgAAAAAAAAAUABAABVnMXe2GS0+fg0xQzOT+whUACAANAAAAAAAAACwAAAAWAIAUQdsPABAAY29udGVudC9maXJzdC5tZBIACAAAAAAAAAAAAAQACAAmAAAAAAAAAEQAAAAUAHxm+/EPABAAY29udGVudC9maXJzdC5tZAsADABkws5qAAAAAHHxcgQKAAwAZMLOagAAAACGl04FCQAMAGTCzmoAAAAAhpdOBQAAAAAVAFBsyZ0=","before":[{"path":"content","ino":257,"mode":493,"size":16,"kind":"directory"},{"path":"linked","ino":259,"mode":493,"size":8,"kind":"directory"},{"path":"content/first.md","ino":258,"mode":420,"size":30,"kind":"file","sha256":"f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"},{"path":"linked/deep","ino":260,"mode":493,"size":16,"kind":"directory"},{"path":"linked/deep/alias.md","ino":258,"mode":420,"size":30,"kind":"file","sha256":"f06935379ae3660888628f4e08993e5623e74134c37618a84588bdf916949562"}],"after":[{"path":"content","ino":257,"mode":493,"size":16,"kind":"directory"},{"path":"linked","ino":259,"mode":493,"size":8,"kind":"directory"},{"path":"content/first.md","ino":258,"mode":420,"size":38,"kind":"file","sha256":"e663a303fbfb608ba49ad9ff7faaaadceb694f3bdd75587a015f413ede3a45ad"},{"path":"linked/deep","ino":260,"mode":493,"size":16,"kind":"directory"},{"path":"linked/deep/alias.md","ino":258,"mode":420,"size":38,"kind":"file","sha256":"e663a303fbfb608ba49ad9ff7faaaadceb694f3bdd75587a015f413ede3a45ad"}]}];
function rootIdentities(stream: Buffer) {
  const end = 27 + stream.readUInt32LE(17), attrs = new Map<number, Buffer>();
  for (let position = 27; position < end;) {
    const kind = stream.readUInt16LE(position), length = stream.readUInt16LE(position + 2); position += 4;
    attrs.set(kind, stream.subarray(position, position + length)); position += length;
  }
  return {
    before: { uuid: attrs.get(20)!.toString("hex"), transaction: attrs.get(21)!.readBigUInt64LE().toString() },
    after: { uuid: attrs.get(1)!.toString("hex"), transaction: attrs.get(2)!.readBigUInt64LE().toString() },
  };
}
function createTree(root: string, entries: Entry[]) {
  mkdirSync(root);
  const aliases = new Map<number, string>();
  for (const entry of [...entries].sort((a,b) => a.path.length - b.path.length)) {
    const file = join(root, entry.path);
    if (entry.kind === "directory") { mkdirSync(file, { recursive: true }); continue; }
    const alias = aliases.get(entry.ino);
    if (alias) linkSync(alias, file);
    else { writeFileSync(file, (`Odysseus Ithaca 2026-07-12 ${entry.sha256 ?? "notes"}`).padEnd(entry.size, "O").slice(0, entry.size), { mode: entry.mode }); aliases.set(entry.ino, file); }
  }
}
function fixture(stream: Buffer, before: Entry[], after: Entry[]) {
  const root = mkdtempSync(join(tmpdir(), "native-observer-odysseus-")), previous = join(root,"before"), next = join(root,"after");
  createTree(previous,before); createTree(next,after);
  const identities = rootIdentities(stream), live = new Set<string>(), released: string[] = [];
  let number = 0, failCompletion = false, failRelease = false;
  const manager: NativeJournalManager = {
    async checkpoint(id, signal) { signal?.throwIfAborted(); live.add(id); const first = number++ === 0; return { id, path: first ? previous : next, ...(first ? identities.before : identities.after), readOnly: true }; },
    async delta(_from,_to,signal) { signal?.throwIfAborted(); return {stream:new ReadableStream({start(controller){controller.enqueue(stream);controller.close();}}),completed:failCompletion ? Promise.reject(new Error("Odysseus helper failed")) : Promise.resolve({exitCode:0,bytes:stream.length})}; },
    async release(id) { if(failRelease){failRelease=false;throw new Error("Odysseus release uncertain");} live.delete(id);released.push(id);return {}; },
  };
  const observer = createNativeJournalObserver(manager);
  return {root, previous, next, identities, manager, observer, live, released, failCompletion(){failCompletion=true;},failRelease(){failRelease=true;},async close(){await observer.close();rmSync(root,{recursive:true,force:true});}};
}

test("one initial metadata index and no metadata/content walk on warm no-change admission", async () => {
  const entries: Entry[] = [{path:"notes",ino:257,kind:"directory",mode:493,size:0}, ...Array.from({length:2000},(_,i)=>({path:`notes/odysseus-${i}.md`,ino:300+i,kind:"file",mode:420,size:4096}))];
  const f=fixture(warmStream,entries,entries);
  try {
    await f.observer.initialize();expect([...f.observer.entries()]).toHaveLength(2001);
    const before=f.observer.currentRoot(), result=await f.observer.observe();
    expect(result.changes).toEqual([]);
    expect(result.stats,"NATIVE_OBSERVER_WARM_NO_FULL_WALK").toEqual({readEntries:0,walkedDirectories:0});
    expect(f.live.size).toBe(2);expect(f.observer.currentRoot()).toBe(before);
    await result.commit();expect(f.live.size).toBe(1);expect(f.observer.currentRoot()).toBe(result.afterRoot);
    await result.commit();expect(f.released).toHaveLength(1);
  } finally {await f.close();}
});

for(const item of cases) test(`real native stream metadata observer covers ${item.name}`,async()=>{
  const f=fixture(Buffer.from(item.stream,"base64"),item.before,item.after);
  try {
    await f.observer.initialize();const result=await f.observer.observe(), paths=new Set(result.changes.map(change=>change.path));
    const signature=(entry:Entry|undefined)=>entry?.kind==="file"?JSON.stringify([entry.mode,entry.size,entry.sha256]):null;
    for(const path of new Set([...item.before,...item.after].filter(entry=>entry.kind==="file").map(entry=>entry.path))) {
      if(signature(item.before.find(entry=>entry.path===path))!==signature(item.after.find(entry=>entry.path===path))) expect(paths.has(path),`NATIVE_OBSERVER_CHANGED_PATH_COVERED ${item.name} ${path}`).toBe(true);
    }
    if(item.name==="preexisting-hardlink-content-update") {
      expect(paths.has("linked/deep/alias.md"),"NATIVE_OBSERVER_HARDLINK_ALIAS_REQUIRED").toBe(true);
      expect(result.stats.walkedDirectories,"NATIVE_OBSERVER_HARDLINK_NO_SUBTREE_WALK").toBe(0);
      expect(result.stats.readEntries).toBe(2);
    }
    await result.commit();
    expect([...f.observer.entries()].map(entry=>entry.path).sort()).toEqual(item.after.map(entry=>entry.path).sort());
  } finally {await f.close();}
});

test("abort retains prior index/root; overlapping observation and reversed terminal action refuse",async()=>{
  const item=cases[3]!,f=fixture(Buffer.from(item.stream,"base64"),item.before,item.after);
  try {
    await f.observer.initialize();const before=f.observer.currentRoot(),entry=f.observer.get("content/first.md"),result=await f.observer.observe();
    await expect(f.observer.observe()).rejects.toBeInstanceOf(NativeJournalObservationError);
    await result.abort();await result.abort();expect(f.observer.currentRoot()).toBe(before);expect(f.observer.get("content/first.md")).toBe(entry);expect(f.live.size).toBe(1);
    await expect(result.commit()).rejects.toBeInstanceOf(NativeJournalObservationError);
    const retry=await f.observer.observe();await retry.commit();await expect(retry.abort()).rejects.toBeInstanceOf(NativeJournalObservationError);
  }finally{await f.close();}
});

test("helper failure after valid END refuses before root/index advancement",async()=>{
  const f=fixture(warmStream,[],[]);
  try {
    await f.observer.initialize();const before=f.observer.currentRoot();f.failCompletion();
    await expect(f.observer.observe(),"NATIVE_OBSERVER_EXIT_ZERO_REQUIRED").rejects.toThrow("Odysseus helper failed");
    expect(f.observer.currentRoot()).toBe(before);expect(f.live.size).toBe(1);
  }finally{await f.close();}
});

test("directory and root timestamp candidates never request subtree traversal",async()=>{
  const item=cases[0]!,source=Buffer.from(item.stream,"base64"),records:Buffer[]=[source.subarray(0,17)];
  for(let pos=17;pos<source.length;){const end=pos+10+source.readUInt32LE(pos),kind=source.readUInt16LE(pos+4),record=source.subarray(pos,end);pos=end;
    if(kind===2||kind===21){records.push(record);continue;}
    if(kind===20){const pathSize=record.readUInt16LE(12),path=record.subarray(14,14+pathSize).toString();if(["","a","b"].includes(path))records.push(record);}
  }
  const f=fixture(Buffer.concat(records),item.before,item.before);
  try{await f.observer.initialize();const result=await f.observer.observe();expect(result.stats.walkedDirectories,"NATIVE_OBSERVER_TIMESTAMPS_NEVER_EXPAND").toBe(0);expect(result.changes.every(change=>change.before?.kind==="directory"&&change.after?.kind==="directory")).toBe(true);await result.commit();}
  finally{await f.close();}
});

test("failed release remains charged/owned until cleanup retries",async()=>{
  const f=fixture(warmStream,[],[]);
  try {
    await f.observer.initialize();const result=await f.observer.observe();f.failRelease();
    await expect(result.abort()).rejects.toThrow("release uncertain");expect(f.live.size).toBe(2);
    await result.abort();expect(f.live.size).toBe(1);
  }finally{await f.close();}
});

test("cancellation after checkpoint creation releases original id even when reply cannot be used",async()=>{
  const f=fixture(warmStream,[],[]),controller=new AbortController();
  const original=f.manager.checkpoint;
  f.manager.checkpoint=async(id,signal)=>{const result=await original(id,signal);controller.abort(new Error("Odysseus stopped"));return result;};
  try{await expect(f.observer.initialize(controller.signal)).rejects.toThrow("Odysseus stopped");expect(f.live.size,"NATIVE_OBSERVER_CANCEL_RELEASES_CREATED_ROOT").toBe(0);}
  finally{await f.close();}
});

test("symlinks are metadata; descendants are never followed outside the sealed tree",async()=>{
  const f=fixture(warmStream,[],[]);
  symlinkSync("/outside",join(f.previous,"odysseus-link"));
  try{await f.observer.initialize();expect(f.observer.get("odysseus-link")?.target).toBe("/outside");expect(f.observer.get("odysseus-link")?.kind).toBe("symlink");expect([...f.observer.entries()]).toHaveLength(1);}
  finally{await f.close();}
});

test("invalid UTF-8 initial names refuse and release the initial root",async()=>{
  const f=fixture(warmStream,[],[]);
  writeFileSync(Buffer.concat([Buffer.from(f.previous+"/"),Buffer.from([0xff])]),"Odysseus");
  try{await expect(f.observer.initialize()).rejects.toThrow("non-UTF-8");expect(f.live.size).toBe(0);}
  finally{await f.close();}
});
