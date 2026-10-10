/** Native completion observations retain every attempt; never a scalar-only accounting substitute. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionProvider } from "../../../packages/core/src/lib/seams";
import { runNative, assessmentPrompt } from "./native";
export function generator(root: string, output: string, token: string, options: Parameters<typeof runNative>[4]) {
  const attempts: Array<{ number: number; input: unknown; observed: Awaited<ReturnType<typeof runNative>> | null; failure: string | null }> = [];
  const provider: CompletionProvider = { id: "native-claude-sonnet-5-5-report-only", capabilities: { vision: false }, async complete(request) {
    const directory = join(output, `attempt-${attempts.length + 1}`); mkdirSync(directory, { mode: 0o700 });
    const attempt: typeof attempts[number] = { number: attempts.length + 1, input: request, observed: null, failure: null }; attempts.push(attempt);
    try { attempt.observed = await runNative(root, directory, token, `${assessmentPrompt}\nRequested generation fields and full untrusted input:\n${JSON.stringify(request)}`, options); return attempt.observed.receipt.result.result; }
    catch (error) { attempt.failure = String(error); throw error; }
    finally { writeFileSync(join(directory, "generation-attempt.json"), JSON.stringify({ number: attempt.number, input: request, failure: attempt.failure, invoiceUsd: null }, null, 2), { mode: 0o600 }); }
  } };
  return { provider, attempts };
}
