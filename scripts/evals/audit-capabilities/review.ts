// Fresh complementary Claude-family input review; root schedules the shared subscription window.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { captureReviewStdout, priceReview, overageState, reviewEnvironment, unrelatedProviderCredentials } from "../note-disposition/review";
import { CLEARED_API_CREDENTIALS, NEUTRALISED_SETTINGS, subscriptionVerdict, settingsRefusal, credentialFields } from "../../../packages/ui-backend-claude/src/subscription";
import { runtimeFreeze, assertNative, repo, sha } from "./freeze";
import { MODEL } from "./protocol";
import { buildReviewPacket } from "./review-packets";
import { drainReviewChild } from "./review-drain";
const MODELS = { current: MODEL };
export async function* protectedReviewPrompt(handle: Promise<any>, payload: string, receipt: any, save: () => void, controller: AbortController) {
    const cli: any = await handle;
    const init = await cli.initializationResult();
    const account = init.account;
    const verdict = subscriptionVerdict(account);
    const settings = typeof cli.getSettings === "function" ? await cli.getSettings() : undefined;
    const conflict = settingsRefusal(settings);
    receipt.credentials = credentialFields(account); save();
    if (!verdict.ok || conflict) {
        controller.abort();
        throw Error("Subscription-only handshake refused: " + (!verdict.ok ? verdict.reason : conflict));
    }
    receipt.promptReleased = true; save();
    yield { type: "user" as const, parent_tool_use_id: null, message: { role: "user" as const, content: payload }, session_id: "" };
}

async function main() {
    if (process.env.BRAIN_LIVE_REVIEW !== "841")
        throw Error("Only the explicitly queued #841 review may dispatch");
    const destination = process.argv[2];
    if (!destination || existsSync(destination))
        throw Error("Require a fresh protected output directory");
    const reservation = Number(process.env.BRAIN_REVIEW_RESERVATION_USD);
    if (!Number.isFinite(reservation) || reservation < 1)
        throw Error("Require the root's checked $1 review reservation before dispatch");
    mkdirSync(destination, { mode: 0o700 });
    const reviewHome = join(destination, "isolated-home");
    mkdirSync(reviewHome, { mode: 0o700 });
    // Read the existing login only into this subprocess's memory; do not copy credential files or print secrets.
    const hostLogin = join(process.env.HOME!, ".claude/.credentials.json");
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? JSON.parse(readFileSync(hostLogin, "utf8"))?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || !token.trim())
        throw Error("No protected subscription token available");
    const root = repo;
    const frozen = runtimeFreeze();
    const freezeSha = frozen.freezeSha;
    const benchmarkSha = frozen.benchmarkSha;
    const protocolSha = sha(JSON.stringify(frozen.protocol));
    const detectedPath = process.argv[4];
    if (!detectedPath) throw Error("Require independently reviewable actual detected inputs");
    const detectedRaw = readFileSync(detectedPath, "utf8");
    const detectedSha = sha(detectedRaw);
    const proofPath = process.argv[3];
    if (!proofPath) throw Error("Require actual current keyless verification receipt before review");
    const proofRaw = readFileSync(proofPath, "utf8");
    const proof = JSON.parse(proofRaw);
    if (proof.freezeSha !== freezeSha || proof.detectedSha !== detectedSha || proof.testsExitCode !== 0 || proof.typecheckExitCode !== 0 || proof.lintExitCode !== 0 || proof.leakageGate !== "clean") throw Error("Verification receipt does not cover this freeze");
    const built = buildReviewPacket(frozen, detectedRaw, proofRaw, process.argv[5] ?? "");
    const payload = built.payload;
    const packet = built.packet;
    const reviewPlanSha = built.reviewPlanSha;
    const rawPath = join(destination, "native-stdout.jsonl");
    writeFileSync(rawPath, "", { mode: 0o600 });
    const receipt: any = { model: MODELS.current, freezeSha, detectedSha, benchmarkSha, protocolSha, packet, reviewPlanSha, promptBytes: built.bytes, helperModelPins: { ANTHROPIC_DEFAULT_HAIKU_MODEL: MODELS.current, ANTHROPIC_SMALL_FAST_MODEL: MODELS.current }, promptSha: createHash("sha256").update(payload).digest("hex"), verificationSha: createHash("sha256").update(proofRaw).digest("hex"), reservationUsd: reservation, protectiveSdkApiEquivalentThresholdUsd: 3, protectiveThresholdIsActualChargeCap: false, capBasis: "actual additional billed charges; API-price equivalents are separate diagnostics", runtime: Bun.version, reviewDriverSha: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"), promptReleased: false, rateLimits: [], result: null, apiEquivalent: null, subscriptionIncrementalUsd: null, subscriptionOverageState: "unknown", failure: null };
    const save = () => writeFileSync(join(destination, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    save();
    const controller = new AbortController();
    let q: any;
    let childDone: Promise<void> | undefined;
    let ownedChild: ReturnType<typeof spawn> | undefined;
    let resolveHandle!: (value: any) => void;
    const handle = new Promise(resolve => resolveHandle = resolve);
    const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(root, "packages/ui-backend-claude/src"));
    const { query } = await import(sdkEntry);
    const deadline = setTimeout(() => { receipt.deadlineExpired = true; save(); controller.abort(); }, 180000);
    try {
        q = query({ prompt: protectedReviewPrompt(handle, payload, receipt, save, controller), options: { cwd: reviewHome, settingSources: [], settings: { ...NEUTRALISED_SETTINGS, autoMemoryEnabled: false }, persistSession: false, env: reviewEnvironment(process.env, reviewHome, token), model: MODELS.current, tools: [], mcpServers: {}, maxTurns: 1, effort: "low", maxBudgetUsd: 3, abortController: controller, spawnClaudeCodeProcess: (options: any) => {
                    if ([...Object.keys(CLEARED_API_CREDENTIALS), ...unrelatedProviderCredentials].some(key => options.env[key]))
                        throw Error("Unexpected billing credential/routing before child startup");
                    assertNative(options.command, frozen);
                    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
                    ownedChild = child;
                    const observe = (line: string) => {
                        let frame: any;
                        try {
                            frame = JSON.parse(line);
                        }
                        catch {
                            return;
                        }
                        if (frame.type === "system" && frame.subtype === "init") {
                            receipt.init = { model: frame.model, apiKeySource: frame.apiKeySource, cli: frame.claude_code_version };
                            if (frame.model !== MODEL || frame.apiKeySource !== "none" || frame.claude_code_version !== frozen.binaries.claude.cliVersion) {
                                receipt.failure = "Native initialized model/auth/runtime differs from frozen subscription route";
                                controller.abort();
                            }
                        }
                        if (frame.type === "rate_limit_event") {
                            const info = frame.rate_limit_info ?? {};
                            receipt.rateLimits.push({ status: info.status, isUsingOverage: info.isUsingOverage, overageInUse: info.overageInUse });
                            if (info.isUsingOverage === true || info.overageInUse === true)
                                controller.abort();
                        }
                        if (frame.type === "result")
                            receipt.result = frame;
                        save();
                    };
                    const capture = captureReviewStdout(rawPath, observe);
                    child.stdout!.pipe(capture);
                    Object.defineProperty(child, "stdout", { value: capture });
                    child.stderr!.on("data", () => { });
                    childDone = new Promise(resolve => child.on("close", (code, signal) => { receipt.childClosed = { code, signal }; save(); resolve(); }));
                    return child;
                } } });
        resolveHandle(q);
        for await (const frame of q) {
            if (frame.type === "result")
                receipt.result = frame;
        }
    }
    catch (error) {
        receipt.failure = String(error);
    }
    finally {
        clearTimeout(deadline);
        try {
            q?.close();
        }
        catch (error) {
            receipt.cleanupFailure = String(error);
        }
        if (childDone && ownedChild) {
            const drain = await drainReviewChild(ownedChild, childDone);
            receipt.forcedKill = drain.forcedKill;
            if (drain.forcedKill) receipt.cleanupFailure = "Owned native child required forced termination after five seconds";
        }
    }
    receipt.apiEquivalent = priceReview(receipt.result);
    receipt.subscriptionOverageState = overageState(receipt.rateLimits);
    receipt.subscriptionIncrementalUsd = null; // No invoice is supplied by native token/model usage.
    receipt.approval = /^APPROVED\b/.test(receipt.result?.result ?? "") && receipt.result?.subtype === "success" && !receipt.failure && !receipt.cleanupFailure && receipt.childClosed?.code === 0 && receipt.childClosed?.signal === null && receipt.apiEquivalent && receipt.init?.model === MODELS.current && receipt.subscriptionOverageState === "reported inactive" && !receipt.result?.is_error ? "APPROVED" : "NOT_APPROVED";
    receipt.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ destination, model: receipt.model, benchmarkSha, protocolSha, apiEquivalent: receipt.apiEquivalent, subscriptionOverageState: receipt.subscriptionOverageState, subscriptionIncrementalUsd: receipt.subscriptionIncrementalUsd, freezeSha, detectedSha, approval: receipt.approval, childClosed: receipt.childClosed, failure: receipt.failure, result: receipt.result?.result ?? null }, null, 2));
    if (receipt.failure || receipt.cleanupFailure || !receipt.childClosed || !receipt.apiEquivalent || receipt.result?.is_error || receipt.init?.model !== MODELS.current || receipt.subscriptionOverageState === "active")
        process.exitCode = 1;
}
if (import.meta.main)
    await main();
