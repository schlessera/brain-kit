---
"@schlessera/brain-ui-kit": patch
---

ui-kit: visual regression, and the browser tests now run in CI at all.

Sixteen committed baselines covering the four assembled screens, the components
whose correctness is geometry rather than text, and two dense cards. They are
generated and compared only inside `mcr.microsoft.com/playwright:v1.63.0-noble`,
because browser rendering is not reproducible across environments — a
host-generated baseline compared in the container did not merely differ, it made
the matcher retry until the test timed out.

The larger half is that the 536 Storybook interaction and accessibility tests
ran nowhere but a developer's machine until now. The accessibility gate that was
proved with a seeded violation was, from the moment it landed, enforced by
nobody. Both projects now run in CI through the same script a developer runs
locally, so the two cannot drift.

No published behaviour changes; this is test infrastructure, and it ships as a
patch so the lockstep group has a reason recorded.
