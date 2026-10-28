# Equipment status ordering and recovery

The development API's equipment-status REST endpoint and SSE stream serialize the
same FAB-scoped snapshot, including `siteId`, `fabId`, `generatedAt`, `epoch`,
`sequence` and the 121 `tools` states. This JSON feed is separate from command
journal cursors and the high-frequency telemetry envelope.

`epoch` is a non-negative JavaScript-safe integer allocated once per status-service
lifetime. The API allocates it under `Fab:DataDirectory/equipment-status/` using an
exclusive `.epoch.lock`, increments `epoch.txt`, flushes a temporary file, and
atomically replaces the counter. The counter is independent of wall-clock time.
Concurrent API startups receive distinct epochs. Corrupt/exhausted counters fail
closed. Preserve this directory across restarts; deliberately replacing the data
directory creates a new feed history and requires a fresh browser QueryClient.
The development server is a local single-authority feed, not a distributed
multi-writer ordering protocol.

The frontend's shared Query acceptance gate applies these rules to both transports:

1. Explicit epoch frames require an integer sequence. The first explicit epoch
   replaces any legacy timestamp/sequence watermark.
2. A higher epoch starts a new generation, regardless of its display timestamp.
3. Within one epoch, sequence must strictly increase; lower epochs are stale.
4. After accepting an epoch, frames missing epoch/sequence cannot downgrade it.
5. Wholly legacy feeds still use the previous timestamp/restart heuristic until
   they upgrade; they do not provide restart-safe generation ordering.

Telemetry Worker faults release the in-flight slot, preserve a bounded slot-keyed
pending frame and retry failed construction/reset with one exponential timer
(250ms, doubling to an 8s ceiling). A successful frame resets the backoff. Repeated
asynchronous Worker errors also enter this backoff; stop cancels the timer.
Any Worker fault that leaves a frame unanswered (`error`/`messageerror`, or an
in-flight reply timeout) replays that frame into the replacement Worker immediately,
merged by render slot with the newest pending frame and carrying that newer frame's
sequence, so the last decoded update survives even when no further SSE frame arrives.
A synchronous `postMessage` failure instead schedules the retained frame through the
retry timer; a healthy replacement is reused, and the timer never submits a second
frame while one is already in flight.
During a Worker fault, renderer-facing `getToolStates()` yields no telemetry
override, so the accepted equipment-status projection supplies the scene states.
The previous Worker snapshot remains available for diagnostics, not rendering.

GPU recovery still rebuilds the Lite world and guards its short state replays by
world/generation/interaction identity. Canvas pointer, wheel, touch and double
click input cancels pending replays before the actual input handlers run. Explicit
preset instructions also cancel them. The page applies presets on a fresh viewer
epoch or a view change; a recovered world in the same viewer epoch keeps its user
pose rather than reapplying the page preset.

Regression coverage lives in equipment-status-epoch, equipment-status-pipeline,
lite-backend-recovery, telemetry-runtime, telemetry-render and fab-runtime-batch23
tests, plus backend EquipmentStatusTests and the REST/SSE API integration test.
