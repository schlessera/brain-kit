# Duplicate pi worker acquisition: reachability and teardown

This report answers [#2918](https://github.com/schlessera/brain-kit/issues/2918).
Source was read and the runtime receipt was recorded on 2026-11-03 at main
`adf371ffab5da62abfd311d95a6583100b22b324`. The test used keyless real workers
under bwrap on Linux. No model or provider was contacted.

## Result

**Reachable, through the public backend, but not through ui-server.** Two
concurrent `startTurn` calls on one `createPiBackend()` instance, both
resuming the same non-resident session, each launch and initialize their own
real worker. The acquisition that returns second loses the pool race. It
receives `BackendBusyError`, emits no frames and never prompts. The winner is
not signalled and finishes with its normal `success` result. At the moment the
loser's refusal settles, though, its worker has not exited, its turn temp has
not been closed and its stdio release has not been awaited. This is the gap
the [#2863 lifecycle ruling](https://github.com/schlessera/brain-kit/issues/2863#issuecomment-6391630082)
forbids. The repair was handed off as
[#3488](https://github.com/schlessera/brain-kit/issues/3488), which now makes
the refusal wait for that teardown. The sections below describe the code as
it was measured.

The new-session duplicate branch cannot be reached by production
worker-backed sessions.

## Call paths

**The pool.** A production backend has no `sessionFactory`, so it never
retains a session (`createSessionPool(runtime, Boolean(options.sessionFactory), options.log)`,
`packages/ui-backend-pi/src/backend.ts:117-120`). `finish()` removes and
disposes every interactive entry when its turn ends. That makes every resume
non-resident, and every resume opens a worker. A resumed acquisition checks
the map, awaits `runtime.openSession` and then checks the map again. If
another acquisition registered the session in the meantime, it calls
synchronous `disposeSession(opened.session)` and then either refuses
`BackendBusyError` or claims the idle entry (`if (req.sessionId)`,
`packages/ui-backend-pi/src/session-pool.ts:77-101`). Without retention, an
entry in the map is always running, so in production the loser always
refuses busy. The runner re-throws that refusal to its caller unchanged
(`let acquired`, `packages/ui-backend-pi/src/turn-runner.ts:63-84`).

**The new-session branch.** A worker-backed session's identity is
`resumeId ?? randomUUID()` (`const sessionId = resumeId`,
`packages/ui-backend-pi/src/worker-session.ts:112`). Autonomous acquisitions
return before the map is consulted (`runtime.newSession`, `packages/ui-backend-pi/src/session-pool.ts:103-105`).
So the duplicate check
(`sessions.get(created.session.sessionId)`, `packages/ui-backend-pi/src/session-pool.ts:106-119`)
fires only for injected `sessionFactory` doubles, which reuse identities.

**ui-server.** The interactive turn path admits one in-flight `startTurn` per
session. `handleChatMessage` queues a message for a session found in
`startingBySession` or `bySession`
(`const runningTurn`, `packages/ui-server/src/ws/run-session.ts:1226-1257`). Otherwise it calls
`runSession`, which calls `runRetainedSession`. That registers
`startingBySession` before its first await
(`runRetainedSession`, `packages/ui-server/src/ws/run-session.ts:201-216`). Nothing on that path
awaits between the check and the registration. The turn then moves to
`bySession` (`coordinator.running.add(turn)`, `packages/ui-server/src/ws/run-session.ts:288-289`), awaits
`backend.startTurn` directly (`await backend.startTurn`, `packages/ui-server/src/ws/run-session.ts:792`),
and releases `bySession` only in the slot's final `finally`
(`coordinator.bySession.get(turn.sessionId) === turn`, `packages/ui-server/src/ws/run-session.ts:1003-1005`). Retry admission refuses
on the same two maps (`coordinator.bySession.has(msg.sessionId)`, `packages/ui-server/src/ws/dispatch.ts:242`). The other
two backend callers run autonomous turns and pass no `sessionId`: the handoff
summary (`await backend.startTurn`, `packages/ui-server/src/ws/handoff.ts:374-388`) and inbox work
(`installApplication(request`, `packages/ui-server/src/inbox/autonomous-turn.ts:409-417`).

The SDK contract suite also resumes a session while it is running
(`busy-ness is per session`, `packages/ui-sdk/src/testing/index.ts:558-575`). That entry is resident, so
the pool refuses before any worker opens. The contract treats a concurrent
same-session resume as supported input that must refuse busy. A host that
calls the backend directly, without ui-server's coordinator, can therefore
reach the loser branch.

## Losing-worker lifecycle today

`dispose()` sets `ended`, ends stdin and requests SIGKILL synchronously
(`dispose()`, `packages/ui-backend-pi/src/worker-session.ts:776`). For a worker that was
never prompted, the only turn-temp close is a detached hook on exit, and its
refusal is swallowed (`A worker that never ran a turn`, `packages/ui-backend-pi/src/worker-session.ts:318-322`).
Nothing calls the launcher's `released()` (`stdioReleased`,
`packages/ui-backend-pi/src/worker-session.ts:357`) for this worker. The
awaited owner already exists: the session's shared inactive `abort()` waits
for exit and protocol consumption, then the turn-temp close, then the bounded
stdio release (`abort()`, `packages/ui-backend-pi/src/worker-session.ts:758-774`).
#2880 uses it for cancelled acquisitions (`cancelAcquiredSession`,
`packages/ui-backend-pi/src/session-pool.ts:176-183`).

## Runtime receipt

`packages/ui-backend-pi/tests/duplicate-acquisition.test.ts` runs the real
launcher with a credential-free shell protocol peer. It gates both
`openPiWorkerSession` returns until each owns a ready worker, then releases
the winner. After the winner has registered and reached its prompt, it
releases the loser. The test tells the two apart by each turn's own signal,
and identifies each worker by its turn-temp root. The committed assertions
hold the facts a repair must keep: two distinct launches, a busy refusal for
the loser with no frames and no prompt, the winner not signalled while
running, the loser stopped, the winner's normal result, the winner's single
turn-temp close and stdio release, and the loser's eventual exit.

A temporary probe, not committed, recorded the loser's state at two moments.
The result was the same in three runs:

| Moment | Loser exited | Kill requests | Turn-temp closes | Stdio releases | Ledger above baseline |
| --- | --- | --- | --- | --- | --- |
| Loser's `BackendBusyError` settled (winner still prompting) | no | 1 | 0 | 0 | 512 MiB (both workers' reservations) |
| Winner settled, loser exited | yes | 1 | 1 (detached hook) | 0 | 0 |

So the detached hook eventually releases the reservation, and Bun eventually
closed the FIFO descriptors. Neither the refusal nor any other owner waits
for either step, and a refused close would be lost.

Mutation receipts for the committed test:

- Removing the loser's `disposeSession(opened.session)` fails
  `PI_DUPLICATE_RESUME_LOSER_IS_STOPPED` (expected > 0, received 0).
- Disposing `raced.session` instead fails
  `PI_DUPLICATE_RESUME_WINNER_NOT_STOPPED_BY_LOSER` (expected 0, received 1).
- Removing the busy refusal fails `PI_DUPLICATE_RESUME_LOSER_REFUSES_BUSY`
  (received `undefined`).

## Repair handoff

[#3488](https://github.com/schlessera/brain-kit/issues/3488) specifies the
narrow owner under the existing ruling. The losing resumed acquisition decides
busy or reuse, and claims a reused entry, synchronously. It then awaits its
own worker's shared inactive `abort()`, disposes it and re-raises the original
outcome. A cleanup refusal is reported, not substituted. That issue also
carries the failing-first and mutation plan. Public `dispose()`, the busy and
result shapes, worker protocols and release bounds are unchanged, so the
contract impact is none.

## Limitations

The receipt replaces the pi worker entry with a shell protocol peer, and it
uses the governed fixture sandbox. A separate-UID broker close and a refused
close on the loser path were not exercised. #3488 covers the refused close.
Concurrent resumes from separate server processes use separate pools, and this
branch does not cover them.
