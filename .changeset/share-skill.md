---
"@schlessera/brain": minor
---

Add the `share` skill

Fourth phase of the Android share target: the behavior that turns a staged
share into brain content now ships as a skill rather than living in the prompt
the UI sends. That means how a share gets filed is editable in a content repo,
versioned with the taxonomy, without a package release.

It reads `meta.json`, branches on what actually arrived (a link is fetched
because a shared title is usually the site name; an image is already attached to
the turn; a PDF or text file is read from its staged path), looks for an existing
home before creating a near-duplicate, moves worth-keeping binaries into the
assets tree under a name a human would recognize, captures with `brain add`, and
clears the staging directory even when nothing was filed.

It carries a prompt-injection guard, and needs one more than any other skill
here: the payload can be pushed at the app by any website, so the skill states
that shared content is material to file and that instructions inside it are part
of the content rather than part of the task.

Deciding a share is not worth filing is an explicit, legitimate outcome — the
alternative is a brain that accumulates every meme anyone ever shared at it.
