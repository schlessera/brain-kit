/** Source/runtime/proof-bound execution identity; reading this module sends nothing. */
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixtureSha, protocolSha, sourceHashes } from "./protocol";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import type { RuntimeIdentity } from "./review-evidence";
export const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function sourceBinding(promptSha: string, proofSha: string) {
  const source = new URL("../../../", import.meta.url).pathname;
  for (const [path, hash] of Object.entries(sourceHashes)) if (sha(readFileSync(join(source, path.replace(/^\.\.\/\.\.\/\.\.\//, "")))) !== hash) throw Error("Source changed after exact freeze");
  const native = bundledClaudeBinary(); if (!native) throw Error("Installed native absent");
  const sdk = JSON.parse(readFileSync(join(source, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(source, "node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"), "utf8"));
  const hash = sha(readFileSync(native)), entry = manifest.platforms?.[`${process.platform}-${process.arch}`];
  if (sdk.version !== "0.3.283" || manifest.version !== "2.1.283" || entry?.checksum !== hash || entry?.size !== lstatSync(native).size || Bun.version !== "1.4.2") throw Error("Frozen283/Bun runtime identity refused");
  const runtime: RuntimeIdentity = { sdk: sdk.version, nativeSha: hash, nativeMode: lstatSync(native).mode & 0o7777,
    bunSha: sha(readFileSync(process.execPath)), bunVersion: Bun.version, bunMode: lstatSync(process.execPath).mode & 0o7777 };
  return { binding: { fixtureSha, protocolSha, sourceFreezeSha: sha(JSON.stringify(sourceHashes)), runtimeSha: sha(JSON.stringify(runtime)), promptSha, proofSha }, runtime };
}
