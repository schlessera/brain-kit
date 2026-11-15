/** Exact-candidate reservation lifecycle and cooperative, proof-checked merge. */
import { randomUUID } from "node:crypto";
import { scanText } from "./check-leakage";
import { GitReservationStore, assertLease, holderToken, holds, LEASE_MS, liveLease, reservationServerTime, reservationTransition, RENEW_MS, sameCandidate,
  type Candidate, type Operation, type Lease } from "./integration-reservation";
import { contractReadiness, latestIntegrationRun, verifyIntegrationProof } from "./integration-proof";
import { declareFix, gateDecision, recordExpedited, type RedMainRecord } from "./red-main";
import { isAncestor } from "./red-main-cli";
import { expeditedProblems, expeditedTests, fixProbeTitle, probeReceipt, type FeedbackEvidence, type ProbeEvidence } from "./red-main-expedite";
import { receiptFromBody, receiptRefusal } from "./check-receipt";
import type { API } from "./proof-reuse";

/**
 * A refusal no retry can cure: the candidate changed or the reservation no longer
 * holds this lease. Anything else on the renewal or proof-poll path (a push,
 * ls-remote or API transport error, an HTTP 5xx, an unavailable clock) is
 * retried on the next tick while the lease is provably still live (#3302).
 */
class Fatal extends Error {}
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().split("\n").slice(0, 3).join(" | ");
/** Never act on a lease that may have expired: give up one renewal interval before it could. */
const SAFETY_MS = LEASE_MS - RENEW_MS;
/** How long `confirm` waits for a pending contract run before refusing (#3573). */
const CONTRACT_WAIT_MS = 10 * RENEW_MS;

async function gh(...args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(err.trim());
  return out.trim();
}

if (import.meta.main) {
  // `token` proves this process holds `own` (#3303). It stays in memory; only `acquire` prints it.
  let own: Lease | undefined, token: string | undefined, store: GitReservationStore | undefined;
  let actor = 0, repository = "";
  let timer: ReturnType<typeof setInterval> | undefined, pending = Promise.resolve(), lost: unknown;
  // Local monotonic time until which the owned lease is certainly live, and of the last successful renewal.
  let liveUntil = 0, renewedAt = 0, pollFailingSince: number | undefined;
  /** `started` precedes the server clock read, so the local deadline never outlasts the lease. */
  const held = (lease: Lease, started: number, serverNow: number) => { liveUntil = started + lease.expires - serverNow; renewedAt = started; };
  const clock = async () => reservationServerTime(await gh("api", "--include", "-H", "Cache-Control: no-cache",
    `repos/${repository}/git/ref/heads/main?integration_clock=${randomUUID()}`));
  const api: API = { async json(path) { return JSON.parse(await gh("api", `repos/${repository}/${path}`)); },
    async log(id) { return gh("api", "--allow-escape-sequences", `repos/${repository}/actions/jobs/${id}/logs`); } };
  async function candidate(pr: number): Promise<Candidate> {
    const live = await api.json(`pulls/${pr}`), base = await api.json("git/ref/heads/main");
    if (live.state !== "open" || live.stack || live.base?.ref !== "main" || live.head?.repo?.full_name !== repository ||
        live.base?.repo?.full_name !== repository || live.base?.sha !== base.object?.sha ||
        !/^[a-f0-9]{40}$/.test(live.head?.sha ?? "") || !/^[a-f0-9]{40}$/.test(base.object?.sha ?? "")) throw new Error("An open ordinary exact-main candidate is required; refresh stale or unsupported native candidates");
    return { repository: `https://github.com/${repository}`, pr, head: live.head.sha, base: base.object.sha };
  }
  async function change(operation: Operation) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = store!.read(), now = await clock();
      let next: ReturnType<typeof reservationTransition>;
      try { next = reservationTransition(snapshot.state, operation, actor, now); } catch (error) { throw new Fatal(describe(error)); }
      if (scanText("coordination", JSON.stringify(next)).length) throw new Fatal("Public coordination state failed the leakage gate");
      if (store!.publish(snapshot, next)) return next;
      await Bun.sleep(100 * 2 ** attempt);
    }
    throw new Error("Concurrent coordination update; bounded retries exhausted");
  }
  async function renew() {
    if (!own) throw new Error("No owned reservation");
    const started = performance.now();
    if (!sameCandidate(await candidate(own.candidate.pr), own.candidate)) throw new Fatal("Candidate head/base changed; reacquisition and new confirmation required");
    const state = await change({ kind: "renew", id: own.id, token }); own = state.active!;
    held(own, started, state.updated);
  }
  async function acquire(desired: Candidate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const secret = holderToken(), started = performance.now();
      try { const state = await change({ kind: "acquire", candidate: desired, token: secret }), lease = state.active!; token = secret; held(lease, started, state.updated); return lease; }
      catch (error) {
        if (!String(error).includes("Integration busy:") || attempt === 2) throw error;
        console.error(String(error)); await Bun.sleep(1000 * 2 ** attempt);
        if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed while waiting for integration ownership");
      }
    }
    throw new Error("Bounded acquisition exhausted");
  }
  /**
   * Cooperative merge blocking while red (#2942): a candidate whose merge ref contains
   * the bad commit proceeds only as a declared fix (#3321). Unknown ancestry refuses.
   */
  function refuseWhileRed(desired: Candidate) {
    const decision = gateDecision({ record: store!.read().redMain, pr: desired.pr,
      contains: sha => isAncestor(sha, desired.base, store!.root) || isAncestor(sha, desired.head, store!.root) });
    if (decision.refuse) throw new Error(`${decision.message}; only a declared fix may confirm or merge (bun scripts/integrate.ts declare-fix <pr>)`);
  }
  async function changeRedMain(update: (record: RedMainRecord, now: number) => RedMainRecord) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = store!.read(), record = update(snapshot.redMain, await clock());
      if (record === snapshot.redMain) return record;
      if (scanText("coordination", JSON.stringify(record)).length) throw new Error("Public coordination state failed the leakage gate");
      if (store!.publishRedMain(snapshot, record)) return record;
      await Bun.sleep(100 * 2 ** attempt);
    }
    throw new Error("Concurrent coordination update; bounded retries exhausted");
  }
  /** Durable record of an expedited fix: the red-main record (coordination ref history) and a ci-timings event. */
  async function recordExpeditedFix(desired: Candidate, fixesRun: number, squash: string, evidence: Awaited<ReturnType<typeof expeditedEvidence>>) {
    try {
      await changeRedMain((record, now) => recordExpedited(record, { pr: desired.pr, head: desired.head, base: desired.base, squash,
        baseProbe: evidence.baseProbe!.run, headProbe: evidence.headProbe!.run, feedbackRun: evidence.feedback!.run, actor, at: now }, now));
      const dir = `${store!.root}/tmp/ci-timings`, file = `${store!.root}/tmp/expedited-fix-${desired.pr}.json`;
      await Bun.write(file, JSON.stringify({ kind: "expedited-fix", pr: desired.pr, run: fixesRun,
        evidence: `https://github.com/${repository}/actions/runs/${evidence.headProbe!.run}` }));
      const child = Bun.spawnSync([process.execPath, `${import.meta.dir}/ci-timings.ts`, "record", "--repo", repository, "--event", file, "--out", dir], { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr).trim());
    } catch (error) { console.error(`Expedited fix merged but its record is incomplete; record it by hand: ${String(error)}`); }
  }
  /** One renewal tick: a transient failure is logged and retried next tick until the safety margin (#3302). */
  async function tick() {
    if (lost) return;
    try { await renew(); }
    catch (error) {
      if (error instanceof Fatal) { lost = error; return; }
      const since = Math.round((performance.now() - renewedAt) / 1000);
      console.error(`Lease renewal failed ${since}s after the last success; retrying next tick: ${describe(error)}`);
      if (performance.now() >= liveUntil - RENEW_MS) lost = new Error(`No lease renewal succeeded for ${since}s (safety margin ${SAFETY_MS / 1000}s before possible expiry); last error: ${describe(error)}`);
    }
  }
  function heartbeat() {
    timer = setInterval(() => { pending = pending.then(tick); return pending; }, RENEW_MS);
  }
  /** A proof read that fails transiently is retried next tick; a refusal is not, and polling gives up with the lease's margin. */
  async function poll<T>(read: () => Promise<T>): Promise<T | undefined> {
    try { const value = await read(); pollFailingSince = undefined; return value; }
    catch (error) {
      if (error instanceof Fatal) throw error;
      pollFailingSince ??= performance.now();
      const failing = Math.round((performance.now() - pollFailingSince) / 1000);
      console.error(`Proof poll failed (failing for ${failing}s); retrying next tick: ${describe(error)}`);
      if (failing * 1000 >= SAFETY_MS) throw new Error(`Proof polls failed for ${failing}s; last error: ${describe(error)}`);
      return undefined;
    }
  }
  /**
   * Hold confirmation until the newest exact-head contract run has passed (#3573). The merge path
   * refuses anything else, so requesting candidate CI first would spend a whole run on a refusal.
   * A pending run is waited for, without a reservation, for a bounded time.
   */
  async function contractPassed(desired: Candidate) {
    for (let waited = 0; ; waited += RENEW_MS) {
      const readiness = contractReadiness(await latestIntegrationRun(api, "contract.yml", desired), desired.head);
      if (readiness.state === "passed") return;
      if (readiness.state === "refused") throw new Error(readiness.message);
      if (waited >= CONTRACT_WAIT_MS) throw new Error(`${readiness.message} after ${waited / 1000}s; confirm again once it completes. No reservation was taken and no candidate CI was requested.`);
      console.error(`${readiness.message}; waiting before taking the reservation`);
      await Bun.sleep(RENEW_MS);
    }
  }
  async function stopHeartbeat() { if (timer) clearInterval(timer); timer = undefined; await pending; }
  async function milestones(pr: number, issueRefs: string[]) {
    const live = await api.json(`pulls/${pr}`);
    if (!live.milestone?.title) throw new Error("PR release milestone required");
    const closing = JSON.parse(await gh("pr", "view", String(pr), "--repo", repository, "--json", "closingIssuesReferences")).closingIssuesReferences;
    const required: string[] = closing.map((issue: { url: string }) => {
      const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(issue.url);
      if (!match) throw new Error("Unknown closing-issue identity"); return `${match[1]}#${match[2]}`;
    });
    if (!issueRefs.length || required.some(ref => !issueRefs.includes(ref))) throw new Error("Explicit delivered/advanced issues must include every closing issue");
    for (const ref of issueRefs) {
      const [repo, number] = ref.split("#"), issue = JSON.parse(await gh("api", `repos/${repo}/issues/${number}`));
      if (issue.milestone?.title !== live.milestone.title) throw new Error(`Release milestone mismatch: ${ref}`);
    }
  }
  async function probeRuns(): Promise<any[]> {
    return (await api.json(`actions/workflows/red-main-probe.yml/runs?event=workflow_dispatch&per_page=50`)).workflow_runs ?? [];
  }
  async function fixProbe(source: number, sha: string, after = 0): Promise<ProbeEvidence | null> {
    const run = (await probeRuns()).filter(r => r.display_title === fixProbeTitle(source, sha) && r.id > after).sort((a, b) => b.id - a.id)[0];
    if (!run) return null;
    if (run.status !== "completed") return { run: run.id, status: run.status, conclusion: null, receipt: null };
    const jobs = (await api.json(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs ?? [];
    const job = jobs.find((entry: { name: string }) => entry.name === "probe");
    return { run: run.id, status: "completed", conclusion: run.conclusion, receipt: job ? probeReceipt(await api.log(job.id)) : null };
  }
  async function feedbackEvidence(desired: Candidate): Promise<FeedbackEvidence | null> {
    const run = await latestIntegrationRun(api, "ci.yml", desired);
    if (!run) return null;
    const jobs = (await api.json(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs ?? [];
    const find = (name: string) => jobs.find((job: { name: string }) => job.name === name);
    const done = (job: any) => job?.status === "completed" ? job.conclusion as string : null;
    const changeset = find("changeset");
    const cadence = done(changeset) ? /"cadence":\s*"(\w+)"/.exec(await api.log(changeset.id))?.[1] ?? null : null;
    return { run: run.id, cadence, changeset: done(changeset), verify: done(find("verify")) };
  }
  /** Expedited fix evidence for the exact candidate; throws the ruling's refusals. */
  async function expeditedEvidence(desired: Candidate, fixesRun: number, after = { probe: 0, run: 0 }) {
    const tests = expeditedTests(store!.read().redMain, fixesRun);
    for (const sha of [desired.head, desired.base]) if (Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: store!.root }).exitCode !== 0) store!.git(["fetch", "origin", sha]);
    const deleted = store!.git(["diff", "--name-only", "--no-renames", "--diff-filter=D", `${desired.base}...${desired.head}`]).split("\n").filter(Boolean);
    const run = await feedbackEvidence(desired), feedback = run && run.run > after.run ? run : null;
    const [baseProbe, headProbe] = [await fixProbe(fixesRun, desired.base, after.probe), await fixProbe(fixesRun, desired.head, after.probe)];
    return { tests, baseProbe, headProbe, feedback, problems: expeditedProblems({ tests, base: desired.base, head: desired.head, deleted, baseProbe, headProbe, feedback }) };
  }
  async function merge(issueRefs: string[], fixesRun?: number, after?: { probe: number; run: number }) {
    if (!own) throw new Error("Explicit owned reservation required");
    heartbeat();
    const desired = own.candidate;
    let tree: string, candidateRun: number, expedited: Awaited<ReturnType<typeof expeditedEvidence>> | undefined;
    if (fixesRun === undefined) {
      const proof = await verifyIntegrationProof(store!.root, repository, desired, api, sha => { store!.git(["fetch", "origin", sha]); });
      const refusal = receiptRefusal((await api.json(`pulls/${desired.pr}`)).body, proof.covered);
      if (refusal) throw new Error(refusal);
      tree = proof.checkout.tree; candidateRun = proof.run;
    } else {
      expedited = await expeditedEvidence(desired, fixesRun, after);
      if (expedited.problems.length) throw new Error(`Expedited fix proof refused: ${expedited.problems.join("; ")}`);
      // The squash must equal the exact base merged with the exact probed head.
      const merged = Bun.spawnSync(["git", "merge-tree", "--write-tree", desired.base, desired.head], { cwd: store!.root, stdout: "pipe", stderr: "pipe" });
      if (merged.exitCode !== 0) throw new Error("The fix head does not merge cleanly onto the exact base");
      tree = new TextDecoder().decode(merged.stdout).split("\n")[0]!.trim(); candidateRun = expedited.feedback!.run;
    }
    await milestones(desired.pr, issueRefs);
    await stopHeartbeat();
    if (lost) throw lost;
    refuseWhileRed(desired);
    if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed before merge");
    assertLease(store!.read().state, own.id, actor, desired, await clock(), token);
    await gh("pr", "merge", String(desired.pr), "--repo", repository, "--squash", "--match-head-commit", desired.head);
    const merged = await api.json(`pulls/${desired.pr}`);
    if (!merged.merged || !merged.merge_commit_sha) throw new Error("Merge not complete; no delivery claim");
    const commit = await api.json(`git/commits/${merged.merge_commit_sha}`);
    if (commit.parents?.length !== 1 || commit.parents[0]?.sha !== desired.base || commit.tree?.sha !== tree) throw new Error("Actual squash parent/tree differ; reconcile actual main before claiming completion");
    store!.git(["fetch", "origin", "main"]); store!.git(["merge-base", "--is-ancestor", merged.merge_commit_sha, "origin/main"]);
    await milestones(desired.pr, issueRefs);
    await change({ kind: "release", id: own.id, token }); own = undefined;
    if (expedited) await recordExpeditedFix(desired, fixesRun!, merged.merge_commit_sha, expedited);
    const main = await api.json(`actions/workflows/ci.yml/runs?event=push&head_sha=${merged.merge_commit_sha}&per_page=10`);
    const mainProof = "pending; inspect actual main jobs before claiming full completion";
    const observedMainConclusion = main.workflow_runs?.[0]?.conclusion ?? null;
    console.log(JSON.stringify({ merged: true, sha: merged.merge_commit_sha, candidateRun, mainProof, observedMainConclusion,
      ...(expedited ? { expedited: { fixesMainRun: fixesRun, baseProbe: expedited.baseProbe!.run, headProbe: expedited.headProbe!.run,
        backstop: "the next main run includes the open red set; only its green result clears the record" } } : {}) }));
    process.exitCode = 2; // A run summary alone never completes actual main proof reconciliation.
  }
  try {
    const [command, target, ...options] = process.argv.slice(2), values = new Map<string, string>();
    for (let index = 0; index < options.length; index += 2) {
      const key = options[index]!, value = options[index + 1];
      if (!["--issues", "--lease", "--token", "--fixes-main-run"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid integration options");
      values.set(key, value);
    }
    const issues = values.has("--issues") ? values.get("--issues")!.split(",") : [];
    const fixesRun = values.has("--fixes-main-run") ? Number(values.get("--fixes-main-run")) : undefined;
    if (fixesRun !== undefined && (!/^[1-9]\d*$/.test(values.get("--fixes-main-run")!) || !Number.isSafeInteger(fixesRun))) throw new Error("--fixes-main-run needs a main CI run ID");
    if (fixesRun !== undefined && !["confirm", "merge"].includes(command ?? "")) throw new Error("--fixes-main-run applies to confirm and merge only");
    if (values.has("--token") && !["merge", "renew", "release"].includes(command ?? "")) throw new Error("--token applies to merge, renew and release only");
    if (issues.some(value => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value)) || issues.length > 100) throw new Error("Invalid delivered issue identities");
    repository = await gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    const user = JSON.parse(await gh("api", "user")); actor = user.id;
    store = new GitReservationStore(process.cwd());
    const remote = store.git(["remote", "get-url", "origin"]).replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || remote !== `https://github.com/${repository}`) throw new Error("Authenticated repository and origin differ");
    if (command === "main-status") {
      if (target !== undefined && target !== "--json") throw new Error("usage: bun scripts/integrate.ts main-status [--json]");
      const snapshot = store.read();
      console.log(JSON.stringify({ red: snapshot.redMain.open !== null, source: snapshot.oid, record: snapshot.redMain }));
    } else if (command === "declare-fix") {
      if (!/^[1-9]\d*$/.test(target ?? "") || !Number.isSafeInteger(Number(target))) throw new Error("A PR number is required");
      const live = await api.json(`pulls/${target}`);
      if (live.state !== "open" || live.base?.ref !== "main" || live.base?.repo?.full_name !== repository) throw new Error("Only an open PR against main can be declared a red-main fix");
      console.log(JSON.stringify(await changeRedMain((record, now) => declareFix(record, Number(target), now))));
    } else if (command === "inspect") {
      const snapshot = store.read(), now = await clock();
      console.log(JSON.stringify({ ...snapshot, live: liveLease(snapshot.state.active, now), serverTime: now }));
    } else if (command === "revoke") {
      const permission = await api.json(`collaborators/${encodeURIComponent(user.login)}/permission`);
      console.log(JSON.stringify(await change({ kind: "revoke", reason: target ?? "", maintainer: permission.permission === "admin" || ["admin", "maintain"].includes(permission.role_name) })));
    } else if (command === "release" || command === "renew") {
      const state = store.read().state;
      token = values.get("--token");
      if (state.active?.holder !== undefined && token === undefined) throw new Error(`${command} needs --token <token>, printed once by the acquire that took this lease; another holder's lease ends only by expiry or revoke`);
      if (!state.active || state.active.id !== target || state.active.actor !== actor || !holds(state.active, token)) throw new Error("Lease identity does not belong to this invocation");
      own = state.active;
      // A failed renew exits nonzero and leaves the lease for the next renewal or expiry;
      // only an explicit release (or confirm/merge's own completion) ends it (#3302).
      if (command === "renew") try { await renew(); console.log(JSON.stringify(own)); } finally { own = undefined; }
      else { console.log(JSON.stringify(await change({ kind: "release", id: own.id, token }))); own = undefined; }
    } else if (["acquire", "confirm", "merge"].includes(command ?? "")) {
      if (!/^[1-9]\d*$/.test(target ?? "") || !Number.isSafeInteger(Number(target))) throw new Error("A PR number is required");
      if (command === "merge" && values.has("--lease")) {
        const current = store.read().state.active;
        token = values.get("--token");
        if (current && current.id === values.get("--lease") && current.actor === actor && holds(current, token) && current.candidate.pr === Number(target) && current.candidate.repository === `https://github.com/${repository}`) own = current;
      }
      const desired = await candidate(Number(target));
      // Refuse an undeliverable confirmation before any write, lease or candidate CI (#3850); merge checks again.
      if (command === "confirm") await milestones(desired.pr, issues);
      if (fixesRun !== undefined) {
        // Refuse a run that is not the open record's, or category-only failures, before any write.
        expeditedTests(store.read().redMain, fixesRun);
        console.log(JSON.stringify({ declared: (await changeRedMain((record, now) => declareFix(record, desired.pr, now))).open?.fixes }));
      } else if (command !== "acquire" && !receiptFromBody((await api.json(`pulls/${desired.pr}`)).body)) {
        throw new Error(receiptRefusal("", new Set())!);
      }
      refuseWhileRed(desired);
      if (command === "merge") {
        const lease = values.get("--lease");
        if (!lease) throw new Error("Explicit --lease required");
        const state = store.read().state;
        if (state.active?.id === lease && state.active.holder !== undefined && token === undefined) throw new Error("merge --lease needs --token <token>, printed once by the acquire that took this lease");
        if (state.active?.id === lease && state.active.actor === actor && holds(state.active, token)) own = state.active;
        const started = performance.now(), now = await clock();
        held(assertLease(state, lease, actor, desired, now, token), started, now);
        await merge(issues, fixesRun);
      } else if (command === "confirm" && fixesRun !== undefined) {
        own = await acquire(desired);
        console.log(JSON.stringify({ acquired: own }));
        heartbeat();
        const tests = expeditedTests(store.read().redMain, fixesRun);
        const after = { probe: Math.max(0, ...(await probeRuns()).map(r => r.id)), run: (await latestIntegrationRun(api, "ci.yml", desired))?.id ?? 0 };
        for (const sha of [desired.base, desired.head]) await gh("api", "--method", "POST",
          `repos/${repository}/actions/workflows/red-main-probe.yml/dispatches`, "-f", "ref=main", "-f", "inputs[purpose]=fix",
          "-f", `inputs[source_run]=${fixesRun}`, "-f", `inputs[sha]=${sha}`, "-f", `inputs[tests]=${JSON.stringify(tests)}`);
        const live = await api.json(`pulls/${desired.pr}`);
        if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed before the expedited request");
        assertLease(store.read().state, own.id, actor, desired, await clock(), token);
        // A fresh ready request runs the exact-head affected fast invariants; the rest of that run is not waited for.
        if (!live.draft) await gh("pr", "ready", String(desired.pr), "--repo", repository, "--undo");
        await gh("pr", "ready", String(desired.pr), "--repo", repository);
        while (!lost) {
          const evidence = await poll(() => expeditedEvidence(desired, fixesRun, after));
          const pending = !evidence || [evidence.baseProbe, evidence.headProbe].some(probe => probe?.status !== "completed") || !evidence.feedback ||
            evidence.feedback.changeset === null || (evidence.feedback.changeset === "success" && evidence.feedback.verify === null);
          if (!pending) { await stopHeartbeat(); await merge(issues, fixesRun, after); break; }
          await Bun.sleep(RENEW_MS);
        }
        if (lost) throw lost;
      } else {
        if (command === "confirm") await contractPassed(desired);
        own = await acquire(desired);
        // Only an explicit acquire prints the holder token, once; confirm keeps it in memory.
        console.log(JSON.stringify(command === "acquire" ? { acquired: own, token } : { acquired: own }));
        if (command === "acquire") { own = undefined; token = undefined; } // Caller retains the explicit id and token.
        else {
          heartbeat();
          const previousRun = await latestIntegrationRun(api, "ci.yml", desired);
          const live = await api.json(`pulls/${desired.pr}`);
          if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed before confirmation request");
          assertLease(store.read().state, own.id, actor, desired, await clock(), token);
          if (!live.draft) await gh("pr", "ready", String(desired.pr), "--repo", repository, "--undo");
          await gh("pr", "ready", String(desired.pr), "--repo", repository);
          while (!lost) {
            const observed = await poll(async () => {
              const run = await latestIntegrationRun(api, "ci.yml", desired);
              if (!(run?.id > (previousRun?.id ?? 0) && run.status === "completed")) return null;
              const jobs = await api.json(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
              const metadata = jobs.jobs?.find((job: { name: string }) => job.name === "changeset");
              const log = metadata ? await api.log(metadata.id) : "";
              return /"cadence":\s*"(?:draft|feedback)"/.test(log) ? null : run;
            });
            if (observed) {
              if (observed.conclusion !== "success") throw new Error(`Candidate proof ${observed.conclusion}; reservation released without retry`);
              await stopHeartbeat(); await merge(issues); break;
            }
            await Bun.sleep(RENEW_MS);
          }
          if (lost) throw lost;
        }
      }
    } else throw new Error("usage: bun scripts/integrate.ts inspect | main-status [--json] | declare-fix <pr> | acquire/confirm/merge <pr> [--lease id --token token] [--issues owner/repo#N,...] [--fixes-main-run <run-id>] | renew/release <id> [--token token] | revoke <reason>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  } finally {
    await stopHeartbeat();
    if (own && store) try {
      const current = store.read().state.active;
      if (current?.id === own.id && current.actor === actor && holds(current, token)) await change({ kind: "release", id: own.id, token });
    } catch (error) { console.error(`Owned reservation cleanup unfinished: ${String(error)}`); process.exitCode = 1; }
  }
}
