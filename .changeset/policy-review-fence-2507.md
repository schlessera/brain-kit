---
"@schlessera/brain-ui-server": patch
---

A policy proposal's review now splits frontmatter from body where the policy parser ends the frontmatter (#2507). Before, the review found the fences with its own pattern, which could disagree with what is enforced. A block with no closing fence, or opened by a `---` line carrying more text, was shown entirely as body even though its rules apply. A `---x` line was skipped as a closer, so the lines after it were shown as frontmatter although the parser ignores them. A `...` line ended the frontmatter, though the parser does not end it there. The approval card's frontmatter diff and body diff now show exactly the enforced block. The closing line with its trailing whitespace and line ending still counts as frontmatter. Proposals that were accepted before are still accepted.
