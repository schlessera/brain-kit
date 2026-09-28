---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

A markdown link in prose shows where it goes (#551, D49). Every link `BrainMarkdown` draws, apart from repo file and directory links, is classified by `classifyLink` on every surface: answers, share blocks, `ask_user`, the briefing and the file viewer, autolinks included. An accepted link keeps its text and shows the ASCII host beside it, `your bank (account-check.example)`, with `rel="noopener noreferrer nofollow"` and `referrerpolicy="no-referrer"`. A refused link is inert text followed by `[link withheld — <reason>]`. A `mailto:` link stays live with its address shown, and its query parameters (`subject`, `body`, `cc`, `bcc`) are dropped from the href. While an answer streams, a link that has not closed yet is held back, so no raw address or half-typed autolink is ever drawn.

`@schlessera/brain-ui-kit/links` gains `classifyMailto`, a check beside `classifyLink` for the one scheme prose keeps live. `classifyLink` is unchanged, and the `link` block still refuses `mailto:`.
