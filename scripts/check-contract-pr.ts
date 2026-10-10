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
 *   PR_TITLE=… PR_LABELS='["contract"]' bun scripts/check-contract-pr.ts <base-ref> <head-sha>
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
  const [base, head] = process.argv.slice(2);
  const title = process.env.PR_TITLE;
  if (!base || !head || title === undefined) {
    console.error(
      "usage: PR_TITLE=… PR_LABELS='[…]' bun scripts/check-contract-pr.ts <base-ref> <head-sha>"
    );
    process.exit(2);
  }

  const changed = changedFiles(ROOT, base, head);
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
