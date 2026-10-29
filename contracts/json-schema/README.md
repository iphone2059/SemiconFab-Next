# contracts/json-schema

Single source of the generated API DTOs: `tools/generate_contracts.py` renders
`fab_shared/src/Generated/Contracts.g.cs`, `web_app/src/generated/contracts.generated.ts` and
`contracts/openapi/openapi.json` from this file. Do not hand-edit the generated outputs; run
`python tools/generate_contracts.py` after a schema change and
`python tools/generate_contracts.py --check` in verification.

## Phase D durable command recovery (ADR-008)

New definitions:

| Definition | Purpose |
| --- | --- |
| `CommandRecoveryDto` | authoritative state of one command inside the retention window |
| `CommandRecoveryListDto` | FAB-scoped listing with the durable `epoch`/`latestSequence` cursor |
| `CommandJournalEventDto` | one durable journal event (`sequence`/`fabId`/`commandId`/`revision`/`outcome`/`occurredAt`) |
| `CommandJournalPageDto` | paged replay with `hasGap`/`firstRetainedSequence`/`latestSequence` |
| `CommandDirtyDto` | SSE `event: dirty` control frame (`reason`/`droppedCount`/`epoch`/`sequence`/`occurredAt`) |

### Retention window (authoritative facts, not a best-effort hint)

The Development backend keeps commands only inside a bounded window: terminal commands are
pruned after the TTL (default 5 minutes) and beyond the terminal capacity (512), and the journal
retains at most 4096 events per Site (`Fab:Commands:*` configuration; the same values are used for
durable recovery and for response semantics). Consequence for every client:

- `GET /api/v1/commands/{commandId}` returns **404** for an unknown *or pruned* command; it never
  fabricates a success state outside the window.
- `GET /api/v1/sites/{siteId}/fabs/{fabId}/commands` lists only commands inside the window.
- `GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal` returns `hasGap=true` when
  `afterSequence` fell out of the window, a retained sequence is missing, or the requested epoch
  was replaced.
- The SSE stream (`.../commands/stream?fabId=`) emits ids as `{epoch}:{sequence}`, sends
  `event: replay-gap` first when the cursor cannot be served, and sends `event: dirty` when events
  may be missing (retention trim / epoch replacement / store fault). A dirty frame requires an
  authoritative reconcile; it is never silently dropped.
- Outside the window there is **no durable recovery**. Clients must not claim guaranteed
  restoration; the browser refresh flow relies on the authoritative listing.

Recovery failures are explicit: an unwritable or corrupt command store fails API startup (or the
submission with HTTP 503 `COMMAND_STORE_UNAVAILABLE`), never a silent in-memory fallback.
