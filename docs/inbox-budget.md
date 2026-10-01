# Autonomous admission budgets

## Interactive capacity and yield

`MAX_AUTONOMOUS_RUNS` defaults to two; positive integers select the autonomous
pool size. Claims and conservative reservations acquire this capacity in the
same transaction, counting a batch as one operation. Interactive WS sessions
retain their separate capacity. Neither setting enables production dispatch.

`BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS` defaults to 20000 and accepts positive
integers below the normal 30000 ms interactive lock-wait bound. Only continued
same-target interactive contention signals an autonomous holder; short calls
and independent keys do not yield. The server commits the checkpoint before
abort. The backend drains its actual writer before settlement and recovery.
Observed spend and the attempted operation remain charged; unused conservative
reservation is released according to the existing complete-receipt rules.

Completed calls are retained as append-only operational receipts, even across
restart. A fresh attempt does not replay a runtime transcript and refuses the
same completed effectful tool/input pair; named first-party reads may be
repeated to inspect current state. Current authority still applies to every other
call. The receipt comparison ignores object key order. A tool with different
inputs is a new call, not a semantic deduplication of filesystem effects.
Every claim consumes an attempt. Yield or expired-lease recovery makes work
ready within its attempt limit, then leaves failed work with one dead-letter
Action when the limit is exhausted.

## Accounting

The Queue budget ledger belongs to the UI operational database, alongside
claims and leases. Markdown remains content authority and `brain.db` is not
involved. The concrete internal budget code is not a storage-provider seam.
Production dispatch stays gated by the complete autonomous v1 containment,
admission and system proof.

## Admission and configuration

A single immediate SQLite transaction checks eligibility, counts charged spend
plus active reservations, claims the Queue items and writes the reservation.
Model work starts after that transaction ends. Two processes cannot each admit
work using the same remaining dollars or operations. Immediately before the
backend starts, the headless turn acquires its active reservation once and
checks its owning claim, attempt, lease and principal identity.

`resolveServerConfig()` supplies `inbox.budget`. Embedded configurations may
omit this optional field; omission cannot enable dispatch. The environment
settings are documented in the [server reference](../packages/ui-server/README.md#environment).

| Setting | Default | Meaning |
| --- | --- | --- |
| `BRAIN_UI_AUTONOMOUS_SPEND_USD_PER_DAY` | `5` | Normal non-subscription admission cap in USD. |
| `BRAIN_UI_AUTONOMOUS_TURNS_PER_DAY` | `0` | Normal model-bearing operation cap; configure explicitly to admit work. |
| `BRAIN_UI_AUTONOMOUS_EMERGENCY_SPEND_USD` | `0` | Separate bounded daily emergency USD reserve. |
| `BRAIN_UI_AUTONOMOUS_EMERGENCY_TURNS` | `0` | Separate bounded daily emergency operation reserve. |
| `BRAIN_UI_AUTONOMOUS_TIMEZONE` | `UTC` | IANA calendar used at admission. |
| `BRAIN_UI_AUTONOMOUS_UNPRICED_USD_PER_TOKEN` | `0.01` | Positive pessimistic per-token rate for missing prices. |

Invalid numeric values or timezones fail startup. Dollar accounting rounds
up to whole microdollars. Every separately dispatched model-bearing operation
counts one turn, including a T1 batch, T2 execution, retry, redo or separate
projection compaction. Compaction folded into an existing call consumes that
call's reservation. SDK-internal tool loops are included in the operation's
conservative token estimate rather than using incompatible backend turn counts.
Future v2 operations must enter the same admission path when enabled.

Server code chooses principal, billing identity, pricing route, model and
conservative counts covering the whole operation. Model/client values cannot
select these or the emergency reserve. API operations without usable counts
are refused. A confirmed subscription operation reserves zero dollars and
one turn. Normal and emergency pools each have ceilings; their combined
ceiling also holds. High priority alone never selects emergency capacity.

The [October 1 maintainer ruling](https://github.com/schlessera/brain-kit/issues/678#issuecomment-5926691626)
chooses conservative admission reservations. They estimate a running
operation's cost; they are not provider-enforced invoice limits. A reported
overrun remains charged in full and can stop later work even in the emergency
pool. This unit adds no backend or inference-transport spend enforcement.

## Settlement, unknown costs and recovery

The reservation freezes admission day, selected pricing route/rates,
pessimistic rate and missing-usage fallback. A terminal Activity rollup and
its settlement commit together. Settlement records observed cost separately
from conservative charged cost, releases the unused reservation once and
freezes the result. Duplicate rollups cannot reprice it. A live partial rollup
cannot release an active reservation.

All four token classes contribute: input, output, cache read and cache creation.
The root's per-model usage already includes subagents; child spans are not
added again. Complete API receipts use frozen effective cost where available
or the admission pricing snapshot. Missing model/cache rates use the frozen
pessimistic rate, retain unknown observed cost and create one Action per model,
suppressed durably across restart. Missing or incomplete token receipts keep
at least the reservation and any larger observed lower bound. An empty map or
one zero field is not proof of a free call. Complete explicit zero usage is
zero; confirmed subscription billing is also zero dollars while counting turns.

Actual runtime billing evidence overrides the selected classification. An
observed API call cannot be erased by an expected subscription classification;
explicitly unknown billing remains unknown and charged conservatively.
Unreserved autonomous Activity also consumes capacity, pessimistically when
unknown. Interactive and cron Activity do not consume this ledger.

Lease recovery reconciles costs before making work ready. A crash without a
terminal complete receipt keeps the whole reservation and any larger known
spend. Yield with a terminal receipt retains its spend and turn before a retry
gets a new reservation. Settlement uses the original admission day across
midnight and DST. Migration `024_inbox_budget.sql` preserves existing rows;
legacy rows without a pricing snapshot retain their reservation on recovery.

Refused over-cap admissions leave work ready without consuming an attempt and
create one durable FYI per local day, shared by normal and emergency failures.
Repeated concurrent attempts and process restarts do not duplicate it.
