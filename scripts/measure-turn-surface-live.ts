/** Private #587 research entrypoint. Never changes a production router/default. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createJevClient } from "../packages/ui-server/src/classification/jev-client";
import { createFixture, fixtureTurn, connectBrainSurface, installedRuntime } from "./turn-surface-fixture";
import { ARMS, type Arm } from "./turn-surface-routing";
import { classifySurface } from "./turn-surface-classifier";
import { gatedSurfaceServer, startOverlappedTurn, type SurfaceDecision } from "./turn-surface-overlap";
import { routingMeasurementHook } from "./turn-surface-isolation";
import { disableMeasurementMemory, type MeasurementToolAccess } from "./measurement-isolation";
import { TurnObservation } from "./turn-surface-observation";
import { SurfaceAdmission, successfulSurfaceReceipt } from "./turn-surface-admission";
import { observeSurfaceProcess } from "./turn-surface-stdout";
import { priceSonnet55Usage } from "./measure-sonnet55-cost";
import liveCases from "./fixtures/turn-surface-live-cases.json";
import { SURFACE_MODEL } from "./capture-turn-surface";
import { CLEARED_API_CREDENTIALS } from "../packages/ui-backend-claude/src/subscription";

const JEV_INPUT_USD_PER_MILLION = 0.042; // https://docs.typesafe.ai/models, 2026-10-07.
const MAX_JEV_ATTEMPT_USD = 64_000 * JEV_INPUT_USD_PER_MILLION / 1_000_000;
const repository = resolve(import.meta.dir, "..");
function sha(text: string | Buffer) { return createHash("sha256").update(text).digest("hex"); }
function validTokens(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export async function measureLiveSurface(params: { manifestPath: string; reviewPath: string; cataloguePath: string; outPath: string }) {
  if (process.env.BRAIN_LIVE_EVAL !== "587" || !process.env.CLAUDE_CODE_OAUTH_TOKEN
    || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_CUSTOM_HEADERS) {
    throw Error("Require reviewed #587 protocol and subscription-only inference environment");
  }
  const manifest = JSON.parse(readFileSync(params.manifestPath, "utf8"));
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (sha(readFileSync(join(repository, path))) !== expected) throw Error(`Frozen source drift: ${path}`);
  }
  if (sha(readFileSync(params.cataloguePath)) !== manifest.catalogueSha) throw Error("Frozen native catalogue drift");
  const catalogue = JSON.parse(readFileSync(params.cataloguePath, "utf8"));
  const review = JSON.parse(readFileSync(params.reviewPath, "utf8"));
  if (review.inputSha !== manifest.reviewInputSha || review.result?.subtype !== "success"
    || review.init?.model !== SURFACE_MODEL || !/^\W*APPROVED\b/.test(review.result?.result ?? "")) throw Error("Bound successful semantic review required");
  if (review.init.apiKeySource !== "none" || review.account?.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN"
    || review.account.apiProvider !== "firstParty" || ![undefined, null, "none"].includes(review.account.apiKeySource)
    || review.overageReported !== false) throw Error("Reviewed subscription route/overage receipt required");
  const reviewPrice = priceSonnet55Usage(review.result);
  const runtime = installedRuntime();
  if (runtime.agentSdk !== catalogue.runtime.agentSdk || runtime.claudeCode !== catalogue.runtime.claudeCode) throw Error("Frozen runtime drift");
  const privateRoot = mkdtempSync(join(tmpdir(), "turn-surface-live-"));
  const fixture = createFixture({ corpus: true });
  disableMeasurementMemory(fixture.root);
  const home = join(privateRoot, "home"), parking = join(privateRoot, "parking");
  mkdirSync(home); mkdirSync(join(home, ".claude")); mkdirSync(parking);
  const index = Bun.spawn([process.execPath, join(repository, "packages/core/src/cli/brain.ts"), "index", "--force", "--json"], {
    cwd: fixture.root, env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, BRAIN_ROOT: fixture.root }, stdout: "pipe", stderr: "pipe",
  });
  const indexOutput = await new Response(index.stdout).text();
  await new Response(index.stderr).text();
  if (await index.exited !== 0) throw Error("Fixture index failed");
  const indexReceipt = JSON.parse(indexOutput);
  if (indexReceipt.total !== 25 || indexReceipt.chunks !== 25 || indexReceipt.embeddings !== 0) throw Error("Unexpected fixture indexing receipt");
  const rows: unknown[] = [];
  const jevReceipts: Array<Record<string, any>> = [];
  let stopped: string | null = null, activeDeadline = new AbortController(), jevPublishedCharge = 0;
  const jev = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY ?? null, fetch: async (url, init) => {
    // The documented 64k request ceiling bounds one attempt; allow one retry
    // in each of the two passes. API-equivalent Claude cost is not this cap.
    if (jevPublishedCharge + MAX_JEV_ATTEMPT_USD > 15) throw Error("Actual billed reservation exhausted");
    const started = performance.now();
    let response: Response;
    try { response = await fetch(url, { ...init, signal: AbortSignal.any([init.signal!, activeDeadline.signal]) }); }
    catch (error) {
      stopped ??= "jev_transport_error_unknown_cost";
      jevReceipts.push({ status: null, durationMs: performance.now() - started, model: null, usage: null,
        publishedChargeUsd: null, error: "transport_failed_or_aborted" });
      throw error;
    }
    const raw = await response.clone().json().catch(() => null) as Record<string, any> | null;
    const receipt = { status: response.status, durationMs: performance.now() - started,
      model: raw?.model ?? null, usage: raw?.usage ?? null, answers: raw?.answers ?? null, publishedChargeUsd: null as number | null };
    if (response.ok && raw?.model === "jev-1.13.0" && validTokens(raw?.usage?.input_tokens) && raw.usage.input_tokens <= 64_000) {
      receipt.publishedChargeUsd = raw.usage.input_tokens * JEV_INPUT_USD_PER_MILLION / 1_000_000;
      jevPublishedCharge += receipt.publishedChargeUsd;
    } else stopped ??= "jev_error_or_missing_model_usage";
    jevReceipts.push(receipt);
    return response;
  } });
  const save = () => writeFileSync(params.outPath, JSON.stringify({ evidence: "live-subscription-routing-comparison", model: SURFACE_MODEL,
    runtime, manifest, indexReceipt, rows, jevReceipts, jevPublishedChargeUsd: jevPublishedCharge,
    jevChargeBasis: "Observed direct-API input usage at official published rate; not a final account statement",
    reviewApiEquivalent: reviewPrice, actualBilledReservationUsd: 15, actualSubscriptionBillingUsd: null,
    stopped, privateRawReceiptsRetained: true }, null, 2) + "\n");
  const tasks: Array<{ arm: Arm; rep: number; test: typeof liveCases.cases[number] }> = [];
  // Interleave arms per prompt and rotate across repetitions. A fixed project
  // path/prompt prefix is retained; cache outcomes are observed, not assumed.
  for (let rep = 1; rep <= 3; rep++) for (const [caseIndex, test] of liveCases.cases.entries()) {
    const offset = (rep - 1 + caseIndex) % ARMS.length;
    for (const arm of [...ARMS.slice(offset), ...ARMS.slice(0, offset)]) tasks.push({ arm, rep, test });
  }
  try {
    for (const [index, task] of tasks.entries()) {
      if (stopped) break;
      fixture.restoreSkills();
      const prepared = await fixtureTurn(fixture.root, task.test.prompt, "normal", undefined, { productionDefaults: true,
        bridge: {
          askUser: async (_id, questions) => ({ answers: Object.fromEntries(questions.map(question => [question.question,
            question.options.find(option => option.label === "Ithaca")?.label ?? question.options[0]!.label])) }),
          queryActivity: async query => ({ scope: query.scope, runs: [], source: "fictional host control" }),
        },
      });
      const brain = await connectBrainSurface(fixture.root);
      const started = performance.now(), observation = new TurnObservation(started, SURFACE_MODEL);
      const beforeJev = jevReceipts.length;
      activeDeadline = new AbortController();
      const routingTimer = setTimeout(() => activeDeadline.abort(), 2000);
      const routing = classifySurface({ client: jev, prompt: task.test.prompt, previousTail: "",
        catalogue: { tools: [...brain.tools, ...prepared.peer.tools], skills: catalogue.skills }, enabled: task.arm !== "baseline", deadline: activeDeadline.signal,
      }).finally(() => clearTimeout(routingTimer));
      const decision: Promise<SurfaceDecision> = routing.then(value => ({ arm: task.arm, routed: value.outcome === "answered",
        tools: value.tools, skills: value.skills }));
      const bridge = gatedSurfaceServer("brain-ui", prepared.peer, decision);
      const core = gatedSurfaceServer("brain", brain, decision);
      const abort = prepared.turn.options.abortController!;
      const timeout = setTimeout(() => abort.abort(), 180_000);
      const admission = new SurfaceAdmission(abort, SURFACE_MODEL, runtime.claudeCode);
      const audit: MeasurementToolAccess[] = [];
      let rawResult: any, error: string | null = null, spawnedMs: number | null = null;
      let turn: Awaited<ReturnType<typeof startOverlappedTurn>> | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let childExited: Promise<void> | undefined;
      try {
        const neutralSettings = prepared.turn.options.settings;
        if (!neutralSettings || typeof neutralSettings !== "object") throw Error("Expected production subscription neutralized settings");
        const options: Options = { ...prepared.turn.options, model: SURFACE_MODEL, effort: "low", maxTurns: 14, maxBudgetUsd: 1, persistSession: false,
          mcpServers: { brain: core, "brain-ui": bridge }, settings: { ...neutralSettings, env: { ...CLEARED_API_CREDENTIALS,
            ANTHROPIC_SMALL_FAST_MODEL: SURFACE_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: SURFACE_MODEL,
            ANTHROPIC_DEFAULT_SONNET_MODEL: SURFACE_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: SURFACE_MODEL,
            CLAUDE_CODE_SUBAGENT_MODEL: SURFACE_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" }, autoMemoryEnabled: false },
          env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
            CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN!, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "true",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: SURFACE_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: SURFACE_MODEL,
            ANTHROPIC_DEFAULT_OPUS_MODEL: SURFACE_MODEL, CLAUDE_CODE_SUBAGENT_MODEL: SURFACE_MODEL,
            ANTHROPIC_SMALL_FAST_MODEL: SURFACE_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", ...CLEARED_API_CREDENTIALS },
          hooks: { ...prepared.turn.options.hooks, PreToolUse: [...(prepared.turn.options.hooks?.PreToolUse ?? []), {
            hooks: [routingMeasurementHook(fixture.root, catalogue.skills.map((skill: { name: string }) => skill.name), decision, audit)],
          }] },
          spawnClaudeCodeProcess: spec => {
            if (spec.env.ANTHROPIC_API_KEY || spec.env.ANTHROPIC_AUTH_TOKEN || spec.env.ANTHROPIC_CUSTOM_HEADERS) throw Error("Unexpected inference billing credential");
            spawnedMs = performance.now() - started;
            child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, signal: spec.signal, stdio: ["pipe", "pipe", "pipe"] });
            childExited = new Promise(resolve => { child!.once("exit", () => resolve()); });
            return observeSurfaceProcess(child, join(privateRoot, `${index}.jsonl`), frame => {
              admission.observe(frame); if (frame.type === "result") rawResult = frame;
              observation.observe(frame);
            });
          },
        };
        turn = await startOverlappedTurn({ options, parkingDirectory: parking, projectDirectory: fixture.root,
          prompt: task.test.prompt, decision, skillCatalogue: catalogue.skills.map((skill: { name: string }) => skill.name),
          onGateRefused: reason => { admission.stop(reason); },
          beforeClaim: selected => { if (selected.routed && selected.arm === "hard-prune") fixture.pruneSkills(selected.skills); },
        });
        // This native control read discloses no identity into the report and
        // does not perform inference. Raw bytes remain private mode0600.
        await turn.query.accountInfo();
        for await (const _message of turn.query as AsyncIterable<SDKMessage>) { /* raw observer owns receipts */ }
        admission.requireIdentity();
        const price = successfulSurfaceReceipt(rawResult, observation);
        const route = await routing;
        const normalizedCalls = [...observation.calls.values()].map(call => ({ ...call,
          input: JSON.parse(JSON.stringify(call.input).split(fixture.root).join("<fixture>")) }));
        rows.push({ id: task.test.id, arm: task.arm, rep: task.rep, durationMs: performance.now() - started,
          spawnedMs, firstFrameMs: observation.firstFrameMs, firstTextMs: observation.firstTextMs,
          router: route, init: admission.init, account: admission.account, rateLimitEvents: admission.rateLimitEvents,
          calls: normalizedCalls, roundTrips: [...observation.roundTrips.values()], audit,
          answer: [...observation.answerParts.values()].join("\n").split(fixture.root).join("<fixture>"),
          score: observation.score(task.test), price, modelUsage: rawResult.modelUsage,
          jevAttemptRange: [beforeJev, jevReceipts.length], error: null });
        if (admission.stopped) stopped ??= admission.stopped;
      } catch (caught) {
        writeFileSync(join(privateRoot, `${index}-error.txt`), caught instanceof Error ? caught.message : String(caught), { mode: 0o600 });
        error = admission.stopped ?? observation.observationError ?? "native_turn_failed";
        stopped ??= admission.stopped ?? "turn_error_or_missing_raw_usage";
        rows.push({ id: task.test.id, arm: task.arm, rep: task.rep, error, included: false,
          init: admission.init, account: admission.account, rateLimitEvents: admission.rateLimitEvents,
          rawResultPresent: Boolean(rawResult), modelUsage: rawResult?.modelUsage ?? null });
      } finally {
        clearTimeout(timeout); clearTimeout(routingTimer); activeDeadline.abort(); turn?.spare.close();
        abort.abort();
        if (childExited) {
          const killTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
          await childExited; clearTimeout(killTimer);
        }
        await bridge.instance.close(); await core.instance.close(); await brain.client.close(); await prepared.close();
        save();
      }
      console.log(`${index + 1}/${tasks.length} ${task.arm} rep${task.rep} ${task.test.id}${error ? " excluded" : " completed"}`);
    }
  } finally { fixture.close(); save(); }
  if (stopped || rows.length !== tasks.length) throw Error(stopped ?? "incomplete_matrix");
  return { rows: rows.length, jevPublishedChargeUsd: jevPublishedCharge };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 8 || args[0] !== "--manifest" || args[2] !== "--review" || args[4] !== "--catalogue" || args[6] !== "--out") throw Error("usage: --manifest file --review file --catalogue file --out file");
  await measureLiveSurface({ manifestPath: args[1]!, reviewPath: args[3]!, cataloguePath: args[5]!, outPath: args[7]! });
}
