# Frontend cleanup — 2026-10-25

Scope: current `web_app` production entry, literal dynamic imports, related tests,
styles and current development documentation. Original source/provenance assets,
121-tool layout, source fixtures and active facility/render code remain intact.
This is a cleanup increment, not a full parity release.

## Removed or consolidated

| Finding | Change |
| --- | --- |
| `ApiClient` and old `FabToolInspector` were reachable only from their own tests | Removed both implementations and obsolete tests; actual RTK endpoints now have six transport tests |
| Custom `startPolling` and toy `SequenceGate` had no product consumers | Removed; retained the active submission `ScopeGate` and actual equipment snapshot ordering |
| `projectOriginalSignalStates` existed only to support a parallel test implementation | Removed; the identity test now drives the actual DEMO reducer |
| Performance statistics were unreachable from the product but used by capture tooling | Moved to `tests/support/perf-metrics.ts`; capture and unit imports updated |
| `setExploded` was an unused chain of compatibility aliases | Removed across viewport/facade/backend/runtime; active `setExplodeFactor` remains |
| Unused local bindings, bounds constant, Redux actions/fields, setters and ignored arguments | Removed; enabled `noUnusedLocals` and `noUnusedParameters` |
| Language initialization duplicated a separately tested resolver | The current locale initializer now consumes the resolver in `preferences.ts`; URL, stored preference and browser precedence remain covered |
| Old preview CSS and stale overrides survived the preview removal | Removed 199 absent-class selectors and one unused animation definition; kept live `.scene`/canvas and dynamic `status-*` rules |
| README/ADR still named removed files and a nonexistent preview test | Updated current paths, RTK/SSE transport description and verification commands |

The original audit found 21 compiler unused diagnostics and three production
modules unreachable from `main.tsx`. After cleanup, strict typecheck passes and
all 62 remaining source modules are reachable through static/literal dynamic
imports (including types). This graph check does not classify actively used
legacy/original recipes as obsolete based on their names.

Porting tests exposed a lost transport guarantee: the RTK fetch callback did not
preserve the global receiver used by the previous client. The receiver assertion
failed first; `globalThis.fetch(input, init)` now passes it on the actual endpoint.
The remaining transport tests cover same-origin credentials/cache, escaping,
ProblemDetails/status, idempotency/JSON, abort propagation and non-JSON failures.

## Verification

- TypeScript with both unused checks: pass (initial audit failed with 21 diagnostics).
- Vitest: 134/134 across 37 files. Four retired tests exercised the removed old
  inspector, poller and sequence helper; live identity assertions and six transport
  tests now exercise the current implementations.
- Production Vite build: pass. CSS is 117.82 kB / gzip 20.16 kB, versus 135.60 kB /
  gzip 23.32 kB immediately before cleanup; no frame-rate claim follows.
- Python tooling: 15/15; architecture and frozen process-vector checks pass.
- Independent read-only review: no Critical/Important finding. A test title was
  narrowed to abort propagation because it does not exercise an abort-ignoring
  late transport response.
- Actual Chrome/Windows development browser: workbench/API load, catalog
  `q=NXT:2050i` StrictMode deep link, Twin single canvas/18 directory rows,
  clock `#2 -> #3` with changing FDC values and pause all pass; captured console
  errors are empty. Final styles were reloaded and the Twin checks repeated.

No backend implementation changed. Full Golden, nine-language, exact dynamics,
production-bundle browser, 60-minute and full repeated-loss parity gates retain
their prior status in `twin-parity/baseline.md`.

## Final renderer-readiness correction

Inspecting the final screenshot caught a scene failure that the earlier HUD-only
checks missed. Network capture identified a Babylon dependency returning
`504 Outdated Optimize Dep`; the source module itself returned HTTP 200. The
local Vite process was restarted with forced dependency optimization, retaining
the existing API. No product rendering fallback or dependency version changed.

`remaining-state.browser.ts` now requires an explicit WebGPU-ready status before
accepting clock/FDC assertions, rejects caught module-load failures and allows a
bounded cold-start wait. The rerun returned `WebGPU · 程序化 FAB · 121 台设备`,
clock `#2 -> #3`, changing sensor values and pause. The final screenshot was
visually inspected with the 3D scene present. Two harness regressions distinguish
a working HUD with a failed renderer from an actual ready renderer.
The frontend suite including these regressions passes **136/136**.

Concurrent dialog-focus work landed in a separate commit during this final
check; its implementation was left intact.
