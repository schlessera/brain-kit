/** Exact-candidate reservation lifecycle and cooperative, proof-checked merge. */
import { randomUUID } from "node:crypto";
import { scanText } from "./check-leakage";
import { GitReservationStore, assertLease, liveLease, reservationServerTime, reservationTransition, RENEW_MS, sameCandidate,
  type Candidate, type Operation, type Lease } from "./integration-reservation";
import { latestIntegrationRun, verifyIntegrationProof } from "./integration-proof";
import type { API } from "./proof-reuse";

async function gh(...args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(err.trim());
  return out.trim();
}

if (import.meta.main) {
  let own: Lease | undefined, store: GitReservationStore | undefined;
  let actor = 0, repository = "";
  let timer: ReturnType<typeof setInterval> | undefined, pending = Promise.resolve(), lost: unknown;
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
      const snapshot = store!.read(), next = reservationTransition(snapshot.state, operation, actor, await clock());
      if (scanText("coordination", JSON.stringify(next)).length) throw new Error("Public coordination state failed the leakage gate");
      if (store!.publish(snapshot, next)) return next;
      await Bun.sleep(100 * 2 ** attempt);
    }
    throw new Error("Concurrent coordination update; bounded retries exhausted");
  }
  async function renew() {
    if (!own) throw new Error("No owned reservation");
    if (!sameCandidate(await candidate(own.candidate.pr), own.candidate)) throw new Error("Candidate head/base changed; reacquisition and new confirmation required");
    const state = await change({ kind: "renew", id: own.id }); own = state.active!;
  }
  async function acquire(desired: Candidate) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return (await change({ kind: "acquire", candidate: desired })).active!; }
      catch (error) {
        if (!String(error).includes("Integration busy:") || attempt === 2) throw error;
        console.error(String(error)); await Bun.sleep(1000 * 2 ** attempt);
        if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed while waiting for integration ownership");
      }
    }
    throw new Error("Bounded acquisition exhausted");
  }
  function heartbeat() {
    timer = setInterval(() => { pending = pending.then(async () => { if (!lost) try { await renew(); } catch (error) { lost = error; } }); return pending; }, RENEW_MS);
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
  async function merge(issueRefs: string[]) {
    if (!own) throw new Error("Explicit owned reservation required");
    heartbeat();
    const desired = own.candidate;
    const proof = await verifyIntegrationProof(store!.root, repository, desired, api, sha => { store!.git(["fetch", "origin", sha]); });
    await milestones(desired.pr, issueRefs);
    await stopHeartbeat();
    if (lost) throw lost;
    if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed before merge");
    assertLease(store!.read().state, own.id, actor, desired, await clock());
    await gh("pr", "merge", String(desired.pr), "--repo", repository, "--squash", "--match-head-commit", desired.head);
    const merged = await api.json(`pulls/${desired.pr}`);
    if (!merged.merged || !merged.merge_commit_sha) throw new Error("Merge not complete; no delivery claim");
    const commit = await api.json(`git/commits/${merged.merge_commit_sha}`);
    if (commit.parents?.length !== 1 || commit.parents[0]?.sha !== desired.base || commit.tree?.sha !== proof.checkout.tree) throw new Error("Actual squash parent/tree differ; reconcile actual main before claiming completion");
    store!.git(["fetch", "origin", "main"]); store!.git(["merge-base", "--is-ancestor", merged.merge_commit_sha, "origin/main"]);
    await milestones(desired.pr, issueRefs);
    await change({ kind: "release", id: own.id }); own = undefined;
    const main = await api.json(`actions/workflows/ci.yml/runs?event=push&head_sha=${merged.merge_commit_sha}&per_page=10`);
    const mainProof = "pending; inspect actual main jobs before claiming full completion";
    const observedMainConclusion = main.workflow_runs?.[0]?.conclusion ?? null;
    console.log(JSON.stringify({ merged: true, sha: merged.merge_commit_sha, candidateRun: proof.run, mainProof, observedMainConclusion }));
    process.exitCode = 2; // A run summary alone never completes actual main proof reconciliation.
  }
  try {
    const [command, target, ...options] = process.argv.slice(2), values = new Map<string, string>();
    for (let index = 0; index < options.length; index += 2) {
      const key = options[index]!, value = options[index + 1];
      if (!["--issues", "--lease"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid integration options");
      values.set(key, value);
    }
    const issues = values.has("--issues") ? values.get("--issues")!.split(",") : [];
    if (issues.some(value => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(value)) || issues.length > 20) throw new Error("Invalid delivered issue identities");
    repository = await gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    const user = JSON.parse(await gh("api", "user")); actor = user.id;
    store = new GitReservationStore(process.cwd());
    const remote = store.git(["remote", "get-url", "origin"]).replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || remote !== `https://github.com/${repository}`) throw new Error("Authenticated repository and origin differ");
    if (command === "inspect") {
      const snapshot = store.read(), now = await clock();
      console.log(JSON.stringify({ ...snapshot, live: liveLease(snapshot.state.active, now), serverTime: now }));
    } else if (command === "revoke") {
      const permission = await api.json(`collaborators/${encodeURIComponent(user.login)}/permission`);
      console.log(JSON.stringify(await change({ kind: "revoke", reason: target ?? "", maintainer: permission.permission === "admin" || ["admin", "maintain"].includes(permission.role_name) })));
    } else if (command === "release" || command === "renew") {
      const state = store.read().state;
      if (!state.active || state.active.id !== target || state.active.actor !== actor) throw new Error("Lease identity does not belong to this invocation");
      own = state.active;
      if (command === "renew") { await renew(); console.log(JSON.stringify(own)); own = undefined; }
      else { console.log(JSON.stringify(await change({ kind: "release", id: own.id }))); own = undefined; }
    } else if (["acquire", "confirm", "merge"].includes(command ?? "")) {
      if (!/^[1-9]\d*$/.test(target ?? "") || !Number.isSafeInteger(Number(target))) throw new Error("A PR number is required");
      if (command === "merge" && values.has("--lease")) {
        const current = store.read().state.active;
        if (current && current.id === values.get("--lease") && current.actor === actor && current.candidate.pr === Number(target) && current.candidate.repository === `https://github.com/${repository}`) own = current;
      }
      const desired = await candidate(Number(target));
      if (command === "merge") {
        const lease = values.get("--lease");
        if (!lease) throw new Error("Explicit --lease required");
        const state = store.read().state;
        if (state.active?.id === lease && state.active.actor === actor) own = state.active;
        assertLease(state, lease, actor, desired, await clock());
        await merge(issues);
      } else {
        own = await acquire(desired);
        console.log(JSON.stringify({ acquired: own }));
        if (command === "acquire") own = undefined; // Caller retains the explicit id.
        else {
          heartbeat();
          const previousRun = await latestIntegrationRun(api, "ci.yml", desired);
          const live = await api.json(`pulls/${desired.pr}`);
          if (!sameCandidate(await candidate(desired.pr), desired)) throw new Error("Candidate changed before confirmation request");
          assertLease(store.read().state, own.id, actor, desired, await clock());
          if (!live.draft) await gh("pr", "ready", String(desired.pr), "--repo", repository, "--undo");
          await gh("pr", "ready", String(desired.pr), "--repo", repository);
          while (!lost) {
            const run = await latestIntegrationRun(api, "ci.yml", desired);
            if (run?.id > (previousRun?.id ?? 0) && run.status === "completed") {
              const jobs = await api.json(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
              const metadata = jobs.jobs?.find((job: { name: string }) => job.name === "changeset");
              const log = metadata ? await api.log(metadata.id) : "";
              if (/"cadence":\s*"(?:draft|feedback)"/.test(log)) { await Bun.sleep(RENEW_MS); continue; }
              if (run.conclusion !== "success") throw new Error(`Candidate proof ${run.conclusion}; reservation released without retry`);
              await stopHeartbeat(); await merge(issues); break;
            }
            await Bun.sleep(RENEW_MS);
          }
          if (lost) throw lost;
        }
      }
    } else throw new Error("usage: bun scripts/integrate.ts inspect | acquire/confirm/merge <pr> [--lease id] [--issues owner/repo#N,...] | renew/release <id> | revoke <reason>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  } finally {
    await stopHeartbeat();
    if (own && store) try {
      const current = store.read().state.active;
      if (current?.id === own.id && current.actor === actor) await change({ kind: "release", id: own.id });
    } catch (error) { console.error(`Owned reservation cleanup unfinished: ${String(error)}`); process.exitCode = 1; }
  }
}
