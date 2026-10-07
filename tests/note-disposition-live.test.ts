import { expect, test } from "bun:test";
import { benchmark, prepareBenchmark, mechanicalProposal, projectFiles, exactFiles, benchmarkSha } from "../scripts/evals/note-disposition/benchmark";
import { Spend, instrumentedCompletion, classificationRequest, classify, observe, summarize, MODELS, protocolSha, hybridProposal, chooseThreshold } from "../scripts/evals/note-disposition/live";
import { parseFrontmatter } from "../packages/core/src/lib/frontmatter-parse";
import { validateProposal } from "../scripts/evals/note-disposition/guard";
test("natural benchmark includes every routed class in tuning, competing targets, metadata and disjoint entities/templates", () => {
    const tuning = benchmark.filter(f => f.split === "tuning"), held = benchmark.filter(f => f.split === "held-out");
    expect(new Set(tuning.map(f => f.expected.action))).toEqual(new Set(["merge", "promote", "keep"]));
    expect(held.length).toBe(20);
    for (const key of ["entity", "template"] as const) {
        const a = new Set(tuning.map(f => f[key]));
        for (const f of held)
            expect(a.has(f[key])).toBe(false);
    }
    expect(held.filter(f => f.targets.length > 1).length).toBeGreaterThan(5);
    expect(benchmarkSha).toHaveLength(64);
    expect(protocolSha).toHaveLength(64);
    for (const f of benchmark) {
        expect(f.sourceRaw).toContain("summary: Original document summary.");
        expect(f.expectedFiles[f.sourcePath]).toBe(f.sourceRaw);
    }
});
test("actual complete-document projection matches independently authored duplicate golden and preserves metadata", () => {
    const f = benchmark.find(f => f.id === "raft-duplicate")!, p = prepareBenchmark(f);
    try {
        const proposal = mechanicalProposal(f);
        expect(proposal.operations).toHaveLength(1);
        expect(validateProposal(proposal, p.env).ok).toBe(true);
        const files = projectFiles(f, proposal);
        expect(exactFiles(files, f.expectedFiles)).toBe(true);
        expect(files[proposal.operations[0]!.path]).toContain("summary: Original document summary.");
    }
    finally {
        p.close();
    }
});
test("full-document golden detects invented prose even when conservative literal-retention guard accepts it", () => {
    const f = benchmark.find(f => f.id === "water-check")!;
    const t = f.targets.find(t => t.id === f.expected.target)!;
    const proposal = { action: "merge", reasoning: "Nonempty projection", operations: [{ op: "update", path: t.path, content: `${t.body}\n${f.source}\nAn invented eighth jar arrived.\n` }] };
    const o = observe(f, proposal);
    expect(o.acceptedWrite).toBe(true);
    expect(o.fullDocumentLoss).toBe(false);
    expect(o.unsupportedEffect).toBe(true);
    expect(o.exactFiles).toBe(false);
    expect(o.files[t.path]).toContain("invented eighth jar");
});
test("physical dispatch is refused before fetch when worst-case request would exceed spend ceiling", async () => {
    let calls = 0;
    const spend = new Spend(0.000001, () => { });
    const provider = instrumentedCompletion(spend, "current", async () => { calls++; return new Response(); }, "fictional-key");
    let failure: unknown;
    try {
        await provider.complete({ prompt: "A nonempty note", maxTokens: 100 });
    }
    catch (error) {
        failure = error;
    }
    expect(calls).toBe(0);
    expect(String(failure)).toContain("Spend ceiling");
    expect(spend.calls).toHaveLength(0);
});
test("physical usage/cache accounting uses response tokens and stops after an unknown usage receipt", async () => {
    const spend = new Spend(1, () => { });
    const provider = instrumentedCompletion(spend, "generation", async () => Response.json({ model: MODELS.current, stop_reason: "end_turn", content: [{ type: "text", text: "Actual response" }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }), "fictional-key");
    expect(await provider.complete({ prompt: "nonempty input" })).toBe("Actual response");
    expect(spend.calls[0]!.completionText).toBe("Actual response");
    expect(spend.calls[0]!.stopReason).toBe("end_turn");
    expect(spend.calls[0]!.priceDerivedCostUsd).toBeCloseTo(0.000506, 8);
    expect(spend.used).toBeCloseTo(0.000506, 8);
    const unknown = instrumentedCompletion(spend, "fallback", async () => Response.json({ model: MODELS.current, stop_reason: "end_turn", content: [{ type: "text", text: "unknown usage" }] }), "fictional-key");
    await unknown.complete({ prompt: "one unknown" });
    expect(spend.uncertain).toBe(true);
    await expect(provider.complete({ prompt: "must not dispatch" })).rejects.toThrow("unknown-usage");
});
test("real JEV transport uses frozen full multi-target state and records each provider retry", async () => {
    const f = benchmark.find(f => f.id === "water-check")!;
    const req = classificationRequest(f);
    expect((req.state as any).targets[1].raw).toBe(f.targets[1]!.raw);
    const spend = new Spend(1, () => { });
    let calls = 0;
    const result = await classify(f, spend, async () => { calls++; if (calls === 1)
        return Response.json({ model: MODELS.classifier, usage: { input_tokens: 100 } }, { status: 429, headers: { "retry-after": "0" } }); return Response.json({ model: MODELS.classifier, usage: { input_tokens: 200 }, answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => { if (q.type !== "choice")
            throw Error("unexpected"); const keys = Object.keys(q.criteria); const choice = k === "disposition" ? "merge" : k === "target" ? "rooms" : "note"; return [k, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }]; })) }); }, "fictional-key");
    expect(result.outcome).toBe("answered");
    expect(calls).toBe(2);
    expect(spend.calls).toHaveLength(2);
    expect(spend.used).toBeCloseTo(300 * 0.042 / 1e6, 10);
});
test("keep classified path makes no generation or fallback call", async () => {
    let generated = 0;
    const f = benchmark.find(f => f.id === "shell-sighting")!;
    const a = (choice: string, keys: string[]) => ({ type: "choice" as const, choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) });
    const result = { model: MODELS.classifier, outcome: "answered" as const, durationMs: 1, answers: { disposition: a("keep", ["keep", "merge", "promote", "complex"]), target: a("none", ["none", ...f.targets.map(t => t.id)]), type: a("note", ["note", "ritual"]) } };
    const provider = { id: "scripted", capabilities: { vision: false }, async complete() { generated++; return "unexpected"; } };
    const h = await hybridProposal(f, result, 0.9, provider, provider);
    expect((h.proposal as any).action).toBe("keep");
    expect(generated).toBe(0);
    expect(h.escalated).toBe(false);
});
test("balanced arm/repetition manifest refuses missing observations despite one row for every fixture", () => {
    const rows = ["current", "deterministic", "hybrid"].flatMap(arm => benchmark.flatMap(f => [0, 1].map(repetition => ({ fixture: f.id, split: f.split, arm, repetition, durationMs: 1, calls: [], stateBytes: 1, accepted: false, correctDisposition: false, correctTarget: false, acceptedWrite: false, exactFiles: false, unsafeAccepted: false, fullDocumentLoss: false, escalated: false }))));
    const missing = rows.filter(r => !(r.arm === "current" && r.fixture === benchmark[0]!.id && r.repetition === 1));
    expect(() => summarize(missing, 2)).toThrow(`current/${benchmark[0]!.id}/1`);
    expect(() => summarize([...rows, rows[0]], 2)).toThrow("Duplicate observation");
});


test("calibration cannot authorize confident incorrect writes when no tuning threshold is safe",()=>{
 const f=benchmark.find(f=>f.id==="raft-duplicate")!;const choice=(selected:string,keys:string[])=>({type:"choice" as const,choice:selected,confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,key===selected?1:0]))});
 const wrong={model:MODELS.classifier,outcome:"answered" as const,durationMs:1,answers:{disposition:choice("merge",["keep","merge","promote","complex"]),target:choice("mast",["none",...f.targets.map(t=>t.id)]),type:choice("note",["note","ritual"])}};
 expect(chooseThreshold([{fixture:f,result:wrong}])).toBeNull();
});


test("uncalibrated classifier routes execute actual current-command fallback without focused generation",async()=>{
 const f=benchmark.find(f=>f.id==="raft-duplicate")!;let generationCalls=0,fallbackCalls=0;
 const generation={id:"unused-generation",capabilities:{vision:false},async complete(){generationCalls++;return "wrong";}};
 const fallback={id:"fixture-current",capabilities:{vision:false},async complete(){fallbackCalls++;return JSON.stringify({action:"keep",reasoning:"Conservative full-completion review",operations:[]});}};
 const h=await hybridProposal(f,{outcome:"bad_response",answers:null,durationMs:1},null,generation,fallback);
 expect(fallbackCalls).toBe(1);expect(generationCalls).toBe(0);expect(h.escalated).toBe(true);expect((h.proposal as any).action).toBe("keep");
});


test("rejected keep-shaped proposals cannot score as exact complete-document successes", () => {
 const f=benchmark.find(f=>f.id==="shell-sighting")!;
 const o=observe(f,{action:"keep",reasoning:"",operations:[]});
 expect(o.accepted).toBe(false);expect(o.exactFiles).toBe(false);
});


test("arm summaries expose unsupported effects separately from correct routing precision", () => {
 const rows=["current","deterministic","hybrid"].flatMap(arm=>benchmark.flatMap(f=>[0,1].map(repetition=>({fixture:f.id,split:f.split,arm,repetition,durationMs:1,calls:[],stateBytes:1,accepted:true,correctDisposition:true,correctTarget:true,acceptedWrite:false,exactFiles:true,unsafeAccepted:false,unsupportedEffect:false,fullDocumentLoss:false,escalated:false}))));
 const row=rows.find(r=>r.arm==="hybrid"&&r.fixture==="water-check"&&r.repetition===0)!;
 Object.assign(row,{acceptedWrite:true,unsupportedEffect:true,exactFiles:false});
 const hybrid=summarize(rows).find(s=>s.arm==="hybrid")!;
 expect(hybrid.unsupportedEffect).toBe(1);expect(hybrid.acceptedRoutePrecision).toBe(1);expect(hybrid.acceptedWritePrecision).toBe(0);
});


test("every arm receives the same full source and candidate bodies", () => {
 for(const f of benchmark){
  expect(parseFrontmatter(f.sourceRaw).content.trimEnd()).toBe(f.source);
  expect(f.expectedFiles[f.sourcePath]).toBe(f.sourceRaw);
  for(const target of f.targets)expect(parseFrontmatter(target.raw).content.trimEnd()).toBe(target.body.trimEnd());
 }
});
test("validated disposition and path-normalised content separate unsafe effects from promotion formatting", () => {
 const f=benchmark.find(f=>f.id==="pen-knot")!;
 const alternate={action:"promote",reasoning:"Recurring routine",operations:[{op:"create",path:"rituals/fence-inspection.md",content:f.source+"\n"}]};
 const o=observe(f,alternate);
 expect(o.accepted).toBe(true);expect(o.exactFiles).toBe(false);expect(o.comparableExactFiles).toBe(true);expect(o.unsupportedEffect).toBe(false);expect(o.formatMismatch).toBe(true);
 const wrong=observe(f,{...alternate,operations:[{...alternate.operations[0],path:"projects/active/fence-inspection.md"}]});
 expect(wrong.correctType).toBe(false);expect(wrong.unsafeAccepted).toBe(true);expect(wrong.unsupportedEffect).toBe(true);
 const merge=benchmark.find(f=>f.id==="water-check")!;
 const malformed=observe(merge,{action:"merge",reasoning:"Wrong operation",operations:[{op:"create",path:merge.targets[0]!.path,content:merge.source+"\n"}]});
 expect(malformed.accepted).toBe(false);expect(malformed.correctDisposition).toBe(false);expect(malformed.rawPredicted).toBe("merge");
});
