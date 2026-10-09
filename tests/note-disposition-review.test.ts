import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { priceReview, overageState, captureReviewStdout, reviewEnvironment, unrelatedProviderCredentials } from "../scripts/evals/note-disposition/review";
import { MODELS } from "../scripts/evals/note-disposition/live";
const raw = { type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 999, usage: { cache_creation_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 } }, modelUsage: { [MODELS.current]: { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 400, webSearchRequests: 0, costUSD: 999 } } };
test("official reviewer charge is derived from nonzero raw token/cache usage independently of SDK dollar fallback", () => {
    // 100 input at $2/M, 200 output at $10/M, 300 reads at $0.10/M, 100 5m writes at $2.50/M, 300 1h writes at $4/M.
    expect(priceReview(raw)!.lowerUsd).toBeCloseTo(0.00368, 12);
    expect(priceReview(raw)!.upperUsd).toBeCloseTo(0.00368, 12);
    expect(priceReview({ ...raw, usage: {} })!.lowerUsd).toBeCloseTo(0.00323, 12);
    expect(priceReview({ ...raw, usage: {} })!.upperUsd).toBeCloseTo(0.00383, 12);
    expect(priceReview(null)).toBeNull();
    expect(priceReview({ ...raw, modelUsage: { other: raw.modelUsage[MODELS.current] } })).toBeNull();
    expect(priceReview({ ...raw, modelUsage: { [MODELS.current]: { ...raw.modelUsage[MODELS.current], outputTokens: undefined } } })).toBeNull();
});
test("subscription overage absence is unknown and any positive flag takes precedence over an inactive flag", () => {
    expect(overageState([])).toBe("unknown");
    expect(overageState([{ status: "allowed" }])).toBe("unknown");
    expect(overageState([{ isUsingOverage: false }, { overageInUse: false }])).toBe("reported inactive");
    expect(overageState([{ isUsingOverage: false }, { status: "allowed" }])).toBe("unknown");
    expect(overageState([{ isUsingOverage: false }, { overageInUse: true }])).toBe("active");
});
test("native stdout tee retains an error-result and partial Unicode frame before consumer rejection", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-840-review-stream-"));
    const path = join(root, "stdout.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    const text = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { isUsingOverage: false } }) + "\n" + JSON.stringify({ ...raw, result: "NOT_APPROVED: Ὀδυσσεύς" });
    const frames: any[] = [];
    const capture = captureReviewStdout(path, line => frames.push(JSON.parse(line)));
    const decoder = new TextDecoder();
    let passthrough = "";
    const code = "const b=Buffer.from(process.argv[1]);for(let i=0;i<b.length;i++){process.stdout.write(b.subarray(i,i+1));await new Promise(r=>setTimeout(r,1));}";
    const child = spawn(process.execPath, ["-e", code, text], { cwd: root, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    let split = false;
    child.stdout!.on("data", chunk => { if (chunk[chunk.length - 1] === 0xCE)
        split = true; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
    child.stdout!.pipe(capture);
    try {
        await expect((async () => { for await (const chunk of capture)
            passthrough += decoder.decode(chunk, { stream: true }); passthrough += decoder.decode(); throw Error("SDK consumer refuses error-result after reading stdout"); })()).rejects.toThrow("SDK consumer refuses");
        expect(await exit).toBe(0);
        expect(split).toBe(true);
        expect(frames).toHaveLength(2);
        expect(frames[1].result).toBe("NOT_APPROVED: Ὀδυσσεύς");
        expect(frames[1].subtype).toBe("error_max_budget_usd");
        expect(priceReview(frames[1])!.upperUsd).toBeCloseTo(0.00368, 12);
        expect(readFileSync(path, "utf8")).toBe(text);
        expect(passthrough).toBe(text);
    }
    finally {
        if (child.exitCode === null)
            child.kill("SIGTERM");
        await exit;
        rmSync(root, { recursive: true, force: true });
    }
});
test("review child environment removes unrelated provider credentials while preserving task path and protected OAuth", () => {
    const original = { PATH: "/usr/bin:/bin", TYPESAFE_API_KEY: "fictional-type-key", CLOUDFLARE_API_TOKEN: "fictional-cloud-key", OPENAI_API_KEY: "fictional-openai-key", ANTHROPIC_API_KEY: "fictional-api-key" };
    const isolated = reviewEnvironment(original, "/tmp/fictional-review-home", "fictional-oauth");
    for (const key of unrelatedProviderCredentials)
        expect(isolated[key]).toBe("");
    expect(isolated.ANTHROPIC_API_KEY).toBe("");
    expect(isolated.CLAUDE_CODE_OAUTH_TOKEN).toBe("fictional-oauth");
    expect(isolated.PATH).toBe("/usr/bin:/bin");
    expect(original.OPENAI_API_KEY).toBe("fictional-openai-key");
 expect(isolated.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-5-5");
 expect(isolated.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5-5");
});
