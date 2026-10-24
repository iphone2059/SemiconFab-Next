# Twin parity baseline

Date: 2026-10-24

- Original: jinjiefan2020/SemiconFab `b3666132e5d8cab2cebe4c4227fc04c52242eb28`, `twin.html` (24,762 lines).
- Next baseline: `06be9c1b894415d579c35c0bf3020a4eba8bc027` plus the TWIN-02 shell in this change.
- Original inventory: 218 named functions, 263 raw `id` attributes (260 unique), 27,263 `events-t1-fifo.jsonl` rows.
- Original license: PolyForm Noncommercial License 1.0.0; commercial reuse requires separate clearance.

## TWIN-02 first shell

The new `/twin` route provides the first page-level shell without replacing the existing WebGPU runtime:

- single FAB only (`FAB-01`);
- top mode/camera/level/tour controls;
- left equipment rail and selection inspector;
- AMHS/KPI/bottom status HUD;
- layer controls;
- the existing `SiteScene` contract with its internal chrome hidden.

Implemented in this shell: ISO/Top/Litho/Airlock camera presets, L1/B1/DUAL/Explode, continuous 0–100% explode slider, X/Y/Z Cut with position and Invert, a five-stop cinematic tour (overview, litho, etch, OHT, Subfab), a three-step first-run onboarding with the original localStorage key, filtered X-Ray (All/UPW/Gas/Vac/Exhaust/AMHS), AMHS/FFU/Subfab/Heatmap/Airflow layers, equipment selection, Research JSONL replay (27,263 rows; WIP, active tools, group utilization, scrubber, pause/play, 1×/10×/100×/500×), and wafer follow A/B/C (120/104/92 steps, round-robin layout projection, FOUP marker, camera follow, 1×/4×/16×, replay). Cut is a real Babylon `scene.clipPlane`; static shadows are disabled while cut is active because the native shadow receiver is not yet clip-plane aware.

Research is aggregate replay at this point: the source machine IDs do not map one-to-one to the 121 layout tools, so per-tool replay coloring remains open and is explicitly disclosed in the HUD. X-Ray system focus uses Subfab mesh classification; it is not yet the original filtered shader. Wafer routes are projected onto layout tools by category and round-robin, like the original, but the FOUP trail and exact load-port path remain simplified.

## Not yet parity

Still required by the parity spec: full original HUD/control inventory, MES/SPC/wafer map/yield, bilingual and theme persistence, golden screenshot diff, and real-GPU long-run acceptance.

Do not mark the page `PARITY_VERIFIED` from the shell alone.
