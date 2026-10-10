import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync,existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

for(const newline of [true,false])test(`actual observer refuses an ungranted USER before native input, including EOF framing: ${newline}`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"tag-alias-user-boundary-")),receiptPath=join(root,"receipt.json"),observed=join(root,"received-user"),sentinel=join(root,"sentinel.ts"),source=resolve(".");
  writeFileSync(sentinel,`import {writeFileSync} from "node:fs";for await(const chunk of Bun.stdin.stream()){if(new TextDecoder().decode(chunk).includes('"type":"user"'))writeFileSync(${JSON.stringify(observed)},"USER arrived");}process.exit(3);`);
  const child=Bun.spawn([process.execPath,join(source,"scripts/evals/tag-aliases/native-observer.ts"),"--settings","{}"],{cwd:source,env:{PATH:process.env.PATH,BRAIN_TAG_ALIAS_OFFLINE:"1",BRAIN_TAG_ALIAS_SOURCE:source,BRAIN_ROOT:root,BRAIN_TAG_ALIAS_RECEIPT:receiptPath,CLAUDE_CODE_OAUTH_TOKEN:"offline-fixture",BRAIN_TAG_ALIAS_NATIVE_COMMAND:JSON.stringify([process.execPath,sentinel])},stdin:"pipe",stdout:"pipe",stderr:"pipe",signal:AbortSignal.timeout(5000)});
  child.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:"Odysseus fixture"}})+(newline?"\n":""));child.stdin.end();
  try{
    const [code]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(existsSync(observed)).toBe(false);
    const receipt=JSON.parse(readFileSync(receiptPath,"utf8"));expect(receipt.inputFailure).toContain("USER release requires a consumed root native grant");expect(code).toBe(1);expect(receipt.promptReleased).toBe(false);expect(receipt.drained).toBe(true);expect(()=>process.kill(receipt.nativePid,0)).toThrow();
  }finally{child.kill();await child.exited;rmSync(root,{recursive:true,force:true});}
});

test("bounded observer deadline force-closes an unresponsive owned native sentinel with unknown usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-tag-alias-deadline-")), receiptPath = join(root, "receipt.json"), sentinel = join(root, "sentinel.ts");
  writeFileSync(sentinel, `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(9), 10000); process.stdout.write(JSON.stringify({type:"system",subtype:"init",model:"claude-sonnet-5-5",apiKeySource:"none",claude_code_version:"2.1.293"})+"\\n");`);
  const source = resolve("."), child = Bun.spawn([process.execPath, join(source, "scripts/evals/tag-aliases/native-observer.ts"), "--settings", "{}"], {
    cwd: source, env: { PATH: process.env.PATH, BRAIN_TAG_ALIAS_OFFLINE: "1", BRAIN_TAG_ALIAS_OBSERVER_DEADLINE_MS: "100", BRAIN_TAG_ALIAS_SOURCE: source,
      BRAIN_ROOT: root, BRAIN_TAG_ALIAS_RECEIPT: receiptPath, CLAUDE_CODE_OAUTH_TOKEN: "offline-fixture", BRAIN_TAG_ALIAS_NATIVE_COMMAND: JSON.stringify([process.execPath, sentinel]) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5000),
  });
  try {
    const [exitCode] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.failure).toBe("Error: Native observation deadline"); expect(exitCode).toBe(1);
    expect(receipt.finished).toBe(true); expect(receipt.drained).toBe(true); expect(receipt.stdoutComplete).toBe(true);
    expect(receipt.termination).toEqual({ requested: "SIGTERM", forced: true, timedOut: true });
    expect(receipt.exitCode).toBe(137); expect(receipt.signalCode).toBe("SIGKILL");
    expect(receipt.apiEquivalent).toBeNull(); expect(receipt.additionalBilledUsd).toBeNull(); expect(receipt.result).toBeNull();
    expect(() => process.kill(receipt.nativePid, 0)).toThrow();
  } finally {
    child.stdin.end();
    child.kill(); await child.exited;
    const nativePid = JSON.parse(readFileSync(receiptPath, "utf8")).nativePid;
    try { process.kill(nativePid, "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

for (const ignoreTermination of [false, true]) test(`observer refusal records actual native closure and stderr flush: ${ignoreTermination ? "forced" : "graceful"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-tag-alias-native-close-"));
  const receiptPath = join(root, "receipt.json"), sentinel = join(root, "sentinel.ts");
  writeFileSync(sentinel, `process.on("SIGTERM", () => { ${ignoreTermination ? "" : 'setTimeout(() => { process.stderr.write("Odysseus sentinel closed\\n"); process.exit(7); }, 300);'} });
setTimeout(() => process.exit(9), 10000);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "unexpected-fixture-model", apiKeySource: "none", claude_code_version: "2.1.293" }) + "\\n");
`);
  const source = resolve(".");
  const child = Bun.spawn([process.execPath, join(source, "scripts/evals/tag-aliases/native-observer.ts"), "--settings", "{}"], {
    cwd: source, env: { PATH: process.env.PATH, BRAIN_LIVE_EVAL: "844", BRAIN_TAG_ALIAS_SOURCE: source,
      BRAIN_ROOT: root, BRAIN_TAG_ALIAS_RECEIPT: receiptPath, CLAUDE_CODE_OAUTH_TOKEN: "offline-fixture",
      BRAIN_TAG_ALIAS_NATIVE_COMMAND: JSON.stringify([process.execPath, sentinel]) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5000),
  });
  child.stdin.end();
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(exitCode).toBe(1);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.failure).toBe("Error: Actual native model/auth mismatch");
    expect(receipt.drained).toBe(true);
    expect(receipt.finished).toBe(true);
    expect(receipt.stderrDrained).toBe(true);
    expect(receipt.stdoutComplete).toBe(false);
    expect(receipt.termination).toEqual({ requested: "SIGTERM", forced: ignoreTermination, timedOut: false });
    expect(receipt.exitCode).toBe(ignoreTermination ? 137 : 7);
    expect(receipt.signalCode).toBe(ignoreTermination ? "SIGKILL" : null);
    expect(receipt.nativePid).toBeGreaterThan(0);
    expect(() => process.kill(receipt.nativePid, 0)).toThrow();
    expect(readFileSync(`${receiptPath}.stdout.jsonl`, "utf8")).toContain("unexpected-fixture-model");
    if (!ignoreTermination) expect(stderr).toContain("Odysseus sentinel closed");
  } finally {
    child.kill(); await child.exited;
    // A reverted close guard can orphan the controlled sentinel. It is ours.
    const nativePid = JSON.parse(readFileSync(receiptPath, "utf8")).nativePid;
    if (Number.isSafeInteger(nativePid) && nativePid > 0) {
      try { process.kill(nativePid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Owned sentinel cleanup failed", error); }
    }
    rmSync(root, { recursive: true, force: true });
  }
});


test("actual observer inactive-overage receipt preserves unknown invoice instead of inventing zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-tag-alias-billing-")), receiptPath = join(root, "receipt.json"), sentinel = join(root, "sentinel.ts");
  const events = [{ type: "system", subtype: "init", model: "claude-sonnet-5-5", apiKeySource: "none", claude_code_version: "2.1.293" },
    { type: "rate_limit_event", rate_limit_info: { isUsingOverage: false } },
    { type: "result", is_error: false, modelUsage: { "claude-sonnet-5-5": { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }];
  writeFileSync(sentinel, `process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join("\n") + "\n")});`);
  const source = resolve("."), child = Bun.spawn([process.execPath, join(source, "scripts/evals/tag-aliases/native-observer.ts"), "--settings", "{}"], {
    cwd: source, env: { PATH: process.env.PATH, BRAIN_TAG_ALIAS_OFFLINE: "1", BRAIN_TAG_ALIAS_SOURCE: source, BRAIN_ROOT: root,
      BRAIN_TAG_ALIAS_RECEIPT: receiptPath, CLAUDE_CODE_OAUTH_TOKEN: "offline-fixture", BRAIN_TAG_ALIAS_NATIVE_COMMAND: JSON.stringify([process.execPath, sentinel]) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5000),
  }); child.stdin.end();
  try {
    const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(code).toBe(0); expect(receipt.overage).toBe("inactive observed");
    expect(receipt.additionalBilledUsd).toBeNull(); expect(receipt.apiEquivalent.lowerUsd).toBeCloseTo(0.000034, 10);
    expect(receipt.finished).toBe(true); expect(receipt.drained).toBe(true);
  } finally { child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
});
