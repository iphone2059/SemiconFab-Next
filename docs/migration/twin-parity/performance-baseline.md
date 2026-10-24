# WebGPU performance baseline — 2026-10-25

Status: **baseline only, not a performance acceptance result**. The scene is still
`IMPLEMENTING / NOT PARITY_VERIFIED`; no visual regression is waived by this run.

## Environment

| Item | Value |
| --- | --- |
| Browser | Headless Chrome 155.0.0.0 |
| Viewport | 1920 × 1080, DPR 1 (headless screen reports 800 × 600) |
| WebGPU adapter | NVIDIA Ampere (adapter info has no device/description) |
| CPU threads | 20 logical |
| Scene | 121 machines, 1,670–1,688 active meshes, 189,534 vertices |
| Query | /twin?lang=en&perf=1&hoverPickMs=50 |
| Warm-up | 5 s before each scenario |

## Raw results

Source JSON: [perf-baseline-2026-10-25.json](perf-baseline-2026-10-25.json).

| Scenario | rAF p50 | rAF p95 | rAF p99 | Long tasks | Babylon frame | Babylon render | Draw calls | FPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Idle 10 s | 41.70 ms | 75.10 ms | 83.40 ms | 30 / 1,736 ms | 40.40 ms | 31.10 ms | 1,670 | 21.9 |
| Orbit 8 s | 41.70 ms | 74.90 ms | 91.70 ms | 26 / 1,619 ms | 41.70 ms | 32.30 ms | 1,688 | 19.9 |

The run never reached the 16.7 ms budget in this environment. fps and
frameTimeMs are Babylon's own counters; rAF frame time is wall-clock and can
include compositor/long-task stalls. Both are recorded because they measure
different boundaries.

## What this does and does not prove

- It proves the current headless environment is dominated by frames above the
  60 FPS budget and by ~1.7k draw calls. Babylon render time (~31–32 ms) and
  active-mesh evaluation (~5 ms) are the largest reported CPU segments.
- It does **not** prove the same numbers on a visible desktop browser, a different
  GPU, a different DPR, or the production server. Headless Chrome can use a
  different GPU path and the reported screen size is not the emulated viewport.
- It does not identify draw-call submission, React commits, or GPU execution as
  the sole cause. A DevTools Performance profile and GPU timing are still needed.
- The perf=1 mode only installs SceneInstrumentation; it does not enable
  Snapshot Rendering, Thin Instances or static mesh freezing.

## Next measurements

1. Repeat on visible Chrome at 1920 × 1080 DPR 1 with DevTools closed, and record
   GPU/driver/browser versions.
2. A/B hoverPickMs=0 versus hoverPickMs=50 while moving over equipment.
3. Separate **idle**, **camera orbit**, **FFU toggle**, **roof + FFU**, **B1**,
   **DUAL**, **Cut**, and **X-Ray** scenarios.
4. Profile JS update, React commit, Babylon render submission and GPU with the
   Performance panel; do not infer a fix from FPS alone.
5. Only then trial static mesh freeze/merge and SNAPSHOTRENDERING_STANDARD on a
   branch, with visual and device-loss regression.
