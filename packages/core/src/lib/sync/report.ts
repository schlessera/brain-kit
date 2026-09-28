/**
 * The terse report `brain sync run` ends with, built from its envelope alone:
 * what was committed, which conflicts were resolved and how, where the index
 * and the remote stand, and what was left for a person. Only lines with
 * something to say are printed.
 */

import type { RunEnvelope } from "./run.js";

const short = (sha: string) => sha.slice(0, 7);

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function renderReport(run: RunEnvelope): string {
  const { steps, leftovers } = run;
  const lines: string[] = [`brain sync: ${run.status}${run.reason ? ` — ${run.reason}` : ""}`];

  const commits: string[] = [];
  for (const assess of steps.assess) {
    if ("skipped" in assess) continue;
    const ignore = assess.fixed.committed;
    if (ignore?.status === "committed") commits.push(`${short(ignore.sha)} Ignore generated artifacts and secrets`);
  }
  for (const commit of steps.commit) {
    for (const result of commit.commits) {
      commits.push("sha" in result ? `${short(result.sha)} ${result.subject}` : `FAILED ${result.subject}: ${result.error}`);
    }
  }
  for (const done of steps.conclude) {
    if (done.outcome === "committed") commits.push(`${done.kind} commit (${done.kind === "merge" ? "conflicts resolved" : "concluded"})`);
  }
  if (commits.length > 0) lines.push("Commits:", ...commits.map((line) => `  ${line}`));

  const resolved = steps.resolve.flatMap((step) => step.resolved);
  if (resolved.length > 0) {
    lines.push("Resolved:");
    for (const file of resolved) {
      const judged = file.decisions.jev > 0 ? `, ${file.decisions.jev} judged` : "";
      lines.push(`  ${file.path} — ${file.strategy}${judged}`);
      for (const note of file.notes) lines.push(`    ${note}`);
    }
  }

  const pull = steps.pull[steps.pull.length - 1];
  if (pull) {
    const rounds = steps.pull.length > 1 ? ` after ${steps.pull.length} pulls` : "";
    const settled = pull.status === "conflicted" && run.status !== "needs-judgment" ? ", resolved" : "";
    lines.push(`Pull: ${pull.status}${settled}${rounds} (local +${pull.localAhead}, remote +${pull.remoteAhead})`);
  }
  const push = steps.push[steps.push.length - 1];
  if (push) lines.push(`Push: ${push.status}`);
  const post = steps.postSync[steps.postSync.length - 1];
  if (post) {
    lines.push(`Index: ${post.index}; skills: ${post.skills}; caches: ${post.cacheCommit}`);
    lines.push(`Sync: ${post.sync} (local ${post.localHead}, remote ${post.remoteHead})`);
  }

  // Ignoring is never silent: a note whose name only looks like a secret
  // (`*_token*`) would otherwise drop out of the brain without a word.
  const ignored = steps.assess.flatMap((assess) => ("skipped" in assess || assess.fixed.refused !== undefined ? [] : assess.fixed.ignored));
  if (ignored.length > 0) {
    lines.push("Ignored:", ...ignored.flatMap((add) => add.paths.map((path) => `  ${path} (${add.reason === "sensitive" ? "looks like a secret" : "artifact"}; .gitignore: ${add.line})`)));
  }
  const tracked = steps.assess.flatMap((assess) => ("skipped" in assess ? [] : assess.fixed.trackedArtifacts));
  const left: string[] = [
    ...leftovers.unresolved.map((file) => `unresolved: ${file.path} — ${file.reason}`),
    ...leftovers.unknown.map((path) => `unknown: ${path}`),
    ...leftovers.media.map((file) => `media: ${file.path} (${size(file.bytes)})`),
    ...tracked.map((file) => `tracked ${file.reason === "sensitive" ? "secret" : "artifact"}: ${file.path}`),
    ...ignored
      .filter((add) => add.reason === "sensitive")
      .flatMap((add) => add.paths.map((path) => `ignored as a secret, check it is one: ${path}`)),
  ];
  if (left.length > 0) lines.push("Left for you:", ...left.map((line) => `  ${line}`));
  return lines.join("\n");
}
