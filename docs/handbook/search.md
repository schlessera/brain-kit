# Search by words and meaning

Start with keyword search. It is useful immediately, needs no model credentials
and gives you a straightforward way to check whether a captured note is there.

## Use words you expect to find

```sh
brain search "sailcloth" --mode fts
```

This searches the full-text index. Specific terms, names and phrases are good
starting points. Open the returned file and follow its links when you need
more than the search excerpt.

If you edited the file yourself and the result is missing or outdated, refresh
the index with `brain index` before assuming you need a different search method.

## Add semantic search for paraphrases

Semantic search helps when your question and the record use different words.
A question about getting ready to leave might relate to a note about raft
supplies even when they do not share the exact phrase.

It requires a configured embedding provider and indexed vectors. Provider
accounts have their own costs, quotas and data policies. Read the
[provider configuration reference on GitHub](../configuration.md#providers)
before choosing one. Once configured, build the vectors with:

```sh
brain index --embeddings
```

Keyword search remains available when optional provider features are disabled.
Indexing with embeddings can also request generated context and asset
descriptions; consider that work when assessing provider cost and privacy.

## Retrieval gives you context, not a verdict

A highly ranked record can still be outdated or incomplete. Read its dates,
qualifications and supporting links. Ask the agent to distinguish what the
records say from what it infers, particularly when records disagree.

If you want to tune search, use a few real questions you need answered and
compare the useful records they return. The
[search evaluation guide on GitHub](../evaluating-search.md) covers a more
formal measurement workflow without making it part of everyday use.
