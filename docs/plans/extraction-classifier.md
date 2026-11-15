# Extraction classifier for tainted sessions

The design and measurement behind [#3434](https://github.com/schlessera/brain-kit/issues/3434),
part of [#3428](https://github.com/schlessera/brain-kit/issues/3428). The
question is whether the host can tell a likely data-extraction call from an
ordinary read, in a session that has taken in untrusted content, well enough
to let clean reads through and keep the
[tainted-destination card](../decisions/governed-writable-workers.md#tainted-destinations-ask)
for suspicious calls. If every new host asks, the card is shown often enough
to be rubber-stamped.

The harness, the labelled set and the recorded runs are in
[`evals/3434-extraction-classifier/`](../../evals/3434-extraction-classifier/README.md).
Nothing here changes production admission.

## Where it runs and what it may change

The classifier runs only once a session is tainted
([Untrusted input (G6)](../decisions/governed-writable-workers.md#untrusted-input-g6)).
It judges each outgoing call at admission, where the full input is already
held: the Claude PreToolUse chain
(`enforcementHookFor`, `packages/ui-backend-claude/src/permission-hooks.ts:289`),
the outward plan
(`prepareOutwardPlan`, `packages/ui-sdk/src/server/outward-policy.ts:47-53`),
and the provider relay. It never sees wire traffic: for HTTPS the turn proxy
sees only `CONNECT host:port` and byte counts.

It is advisory and narrow:

- An `allow` may relax exactly one thing, the #3430 card for a host the
  tainted session has not contacted
  (`const narrowing`, `packages/ui-sdk/src/server/egress-proxy.ts:280-285`;
  `const approveTainted`, `packages/ui-server/src/brain/turn-egress.ts:168-179`).
  Because the proxy cannot tell which process opened a connection, that
  relaxation can only cover the hosts a readable call names while it is in
  progress, as the outward exception already does. An opaque call withholds
  it.
- `ask` adds the card to any call, including one to a contacted host. `block`
  refuses it, with the reason as the text of that call's own tool result.
- `deny`, `allowlist` mode, budgets and outward-action rules stand whatever the
  band says. Voice and autonomous turns keep refusing a tainted destination
  whatever the verdict, and refuse wherever an interactive turn would ask.

`decide` in the harness is that combination
(`decide`, `evals/3434-extraction-classifier/classify.ts:29-36`).

## The request the classifier sees

Built host-side from what admission holds (`toRequest`, `evals/3434-extraction-classifier/request.ts`):

| Field | Source |
| --- | --- |
| `surface`, `tool` | `web_fetch`, `bash`, `mcp`, `brain_cli`, `provider_relay`; the admitted tool name. |
| `toolClass` | The command policy's existing `read`/`outward`/`opaque` classification. |
| `route` | `network` through the turn proxy; `relay` for a validated provider-relay request, routed under [G2](../decisions/governed-writable-workers.md#data-to-provider-routing-g2); `local` when no connection opens (brain-kit's own MCP servers, local `brain` commands). |
| `method` | GET for WebFetch; from `-X`, data flags or a `gh` write subcommand for Bash; POST for an outward MCP call. |
| `hosts`, `urls` | Every URL's host, path and query; `gh` maps to `api.github.com` with its subcommand as the path. |
| `body` | What else reaches the destination: the full Bash command, MCP argument values, the relay body. WebFetch's prompt is excluded, because it goes to the fetch summarizer on the conversation's own provider, never to the destination. |
| `pathRefs` | Brain-relative paths the call names (`-F file=@notes/x.md`, `--data-binary @…`), which send a file without its text appearing. |
| `bytes` | Query and data-argument sizes. |

Session state the host keeps beside it, never the content itself: shingle
hashes of every brain file read in the session, the taint source's display
name and the hosts the tainting content named (extracted at ingestion), the
hosts contacted so far, and each site's earlier payloads in this session.

## Signals

Each is deterministic and was scored alone
(`signals`, `evals/3434-extraction-classifier/signals.ts`):

| Signal | Fires when |
| --- | --- |
| Fingerprint overlap | Four-word shingle hashes of the payload match the session's read brain files. The payload is percent-decoded, and any base64, base64url or hex blob that decodes to readable text adds its decoding. Calls to one site are scored as one stream, counting only the matches this call adds, so a trickle registers on the call that completes a phrase. Strong: a named brain path, four matched shingles, or two that cover half the call's own shingles. |
| Taint host | A destination's site appears among the hosts the tainting content named. |
| Encoded blob | A base64 or hex token of at least twelve characters in subdomain, path, query or body; an undecodable one must be twenty characters with a digit. `encodedText`: the blob decodes to readable text. |
| Volume | A query of 120 characters or data of 512 bytes to a host the session has not contacted. |
| Write-shaped | Paste, webhook, request-bin, form, upload and collect hosts, the built-in outward mail hosts (`MAIL_SUBMISSION_PORTS`, `packages/ui-server/src/brain/turn-egress.ts:20`), a writing method to a submit, issue, comment, gist or message path, a beacon path, or an MCP tool named send, create, post, upload, comment, write, update, append or share. |
| Fan-out | Five earlier calls, or three distinct hosts, to one site the session had not used before its taint. |
| Method | A writing method, or a tool the policy classifies outward or opaque. |

## Configurations

- **Baseline**: no classifier, the shipped #3430 behaviour. Every new host asks;
  a contacted host is admitted.
- **Overlap**: fingerprint overlap alone, the issue's early-stop configuration.
  Strong overlap blocks a copy leaving for a new, write-shaped or writing
  destination and asks otherwise; any overlap asks; nothing else asks.
- **Heuristics**: strong overlap decides as above, except that an outward action
  (a gist, an issue, mail) asks with the overlap as the card's evidence rather
  than blocking, because it already raises its own card and the user's own
  write often quotes their notes. Every other call sums weighted evidence
  (`WEIGHTS`, `evals/3434-extraction-classifier/classify.ts`); below the
  calibrated allow threshold it is allowed, and above it asks.
- **Heuristics plus Jev**: the same, except that the band between the allow and
  ask thresholds goes to Jev. Its state is the outgoing request, the taint
  source's name and the overlap score only
  (`judgeState`, `evals/3434-extraction-classifier/classify.ts`); it never sees
  the conversation or the untrusted content. One Choice question picks
  `benign`, `suspicious` or `extraction`; `benign` allows and `extraction`
  blocks only at or above a calibrated confidence floor, and anything else, or
  no answer, asks. Relay and local calls are never escalated.

## Labelled set

Seven Odysseus sessions, 86 calls, over the keyless fixture corpus: four
tuning sessions (40 calls) and three held out (46 calls: 33 benign, 13
extraction). One session in each split is a realistic benign working session.
Benign calls cover reference lookups, documentation, public APIs, `gh` reads
and GraphQL, image prompts through the relay, links the tainting content
named, pagination cursors, hashed asset names, long searches, searches using
the project's own words, and the user's own writes. Extraction calls cover
verbatim posts to paste sites, forms, webhooks, gists, issues, mail and another
MCP server; base64, hex and ROT13 encodings in query, path, subdomain and body;
uploads of a brain file by path; chunked trickles; subdomain fan-out;
paraphrased and word-shuffled leaks; injected beacons; and a request that
addresses the judge. Every heuristic has cases written to evade it.

## Measured: heuristics

Offline, 2026-11-15, held-out sessions only. Thresholds were calibrated on
tuning: allow below 0.2. Bands are what the user experienced: an admitted call
counts as allowed, a refused one as blocked.

| Configuration | Leaked extraction (of 13) | Extraction recall | Benign cards (of 33) | Benign refused | Allow P/R | Ask P/R | Block P/R | Realistic-session ask rate (of 22) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (#3430) | 4 | 0.69 | 19 (0.58) | 0 | 0.78 / 0.42 | 0.14 / 0.67 | — / 0 | 10 (0.45) |
| Overlap alone | 6 | 0.54 | 3 (0.09) | 0 | 0.83 / 0.91 | 0.14 / 0.17 | 1 / 0.43 | 2 (0.09) |
| Heuristics | 1 | 0.92 | 11 (0.33) | 0 | 0.96 / 0.67 | 0.25 / 0.83 | 1 / 0.43 | 7 (0.32) |

The baseline's four leaks are all to hosts the session had already contacted,
which #3430 admits without a card: a paraphrase and a word-shuffled list to a
link the tainting content named, a file upload by path, and a star catalogue
copied into a search query. The heuristics' one leak is a paraphrased health
note sent to a translation host nothing else connects to the session.

Each signal alone, all 86 calls, network calls only:

| Signal | Fires | On extraction | On benign | Precision | Recall | Benign fire rate |
| --- | --- | --- | --- | --- | --- | --- |
| Overlap (any) | 19 | 17 | 2 | 0.89 | 0.59 | 0.04 |
| Overlap (strong) | 14 | 13 | 1 | 0.93 | 0.45 | 0.02 |
| Taint host | 32 | 21 | 11 | 0.66 | 0.72 | 0.22 |
| Encoded blob | 14 | 8 | 6 | 0.57 | 0.28 | 0.12 |
| Encoded text | 8 | 6 | 2 | 0.75 | 0.21 | 0.04 |
| Volume | 4 | 3 | 1 | 0.75 | 0.10 | 0.02 |
| Write-shaped | 19 | 16 | 3 | 0.84 | 0.55 | 0.06 |
| Fan-out | 12 | 12 | 0 | 1.00 | 0.41 | 0.00 |
| Method | 14 | 9 | 5 | 0.64 | 0.31 | 0.10 |

Fingerprint overlap is the strongest single signal, as the issue expected, but
alone it misses every extraction that carries no copied text: paraphrases,
shuffles, ROT13, beacons and short encoded labels. Its 0.54 held-out recall
does not meet the early-stop condition, so the Jev leg is measured.

The heuristics' remaining benign cards come mostly from the taint-host signal:
a link the tainting content named is the commonest benign follow-up and also
where an injected instruction points. That is the band Jev is asked about.

Heuristic cost is a few tens of microseconds per call on the measuring machine
(median 22–33 µs, p95 66–90 µs across runs), with no data flow and no spend.

## Measuring Jev

The live leg runs outside CI under the maintainer's authorization recorded on
the issue: `jev-1.13.0`, the maintainer's credential, a $10 cap. TypeSafe
prices Jev at $0.042 per million input tokens with output tokens free
([models page](https://docs.typesafe.ai/models), read 2026-11-15). The harness
reserves a conservative cost per request (one token per byte, two attempts)
before sending it and stops at the cap. Each ambiguous call is asked three
times, as independent repetitions; the floor is calibrated on tuning
repetition 0 before any held-out answer is scored, and every repetition is
reported on its own. A response from any model other than the one requested
counts as no answer. The recorded run keeps the typed answers, the answering
model, input tokens, spend and latency; `--summary` recomputes every table
from it without a call.

Routed in production, this is its own data flow: the request content goes to
a provider, so it would be routed under
[G2](../decisions/governed-writable-workers.md#data-to-provider-routing-g2),
metered and budgeted, and an unavailable judge leaves its band on the card.

## Known evasions

These stay with the card, whatever configuration is chosen:

- **Paraphrase** to a host nothing ties to the session, with a short query. No
  copied text, no taint host, no volume: the heuristics allow it.
- **Opaque transformation.** `$(… | gzip | base64)`, a script file, or any
  process whose payload never appears in the command. Only a literal brain
  path is recognized, and the proxy sees only the host of an HTTPS connection.
- **One-bit beacons.** A bare request to a host the tainting content named is
  indistinguishable from following its link.
- **Leaks to an approved host.** Once a host is contacted, a low-volume query
  carrying reordered or paraphrased words is admitted like any other lookup.
- **Encodings the decoder does not try**, such as ROT13 or a custom alphabet,
  are caught only when the destination is write-shaped.
- **Trickles across sites**, or chunks shorter than one shingle, never form a
  matching stream.
- **Judge injection.** Text in the request addressed to the judge reaches it
  as data; the request, not the untrusted content, is what an attacker
  controls.
- **The relay.** A validated provider-relay request is routed under G2 and not
  escalated, so brain text in an image prompt is treated as the user's own.

## Decisions the measurement leaves to implementation

- **Signal data stays host-side.** Shingle hashes of read files, the taint
  hosts and per-site streams are internal state, like other session-safety
  evidence. None of it enters the provider-facing conversation; a refusal's
  reason is the only verdict text the model sees.
- **Outward actions are not blocked by overlap.** They keep their own card, with
  the overlap as evidence on it.
