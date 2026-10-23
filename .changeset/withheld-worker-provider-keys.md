---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain": minor
"@schlessera/brain-module-images": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": minor
"@schlessera/brain-common": patch
---

Governed and strict turn workers no longer receive the `brain` CLI's provider keys (#1666). A worker keeps only its own inference credential where the host does not relay it, plus any name an operator admits through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` and the other provider credentials stay on the host. The brain's `.env*` files were already unreadable in these workers, and now there is a test for that.

A `brain` command that needs a withheld key names the provider and the key, and falls back where it can. `brain search` returns keyword results, `brain index --embeddings` builds a keyword index, and an enabled `jev` reranker keeps lifecycle order. `brain process` and `brain image` refuse. Each notice ends in a `[provider_unavailable …]` token. The worker learns which keys it lacks from the new `BRAIN_WITHHELD_KEYS` variable, which holds names only. The server records each token in a tool's result as a `provider_unavailable` governance event, at most 20 per turn. The capabilities note now says that secrets are hidden and names the keys a worker keeps.

To keep the old behaviour for a key until the metered relays land (#1673), admit it explicitly with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. Outside a worker, a brain without keys behaves as before.
