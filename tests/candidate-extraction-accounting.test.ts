import { expect, test } from "bun:test";
import { observedClient } from "../scripts/evals/candidate-extraction/jev-observer";
import { input, choices } from "../scripts/evals/candidate-extraction/grading";
import { workload } from "../scripts/evals/candidate-extraction/workload";
import { prepare } from "../scripts/evals/candidate-extraction/prototype";
const p=input(workload[0]), selected=choices(workload[0],p);
function body() {
  return { model:"jev-1.13.0",answers:Object.fromEntries(Object.entries(p.request.questions).map(([field,q])=>{
    if(q.type!=="choice")throw Error("Choice required");const choice=selected[field];
    return[field,{type:"choice",choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,Number(k===choice)]))}];
  })),usage:{input_tokens:456,output_tokens:23} };
}
test("actual nonempty role transport captures raw bytes before normalization and retains output usage",async()=>{
  const raw=JSON.stringify(body());let asked:unknown,result:unknown,failure:unknown;
  const observer=observedClient(async(_url,init)=>{asked=JSON.parse(String(init.body));return new Response(raw);});
  try{result=await observer.judge(p);}catch(error){failure=error;}
  expect(observer.calls[0].responseBytes).toBe(Buffer.from(raw).toString("base64"));
  expect(failure).toBeUndefined();expect(result).toHaveProperty("result.outcome","answered");expect(asked).toEqual(p.request);
  expect(Object.keys(p.request.questions)).toHaveLength(7);expect(observer.calls).toHaveLength(1);
  expect(observer.calls[0].inputTokens).toBe(456);expect(observer.calls[0].outputTokens).toBe(23);
  expect(observer.calls[0].cacheReadTokens).toBeNull();expect(observer.calls[0].cacheWriteTokens).toBeNull();expect(observer.calls[0].actualBilledUsd).toBeNull();
  expect(observer.calls[0].responseEof).toBe(true);expect(observer.calls[0].responseClosed).toBe(true);
});
test.each(["binary-error","missing-usage","wrong-model"])("%s survives interpretation and stops another physical call",async mode=>{
  let dispatched=0;const bytes=mode==="binary-error"?Buffer.from([255,0,128]):Buffer.from(JSON.stringify(mode==="missing-usage"?{...body(),usage:undefined}:{...body(),model:"jev-latest"}));
  const observer=observedClient(async()=>{dispatched++;return new Response(bytes,{status:mode==="binary-error"?500:200});});
  for(let i=0;i<2;i++)await expect(observer.judge(p)).rejects.toThrow("unknown usage/model");
  expect(dispatched).toBe(1);expect(observer.calls).toHaveLength(1);expect(observer.calls[0].responseBytes).toBe(bytes.toString("base64"));
  expect(observer.calls[0].actualBilledUsd).toBeNull();
});
test("overflow never sends an empty question map to even the injected actual transport",async()=>{
  let calls=0;const huge=prepare(Array.from({length:254},(_,i)=>`Event${i} on 2028-01-01`).join("\n"),"cfp");
  expect(huge.overflow).toBe(true);expect(Object.keys(huge.request.questions)).toHaveLength(0);
  const observer=observedClient(async()=>{calls++;return Response.json(body());});
  await expect(observer.judge(huge)).rejects.toThrow("no physical request");expect(calls).toBe(0);
});
