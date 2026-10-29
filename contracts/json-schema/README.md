# contracts/json-schema

Single source of the generated API DTOs: `tools/generate_contracts.py` renders
`fab_shared/src/Generated/Contracts.g.cs`, `web_app/src/generated/contracts.generated.ts` and
`contracts/openapi/openapi.json` from this file. Do not hand-edit the generated outputs; run
`python tools/generate_contracts.py` after a schema change and
`python tools/generate_contracts.py --check` in verification.

## Transactional durable command store (Round 2, ADR-012)

The Development backend persists commands in a single SQLite database
(`<Fab:DataDirectory>/commands.db`) with WAL journaling, `synchronous=FULL`, foreign keys on and a
5 s busy timeout. Every submit/advance/retention mutation is exactly one database transaction:
a committed command always has its idempotency/outbox row and accepted journal event, and the
journal revision always matches the command revision. A 202 response is only sent after COMMIT, so
a same-key + same-payload retry after restart returns the same `commandId`/`revision`/`outcome`
inside the retention window. There is no compatibility migration from the old file protocol.

New/changed definitions:

| Definition | Purpose |
| --- | --- |
| `CommandRecoveryDto` | authoritative state of one command inside the retention window |
| `CommandRecoveryListDto` | FAB-scoped listing with the durable `epoch`/`latestSequence` cursor |
| `CommandJournalEventDto` | one durable journal event (`sequence`/`fabId`/`commandId`/`revision`/`outcome`/`occurredAt`) |
| `CommandJournalPageDto` | epoch-aware replay page with `hasGap`/`firstRetainedSequence`/`latestSequence`/`nextAfterSequence` |
| `CommandDirtyDto` | SSE `event: dirty` control frame (`reason`/`droppedCount`/`epoch`/`sequence`/`occurredAt`) |
| `JournalEpochMismatchDto` | HTTP 409 `application/problem+json` body `{code:"journal-epoch-mismatch", currentEpoch, firstRetainedSequence, latestSequence}` |

### Retention window (authoritative facts, not a best-effort hint)

The Development backend keeps commands only inside a bounded window: terminal commands are
pruned after the TTL (default 5 minutes) and beyond the terminal capacity (512), and the journal
retains at most 4096 events per Site (`Fab:Commands:*` configuration; the same values are used for
durable recovery and for response semantics). Consequence for every client:

- `GET /api/v1/commands/{commandId}` returns **404** for an unknown *or pruned* command; it never
  fabricates a success state outside the window.
- `GET /api/v1/sites/{siteId}/fabs/{fabId}/commands` lists only commands inside the window.
- `GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal?epoch=...` requires `epoch`; a stale
  epoch is **409** `journal-epoch-mismatch` (reconcile authoritatively, never continue by sequence);
  a missing/invalid epoch is **400** `journal-cursor-invalid`; retained sequence holes set
  `hasGap=true`; `nextAfterSequence` is the next page cursor and always progresses.
- The SSE stream (`.../commands/stream?fabId=`) emits ids as `{epoch}:{sequence}`, sends
  `event: replay-gap` first when the cursor cannot be served, and sends `event: dirty` when events
  may be missing (retention trim / epoch replacement / store fault). A dirty frame requires an
  authoritative reconcile; it is never silently dropped.
- Outside the window there is **no durable recovery**. Clients must not claim guaranteed
  restoration; the browser refresh flow relies on the authoritative listing.

Recovery failures are explicit: an unwritable or inconsistent command store fails API startup (or
the submission with HTTP 503 `COMMAND_STORE_UNAVAILABLE`), never a silent in-memory fallback.
