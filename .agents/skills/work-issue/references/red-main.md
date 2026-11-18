# Main is red: work the incident

Read this when any command prints `main red at <sha>` — the hosted gate on
your PR's proof, a cancelled proof run, or `bun scripts/integrate.ts`
refusing `confirm`/`merge` — or when `main-status` reports `"red": true`.
The binding rules are in
[the CI decision](../../../../docs/decisions/ci-utility.md#red-main-record-and-coordinator).

Every orchestrator notices the same red main. Coordination goes only through
the red-main record and the one incident issue the coordinator filed; never
message other agents and never open a second incident.

## Identities

- **Worker ID**: the claim token of the issue you are working
  (`wi-<date>-<random>`). A worker with no claimed issue makes a fresh token.
- **Orchestrator ID**: a stable random token for your orchestrator session,
  such as `orch-<random>`, reused by every worker it runs.

Both are opaque tokens (`[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`), written to the
public coordination ref and incident: never a hostname, path, account or
person's name.

## Detect

1. Read `bun scripts/integrate.ts main-status --json` at most every 15
   minutes while you hold work that needs proof, and immediately after any
   `main red at <sha>` message. Never tight-poll.
2. `red: false` means there is nothing to do here. `record.open` is the
   incident: `firstBad`, `failures`, `incident` (issue number or `null`),
   `fixes` (declared PRs) and `claim`.
3. `incident: null` means the coordinator has not filed the issue yet. Do not
   file one. Keep working (see **Wait and resume**) and read again later.

## Stop doomed proof

4. Do not request proof, `confirm` or `merge` for a PR that is not a declared
   fix while main is red. Do not rerun refused or cancelled proof. Your own
   issue stays claimed and its branch stays yours. Exception: when every
   failure in the record is a post-merge category (`runtime`, `runtime_host`,
   `browser`, `layout`, `captures`, `endurance`), ordinary proof and merges
   continue; the gate says so
   ([hybrid ruling](../../../../docs/decisions/ci-utility.md#hybrid-post-merge-heavy-proof)).

## Find and deduplicate

5. Open the incident issue named in the record and read its body and every
   comment, newest last, before doing anything else.
6. Search open issues for each failing test path. Link any other open issue
   for the same failure on the incident instead of filing a new one:

   ```sh
   bun scripts/red-main-incident.ts evidence --worker <w> --orchestrator <o> \
     --kind duplicate --issue <n> --summary "<one line>"
   ```

   Use `--kind related --issue <n>` for an issue that is related but not the
   same failure.

## Claim the fix, or contribute

7. If `record.open.claim` is absent, `null` or expired, try to claim it:

   ```sh
   bun scripts/red-main-incident.ts claim --worker <w> --orchestrator <o>
   ```

   The claim is written into the record by compare-and-swap, so exactly one
   concurrent claimant wins. The winner is mirrored to the issue's assignment
   and a claim comment; taking over an expired claim posts a takeover comment
   naming the previous claimant.
8. `Fix claimed by worker … until …` means someone else owns the fix. You are
   a contributor: go to step 12.
9. As claimant, renew before the term ends (one hour from the last renewal),
   for example with every push or every 30 minutes:
   `bun scripts/red-main-incident.ts renew --worker <w> --orchestrator <o>`.
   If you stop owning the fix, `release` it so the next orchestrator can claim
   it without waiting for expiry.

## Claimant: assess, choose, record

10. Make a quick assessment, then choose a **fix PR** or a **targeted revert
    PR**. Decide from causal and current-tree evidence: a bisect or probe that
    reproduces at the first bad SHA and passes at its parent, a reproduction
    on current main, the failing assertion and the change that reaches it. A
    red check or the latest squash alone is not proof of cause. Assess what
    depends on or conflicts with the suspect change: a revert must preserve
    unrelated and later good work, so revert only the causal change and only
    when later squashes do not build on it. When neither change is
    supportable yet, say so and keep gathering evidence; do not guess.
11. Record the choice and its rationale on the incident before opening the PR:

    ```sh
    bun scripts/red-main-incident.ts evidence --worker <w> --orchestrator <o> \
      --kind decision --choice fix|revert|uncertain --sha <first-bad> \
      --summary "<one line>" --details-file <rationale.md>
    ```

    The details file states the cause evidence, the dependency and conflict
    assessment and, for `uncertain`, what evidence is still missing.
    Then open the PR against `main` with `Refs #<incident>`, and declare it,
    whether it is a fix or a revert:
    `bun scripts/integrate.ts declare-fix <pr>`. It then follows the normal
    route — required review, `check:pr`, hosted candidate proof, the
    collisions check and `bun scripts/integrate.ts confirm <pr> --issues …` —
    through the declared-red-main-fix path. Nothing merges it automatically,
    and a failed fix gets a new assessment and decision comment, not a retry
    loop. After the squash lands, read the main run that includes the failing
    set: only its green result clears the record. Record the merged SHA and
    that run on the incident as the exact recovery proof.

## Everyone: add evidence

12. Post what you learn in the fixed format, one comment per finding:

    ```sh
    bun scripts/red-main-incident.ts evidence --worker <w> --orchestrator <o> \
      --kind reproduction|bisect|log|ruled-out|fix-attempt \
      --summary "<one line>" [--sha <sha>] [--details-file <file>]
    ```

    Kinds: `reproduction` (reproduced or not, at which SHA), `bisect` (probe
    results), `log` (an excerpt with a link to the run), `ruled-out` (a
    hypothesis eliminated, and how), `fix-attempt` (an alternative change you
    tried). Read existing evidence first and do not repeat it. The command
    refuses while the incident is pending and never files an issue.
13. A contributor may also open an alternative declared fix PR when the
    claimant's approach stalls; it names the incident and follows the same
    route. Add a `fix-attempt` evidence comment linking it.

Add `--dry-run` to any command above to print the writes instead of sending
them.

## Wait and resume

14. While red, a worker whose proof was refused or cancelled keeps working
    without proof: code, `bun run test <files>`, `bun run check:pr`, review
    fixes, or evidence on the incident. Do not release your own issue's claim
    because main is red.
15. Resume proof when `main-status` reports `red: false`: rebase only if your
    change requires it, then request candidate confirmation as usual. A
    claimant whose fix merged releases nothing extra: clearing the record
    removes the claim.
