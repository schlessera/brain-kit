/**
 * Contract gate.
 *
 * `docs/integration-contract.md` asks for a `CONTRACT:` commit prefix on every
 * contract change. Nothing enforced it, and between 0.33.0 and 0.37.0 at least
 * six commits added contract surface without the prefix. Each was additive, so
 * nothing broke — but an audit that trusted the prefix undercounted, and after
 * 1.0 the same omission on a breaking change ships a break in a minor.
 *
 * The canonical index and every Markdown component under
 * docs/integration-contract/ are authoritative parts; the gate keys on all of
 * them. A pull request that changes any part must be titled `CONTRACT:` and
 * carry the `contract` label; a pull request titled `CONTRACT:` or labelled
 * `contract` must change one of those parts. PRs are squash-merged, which makes
 * the title the commit subject, so the title is what gets checked.
 *
 * The diff is the PR's own: from where its branch left the base to its head
 * commit. Not the synthetic merge commit a `pull_request` checkout gives by
 * default — diffed against the base, that hides a doc edit which also landed
 * on the base through another PR, and would reject a correctly titled one.
 *
 * The base is the one the PR declares. The workflow reads it from the PR
 * itself at run time, never from the event context: for an upper layer of a
 * native stack, GitHub reports the stack's base (`main`) as `github.base_ref`
 * on `edited` events, and a diff against `main` charges the layer with its
 * parent's contract edit (#2650). A base that cannot be read or fetched fails
 * the gate; it never falls back to `main`.
 *
 *   PR_TITLE=… PR_LABELS='["contract"]' bun scripts/check-contract-pr.ts <base-ref> <head-sha>
 *   PR_NUMBER=… GH_TOKEN=… PR_TITLE=… bun scripts/check-contract-pr.ts --declared-base <head-sha>
 */

import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

export const CONTRACT_DOC = "docs/integration-contract.md";
export const CONTRACT_PREFIX = "CONTRACT:";
export const CONTRACT_LABEL = "contract";

export interface ContractVerdict {
  touchesDoc: boolean;
  titled: boolean;
  labelled: boolean;
  /** One line per disagreement; empty when the three agree. */
  problems: string[];
  ok: boolean;
}

export function judge(title: string, labels: string[], changed: string[]): ContractVerdict {
  const changedContract = changed.find((file) => file === CONTRACT_DOC
    || /^docs\/integration-contract\/.+\.md$/.test(file));
  const touchesDoc = changedContract !== undefined;
  const titled = title.trimStart().startsWith(CONTRACT_PREFIX);
  const labelled = labels.includes(CONTRACT_LABEL);

  const problems: string[] = [];
  if (touchesDoc && !titled) {
    problems.push(`${changedContract} changed, but the title does not start with \`${CONTRACT_PREFIX}\`.`);
  }
  if (touchesDoc && !labelled) {
    problems.push(`${changedContract} changed, but the PR does not carry the \`${CONTRACT_LABEL}\` label.`);
  }
  if (!touchesDoc && titled) {
    problems.push(`The title starts with \`${CONTRACT_PREFIX}\`, but ${CONTRACT_DOC} and its authoritative components did not change.`);
  }
  if (!touchesDoc && labelled) {
    problems.push(`The PR carries the \`${CONTRACT_LABEL}\` label, but ${CONTRACT_DOC} and its authoritative components did not change.`);
  }
  return { touchesDoc, titled, labelled, problems, ok: problems.length === 0 };
}

/** Files the PR changes: `base...head`, i.e. since the merge base. `null`
 * when git cannot answer, which the caller must not read as "no change". */
export function changedFiles(cwd: string, base: string, head: string): string[] | null {
  const result = Bun.spawnSync(["git", "diff", "--name-only", `${base}...${head}`], { cwd });
  if (result.exitCode !== 0) {
    console.error(`git diff ${base}...${head} failed:`);
    console.error(new TextDecoder().decode(result.stderr));
    return null;
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const LOOKUP_ATTEMPTS = 3;

/** The remote-tracking ref of the base the PR declares right now, read from
 * the PR object rather than the event. Throws, with the reason, when the PR
 * cannot be identified, the lookup fails, or the base is not fetched. */
export async function declaredBase(cwd: string, env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch, retryDelayMs = 2000): Promise<string> {
  const number = env.PR_NUMBER ?? "";
  if (!/^[1-9][0-9]*$/.test(number)) throw new Error(`PR_NUMBER is not a pull request number: ${JSON.stringify(number)}`);
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`GITHUB_REPOSITORY is not owner/name: ${JSON.stringify(repository)}`);
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN is required to read the PR's declared base");
  const api = new URL(env.GITHUB_API_URL || "https://api.github.com");
  if (api.protocol !== "https:" && !(api.protocol === "http:" && api.hostname === "127.0.0.1")) {
    throw new Error(`GITHUB_API_URL must be https: ${api.href}`);
  }
  const url = `${api.href.replace(/\/$/, "")}/repos/${repository}/pulls/${number}`;

  let pr: any;
  for (let attempt = 1; ; attempt++) {
    let response: Response | undefined;
    let failure: string;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(15000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (response?.ok) { pr = await response.json().catch(() => undefined); break; }
    // A refusal is an answer; only a server or network failure is worth repeating.
    if (response && response.status < 500) throw new Error(`Reading PR #${number} failed: ${failure}`);
    if (attempt >= LOOKUP_ATTEMPTS) throw new Error(`Reading PR #${number} failed after ${attempt} attempts: ${failure}`);
    await Bun.sleep(retryDelayMs * attempt);
  }

  if (pr?.number !== Number(number)) throw new Error(`The lookup for PR #${number} did not return that pull request`);
  if (pr.base?.repo?.full_name !== repository) {
    throw new Error(`PR #${number} declares a base outside ${repository}: ${JSON.stringify(pr.base?.repo?.full_name ?? null)}`);
  }
  const ref = pr.base?.ref;
  const valid = typeof ref === "string" && !ref.startsWith("-") &&
    Bun.spawnSync(["git", "check-ref-format", "--branch", ref], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (!valid) throw new Error(`PR #${number} declares no valid base branch: ${JSON.stringify(ref ?? null)}`);
  const tracking = `refs/remotes/origin/${ref}`;
  if (Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${tracking}^{commit}`], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    throw new Error(`PR #${number} declares base ${ref}, but the checkout has not fetched origin/${ref}`);
  }
  const reported = env.EVENT_BASE_REF;
  console.log(`Contract base: origin/${ref}, declared by PR #${number}` +
    (reported === undefined ? "." : reported === ref ? "; the event agrees." : `; the event reported ${JSON.stringify(reported)}.`));
  return tracking;
}

/** `PR_LABELS` as the workflow passes it: a JSON array of label names. */
export function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((l) => typeof l === "string")) {
    throw new Error(`PR_LABELS is not a JSON array of strings: ${raw}`);
  }
  return parsed;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const resolveBase = args[0] === "--declared-base";
  let [base, head] = resolveBase ? [undefined, args[1]] : args;
  const title = process.env.PR_TITLE;
  if ((!resolveBase && !base) || !head || title === undefined) {
    console.error(
      "usage: PR_TITLE=… PR_LABELS='[…]' bun scripts/check-contract-pr.ts <base-ref> <head-sha>\n" +
      "       PR_NUMBER=… GH_TOKEN=… PR_TITLE=… bun scripts/check-contract-pr.ts --declared-base <head-sha>"
    );
    process.exit(2);
  }
  if (resolveBase) {
    try {
      base = await declaredBase(ROOT, process.env);
    } catch (error) {
      // A gate that cannot name the PR's base must not pick one.
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  }

  const changed = changedFiles(ROOT, base!, head);
  // A gate that cannot see the diff must not report success.
  if (changed === null) process.exit(2);

  const verdict = judge(title, parseLabels(process.env.PR_LABELS), changed);
  if (verdict.ok) {
    console.log(
      verdict.touchesDoc
        ? `Contract change, titled \`${CONTRACT_PREFIX}\` and labelled \`${CONTRACT_LABEL}\`.`
        : `${CONTRACT_DOC} and its authoritative components unchanged; not a contract change.`
    );
    process.exit(0);
  }

  for (const problem of verdict.problems) console.error(problem);
  console.error(
    `\nA change to the integration contract updates ${CONTRACT_DOC} or an authoritative component, is titled` +
      `\n\`${CONTRACT_PREFIX} <type>(<scope>): …\` and carries the \`${CONTRACT_LABEL}\` label.` +
      `\nA change that is not one does none of the three. See CONTRIBUTING.md.`
  );
  process.exit(1);
}
