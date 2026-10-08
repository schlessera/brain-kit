/** Exact private source/runtime binding, checked again before physical forwarding. */
import { readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundledClaudeBinary } from "../../../../core/src/providers/agents/claude-binary";
import { ownedClosure } from "./closure";
import { protocol } from "./protocol";
import { sha } from "./adapter";
import { type RuntimeIdentity } from "./review-evidence";
import { semanticSourcePaths, semanticSources, currentRequestSets, reviewPrompt } from "./prepare";
import { type ReviewBinding } from "./paid-policy";
import { CORPUS,CORPUS_CONTEXT } from "./corpus";
import { LABEL_PANEL,labelRequests } from "./label-panel";
export const ROOT = resolve(import.meta.dir, "../../../../..");
export function runtimeIdentity(): RuntimeIdentity {
  const binary = bundledClaudeBinary(); if (!binary) throw Error("Bundled native runtime absent");
  const sdk = JSON.parse(readFileSync(join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;
  if (sdk !== "0.3.293" || Bun.version !== "1.4.2") throw Error("Exact pinned review runtime required");
  return { sdk, nativeSha: sha(readFileSync(binary)), nativeMode: lstatSync(binary).mode & 0o7777,
    bunSha: sha(readFileSync(process.execPath)), bunVersion: Bun.version, bunMode: lstatSync(process.execPath).mode & 0o7777 };
}
export function frozenBinding(sidecar: string) {
  const manifest = JSON.parse(readFileSync(join(sidecar, "manifest.json"), "utf8")), input = JSON.parse(readFileSync(join(sidecar, "input.json"), "utf8"));
  const proofBytes = readFileSync(join(sidecar,"verification.json"),"utf8"), proof = JSON.parse(proofBytes);
  const prompt = readFileSync(join(sidecar, "review-prompt.txt"), "utf8"), runtime = runtimeIdentity();
  const binding: ReviewBinding = { freezeSha: sha(JSON.stringify(manifest)), inputSha: sha(JSON.stringify(input)), protocolSha: sha(JSON.stringify(protocol)),
    runtimeSha: sha(JSON.stringify(runtime)), proofSha: input.verificationSha, promptSha: sha(prompt) };
  function verify() {
    const rubric=readFileSync(join(ROOT,"packages/ui-server/evals/triage/prompt.txt"),"utf8");
    const literalInput={verification:proof,verificationSha:sha(proofBytes),protocol,labelPanel:{config:LABEL_PANEL,rubric,blindRequests:labelRequests(CORPUS)},context:CORPUS_CONTEXT,corpus:CORPUS,rubric,requests:currentRequestSets(rubric),sourceHashes:Object.fromEntries(Object.entries(semanticSources(ROOT)).map(([p,v])=>[p,v.sha256]))};
    if(JSON.stringify(input)!==JSON.stringify(literalInput) || prompt!==reviewPrompt(binding.freezeSha,binding.inputSha,input,semanticSources(ROOT))) throw Error("Literal complete semantic input/prompt changed");
    if (manifest.issue !== 848 || manifest.inputSha !== binding.inputSha || JSON.stringify(input.protocol) !== JSON.stringify(protocol) ||
      sha(proofBytes)!==input.verificationSha || sha(readFileSync(join(sidecar,"verification.json")))!==binding.proofSha || JSON.stringify(proof)!==JSON.stringify(input.verification) ||
      [proof.testsExit,proof.typecheckExit,proof.lintExit,proof.diffCheckExit,proof.nativeExit,proof.panelExit].some(exit=>exit!==0) ||
      semanticSourcePaths(ROOT).some(path=>sha(readFileSync(join(ROOT,path)))!==input.sourceHashes?.[path] || input.sourceHashes[path]!==proof.sourceHashes?.[path]) ||
      JSON.stringify(ownedClosure(ROOT)) !== JSON.stringify(manifest.ownedClosure) || JSON.stringify(runtimeIdentity()) !== JSON.stringify(runtime) ||
      sha(readFileSync(join(sidecar, "review-prompt.txt"))) !== binding.promptSha ||
      sha(JSON.stringify(JSON.parse(readFileSync(join(sidecar, "manifest.json"), "utf8")))) !== binding.freezeSha ||
      sha(JSON.stringify(JSON.parse(readFileSync(join(sidecar, "input.json"), "utf8")))) !== binding.inputSha) throw Error("Current source/runtime/proof/prompt freeze changed");
  }
  verify(); return { binding, runtime, prompt, input, verify };
}
