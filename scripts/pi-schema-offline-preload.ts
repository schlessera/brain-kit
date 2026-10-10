/** Native control, always fake: no provider transport delegates to real fetch. */
process.env.BRAIN_MEASURE_PI_WORKER_OFFLINE = "1";
import { writeFileSync,readFileSync } from "node:fs";
import {plugin} from "bun";
import { createHash } from "node:crypto";
if(process.env.BRAIN_MEASURE_PI_OFFLINE_MUTATION==="replay-history")plugin({name:"offline-replay-history-negative",setup(build){build.onLoad({filter:/\/pi-ai\/dist\/api\/openai-codex-responses\.js$/},({path})=>{const source=readFileSync(path,"utf8"),anchor="            const bodyJson = JSON.stringify(body);";if(source.split(anchor).length!==2)throw new Error("Offline real provider payload anchor drift.");return {contents:source.replace(anchor,'            if(body.input.some(item=>item.type==="function_call_output"))body.input=body.input.filter(item=>item.type!=="function_call"&&item.type!=="function_call_output");\n'+anchor),loader:"js"};});}});
if(process.env.BRAIN_MEASURE_PI_OFFLINE_MUTATION==="preterminal-cancel")plugin({name:"offline-preterminal-consumer-cancel",setup(build){build.onLoad({filter:/\/pi-ai\/dist\/api\/openai-codex-responses\.js$/},({path})=>{const source=readFileSync(path,"utf8"),anchor="        yield event;\n    }\n}\nfunction normalizeCodexStatus";if(source.split(anchor).length!==2)throw new Error("Offline terminal consumer anchor drift.");return {contents:source.replace(anchor,'        if(event.type==="response.created")return;\n'+anchor),loader:"js"};});}});
const {decodePiRequest}=await import("./pi-schema-capture.ts");
const accountId = "fictional-odysseus-account";
const payload = { exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
process.env.BRAIN_MEASURE_CODEX_ACCESS_TOKEN = `offline.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fictional`;
process.env.BRAIN_MEASURE_CODEX_ACCOUNT_ID = accountId;
process.env.BRAIN_MEASURE_CODEX_MODEL = "gpt-6.1-sol"; // fictional credential, exact ruled model identity only
for (const key of ["OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "TYPESAFE_API_KEY"]) delete process.env[key];
const original = globalThis.fetch.bind(globalThis);
let sequence = process.env.BRAIN_MEASURE_PI_REPLAY_ROOT ? 1 : 0;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return original(input, init);
  if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/codex/responses") throw new Error("Offline sentinel denies unexpected egress.");
  const decoded = decodePiRequest(init?.body, new Headers(init?.headers));
  const sent = decoded.body;
  sequence++;
  const mode = process.env.BRAIN_MEASURE_PI_OFFLINE_MUTATION;
  if((mode==="late-eof"||mode==="late-eof-final")&&sequence>1){const prior=JSON.parse(readFileSync(`${process.env.BRAIN_MEASURE_PI_RECEIPTS}/physical-requests.json`,"utf8"))[0];if(!prior.eof||!prior.streamLifecycle?.some((event:any)=>event.event==="natural-upstream-eof"))throw new Error("Actual next provider request preceded prior natural upstream EOF.");}

  const block = { block: { kind: "comparison", columns: [{ label: "Journal entries" }, { label: "Topic notes" }], rows: [{ label: "Use", cells: ["Dated voyage events", "Distilled themes"] }] } };
  const blockSequence = mode === "fixture-tools" ? 3 : mode === "tool-guard" ? 2 : 1;
  let item: any = sequence === blockSequence
    ? { id: "fc_odysseus", type: "function_call", call_id: "call_odysseus", name: "show_block", arguments: JSON.stringify(block) }
    : { id: "msg_odysseus", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Odysseus keeps dated events and distilled themes distinct. ⚓", annotations: [] }] };
  if (mode === "fixture-tools" && sequence < 3) item={id:`fc_fixture_${sequence}`,type:"function_call",call_id:`call_fixture_${sequence}`,name:sequence===1?"brain_list":"brain_read",arguments:JSON.stringify(sequence===1?{limit:3}:{path:"me/identity.md"})};
  if (mode === "tool-guard" && sequence===1) item={id:"fc_denied",type:"function_call",call_id:"call_denied",name:"bash",arguments:JSON.stringify({command:"printf unsafe > forbidden-write.txt"})};
  if (mode === "fixture-tools" && sequence > 1 && !sent.input.some((row:any)=>row.type==="function_call_output"&&typeof row.output==="string"&&row.output.length>10)) throw new Error("Actual fixture tool produced no populated output.");
  const response = { id: `resp_odysseus_${sequence}`, object: "response", created_at: 0, model: sent.model, status: "completed", output: [item], usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } },
    ...(item.type === "function_call" ? [
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
    ] : [
      { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Odysseus keeps dated events and distilled themes distinct. ⚓" },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  if (mode === "model") (events.at(-1)!.response as typeof response).model = "unapproved-model";
  if (mode === "eof") events.pop();
  if (mode === "usage") delete (events.at(-1)!.response as any).usage;
  if (mode === "invalid-block" && sequence === 1) { (item as any).arguments = JSON.stringify({block:{kind:"comparison"}}); for (const event of events) if ("arguments" in event) (event as any).arguments = (item as any).arguments; else if ("delta" in event) (event as any).delta = (item as any).arguments; }
  const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("").trimEnd();
  const headers:Record<string,string>={"content-type":"text/event-stream"};
  if(mode==="media-type-absent")delete headers["content-type"];
  if(mode==="media-type-octet"||mode==="binary-error")headers["content-type"]="application/octet-stream";
  if(["billing-header","billing-event","credit-metadata"].includes(mode??""))Object.assign(headers,{"x-codex-primary-used-percent":mode==="billing-header"?"100":"10","x-codex-credits-has-credits":"true","x-codex-credits-unlimited":"false","x-codex-credits-balance":"100"});
  const finalWire=mode==="not-sse"?JSON.stringify({error:{message:"fictional malformed successful response"}}):mode==="billing-event"?`data: ${JSON.stringify({type:"codex.rate_limits",credits:{has_credits:true,unlimited:false,balance:"90"},rate_limits:{primary:{used_percent:10}}})}\n\n`+wire:wire;
  writeFileSync(`${process.env.BRAIN_MEASURE_PI_RECEIPTS}/sentinel-${sequence}.sse`, finalWire);
  const originalWire = typeof init?.body === "string" ? Buffer.from(init.body) : Buffer.from(init!.body as Uint8Array);
  writeFileSync(`${process.env.BRAIN_MEASURE_PI_RECEIPTS}/sentinel-${sequence}-wire-sha.txt`, createHash("sha256").update(originalWire).digest("hex"));
  const bytes = mode==="binary-error"?new Uint8Array([0xff,0x00,0xc3,0x28,0x4f,0x64,0x79,0x73,0x73,0x65,0x75,0x73]):new TextEncoder().encode(finalWire+(mode==="late-eof"||mode==="late-eof-final"?"\n\n":""));
  if(mode==="binary-error"||mode==="late-eof"||mode==="late-eof-final")writeFileSync(`${process.env.BRAIN_MEASURE_PI_RECEIPTS}/sentinel-${sequence}.sse`,bytes);
  const firstFrameEnd=new TextEncoder().encode(`data: ${JSON.stringify(events[0])}\n\n`).length;
  let at = 0;let cancelled=false;
  return new Response(new ReadableStream({ async pull(controller) { if(mode==="preterminal-cancel"&&at===firstFrameEnd)await Bun.sleep(100);if(cancelled)return;if (at === bytes.length) { if(mode==="late-eof"||mode==="late-eof-final")await Bun.sleep(mode==="late-eof-final"?9500:100);if(!cancelled)controller.close(); return; } controller.enqueue(bytes.slice(at, ++at)); },cancel(){cancelled=true;} }), { headers,status:mode==="binary-error"?503:200 });
}) as typeof fetch;
