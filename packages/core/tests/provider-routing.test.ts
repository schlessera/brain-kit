import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateVecSchema, openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { collectStats } from "../src/lib/stats";
import { createEnrichment } from "../src/lib/enrichment";
import { fakeEmbeddingProvider } from "./vec-fixture";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test("provider policy removes forbidden vectors without losing keyword content or calling an unknown recipient", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-provider-routing-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "me")); mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "me/identity.md"), "---\ntype: note\ntitle: Ithaca identity\n---\nOdysseus keeps a confidential harbourmarker.\n");
  writeFileSync(join(root, "me/image.png"), Buffer.from([0x89,0x50,0x4e,0x47]));
  writeFileSync(join(root, "notes/voyage.md"), "---\ntype: note\ntitle: Voyage\n---\nAthena charts a public crossingmarker.\n");
  const taxonomy = buildTaxonomy({ user: { taxonomy: { types: { note: { dir: "notes" } } } } });
  const db = openDatabase(join(root, "brain.db"), { embeddingDimensions: 16 });
  cleanup.push(() => db.close());
  expect(await migrateVecSchema(db, 16)).toBe(true);
  const provider = fakeEmbeddingProvider();
  provider.id = "gemini:gemini-embedding-2"; // An injected implementation cannot borrow factory authority.
  const recorded: string[] = [], embed = provider.embed;
  provider.embed = async texts => { recorded.push(...texts); return embed(texts); };
  const descriptions: string[] = [];
  const enrichment = createEnrichment({ id: "fixture:unproven-completion", capabilities: { vision: true },
    async complete(request) { descriptions.push(request.prompt); return "Odysseus describes the protected image."; } });
  const options = { root, taxonomy, provider, quiet: true, graph: false };
  await indexAll(db, { ...options, embeddings: true });
  const vectors = (path: string) => (db.query("SELECT count(*) AS n FROM vec_chunks v JOIN chunks c ON c.id=v.chunk_id JOIN documents d ON d.id=c.document_id WHERE d.path=?").get(path) as {n:number}).n;
  expect(vectors("me/identity.md")).toBeGreaterThan(0);
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\nproviders:\n  - paths: [me/**]\n    allow: [anthropic]\n---\n");
  recorded.length = 0;
  // Unchanged-file reconciliation must work even without an embedding pass.
  await indexAll(db, options);
  expect(vectors("me/identity.md"), "PROVIDER_RESTRICTION_DROPS_EXISTING_VECTORS").toBe(0);
  expect(vectors("notes/voyage.md"), "PERMITTED_SIBLING_RETAINS_VECTORS").toBeGreaterThan(0);
  writeFileSync(join(root, "notes/new.md"), "---\ntype: note\ntitle: New crossing\n---\nAthena records a crossingmarker with a new route.\n");
  await indexAll(db, { ...options, enrichment, embeddings: true, force: true });
  expect(descriptions, "EMBEDDING_ROUTE_DOES_NOT_AUTHORIZE_VISION_COMPLETION").toEqual([]);
  const stats = await collectStats(db, { root, dbPath: join(root,"brain.db"), taxonomy, config: {embeddings:{provider}}, embeddingsConfigured: true });
  expect(stats.health.embeddingCoverage, "COVERAGE_EXCLUDES_FORBIDDEN_CHUNKS").toBe(1);
  expect(recorded.some(text => text.includes("harbourmarker")), "UNKNOWN_RECIPIENT_CANNOT_AUTHORIZE_PROTECTED_DATA").toBe(false);
  expect(recorded.some(text => text.includes("crossingmarker"))).toBe(true);
  expect((db.query("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH 'harbourmarker'").get() as {n:number}).n, "KEYWORD_CONTENT_REMAINS").toBe(1);
  writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\nproviders:\n  - types: [note]\n    allow: [anthropic]\n---\n");
  await indexAll(db, options);
  expect(vectors("notes/voyage.md"), "TYPE_SELECTOR_RECONCILES_UNCHANGED_DOCUMENTS").toBe(0);
  writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\nunknown: true\n---\n");
  recorded.length = 0; descriptions.length = 0;
  await indexAll(db, { ...options, enrichment, embeddings: true, force: true });
  expect(recorded, "INVALID_POLICY_WITHHOLDS_EMBEDDING_REQUESTS").toEqual([]);
  expect(descriptions, "INVALID_POLICY_WITHHOLDS_ENRICHMENT_REQUESTS").toEqual([]);
  expect((db.query("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH 'harbourmarker'").get() as {n:number}).n).toBe(1);


});

test("the actual Gemini SDK recipient is resolved from its fixed transport and custom endpoints cannot inherit it", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-provider-recipient-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "me")); mkdirSync(join(root, "context/policies"), {recursive:true});
  writeFileSync(join(root, "me/identity.md"), "---\ntype: note\ntitle: Ithaca\n---\n## Harbour\n" + "Odysseus keeps the harbourmarker safe. ".repeat(120) + "\n## Crossing\n" + "Athena charts the passage. ".repeat(120));
  writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\nproviders:\n  - paths: [me/**]\n    allow: [google]\n---\n");
  const path = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
  const script = `
    import { geminiEmbeddings, geminiEmbeddingRecipient } from ${path("../src/providers/embeddings/gemini.ts")};
    import { openDatabase,migrateVecSchema } from ${path("../src/lib/db.ts")};
    import { indexAll } from ${path("../src/lib/indexer.ts")};
    import { buildTaxonomy } from ${path("../src/lib/taxonomy.ts")};
    import { createEnrichment } from ${path("../src/lib/enrichment.ts")};
    const root=${JSON.stringify(root)}, calls=[];
    globalThis.fetch=async (url,init)=>{calls.push(String(url)); const body=JSON.parse(init.body); return new Response(JSON.stringify({embeddings:(body.requests ?? body.contents ?? []).map(()=>({values:Array(16).fill(0.1)}))}),{headers:{"Content-Type":"application/json"}});};
    const provider=geminiEmbeddings({dimensions:16});
    if(await geminiEmbeddingRecipient(provider)!=="google")throw Error("actual native Google endpoint unknown");
    const db=openDatabase(root+"/brain.db",{embeddingDimensions:16}); await migrateVecSchema(db,16);
    let completions=0;
    const enrichment=createEnrichment({id:"fixture:unknown-completion",capabilities:{vision:false},complete:async()=>{completions++;return "Unknown completion context";}});
    const options={root,taxonomy:buildTaxonomy({}),provider,enrichment,embeddings:true,quiet:true,graph:false};
    await indexAll(db,options);
    if(calls.length!==1||!calls[0].startsWith("https://generativelanguage.googleapis.com/"))throw Error("allowed recipient did not execute actual SDK request");
    if(db.query("SELECT count(*) AS n FROM vec_chunks").get().n<2)throw Error("allowed multi-chunk SDK embeddings were not persisted");
    if(completions)throw Error("allowed embedding identity authorized a separate completion route");
    const originalEmbed=provider.embed;let substituted=0;
    provider.embed=async texts=>{substituted++;return texts.map(()=>new Float32Array(16));};
    await indexAll(db,{...options,force:true});
    if(substituted)throw Error("substituted method borrowed installed factory authority");
    provider.embed=originalEmbed;
    process.env.GOOGLE_GEMINI_BASE_URL="https://proxy.invalid";
    if(await geminiEmbeddingRecipient(provider)!=="google")throw Error("constructed client borrowed later environment");
    const redirected=geminiEmbeddings({dimensions:16});
    calls.length=0; await indexAll(db,{...options,provider:redirected,force:true});
    if(calls.length)throw Error("CUSTOM_ENDPOINT_RECEIVED_PROTECTED_CONTENT");
    if(await geminiEmbeddingRecipient(redirected)!==undefined)throw Error("custom endpoint inherited Google authority");
    const vectors=db.query("SELECT count(*) AS n FROM vec_chunks").get().n;
    if(vectors!==0)throw Error("unproven endpoint retained protected vectors");
    db.close();console.log("ok");
  `;
  const { keylessEnv } = await import("./cli-harness");
  const child = Bun.spawn([process.execPath,"-e",script],{env:{...keylessEnv(root),GEMINI_API_KEY:"fixture-key",GOOGLE_API_KEY:"",GOOGLE_GEMINI_BASE_URL:"",GOOGLE_VERTEX_BASE_URL:"",GOOGLE_GENAI_USE_VERTEXAI:"false",GOOGLE_GENAI_USE_ENTERPRISE:"false"},stdout:"pipe",stderr:"pipe",timeout:15000});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,stderr}).toEqual({code:0,stderr:""});
  expect(stdout.trim()).toBe("ok");
});

test("policy CLI exposes normalized type selectors and a truthful git-history warning", async () => {
  const { runCli } = await import("./cli-harness");
  const root = mkdtempSync(join(tmpdir(), "brain-provider-policy-cli-"));
  cleanup.push(() => rmSync(root, {recursive:true,force:true}));
  mkdirSync(join(root,"context/policies"),{recursive:true});
  writeFileSync(join(root,"context/policies/governance.md"),"---\nschema_version: 1\nproviders: [{types: [private], allow: [anthropic]}]\n---\n");
  const result = await runCli(root,["policy","check","--json"]);
  expect(result.code,result.stderr).toBe(0);
  const checked = JSON.parse(result.stdout);
  expect(checked.effective.providers).toEqual([{paths:[],types:["private"],allow:["anthropic"]}]);
  expect(checked.warnings.join(" ")).toContain("git history");
});
