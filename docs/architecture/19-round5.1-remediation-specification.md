# Round 5.1 — Command Runtime Invariant Repair Specification

**Document nature:** frozen Round 5.1 specification (规范) and remediation record (整改记录). It is **not** a final acceptance certificate: automated results and real-runtime verification status are recorded separately by the final gate report.
**Repository:** `iphone2059/SemiconFab-Next`, branch `main`.
**Baseline commit (start of Round 5.1):** `9e62c3d8869d9cae1825fb42758bb6ddc4be3e7c` (tree after Round 5 remediation).
**Previous round:** Round 5 remediation commit `4c8f0c1` (user-authored command-runtime correctness fixes; specification in `docs/architecture/18-round5-remediation-specification.md`).
**Round:** Round 5.1.
**Goal:** repair the remaining P1/P2 invariant violations found by the Round 5 re-review. This is **not** a re-architecture: no new state machine, no second authority, no compatibility layer.
**Date:** 2026-10-30.

> This document supersedes the *remaining* P1/P2 obligations of
> `docs/architecture/18-round5-remediation-specification.md`. The Round 5 document
> stays untouched as history; where this document and Round 5 differ, this document
> and the source of truth in `web_app/src` win. Round 4 residual risks remain
> tracked in `docs/architecture/17-round4-remediation-record.md`.

## 0. Reading guide and source of truth

Round 5.1 changes exactly six production contracts/implementations and the tests
that exercise them:

| Area | Source of truth (actual implementation) |
|---|---|
| Command result / cursor / connection contracts | `web_app/src/contracts/command-events.contract.ts` |
| Workflow source-channel contract | `web_app/src/contracts/command-workflow.contract.ts` |
| Realtime transport + three-cursor ledger + connection status | `web_app/src/realtime/command-event-source.transport.ts` |
| Bridge (realtime vs authoritative delivery, conflicts) | `web_app/src/runtime/command-event-bridge.ts` |
| Correlation watermarks (revision + outcome) | `web_app/src/runtime/command-correlation-registry.ts` |
| Bounded recovery queue / conflict records | `web_app/src/runtime/command-event-recovery.ts` |
| Recovery state machine, final barriers, lazy SSE, TTL timers | `web_app/src/runtime/fab-runtime.ts` |
| XState machine / adapter (expired + terminal correction) | `web_app/src/runtime/equipment-command.machine.ts`, `web_app/src/runtime/xstate-command-workflow-adapter.ts` |
| Authority list/journal queries (scheduler) | `web_app/src/runtime/fab-reconciliation-scheduler.ts` |
| Composition root (production lazy subscription) | `web_app/src/app/runtime-bootstrap.tsx` |
| Test doubles that must be protocol-faithful | `web_app/tests/support/command-fakes.ts` |

Contract rule: documentation describes the *actual* names and semantics of these
files. If the brief and the source ever differ, the source wins and the difference
is recorded in §12.4; do not "fix" the document by inventing an API.

---

# 1. Baseline, scope, and inherited state

## 1.1 Baseline facts

- Layer under change: `web_app` frontend only (Effect 4 runtime + XState 6 actor +
  SSE transport + scheduler). Backend DTOs/algorithms are unchanged by Round 5.1;
  the backend remains the only authority for command state.
- Baseline SHA `9e62c3d` contains the Round 5 source remediation (commit
  `4c8f0c1`) and the Round 5 specification. Round 5.1 starts from the invariant
  gaps re-review found *after* that remediation.
- Deployment context is unchanged: production composes one FAB by default; the
  architecture supports 1–32 independent FABs and per-FAB isolation is frozen
  (§2.5).

## 1.2 What Round 5.1 is

1. Repair of the remaining P1/P2 *invariant* violations: recovery acceptance
   barrier, revision/outcome conflict semantics, realtime-vs-authoritative source
   isolation, the delivered cursor, connection lifecycle, on-demand command SSE,
   independent retention timers, and test-double fidelity.
2. Contract tightening in the two shared contract files (already frozen by the
   Lead before source work): `receiveRealtime`/`receiveAuthoritative`,
   `CommandConnectionStatus` including `closed`, and a **required**
   `CommandSourceCursors.pendingAcknowledgements: number`.
3. Test changes that assert the invariants instead of call order, including
   protocol-faithful fakes.

## 1.3 What Round 5.1 is not

- No new recovery state machine, no second workflow registry, no second command
  cache, no compatibility shim, no dual implementation.
- No weakening of assertions/TTLs/retry budgets to make the suite green.
- No promotion of realtime events to authoritative events, and no fabrication of
  terminal outcomes for unknown commands.
- No "keep every SSE open" workaround for the Healthy invariant.

## 1.4 Round 5.1 defect register

| ID | Defect class | Repair target |
|---|---|---|
| P1-01 | Recovery could report `Healthy` while held/conflicting events, pending ACK entries or a new dirty episode still existed; cover was not a two-sided barrier | Two independent barriers (pre-cover and post-cover) inside one synchronous commit window; uncorrelated/conflict signals force a list-only pass; post-cover `pendingAcknowledgements` must be a real zero |
| P1-02 | Same revision with different outcome was silently deduped; conflicts were not represented anywhere; an authoritative record could not correct a wrong (including terminal) projection | Correlation truth table with `conflict`; bounded conflict records in the recovery queue; bridge conflict path without ACK; authoritative correction including terminal correction |
| P1-03 | One source-agnostic `receive` let realtime events revive `expired-unresolved` workflows or "correct" same-revision conflicts | `receiveRealtime` / `receiveAuthoritative` contract split; state machine `RESULT_REALTIME` / `RESULT_AUTHORITATIVE` events; expired state never reactivatable by realtime |
| P1-04 | Authoritative cover advanced `delivered`, forging "published to a bounded consumer" | Cover may mark ledger entries covered / release latch / replace `ledgerEpoch` / advance `acknowledged` — never `delivered` |
| P2-01 | `CommandConnectionStatus` had no deliberate-close state; `failed` and `closed` were conflated; status was not published for every attempt | Five-state lifecycle `connecting/open/reconnecting/failed/closed` with replay of current state to the first subscriber and no failed→closed downgrade |
| P2-02 | Every FAB opened a command SSE at start even with no command activity | Demand-driven subscription: reservation / active workflow / held event or conflict demand; `closed` is legal idle; at most one SSE per FAB; no connection per workflow |
| P2-03 | One sweep timer and one TTL coupled workflow retention and correlation retention | Independent `workflowSweepTimer` and `correlationSweepTimer` with independent TTLs; `TTL=0` disables only time-based eviction of that kind, never capacity bounds or the other TTL |
| P2-04 | Test fakes implemented an older protocol (generic `receive`, optional `pendingAcknowledgements`, cover that advanced delivered) and could hide invariant violations | Protocol-faithful fakes: realtime/authoritative channels, required pending-ACK accounting, configurable connection status and cover result, delivered-but-unapplied seam |

---

# 2. Frozen global invariants

The following invariants bind every module. No local implementation may satisfy
its own tests by violating them.

## 2.1 Recovery Healthy invariant (Dirty → Healthy is a proof, not a state flag)

A FabRuntime may enter `Healthy` only when **all twelve** conditions hold for the
*current* recovery generation. "Recovery completed" is never a single boolean.

1. **Current recovery generation.** The owner generation `g` is still the live
   generation (`isRecoveryCurrent(g)` / `ensureRecoveryCurrent(g)`): not disposed,
   still started, and `g === recoveryGeneration`. A superseded generation may not
   write phase, projection or timers.
2. **Authoritative List/Journal snapshot fully applied.** The pass produced a
   verified `RecoverySnapshot`: for a list pass, every record of the full
   `listFabCommands(..., 'all')` result was accepted by `receiveAuthoritative`
   with outcome `applied`/`stale-covered`; for a journal pass, the page loop
   reached `latestSequence` with epoch/sequence/retention validation intact.
3. **Post-snapshot reconciliation done.** Every still-active command was
   reconciled through the scheduler batch and every
   `ReconciliationResult` is converged: no `failed`, `timed-out`, `cancelled` or
   `not-found` for a command that is still active (`batchFailure === undefined`).
4. **No pending DropIntent.** No post-snapshot scheduler-queue drop intent remains
   relative to this snapshot: `pendingDrops` is empty, or every generation is
   `<= snapshot.dropBarrier` (proven covered). `overflowDropGeneration` must be
   covered too. A drop after the snapshot forces `needsNextAuthoritativePass`.
5. **No pending Recovery request.** `pendingRecovery === undefined` and
   `recoveryPending === false`. A merged request (dirty/reconnect/replay-gap/
   uncorrelated/conflict/queue-capacity/protocol-error) invalidates the pass.
6. **`CommandEventBridge.pendingCount === 0`.** The bounded recovery queue is
   empty: no held (uncorrelated/unapplied) event **and** no unresolved conflict
   record. `pendingCount` is `recovery.size` (held + conflicts); it is not just a
   held-event counter.
7. **No unresolved event conflicts.** `bridge.conflictCount === 0`. A same-revision
   different-outcome protocol conflict is only resolved by a validated
   authoritative record (P1-02).
8. **Transport ACK cover status `covered`.** `source.cover({epoch,sequence}, kind,
   lossBarrier)` returned `{ status: 'covered' }` for this snapshot; a
   `status: 'insufficient'` answer is a pass failure, never a warning to ignore.
9. **Post-cover `pendingAcknowledgements === 0`.** Immediately after the successful
   cover, the transport reports a real zero delivered-but-not-yet-applied ledger
   count. This field is **required** by contract; a source that omits it (or
   returns `undefined`) is a barrier failure — never treat "absent" as zero.
10. **Realtime availability `ready`.** `realtimeAvailability === 'ready'`; a
    transport that is (or became) unavailable yields `Degraded`, never `Healthy`.
11. **Connection status `open`.** `connectionStatus === 'open'` and the observation
    is current for this barrier. A deliberately `closed` connection is legal idle
    (never `failed`, never `open`): an idle-closed runtime is `Degraded`, not
    `Healthy`, and the runtime must not force-open the stream just to satisfy this
    condition — the next real command demand opens it and a new authoritative pass
    re-earns `Healthy`.
12. **Current generation not invalidated by new Dirty/Conflict/Rejection events.**
    Between the successful cover and the Healthy commit there is **no async yield
    point**: all reads in conditions 4–11 happen synchronously inside the same
    `Effect.gen` step, and a new dirty/conflict/rejection signal that arrives in
    that window (a) sets `needsNextAuthoritativePass`, (b) merges a list-only
    recovery request, and (c) prevents `Healthy`.

### 2.1.1 Four distinct facts (do not collapse them)

`Healthy` needs four independent proofs. Each can succeed while the others have
failed, so none may substitute for another:

| Fact | What it proves | What it does NOT prove |
|---|---|---|
| **HTTP recovery success** | The gateway answered (page/list response). | That the local actor applied it, that active commands converged, or that the transport safe prefix advanced. |
| **List application** | Authoritative records were delivered to actors via `receiveAuthoritative`. | That the post-snapshot scheduler batch converged, or that the ACK ledger is clean. |
| **Actor batch completion** | The scheduler reconciled every active command to a converged result. | That the transport saw and will never see a pending/held/conflicting frame, or that cover is safe. |
| **ACK cover success** | The transport accepted the authoritative watermark and released a provable latch. | That the actor projection is correct, that the connection is open, or that the ledger is drained after cover. |

Consequently the commit pipeline in §3 is strictly: snapshot → apply → batch →
**pre-cover barrier** → cover → **post-cover barrier** → commit phase. Cover
success alone never means `Healthy` (see `docs/command-reconciliation.md`).

## 2.2 Correlation invariant (revision + outcome)

For each `(fabId, commandId)` the correlation registry maintains:

- `observed` revision: the highest revision seen on the wire (dedupe/ordering);
- `applied` revision: the highest revision an actor projection provably applied;
- recorded `outcome` of the current highest observed revision;
- terminal bookkeeping (completion-order sequence, counts).

Frozen rules:

1. Revision within one command is **monotonic**: a lower revision is `stale` and
   can never roll state or watermarks back.
2. **Same revision must have the same outcome.** `revision === current &&
   outcome === recorded` is `duplicate`; `revision === current && outcome !==
   recorded` is a **protocol conflict** (`conflict`), not a duplicate. A conflict
   never mutates the recorded entry and is never applied to the actor through the
   realtime path.
3. `observed` and `applied` are separate watermarks. Observing a revision does not
   apply it. `applied` advances only via `markApplied(event)` after the actor
   projection proved it advanced, and only when the event outcome agrees with the
   recorded outcome.
4. Same-revision different-outcome is resolvable **only by authority**: a
   validated authoritative List/Journal record (`observeAuthoritative`) may set
   the recorded outcome to the authoritative one (resolving the conflict) and a
   terminal projection may be corrected; realtime can never do either.
5. `applied <= observed`; a stale/duplicate frame does not prove application.

## 2.3 Expired-unresolved invariant

`expired-unresolved` (过期未决) is a **client recovery disposition**, not a
business outcome:

1. It is set only by Recovery: `workflow.markExpiredUnresolved()` when a
   *validated full authoritative List* proved the command absent while it was
   still locally active. The projection then carries
   `recoveryDisposition === 'expired-unresolved'` while retaining the last known
   revision/outcome (often `executing`).
2. Realtime can **never** clear or move it: `receiveRealtime` on an expired
   workflow is a no-op for any revision/outcome (for example a late SSE
   `executing` revision 5, or `succeeded` revision 6, or `failed` revision 7 must
   not reactivate it).
3. Only a validated authoritative record can resolve it: after
   identity/revision/outcome validation, `receiveAuthoritative` applies the
   record, updates the projection and returns the disposition to `tracked`
   (equal authoritative revision resolves the uncertainty; a higher revision
   advances).
4. Never fabricate `succeeded`/`failed`/`cancelled` for an unknown command. The
   UI must be able to show "result unknown / unresolved", and no terminal
   business action may be taken from an expired disposition.
5. Expired-unresolved is terminal *for delivery* (`isTerminalCommand` treats it as
   no longer active, so it does not block Healthy and is not reconciled forever),
   but it is not a business terminal outcome and must not be reported as one.

## 2.4 Three-cursor invariant

The transport maintains three conservative cursors that are never
interchangeable:

| Cursor | Definition | Advanced only by |
|---|---|---|
| `observed` | highest SSE position actually observed (valid SSE `id:`) | parsing a valid SSE id |
| `delivered` | highest position actually **published to the bounded consumer queue** | a successful `commandResults.publish` of a real SSE frame |
| `acknowledged` | last safe ACK prefix: every earlier delivered event is `applied` or `covered` | a contiguous `applied|covered` prefix (ordered ACK ledger), or an authoritative cover |

Frozen rules:

1. **Same epoch:** `acknowledged.sequence <= delivered.sequence <=
   observed.sequence`. The invariant is checked at all times and is the reason
   cover may never touch `delivered`.
2. **Cross-epoch:** positions are compared by **epoch identity, never by sequence
   ordering**. A cover with a new epoch replaces the acknowledged epoch (and may
   replace `ledgerEpoch`) but does not turn the cover watermark into a delivered
   frame. `delivered` remains in the old epoch until a **real SSE frame of the new
   epoch** is actually published to bounded consumers — at which point
   `delivered` moves to that actually-published sequence.
3. An authoritative List cover may advance `acknowledged` (and mark ledger
   entries covered / replace `ledgerEpoch` / release a proven ACK latch) but
   **may never advance `delivered`** (P1-04).
4. `observed` and `delivered` are never recovery start positions; recovery starts
   from `acknowledged` (or is list-only). `pendingAcknowledgements` is the real
   count of delivered-but-still-pending ordered-ledger entries and is a required
   cursor field.
5. A lost/unprovable position engages the ACK latch (`ackBlockedUntilCover`); it
   is released only by a cover that provably covers every untracked position
   (§ `10-adr-command-cursor-ack-protocol.md`).

## 2.5 Frozen modules (no Round 5.1 redesign)

These were delivered by earlier rounds and remain frozen; Round 5.1 must not
weaken them to satisfy its own repair:

1. **Admission reservation.** `reserveCommandAdmission()` reserves capacity before
   the HTTP POST and has exactly one terminal transition: `commit` (HTTP 202
   accepted) or `release` (failure/cancel). A reservation is never burned twice
   and never silently abandoned.
2. **Accepted Registration.** Once the backend answered HTTP 202, the command must
   be registered locally (`registerAcceptedCommand()`); the frontend must never
   re-reject it. Frontend `maxActiveCommands` admission runs at reservation time,
   before the POST, not after the 202.
3. **Scheduler.** `FabReconciliationScheduler` owns independent waiters for one
   shared physical request: cancelling one waiter never cancels work another
   waiter still needs; the last waiter cancellation really interrupts the request.
   Per-command results are explicit (`succeeded | already-terminal | not-found |
   failed | timed-out | cancelled | dropped`).
4. **PhysicalRequestBudget.** The shared permit is released only after the request
   has actually completed/aborted; a timeout first interrupts the fetch, then
   releases the permit. Recovery and scheduler share the per-FAB budget.
5. **Scope tree.** `AppScope → FabScope → {CommandScope, RecoveryScope,
   CommandTransportScope}`; every fiber/timer/resource has exactly one owner and a
   finalizer. Disposing a scope interrupts its children before it returns.
6. **Recovery scope/generation/fiber interruption.** One owned pass fiber in the
   RecoveryScope; generation-stamped; `stop()/dispose()` bump the generation first,
   interrupt the fiber (fetch abort, permit release) and only then return. A stale
   generation can never write projection/phase, cover, or schedule.
7. **Per-FAB isolation.** Every bridge/correlation/recovery/scheduler/transport
   instance is per FAB; composite identity `(fabId, commandId)` is used for
   storage/lookup; disposing FAB A never affects FAB B.

---

# 3. P1-01 — Recovery final acceptance barrier (恢复最终验收屏障)

**Priority:** highest.
**Files:** `web_app/src/runtime/fab-runtime.ts` (primary),
`web_app/tests/integration/fab-runtime.test.ts`,
`web_app/tests/integration/fab-runtime-batch23.test.ts`,
`web_app/src/contracts/command-events.contract.ts` (pending-ACK contract),
`web_app/tests/support/command-fakes.ts` (fake seams).

## 3.1 Problem

After Round 5, the pass order was: snapshot → post-snapshot batch → drop check →
pending request check → realtime check → `source.cover` → Healthy. The single
cover was treated as the last word:

- a held event or an unresolved conflict arriving after the batch was not part of
  the acceptance decision;
- a cover could return `covered` while the ordered ACK ledger still had pending
  entries above the cover watermark;
- a realtime transport that was unavailable, or a connection that was not
  `open`, could be bypassed by ordering;
- there was no two-sided (pre/post) barrier, so an event delivered concurrently
  with the cover could be lost between the decision and the Healthy commit.

## 3.2 Required change

Inside `completeRecoveryEffect(generation, snapshot)`, after the snapshot was
verified and after the post-snapshot scheduler batch completed:

### (a) PRE-COVER barrier

Evaluate synchronously, before calling cover:

1. `pendingRecovery === undefined`;
2. `recoveryPending === false`;
3. `bridge.pendingCount === 0` (held events **and** conflicts);
4. effective pending drop count === 0 using the generation/dropBarrier
   semantics (a drop with generation `<= snapshot.dropBarrier` is proven covered
   by this snapshot and must not count as new loss);
5. `bridge.conflictCount === 0`;
6. `batchFailure === undefined` (every still-active command converged);
7. `realtimeAvailability === 'ready'`;
8. `connectionStatus === 'open'`.

If the pre-cover barrier fails: do **not** become Healthy, do **not** clear
pending state, always set `needsNextAuthoritativePass = true` and record a
bounded diagnostic. Then branch by failure kind (as implemented by
`handleHealthyBarrierFailure`):

- **Correctness evidence** (pending recovery request/queued pass, bridge
  held/conflicted result, uncovered post-snapshot drop intent, batch failure):
  merge a list-only recovery request
  (`mergeRecoveryRequest({ listOnly: true, cause: 'protocol-error' })`) and
  continue through the existing bounded compensation path
  (`scheduleCompensationPass(generation)` / retry budget; per-command batch
  failures keep the existing bounded backoff). The next authoritative **List**
  pass must resolve the condition; exhaustion still ends in `Unrecoverable`,
  never `Healthy`.
- **Environment readiness** (`realtimeAvailability !== 'ready'` or
  `connectionStatus !== 'open'`): set phase `Degraded` and do **not** enter the
  compensation loop (there is no authoritative correctness gap to compensate);
  the next connection-status transition re-arms exactly one authoritative pass.
  Never force the stream open to pass this barrier and never report `Healthy`
  while it is not open.

### (b) COVER

```ts
const cover = source.cover(
  { epoch: snapshot.epoch, sequence: snapshot.sequence },
  snapshot.kind,           // 'journal' | 'list' -> CommandCoverAuthority
  snapshot.lossBarrier,
);
if (cover.status !== 'covered') { /* typed pass failure; retry path */ }
```

Only `status === 'covered'` continues. `insufficient` is a pass failure (the
transport keeps its latch and requires another authoritative List).

### (c) POST-COVER barrier (same synchronous window as the cover)

Immediately after the successful cover, in the *same* `Effect.gen` step, with no
async yield between cover and commit, re-read:

1. `bridge.pendingCount === 0`;
2. `source.cursors.pendingAcknowledgements === 0` — required numeric; an absent
   value is a barrier failure, never zero;
3. no unresolved conflict (`bridge.conflictCount === 0`);
4. `pendingRecovery === undefined`;
5. `recoveryPending === false`.

The post-cover barrier does not re-read `realtimeAvailability`/`connectionStatus`:
the pre-cover check plus the no-async-yield rule guarantee they cannot change in
this window; `completeRecoverySuccess` still re-reads them before publishing
`Healthy`.

If the post-cover barrier fails: do **not** become Healthy; do **not** clear the
pending ACK/ledger state; do **not** modify `delivered` (the runtime never does);
merge a list-only recovery request; keep the ACK/ledger state as it is; schedule
the next authoritative List pass through the existing compensation path
(`handleHealthyBarrierFailure` + `scheduleCompensationPass`).

Only after both barriers pass may `completeRecoverySuccess(snapshot)` run
(resetting attempts, clearing the active request, resolving covered drops, and
committing `Healthy` iff `recoveryAvailable && realtimeAvailability === 'ready' &&
connectionStatus === 'open'` — otherwise `Degraded`).

### (d) Uncorrelated-event and conflict paths

Wire the bridge callbacks in the FabRuntime constructor:

```ts
onUncorrelated: (event) => this.onBridgeUncorrelated(event),
onConflict:     (event) => this.onBridgeConflict(event),
```

Both handlers must:

- record a bounded diagnostic (no payload beyond identity/revision);
- set `needsNextAuthoritativePass = true`;
- merge `{ listOnly: true }` into the pending recovery request;
- **not ACK** the event;
- if started, recovery authority is available and no pass is running/scheduled:
  clear the retry timer, enter Dirty and schedule the recovery pass. They must
  never start a second parallel recovery executor; a running pass must observe the
  merged request at its pre-cover barrier.

### (e) ACK-contract note

`CommandSourceCursors.pendingAcknowledgements` is a required `number` (not
optional). Every real source and every fake source must report it. Recovery may
only treat a real `0` as proof. This is the only way condition 9 of §2.1 can be
satisfied without trusting "no data".

## 3.3 Acceptance tests

- `web_app/tests/integration/fab-runtime.test.ts`:
  - "does not become healthy when an uncorrelated event arrives during
    post-snapshot reconciliation": Dirty → List recovery → snapshot applied →
    pause the batch → inject a realtime event for a command with no workflow →
    resume → assert `bridge.pendingCount > 0`, runtime records the event
    (`recoveryHistory`/`needsNextAuthoritativePass`), phase 
    `!== 'Healthy'`, and a new List pass is scheduled; the next List returns the
    authoritative record and Healthy is re-earned only after resolution.
  - "does not become healthy when cover succeeds but pending acknowledgements
    remain": cover returns `covered` while
    `cursors.pendingAcknowledgements === 1` (delivered-but-unapplied ledger entry
    above the snapshot sequence) → phase `!== 'Healthy'`; the next authoritative
    List cover of the pending entry → Healthy.
  - P2-01/P2-02/P2-03 integration cases (§7–§9 below).
- `web_app/tests/integration/fab-runtime-batch23.test.ts`: post-snapshot race
  cases — snapshot applied, then a new event/request arrives during the
  post-snapshot batch → compensation List pass, never Healthy in between,
  converges after authority resolves.
- Fakes: see P2-04 (§10) — the fake must expose a configurable cover result and a
  delivered-but-unapplied accounting seam; the pending-ACK barrier must be
  testable without weakening production code.

---

# 4. P1-02 — Correlation revision/outcome conflicts and authoritative correction

**Priority:** high.
**Files:** `web_app/src/runtime/command-correlation-registry.ts`,
`web_app/src/runtime/command-event-recovery.ts`,
`web_app/src/runtime/command-event-bridge.ts`; tests:
`web_app/tests/contract/command-correlation.test.ts`,
`web_app/tests/contract/command-recovery.test.ts`,
`web_app/tests/integration/command-event-bridge.test.ts`.

## 4.1 Problem

Round 5 separated `observed` from `applied`, but treated
"same revision" as always duplicate. If the backend emits the same revision with
a different outcome (a protocol violation/correction) the second event was
dropped without evidence, so:

- the wrong projection could never be corrected;
- the runtime could never prove "no unresolved conflict" and therefore could
  satisfy the Healthy barrier while a real conflict existed;
- an authoritative snapshot could not correct a wrong *terminal* projection
  because terminal states had effectively sealed the actor.

## 4.2 Required change

### (a) Correlation truth table

`CorrelationDecision = 'new' | 'duplicate' | 'stale' | 'conflict'`.
The entry keeps the recorded `outcome` of the current highest observed revision
(`occurredAt` never participates in ordering).

`observe(event)` (realtime only):

| Condition | Decision | Entry mutation |
|---|---|---|
| no record | `new` | record revision/outcome/terminal bookkeeping |
| `revision > current` | `new` | record (preserve applied watermark) |
| `revision === current && outcome === recorded` | `duplicate` | none |
| `revision === current && outcome !== recorded` | `conflict` | **none** |
| `revision < current` | `stale` | none |

`observeAuthoritative(event)` (authority only):

| Condition | Decision | Entry mutation |
|---|---|---|
| no record | `new` | record |
| `revision > current` | `new` | record (update outcome/terminal bookkeeping) |
| `revision === current` | `new` if outcome changed (authoritative resolution/correction), else `duplicate` | recorded outcome := authoritative outcome; terminal bookkeeping stays coherent (terminal order/seq/entries/updatedAt) |
| `revision < current` | `stale` | none — never roll back |

Additional requirements:

- `markApplied(event)` may advance the applied watermark only when the event
  `outcome` equals the current recorded outcome; otherwise it does nothing. It
  stays forward-only. If the entry is missing, a defensive `observe(event)`.
- `lastObservedOutcome(fabId, commandId): CommandOutcome | undefined`.
- Keep `sweep()`/capacity bounds coherent when a same-revision authoritative
  correction flips active↔terminal or changes terminal outcome.
- Retention semantics (terminal TTL/caps, maxEntries, per-event O(1)) are
  unchanged; Round 5.1 does not add a second index.

### (b) Bounded recovery queue conflicts

```ts
export type CommandRecoveryHoldResult = 'inserted' | 'duplicate' | 'conflict';
```

- `hold(event)`: same command + same revision + same outcome → `duplicate` (no
  insert); same revision + different outcome → `conflict` (no insert, never
  overwrite the already-held event); otherwise insert → `inserted`. Capacity
  eviction policy unchanged.
- `holdConflict(event)`: called by the bridge when *correlation* says
  `conflict` (including when the earlier event was already applied/released).
  Stores a bounded conflict record (fabId, commandId, revision, conflicting event,
  optional held original/outcome, arrival sequence). Bounded capacity (~64) with
  payload-free diagnostics.
- Conflicts participate in `size`/`pendingCount` but are **excluded** from
  `snapshot()`/`drain()`/`pendingFor()` and are never applied by
  `flushRecovery()`; no ACK for conflicts.
- `resolveAuthoritative(event)`: remove every conflict for the same
  `(fabId, commandId)` with revision `<=` the authoritative event revision;
  return the removed count. Called by the bridge after a successful authoritative
  application.
- `size` = held events + conflicts; `conflictCount` getter; `conflicts` readonly
  getter; `clear()/dispose()` clear conflicts too.

### (c) Bridge conflict path and source isolation

`CommandDeliveryOutcome` adds `'conflict'`; bridge options add
`onConflict?: (event: CommandResultEvent) => void` (alongside the existing
`onUncorrelated`, `onResultDelivered`, `onRejected`).

`receive(event)` (realtime path only — the source does not matter, a queue retry
of a realtime event is still realtime):

1. foreign FAB → `'ignored'`;
2. `decision = correlation.observe(event)`;
   - `'conflict'` → `recovery.holdConflict(event)`; `onConflict?.(event)`;
     return `'conflict'` — **never ACK**, even if `appliedRevision >= revision`;
3. `'duplicate'`/`'stale'` with `appliedRevision >= revision` → ACK the event and
   return `'duplicate-applied'`/`'stale-covered'` (existing behavior, including
   `onRejected` when an observation is still unapplied);
4. missing workflow → `hold(event)` + `onUncorrelated` → `'held'`;
5. workflow → `applyToWorkflow(workflow, event, 'realtime')`.

`receiveAuthoritative(event)` (List/Journal only):

1. foreign FAB → `'ignored'`;
2. `decision = correlation.observeAuthoritative(event)` (this is what resolves a
   same-revision conflict and records the authoritative outcome);
3. missing workflow → hold (single hold; do not double-report);
4. workflow → `applyToWorkflow(workflow, event, 'authoritative')`;
5. on a successful outcome (`applied` / `stale-covered`) call
   `recovery.resolveAuthoritative(event)` to clear conflicts with
   revision `<=`; on rejection hold + `onRejected` (existing behavior).

`applyToWorkflow(workflow, event, channel)` calls `workflow.receiveRealtime()` or
`workflow.receiveAuthoritative()` **based only on the channel**. Projection
verification is unchanged: after applying, if
`(projection.revision ?? -1) < event.revision` → `'rejected'`; if
`projection.revision === event.revision` and
`projection.outcome !== event.outcome` → `'rejected'`; otherwise
`correlation.markApplied(event)`, `onResultDelivered`, `source.acknowledge(event)`
and return `applied`/`stale-covered`. The authoritative path must be able to
correct a terminal wrong projection because the adapter/machine now accepts an
authoritative same-revision correction (P1-03).

### (d) pendingCount / flush semantics

- `CommandEventBridge.pendingCount = recovery.size` — **held events + conflicts**.
- `conflictCount` exposes unresolved conflicts.
- `flushRecovery()`: held queued events keep **realtime** semantics (a queued SSE
  event is never upgraded to authoritative); release only when applied or
  stale-covered; rejected events are re-held and reported via `onRejected`;
  conflicts are untouched; return shape stays `{ applied, held, rejected }`.
- An uncorrelated event (held) and a conflict both trigger the FabRuntime
  list-only recovery path (§3.2d); neither is ACKed.

## 4.3 Acceptance tests

- `web_app/tests/contract/command-correlation.test.ts`: `rev3 accepted` then
  `rev3 accepted` → duplicate; `rev3 accepted` then `rev3 failed` → conflict;
  `rev3 executing` then `rev3 succeeded` → conflict; authoritative same revision
  resolves the conflict and records the authoritative outcome; authoritative
  higher revision converges; authoritative lower revision is stale with no
  rollback; `markApplied` refuses an outcome that disagrees with the recorded
  outcome and does not advance applied; `lastObservedOutcome`; terminal↔active
  correction keeps `terminalCount`/`sweep` coherent; existing retention/perf/
  validation tests unchanged.
- `web_app/tests/contract/command-recovery.test.ts`: hold returns
  inserted/duplicate/conflict per matrix; same revision + different outcome never
  overwrites the first held event; `holdConflict` participates in size and is
  excluded from snapshot/flush/drain; `resolveAuthoritative` clears `<=` revision
  and leaves higher ones; conflicts are bounded; existing capacity/order tests
  updated (the old "keeps one held record for a duplicate revision" test now
  asserts a conflict).
- `web_app/tests/integration/command-event-bridge.test.ts`: uncorrelated →
  `held`, `pendingCount > 0`, `onUncorrelated` called, no ACK; conflict: apply
  `rev3 accepted`, then `rev3 failed` → `conflict`, `onConflict` called,
  `pendingCount` includes it, no ACK (acknowledged cursor unchanged), workflow not
  re-delivered; then `receiveAuthoritative(failed rev3)` → projection corrected,
  `conflictCount === 0`; "already applied then conflict then authority" matrix
  row; realtime/authoritative channel routing asserted through the fake workflow;
  authoritative same-revision correction of a terminal projection; CE-01..CE-05
  and lifecycle/defect tests adapted and green.

---

# 5. P1-03 — Realtime vs authoritative source split and expired semantics

**Priority:** high.
**Files:** `web_app/src/contracts/command-workflow.contract.ts` (Lead-frozen),
`web_app/src/runtime/equipment-command.machine.ts`,
`web_app/src/runtime/xstate-command-workflow-adapter.ts`;
tests: `web_app/tests/contract/command-workflow.test.ts`.

## 5.1 Problem

The old `CommandWorkflow.receive(event)` had no source channel, so any caller —
including a recovery queue retry of an SSE frame — looked like authority. As a
result a late realtime event could revive an `expired-unresolved` workflow, and
same-revision conflicts could be "corrected" by whichever event arrived last.
Terminal states were also XState `type: 'final'`, which permanently sealed them
against an authoritative correction.

## 5.2 Required change

### (a) Contract (already frozen by the Lead)

```ts
export interface CommandWorkflow {
  /** Apply one live realtime result (never restores expired, never corrects conflicts). */
  receiveRealtime(event: CommandResultEvent): void;
  /** Apply one validated authoritative List/Journal record (may resolve expired and correct projections). */
  receiveAuthoritative(event: CommandResultEvent): void;
  markExpiredUnresolved(): void;
  reconcile(commandId: string): Promise<void>;
  dispose(): void;
  readonly projection?: CommandWorkflowProjection; // recoveryDisposition: 'tracked' | 'expired-unresolved'
}
```

There is no source-agnostic `receive` and no compat shim. The **data source**
decides the method; the call path (direct stream delivery, recovery-queue retry,
journal replay) never upgrades a realtime event into an authoritative one.

### (b) XState machine

Replace the single `RESULT` event with `RESULT_REALTIME` and
`RESULT_AUTHORITATIVE` (keep `EXPIRE`):

- Active states (`idle/accepted/executing`) accept both. Realtime applies only on
  `revision > context.revision` (equal/lower → no transition). Authoritative
  applies on `revision > context.revision`, or `revision === context.revision`
  when it is a correction (different outcome) / duplicate (same outcome → no-op).
  Never apply `revision < context.revision` (no rollback).
- `expired` state: `RESULT_REALTIME` **never** transitions for any revision and
  mutates neither revision nor outcome nor `lastEvent`;
  `RESULT_AUTHORITATIVE` validates `fabId/commandId`, integer `revision >= 0` and a
  valid outcome, rejects lower revisions, allows equal revision (same outcome
  resolves; different outcome is an authoritative correction) and applies higher
  revisions. `EXPIRE` in expired stays expired.
- Terminal states (`succeeded/failed/cancelled`) are **not** XState `final`
  states: an authoritative same-revision correction can transition them. Guards:
  realtime from terminal is ignored (no transition/mutation); authoritative from
  terminal applies higher revisions; equal revision with a different outcome
  corrects state/outcome (same revision, outcome replaced); same outcome is a
  no-op; lower revisions are rejected.
- Keep identity validation and the `EquipmentCommandContext` shape unchanged.

### (c) Adapter

`XStateCommandWorkflowAdapter.receiveRealtime`: ignore when the current state is
terminal, ignore when expired (realtime can never revive expired), ignore
`revision <= context.revision` (strictly monotonic realtime), otherwise send
`{ type: 'RESULT_REALTIME', event }`.

`receiveAuthoritative`: ignore only `revision < context.revision` (no rollback);
allow equal revision (machine resolves expired / corrects outcome / no-ops
duplicate); allow any current state including expired and terminal; send
`{ type: 'RESULT_AUTHORITATIVE', event }`.

Keep `start/subscribe/reconcile/dispose/state/context/isTerminal/projection`
behavior; `projection.recoveryDisposition = 'expired-unresolved'` only for the
expired state.

## 5.3 Acceptance tests

`web_app/tests/contract/command-workflow.test.ts` (spec matrix):

- executing → expired → projection `expired-unresolved` (revision/outcome
  retained);
- expired + realtime `executing` rev5 → still expired; expired + realtime
  `succeeded` rev6 → still expired; expired + realtime `failed` rev7 → still
  expired (assert revision/outcome unchanged — no reentrant reactivation);
- expired + authoritative `executing` rev5 → executing; expired + authoritative
  `succeeded` rev6 → succeeded;
- expired + authoritative same revision same outcome → resolved to that outcome,
  disposition `tracked`;
- expired + authoritative same revision different outcome → authoritative
  correction (state = corrected outcome, revision unchanged);
- expired + older authoritative revision → no rollback;
- terminal: realtime `succeeded` rev3 then authoritative same-rev3 `failed` →
  state failed and tracked; a later realtime revision 4 is ignored; authoritative
  higher revision 4 `succeeded` → succeeded;
- existing "drives accepted/executing/succeeded" (via `receiveRealtime`) and
  "scheduler is the only authority" tests adapted;
- the contract has `receiveRealtime`/`receiveAuthoritative` and no `receive`.

---

# 6. P1-04 — Cover must never forge the delivered cursor

**Priority:** high.
**Files:** `web_app/src/realtime/command-event-source.transport.ts`;
tests: `web_app/tests/correctness/sse/matrix-1-three-cursor.test.ts`,
`web_app/tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`,
`web_app/tests/realtime/realtime-transport.test.ts`.

## 6.1 Problem

`cover()` mutated `state.delivered` (taking max with the cover cursor, and
replacing it wholesale on an epoch change). That forged a fact the transport
cannot know: `delivered` means "actually published to the bounded consumer", and
an authoritative watermark does not prove any frame was delivered. The forgery
could also violate `acknowledged <= delivered <= observed`, skip a pending
ledger entry, or present a cross-epoch cover as a delivered new-epoch frame.

## 6.2 Required change

In `cover(cursor, authority?, lossBarrier?)` **delete** the block that mutates
`state.delivered`. A cover may only:

1. mark ordered-ledger entries at/before the cursor as `covered` (and clear /
   replace the ledger on an authoritative epoch replacement);
2. advance the `acknowledged` safe cursor (monotonic; never regress same epoch);
3. set `ledgerEpoch` to the authoritative epoch;
4. release a proven ACK latch (existing R4-01 rules: known position requires same
   epoch and `cursor.sequence >= untrackedHighWater`; unknown/cross-epoch
   positions require `authority === 'list'`);
5. return `{ status: 'covered', ... }` or, when it cannot prove the range,
   `{ status: 'insufficient', ... }` **leaving every cursor/ledger/loss state
   unchanged**.

Invariants that must hold at all times (same epoch):
`acknowledged.sequence <= delivered.sequence <= observed.sequence`.

Cross-epoch rule: a List cover with a new epoch replaces the acknowledged epoch
identity (and may replace `ledgerEpoch`) but leaves `delivered` in the old epoch.
Only a real SSE frame of the new epoch that is successfully published to bounded
consumers may move `delivered` into the new epoch, to that actually-published
sequence.

Mandatory examples (from the transport test matrix):

| Scenario | expected observed | expected delivered | expected acknowledged |
|---|---|---|---|
| observed 25, delivered 10, acknowledged 8; List cover epoch-1:20 | epoch-1:25 | epoch-1:10 | epoch-1:20 |
| delivered epoch-A:10; List cover epoch-B:20 | unchanged | **epoch-A:10** (old epoch) | epoch-B:20 |
| cover `insufficient` | unchanged | unchanged | unchanged |

Do not change dirty/latch semantics beyond removing the delivered forgery.

## 6.3 Acceptance tests

- `tests/correctness/sse/matrix-1-three-cursor.test.ts`: same-epoch cover and
  cross-epoch cover assertions as above; `insufficient` cover leaves every cursor
  unchanged.
- `tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`: "cover succeeds but
  pending ACK entries remain" — a delivered entry after the cover watermark stays
  pending and `acknowledged` does not jump it; cross-epoch cover/ledger
  replacement assertions; existing ordered-prefix tests unchanged.
- `tests/realtime/realtime-transport.test.ts`: existing cursor/loss/ledger/dirty
  tests stay green after the delivered mutation is removed.

---

# 7. P2-01 — CommandConnectionStatus lifecycle (including `closed`)

**Priority:** medium.
**Files:** `web_app/src/contracts/command-events.contract.ts` (frozen type),
`web_app/src/realtime/command-event-source.transport.ts`,
`web_app/src/runtime/fab-runtime.ts`, `web_app/src/runtime/command-sources.ts`;
tests: `web_app/tests/realtime/realtime-transport.test.ts`,
`web_app/tests/integration/fab-runtime.test.ts`.

## 7.1 Semantics

```ts
export type CommandConnectionStatus =
  | 'connecting'    // an attempt to establish the connection is in progress
  | 'open'          // connection established
  | 'reconnecting'  // connection interrupted, reconnect scheduled
  | 'failed'        // permanently unavailable in this environment
  | 'closed';       // deliberately closed; no active connection (normal idle)
```

Rules:

1. A transport that has not opened starts `closed` (not `connecting`). The first
   status subscriber observes the current lifecycle state once, then changes.
2. `open()` publishes `connecting` **before** starting to establish the
   connection (before the factory call / timer setup).
3. `onopen` → `open`; `onerror` → `reconnecting`; a reconnect attempt
   (`open()` again) → `connecting` → `open`. A transient factory throw or
   connect timeout publishes `reconnecting`, not `failed` (`failed` is
   permanent-only).
4. `closeSource()`/`closeTransport()`/last `commandResults` subscriber leaving
   → publish `closed` (unless permanently unavailable: then keep `failed` and
   never downgrade `failed` → `closed`). Scope finalizers must update the status
   too.
5. Permanent unavailability (no EventSource factory at construction, or the
   bounded failed-open-attempt budget exhausted) publishes `failed` exactly once;
   afterwards ordinary close must not downgrade it; `availability` stays
   `unavailable`; no reconnect loop. A source without a factory starts and
   reports `failed` without waiting for a consumer.
6. After a closed connection, a new `commandResults` subscriber publishes
   `connecting` then `open` on `onopen`. Each FAB transport keeps at most one
   connection.
7. Status changes are the real published stream (mark-dirty bounded channel), not
   a local field mutation; existing dirty/loss/epoch/ledger logic is unchanged.

## 7.2 Runtime interpretation (FabRuntime)

- Initial runtime `connectionStatus = 'closed'` (idle: no connection yet).
- `closed` must not equal `failed`, must not trigger a recovery retry storm, and
  must never be read as `open`. While not open, the runtime cannot be Healthy.
- `open` → enter Dirty with `{ listOnly: true, cause: 'reconnect' }` (existing).
- `reconnecting`/`failed` → Dirty + `Degraded` (existing), but a transport failure
  is never reported as a command outcome.
- `closed` → mark `Degraded` (unless the phase is already `Unrecoverable`
  or `Unavailable`); do **not** schedule a recovery loop; the next `open`
  transition re-arms exactly one authoritative pass.
- Keep `refreshRealtimeAvailability()` separate from connection status.

## 7.3 Acceptance tests

- `tests/realtime/realtime-transport.test.ts` lifecycle matrix: first subscription
  → `connecting` (subscriber observes the current state before open); `onopen` →
  `open`; `onerror` → `reconnecting`; reconnect start → `connecting`; reconnect
  success → `open`; last consumer leaves → `closed`; new consumer → `connecting`
  → `open`; permanent unavailability (no factory / max attempts) → `failed`;
  pending source → `failed`; scope close → `closed` or keeps `failed`, never
  forged `open`.
- `tests/integration/fab-runtime.test.ts`: fake source
  `setConnectionStatus('closed')` → not Healthy and no failed-retry storm;
  `setConnectionStatus('failed')` → `Degraded`/never Healthy; back to `open` →
  recovery Healthy again.

---

# 8. P2-02 — On-demand Command SSE subscription

**Priority:** medium.
**Files:** `web_app/src/runtime/fab-runtime.ts`,
`web_app/src/app/runtime-bootstrap.tsx` (production sets
`lazyCommandSubscription: true`);
tests: `web_app/tests/integration/fab-runtime.test.ts`,
`web_app/tests/integration/runtime-bootstrap.test.tsx`.

## 8.1 Problem

Opening one command SSE per FAB at start means 1–32 idle connections at boot, a
non-idle transport that keeps the Healthy decision coupled to a stream no command
needs, and an unbounded resource cost for display-only FABs.

## 8.2 Required behavior

`lazyCommandSubscription: true` semantics:

**Demand** exists when any of:

1. an uncommitted admission reservation exists (`reservations.size > 0`);
2. an active (non-terminal) tracked workflow exists;
3. an unresolved held event or conflict exists (`bridge.pendingCount > 0`).

Recovery through HTTP journal/List does **not** require the live SSE transport.

Rules:

- `hasCommandStreamDemand()` implements the demand definition above
  (`reservations.size > 0` || active tracked workflows || `bridge.pendingCount > 0`).
- `syncCommandSubscription()`: if lazy && started && !disposed: demand &&
  !bridgeStarted → `bridge.start()`, `bridgeStarted = true`; no demand &&
  bridgeStarted → `bridgeStarted = false`, `bridge.stop()` (the real transport
  then closes the EventSource and publishes `closed`). Terminal delivery
  re-evaluates demand on the next microtask (`scheduleCommandSubscriptionSync`)
  so the bridge never interrupts its own consumer fiber.
- Call it after: `start()`; a successful `reserveCommandAdmission()` (before the
  HTTP POST returns — so an SSE event can arrive before the 202);
  reservation commit/release; `createTrackedWorkflow()`; `afterDelivery()`/
  `recordTerminal()` (a terminal transition may remove the last demand);
  `onBridgeUncorrelated/onBridgeConflict`; bridge flush points; and
  `onBridgeConsumerExit` (restart only when demand).
- `stop()` closes the bridge; `start()` re-evaluates demand (reservations and
  workflows may already exist); `dispose()` closes everything via the existing
  scopes.
- At most **one SSE per FAB**, never one per workflow. Do not close the connection
  while another active workflow still needs it. Do not keep an idle connection for
  terminal workflows retained only for UI projection.
- `closed` is legal idle but **not** `Healthy`: while a FAB has no command
  demand it holds no connection, so its phase is `Degraded` (environment
  readiness: connection not open) — never `failed` and never a recovery loop.
  When demand appears (reservation/active workflow/held-conflict) the stream opens
  (`connecting` → `open`) and the `open` transition re-arms exactly one
  authoritative pass, which can then re-earn `Healthy`. The runtime must never
  force or keep the stream open just to satisfy the Healthy barrier (no
  forced-open); `closed` must never be treated as `failed` or as `open`.

## 8.3 Acceptance tests

`tests/integration/fab-runtime.test.ts`:

- 32 FAB runtimes `startAll()` → no `commandResults` subscriptions
  (`commandObservers === 0`) for idle FABs;
- reserve on FAB-07 → exactly one connection; 10 active workflows on FAB-07 →
  still one; FAB-08 reservation → a second connection (per-FAB isolation);
- release a failed reservation → that FAB connection closes when no other demand;
  last active command reaches a real terminal state (authoritative terminal
  event) → connection closes; next reservation → re-established;
- SSE event emitted while reserved but before HTTP 202 → after commit it is
  applied (flush path);
- dispose closes all; closing FAB-A does not affect FAB-B.

`tests/integration/runtime-bootstrap.test.tsx`: composition root with
`lazyCommandSubscription: true` assembles 32 FABs without 32 command SSEs; only a
FAB with command activity opens one; resources are released on unmount/dispose;
multi-FAB isolation.

---

# 9. P2-03 — Independent Workflow TTL and Correlation TTL

**Priority:** medium.
**Files:** `web_app/src/runtime/fab-runtime.ts`,
`web_app/src/runtime/command-correlation-registry.ts`;
tests: `web_app/tests/integration/fab-runtime.test.ts`.

## 9.1 Problem

A single `sweepTimer`/TTL coupled two different lifetimes: resolved workflow
actors and correlation watermarks. `ttl = 0` (documented as "no time-based
eviction") could also stop the other kind of sweep, or still schedule a timer
loop that never evicts anything.

## 9.2 Required behavior

- Add `FabRuntimeRetentionOptions.correlationTerminalTtlMs?: number` (default
  `300_000`, resolved with `resolveTimeoutOption`, `min: 0`) and pass it to
  `new CommandCorrelationRegistry({ terminalTtlMs: ... })` (keeping
  `maxTerminalEntries`/`maxEntries`/`now`).
- Split the single `sweepTimer` into two independent timers owned by FabRuntime:
  - `workflowSweepTimer`: evicts resolved workflows older than
    `resolvedWorkflowTtlMs`. If `resolvedAt.size === 0` or
    `resolvedWorkflowTtlMs === 0`, clear it and do not schedule (capacity caps
    still enforced by `enforceTerminalLimit()`).
  - `correlationSweepTimer`: calls `correlation.sweep()` on the
    `sweepIntervalMs` cadence. If `correlationTerminalTtlMs === 0`, clear it and
    do not schedule (terminal-count/absolute caps still enforced).
- Both timers are started in `start()`, cleared in `stop()`/`dispose()`; neither
  may stop the other's lifecycle; there is no global timer service.
- `TTL = 0` semantics: no time-based eviction of that kind — it must not disable
  the other TTL and must not disable capacity bounds.

## 9.3 Acceptance tests

`tests/integration/fab-runtime.test.ts` with a controlled clock:

- `resolvedWorkflowTtlMs = 0`, `correlationTerminalTtlMs = 1000`: terminal event
  observed at t=0 → t=1001 → workflow retained, correlation terminal entry
  expired (size decreases), no leftover timer; dispose clears both timers;
- inverse case (`workflow TTL 300000`, `correlation TTL 0`): correlation entries
  are retained but workflows expire, and capacity bounds still apply.

---

# 10. P2-04 — Test-double protocol fidelity

**Priority:** medium.
**Files:** `web_app/tests/support/command-fakes.ts` (Lead-owned), plus the test
suites that use it. Test doubles are test infrastructure; they must implement the
real protocol, never a convenient approximation.

## 10.1 Problem and fidelity principle

The Round 5 fakes implemented the older protocol: `receive` (source-agnostic),
optional/absent `pendingAcknowledgements`, a `cover()` that advanced
`delivered`, a `connectionStatus` stream that unconditionally announced `open`,
and no way to simulate a delivered-but-unapplied ACK entry. Tests using such
fakes can pass while the real transport/runtime violates the invariants.

Fidelity principle: the doubles model the *protocol states the runtime must react
to* (realtime vs authoritative channel, expired-unresolved, pending ACK ledger,
cover results, connection lifecycle, revision/outcome conflicts) instead of hiding
them behind always-successful behaviour. They must never announce a state the real
transport would not announce (in particular no implicit `open`) and must never
silently satisfy an invariant they are supposed to exercise.

## 10.2 Fake workflow contract

`FakeCommandWorkflow` (and `CountingCommandWorkflow` where used):

- implements `receiveRealtime` and `receiveAuthoritative` (no `receive` shim) and
  records per-channel delivery attempts (`realtimeEvents`, `authoritativeEvents`,
  plus `events` for events whose projection actually advanced);
- realtime: strictly monotonic revision only; when `expired`, every realtime event
  is ignored for any revision/outcome (no revival, no context mutation);
- authoritative: no revision rollback; equal revision is allowed (same outcome is
  a no-op, different outcome is an authoritative correction and resolves
  `expired`); expiry disposition returns to `tracked` on application;
- `projection.recoveryDisposition` is `expired-unresolved` only in the expired
  state; `markExpiredUnresolved`/reconcile/dispose remain contract-faithful;
- exposes `lastEvent` and channel logs so tests assert observable protocol facts
  (channel, applied revision/outcome) rather than call order only.

## 10.3 Fake source contract

`FakeCommandEventSource`:

- `connectionStatus` is stateful: a new subscriber first observes the current
  lifecycle value (like the real transport's first-subscriber replay), then
  changes. It starts `closed` and changes only through the explicit seams
  `setConnectionStatus(status)` / `openStream()` / `failTransport()`; it never
  announces an implicit `open`. `createFabRuntime` sets the fixture status
  (`connectionStatus`, default `open` for tests that expect a healthy runtime).
- `cursors.pendingAcknowledgements` is always the live ordered-ledger length
  (required contract number, never absent).
- `acknowledge(event)` marks the matching delivered identity applied and advances
  `acknowledged` only over a contiguous `applied|covered` prefix.
- `cover(cursor, authority?, lossBarrier?)` only marks ledger entries covered,
  advances `acknowledged`, and replaces the ledger on an authoritative cross-epoch
  cover; it **never** modifies `delivered` or `observed` (P1-04). The next cover
  outcome is controllable with `setCoverResult('covered' | 'insufficient')`.
- `emit(event, cursor?)` delivers a frame through the bounded consumer bus
  (optional explicit journal cursor); `deliverUnprocessed(event, cursor?)` records
  a delivered-but-not-yet-consumed ledger entry (the post-cover pending-ACK race)
  without publishing it to the consumer.
- every eviction/observability counter (observers, dropped, dirty, status) works,
  so runtime/subscription tests can prove detach/re-attach behavior.

## 10.4 Acceptance tests

The fakes are exercised by the P1-01…P2-03 suites above; every test that
implemented `CommandWorkflow` or relied on the old fake source semantics is
migrated to the new protocol (no compat layer, no dual implementation), and the
repository architecture/contract tests (e.g.
`web_app/tests/architecture/architecture-contract-rules.test.ts`) must remain green
after the contract change (they compile against `receiveRealtime`/`receiveAuthoritative`
and the required `pendingAcknowledgements`).

## 10.5 Fake boundary — what doubles do not model

- Ordered journal-position realism (epoch/sequence continuity, sparse Site
  sequence, ordered-ledger prefix, ACK-latch release) stays in the real transport
  tests: `web_app/tests/realtime/realtime-transport.test.ts`,
  `web_app/tests/correctness/sse/matrix-1-*`, and
  `web_app/tests/correctness/sse/support/transport-harness.ts`. The fake has no
  server-assigned journal positions and records a frame at the current safe
  acknowledged position unless a test supplies an explicit cursor.
- Fake `cover()` intentionally reports `latchReleased: false` (the fake does not
  model the R4-01 ACK latch); latch behavior is proven only by the transport
  harness. Fakes never forge `delivered` or a pessimistic/optimistic cover result
  to make a barrier test pass.
- The fake pending-ACK race must be injected through `deliverUnprocessed`; a test
  may not weaken the runtime barrier or edit production code to reproduce it.
- Passing integration tests with fakes is not real-runtime acceptance: Phase C
  (§12.3) remains the only evidence for browser/SSE/production behavior.

---

# 11. Protocol flows (Round 5.1 brief, four flows)

## 11.1 Conflict flow

```text
SSE rev3 accepted -----------------> bridge.receive
                                      correlation.observe -> 'new'/'applied'
SSE rev3 failed -------------------> bridge.receive
                                      correlation.observe -> 'conflict'
                                      recovery.holdConflict(event)      (no actor delivery)
                                      onConflict(event)                 (no ACK)
                                      pendingCount includes conflict, conflictCount=1
FabRuntime onBridgeConflict -------> bounded diagnostic
                                      needsNextAuthoritativePass = true
                                      mergeRecoveryRequest({ listOnly: true })
                                      schedule/reuse recovery pass (no parallel executor)
List 'all' returns rev3 failed ----> bridge.receiveAuthoritative
                                      correlation.observeAuthoritative -> records 'failed'
                                      actor.receiveAuthoritative -> projection corrected
                                      correlation.markApplied (outcome matches)
                                      recovery.resolveAuthoritative -> removes conflict (rev <= 3)
                                      ACK rev3
Pending count/conflict count = 0 --> pre-cover barrier passes -> cover -> post-cover barrier
```

## 11.2 Expired-unresolved flow

```text
local active command set captured at snapshot start
List 'all' snapshot does not contain the command
  -> workflow.markExpiredUnresolved()
  -> projection: recoveryDisposition = 'expired-unresolved'   (NO fabricated succeeded/failed/cancelled)
  -> command no longer counts as active (does not block Healthy, not reconciled forever)
late SSE rev5 executing / rev6 succeeded / rev7 failed
  -> receiveRealtime: ignored for ANY revision -> stays expired (no reactivation)
authoritative record (later List/Journal)
  -> receiveAuthoritative: validate identity/revision/outcome
     rev < current   -> reject (no rollback)
     rev == current  -> same outcome resolves; different outcome is a correction
     rev > current   -> apply; disposition back to 'tracked'
(if no authoritative record ever arrives: remains expired-unresolved, observable,
 never converted to a business outcome)
```

## 11.3 Recovery barrier sequence

```text
Dirty / reconnect / gap / conflict / uncorrelated / drop
  -> Recovering (generation g; one owned fiber in RecoveryScope)

1. snapshot = executeRecoveryEffect
     journal: loop pages until nextAfterSequence >= latestSequence (epoch/seq checks)
     list:    listFabCommands(site,fab,'all') + validate full-set + apply each record
     apply:   bridge.receiveAuthoritative (bypasses observed-revision dedupe)
2. post-snapshot reconciliation batch
     scheduler.scheduleMany(active commands) -> per-command ReconciliationResult
     any failed/timed-out/cancelled/not-found for an active command -> pass fails
3. PRE-COVER barrier (synchronous)
     generation current | no pending recovery request | bridge.pendingCount === 0
     | conflicts === 0 | effective drop intents === 0 | batchFailure undefined
     | realtimeAvailability ready | connectionStatus open
     correctness failure -> needsNextAuthoritativePass + list-only request + bounded compensation -> next LIST pass
     environment failure -> needsNextAuthoritativePass + Degraded; next connection-status transition re-arms one pass
4. cover = source.cover({epoch,sequence}, kind, lossBarrier)
     status !== 'covered' -> pass failure (transport keeps latch; retry List)
5. POST-COVER barrier (same synchronous step, NO async yield between 4 and 6)
     bridge.pendingCount === 0 | pendingAcknowledgements === 0 (real zero!)
     | conflicts === 0 | no pending recovery request
     fail -> do not Healthy; keep ACK/ledger; list-only request -> compensation -> next LIST pass
6. commit
     completeRecoverySuccess: attempts=0, clear active request, resolve covered drops
     Healthy  iff recoveryAvailable && realtimeAvailability==='ready' && connectionStatus==='open'
     otherwise Degraded (never Healthy)
```

## 11.4 SSE lazy lifecycle

```text
FabRuntime.start()                    (lazyCommandSubscription = true)
  no demand -> bridge NOT started, connectionStatus = 'closed' (legal idle; runtime Degraded, not failed)

reserveCommandAdmission() success  (BEFORE the HTTP POST returns)
  -> demand -> syncCommandSubscription -> bridge.start()
  -> transport open() -> publish 'connecting' -> EventSource -> onopen -> 'open'

HTTP 202 -> registerAcceptedCommand (never re-rejected)
SSE result may arrive before the 202 -> held -> flush after registration

last demand disappears (terminal delivered, reservation released, queue empty)
  -> syncCommandSubscription -> bridge.stop()
  -> transport closes -> 'closed' (not 'failed', no reconnect storm)

next reservation -> demand -> 'connecting' -> 'open' (at most one SSE per FAB)
  -> open transition re-arms one authoritative pass -> Healthy can be re-earned
```

---

# 12. Verification gates

## 12.1 Phase A — static correctness (source review, no runtime)

Review the diff against the invariants; each item must be provable by reading code:

1. No `workflow.receive(...)` / no generic receive contract remains; only
   `receiveRealtime`/`receiveAuthoritative` (and `markExpiredUnresolved`).
2. No code path calls `receiveAuthoritative` for a realtime/queued SSE event
   (queue retries stay realtime); no path upgrades a realtime event.
3. `cover()` does not assign `state.delivered` anywhere; `delivered` is only
   written by a successful publish of a real frame.
4. `pendingAcknowledgements` is a required numeric cursor field in the contract
   and in every source; no fallback `?? 0` makes "absent" look healthy.
5. `bridge.pendingCount` includes conflicts; `conflictCount` exists; conflicts are
   excluded from snapshot/flush/drain and never ACKed.
6. Correlation truth table implemented exactly (`conflict` on equal revision,
   different outcome; no mutation; `observeAuthoritative` resolves/corrects;
   `markApplied` outcome match).
7. Machine has no `type: 'final'` terminal states and keeps `expired` realtime-inert;
   realtime from terminal/expired cannot mutate state/revision/outcome.
8. `completeRecoveryEffect` contains both barriers, in the required order, with
   the cover and post-cover barrier in one synchronous `Effect.gen` step;
   correctness failures merge a list-only request and enter bounded compensation,
   environment failures set `Degraded` and re-arm on the next connection-status
   transition; neither can fall through to Healthy.
9. `connectionStatus` publishes every lifecycle state, initial state is
   `closed` (transport) / `closed` (runtime idle), `failed` is not downgraded,
   and `closed` is never treated as `open` or `failed`.
10. Lazy SSE: demand definition is exactly reservation-or-active-workflow-or-
    pending-bridge; `syncCommandSubscription` is called on every demand change;
    no per-workflow connection; recovery does not require SSE; an idle-closed FAB
    is `Degraded` (not Healthy) and is never force-opened to satisfy the barrier.
11. Two independent sweep timers; TTL=0 disables only its own time-based eviction;
    capacity bounds still enforced.
12. Fakes implement the exact contract (no `receive`, required
    `pendingAcknowledgements`, configurable status/cover/pending-ACK seam).
13. No compat layers, dual implementations, silent fallbacks or weakened
    assertions for any of the above.

## 12.2 Phase B — automated verification (exact commands)

Run from `web_app` (pnpm 12.15.0 / node 26.12.1 pinned):

```powershell
# 1) P1-03 workflow contract/machine matrix
pnpm exec vitest run tests/contract/command-workflow.test.ts --reporter=dot

# 2) P1-02 correlation + recovery queue + bridge
pnpm exec vitest run tests/contract/command-correlation.test.ts tests/contract/command-recovery.test.ts tests/integration/command-event-bridge.test.ts --reporter=dot

# 3) P1-01 / P2-01 / P2-02 / P2-03 runtime + composition root
pnpm exec vitest run tests/integration/fab-runtime.test.ts tests/integration/fab-runtime-batch23.test.ts tests/integration/runtime-bootstrap.test.tsx --reporter=dot

# 4) P1-04 + P2-01 transports / cursor matrices
pnpm exec vitest run tests/realtime/realtime-transport.test.ts tests/correctness/sse/matrix-1-three-cursor.test.ts tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts --reporter=dot

# 5) static + full frontend gates
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

Repo-level gates (from the repository root) after the frontend gates:

```powershell
python tools/generate_contracts.py --check
node tools/build_twin_translations.cjs --check
node tools/pack_static_structure.mjs --check
node tools/check_generated_artifacts.mjs --check
node tools/check_frozen_assets.mjs
node --test tools/test_check_frozen_assets.mjs
python tools/check_architecture.py
python -m unittest discover -s tools -p 'test_*.py'
python tools/migrate_legacy_data.py --check
# 3 .NET projects Release build + dotnet test fab_tests
git diff --check
```

Expected: all commands pass with no new warnings; the full Vitest suite is green
after the Lead-owned collateral test migration (P2-04). Record the actual file/test
counts, and remember that passing tests do not by themselves prove the invariants
— Phase A must still be reviewed.

## 12.3 Phase C — real-runtime verification (not replaceable by unit tests)

Must be performed against the real browser/runtime before claiming production
acceptance:

1. EventSource first connection: `closed` before demand, `connecting` before
   open, `open` once established; only the FAB with command activity connects.
2. EventSource disconnect/reconnect: `reconnecting` on error, recovery from the
   acknowledged cursor, `open` after reconnect; no false `failed`.
3. HTTP vs SSE ordering: an SSE result arriving before the HTTP 202 is applied
   after accepted registration; no duplicate terminal action.
4. Actor rejection/conflict: a same-revision different-outcome event triggers
   List recovery, the authoritative record corrects the projection, and the
   runtime stays non-Healthy until the conflict is resolved.
5. Expired-unresolved: a command missing from the authoritative List becomes
   expired-unresolved; late SSE events never reactivate it; a later authoritative
   record resolves it to tracked.
6. Recovery barrier: force an uncorrelated event during post-snapshot
   reconciliation and a pending ACK after cover; the runtime must not report
   Healthy until both are resolved.
7. Multi-FAB concurrency: independent connections, recovery, and cancellation per
   FAB; disposing one FAB does not affect others.
8. Page unload / Runtime stop / dispose: no leaked SSE, timers, actors or
   subscriptions; no callbacks after dispose.
9. Recovery cancellation: interrupting a pass aborts the HTTP request, releases
   the physical budget permit, and never writes a stale generation.
10. Backend capacity: reservation/admission errors are surfaced without
    fabricating command outcomes; HTTP 202 is always registered.
11. Terminal retention: TTL and capacity behavior, including TTL=0, matches §9.

## 12.4 Verification status of this record

The Round 5.1 source/convergence status at the time this document was written is
recorded in §14.1; automated gate results and any post-convergence changes are
reported by the Lead's final gate report. Tests passing for one item never
constitutes final acceptance; the Phase C list above is explicitly not executed
by unit/integration tests.

---

# 13. Forbidden changes

Explicitly forbidden in Round 5.1 (violations are defects, even if tests pass):

1. **No new architecture.** No second recovery state machine, no new command
   cache/authority, no new event bus, no alternate workflow registry.
2. **No compat layer / dual implementation.** No source-agnostic `receive` kept
   "for compatibility"; no dual contract paths.
3. **No fake delivered cursor.** Cover must never advance `delivered`; nothing may
   synthesize a delivered fact.
4. **No clearing pending ACK state.** A recovery barrier failure must not reset
   the ledger, pending count, or latch to force Healthy.
5. **No upgrading realtime events to authoritative.** Queue retries, journal
   replay of realtime frames, or convenience wrappers must never skip the
   authoritative validation/revision rules.
6. **No keeping all SSEs open** (or opening one per workflow) to avoid implementing
   demand logic or to keep connection status `open` artificially.
7. **No TTL/retry masking.** Do not raise TTLs, retry counts or timeouts to hide
   state leaks; do not extend retention to make tests pass.
8. **No silent fallbacks.** Absent `pendingAcknowledgements` must not be treated
   as 0; unknown outcome must not become a terminal outcome; insufficient cover
   must not be treated as covered.
9. **No weakened tests.** Tests must assert invariants (cursors, barriers,
   expired semantics, no ACK on conflicts), not merely call order; fakes must be
   protocol-faithful.
10. **No edits outside the owned scope of an item** while its invariants are being
    repaired (prevent "fix the test by changing production semantics").

---

# 14. Implementation mapping (per item)

Source of truth for final status is the converged tree plus the Lead's gate report;
this table records the required file-level mapping. Convergence observed at
documentation close is recorded in §14.1.

| Item | Contracts | Source | Primary tests |
|---|---|---|---|
| P1-01 | `command-events.contract.ts` (`CommandSourceCursors.pendingAcknowledgements: number`) | `runtime/fab-runtime.ts` (`completeRecoveryEffect` pre/post barriers, `onBridgeUncorrelated`, `onBridgeConflict`, `completeRecoverySuccess`) | `tests/integration/fab-runtime.test.ts`, `tests/integration/fab-runtime-batch23.test.ts` |
| P1-02 | `command-events.contract.ts` (`CommandSourceCursors`), bridge outcome types | `runtime/command-correlation-registry.ts`, `runtime/command-event-recovery.ts`, `runtime/command-event-bridge.ts` | `tests/contract/command-correlation.test.ts`, `tests/contract/command-recovery.test.ts`, `tests/integration/command-event-bridge.test.ts` |
| P1-03 | `command-workflow.contract.ts` (already Lead-frozen: `receiveRealtime`/`receiveAuthoritative`) | `runtime/equipment-command.machine.ts`, `runtime/xstate-command-workflow-adapter.ts` | `tests/contract/command-workflow.test.ts` |
| P1-04 | `command-events.contract.ts` (`cover()` doc: never advances delivered) | `realtime/command-event-source.transport.ts` (`cover`) | `tests/correctness/sse/matrix-1-three-cursor.test.ts`, `tests/correctness/sse/matrix-1-ordered-ack-ledger.test.ts`, `tests/realtime/realtime-transport.test.ts` |
| P2-01 | `command-events.contract.ts` (`CommandConnectionStatus` incl. `closed`) | transport status lifecycle; `runtime/fab-runtime.ts` connection subscription; `runtime/command-sources.ts` pending source `failed` + required cursor | `tests/realtime/realtime-transport.test.ts`, `tests/integration/fab-runtime.test.ts` |
| P2-02 | — | `runtime/fab-runtime.ts` (`lazyCommandSubscription`, `syncCommandSubscription`), `app/runtime-bootstrap.tsx` | `tests/integration/fab-runtime.test.ts`, `tests/integration/runtime-bootstrap.test.tsx` |
| P2-03 | — | `runtime/fab-runtime.ts` (`workflowSweepTimer`, `correlationSweepTimer`, `correlationTerminalTtlMs`), `runtime/command-correlation-registry.ts` | `tests/integration/fab-runtime.test.ts` |
| P2-04 | — | `tests/support/command-fakes.ts` (Lead-owned) + all suites using fakes | existing command suites + architecture/contract tests |

## 14.1 Convergence status at documentation close (2026-10-30)

- **Contracts (Lead-frozen, present in the worktree):**
  `CommandWorkflow.receiveRealtime`/`receiveAuthoritative`/`markExpiredUnresolved`
  (no generic `receive`); `CommandSourceCursors.pendingAcknowledgements` is a
  required `number`; `CommandConnectionStatus` includes `closed`;
  `cover()` documents "never advances delivered".
- **Source landed in the worktree and reviewed against this specification:**
  P1-02 (correlation conflict truth table, bounded conflict records, bridge
  conflict path/source isolation), P1-03 (machine `RESULT_REALTIME`/
  `RESULT_AUTHORITATIVE`, no `type: 'final'` terminals, adapter channel split),
  P1-04 (transport `cover()` delivered mutation removed), P2-01 (transport and
  runtime lifecycle incl. `closed`; pending source reports `failed` + required
  cursor), P2-02 (`lazyCommandSubscription: true` in the production composition
  root, demand-driven `syncCommandSubscription`), P2-03 (`correlationTerminalTtlMs`,
  independent `workflowSweepTimer`/`correlationSweepTimer`), P2-04
  (protocol-faithful fakes with status/cover/pending-ACK seams), and P1-01
  (pre/post Healthy barriers in `completeRecoveryEffect`,
  `onBridgeUncorrelated`/`onBridgeConflict` list-only recovery,
  environment-vs-correctness failure handling).
- **Tests updated in the worktree:** `tests/contract/command-workflow.test.ts`,
  `command-correlation.test.ts`, `command-recovery.test.ts`;
  `tests/integration/command-event-bridge.test.ts`,
  `fab-runtime.test.ts`, `fab-runtime-batch23.test.ts`,
  `runtime-bootstrap.test.tsx`; `tests/realtime/realtime-transport.test.ts`;
  `tests/correctness/sse/matrix-1-three-cursor.test.ts`,
  `matrix-1-ordered-ack-ledger.test.ts`; `tests/support/command-fakes.ts`.
- **Not yet claimed by this document:** the item owners' final
  vitest/typecheck runs and the Lead's full Phase B gate run (§12.2) were still in
  progress at documentation close; their results are reported by the Lead. Phase C
  (§12.3) real-runtime verification was not executed.

## 14.2 Relations to prior rounds

- Round 4 (`17-round4-remediation-record.md`): R4-01 ACK latch, R4-02 scheduler
  results, R4-03 observed/applied, R4-05 stream supervision, R4-06
  availability separation remain in force; Round 5.1 tightens them (cover no
  longer forges delivered; barriers become two-sided; source isolation becomes
  contractual).
- Round 5 (`18-round5-remediation-specification.md`): P1-01 ACK cover atomicity →
  Round 5.1 P1-04; P1-02 actor rejection → Round 5.1 P1-02 + P1-03; P1-03 full List
  reconciliation → Round 5.1 P1-01 + P1-03 (expired semantics); P1-04 admission
  and P1-05 scheduler cancellation are frozen (§2.5); P2-01 resolved-workflow
  TTL → Round 5.1 P2-03; P2-02 connection state → Round 5.1 P2-01.
- ADR-010: updated with the three-cursor cover semantics (§8 in that ADR).
- ADR-011 (scheduler/budget), ADR-012 (persistence), ADR-013 (resource commit) are
  unchanged by Round 5.1.

# 15. Residual risks and open items

1. **Phase C unexecuted.** Browser SSR/EventSource/real HTTP validation remains
   listed in §12.3 until a real-runtime session is recorded; this document must
   not be cited as final acceptance before that.
2. **Shared-contract ownership.** The two contract files are Lead-owned; source
   owners code against them. Any late contract change re-opens P1-01/P1-02/P1-03.
3. **Fake fidelity drift.** If test fakes are less strict than the real transport
   (ACK ledger, cover insufficiency), integration tests can under-approximate the
   transport; Phase A item 12 must be re-review after any fake change.
4. **expired-unresolved is still display-only semantics** for terminal history
   (ADR-010 §6.6 decision A): active-command recovery only; terminal history is
   not guaranteed across refresh.
5. **Multi-FAB lazy SSE** is validated only by integration tests with fake
   transport in Round 5.1; real 32-FAB connection behavior remains a Phase C item.
