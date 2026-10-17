import {expect,test} from "bun:test";
import {installWorkerBoundary} from "../scripts/browser-worker-boundary";
test("caught Worker attempts remain failures and original descriptors restore completely",()=>{
  let launched=false;class Worker {constructor(_url:string){launched=true;}}
  const original={value:Worker,writable:true,configurable:true,enumerable:false},target={};Object.defineProperty(target,"Worker",original);
  const boundary=installWorkerBoundary(target);expect(()=>boundary.assert("initial")).not.toThrow();
  try{new (target as {Worker:typeof Worker}).Worker("http://127.0.0.1/odysseus-worker.js");}catch{/* Product fallback may catch construction errors. */}
  expect(launched).toBe(false);expect(boundary.count()).toBe(1);expect(()=>boundary.assert("after cleanup")).toThrow("Browser Worker attempt (after cleanup): http://127.0.0.1/odysseus-worker.js");
  boundary.restore();expect(Object.getOwnPropertyDescriptor(target,"Worker")).toEqual(original);
});
test("descriptor replacement and hostile URL conversion cannot hide boundary failures",()=>{
  const target={Worker:class{}};const boundary=installWorkerBoundary(target);
  try{new (target as {Worker:new(url:unknown)=>unknown}).Worker({toString(){throw new Error("coercion");}});}catch{}
  expect(boundary.count()).toBe(1);expect(()=>boundary.assert("test")).toThrow("<unresolved URL>");
  target.Worker=class{};expect(()=>boundary.assert("test")).toThrow("Browser Worker boundary changed");boundary.restore();
  expect(()=>installWorkerBoundary({})).toThrow("Unsupported browser Worker descriptor");
});
