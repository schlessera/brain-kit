# Design prompts during triage

Read this when an issue needs a design prompt or an existing one needs review.
The GitHub skill's “Issues that need design” is the format authority. This
guide adds examples and rules for maintaining prompts against later rulings.

## Learn the existing pattern

Before writing the first new prompt in a pass, read **at least five existing
design prompts**, with their current issue bodies and relevant later comments.
The following five informed this skill; fetch their latest content rather
than treating these summaries or historical line numbers as current truth:

| Example | What to learn |
| --- | --- |
| [#612: homepage and landing pages](https://github.com/schlessera/brain-kit/issues/612#issuecomment-5908852129) | Separate page hierarchy/copy from undecided platform and visitor-data policy. Truthful feature proof, justified secondary pages and acceptable simpler outcomes matter. Its later example-corpus ruling shows why old constraints must be refreshed. |
| [#598: failed-activity bug reports](https://github.com/schlessera/brain-kit/issues/598#issuecomment-5908588846) | State the approved reporting policy, exact outgoing-data disclosure, absent/pruned/offline states and concrete allowlist questions. Do not turn a design prompt into a new privacy ruling. |
| [#316: spoken conversation](https://github.com/schlessera/brain-kit/issues/316#issuecomment-5824461590) | Compare still-open architectures without selecting one by implication; keep decided permission rules intact. Distinguish a design-producing spike from implementation awaiting its design. |
| [#114: approval announcement/refusal](https://github.com/schlessera/brain-kit/issues/114#issuecomment-5906608662) | Carry real upstream dependencies, pending/non-pending states, races and timeout behavior. The prompt does not make the dependencies complete. |
| [#61: cross-backend handoff](https://github.com/schlessera/brain-kit/issues/61#issuecomment-5869741735) | Preserve the chosen architecture and exclusions while designing entry, reviewed content, linkage, uncertain completion and focus. Moved source pointers need verification. |

If a comment is unavailable, choose another comparable prompt; fetch all
comment pages and read the complete prompt, not just its heading. Learn the
framing and specificity rather than copying unrelated constraints. Reuse
these readings across the pass; reread changed or issue-specific evidence.

## Check before adding or refreshing

Find prompts in the issue body/comments, linked design records and the parent.
Compare each against the latest approved scope, decisions, protocol/source
and dependencies at the inspected main SHA. Search moved anchors before
updating line citations. Verify technical capabilities against source or
primary upstream documentation when the design depends on them.

- A current usable prompt needs no duplicate comment.
- A stale prompt needs updated scope, pointers and constraints. Preserve valid
  parts. Edit the existing prompt when appropriate/authorized; otherwise post
  a replacement explicitly linking and superseding the old prompt. Say what
  changed and date it so the designer knows which version to use.
- An approved design needs its result folded into the issue's acceptance
  criteria and verification. Only then clear `needs: design`, provided no
  design questions remain. A proposed answer, prompt or mock alone is not approval.
- A design-producing spike can have a prompt without the prerequisite label.
  A pipeline/provider/architecture ruling uses `needs: decision`; do not
  disguise it as visual design. If independent UX questions also remain, keep
  both labels and state the ordering.

## Write a usable prompt

Start with two or three sentences in the issue's own terms: what is settled,
what judgment remains, and why code cannot answer it. Follow with a fenced,
self-contained prompt someone can paste into the designer's session. Use
this outline, adapting the questions and constraints to the actual issue:

```text
Design <specific interaction/surface> for <public issue URL>, under <epic if any>.

Read first:
- Current issue/epic scope and relevant dated rulings; identify the chosen branch.
- Verified source pointers with symbols and file:line citations at <main SHA>.
- Named binding decision records, existing components/stories and approved designs.

Problem:
<Concrete user scenario, current behavior and failing case; evidence source.>

Settled:
<Approved behavior, architecture, permissions, exclusions and dependencies.>
<Mark unresolved choices explicitly; a recommendation is not a ruling.>

Design:
1. <Precise hierarchy/placement/flow question, with relevant states.>
2. <Exact content/action/copy questions and available versus unavailable evidence.>
3. <Failure, cancellation, race, offline or uncertainty questions where applicable.>
4. <Responsive, keyboard/focus, touch and accessibility behavior where applicable.>

Requirements to hold:
<Only applicable binding rules, cited by record; what the design must not change.>
<Current tokens/themes, data-only and untrusted-content rules where relevant.>
<Honest unknowns/provenance/privacy and current approved fictional fixture world.>

Deliverable:
<Concrete proposal, exact copy and state/focus/action rules; ASCII mocks at 320px
and desktop for a visual product surface; implementation/browser criteria.>
<Acceptable smaller/no outcomes when permitted, evidence they require and who
reviews the proposal. Identify unresolved dependencies rather than inventing APIs.>
```

Name the binding decision records rather than assuming the designer knows a
decision number. Include effective touch targets, accessible names, focus,
long content, reduced motion and both themes when that surface requires
them. For nonvisual work, ask for the relevant artifact instead of forcing
screen mocks. Do not reopen approved navigation, grant/denial semantics or
accounting rules. Do not assume marketing pages inherit every app constraint.

Use current approved fictional fixtures and the latest corpus ruling; never
capture a private running instance, add real data or copy a superseded persona
split from an old prompt. State legitimate outcomes, including a documented
smaller design or no change when the scope allows it. Avoid a generic “make it
beautiful” brief, speculative feature claims and preapproved-looking answers.

Screen the full framing and prompt before posting. Ensure `needs: design`
remains for implementation awaiting approval, and record the prompt's source
SHA/date. Repeating triage should refresh evidence only when it changed.
