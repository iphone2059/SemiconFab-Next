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

Implemented in this shell: ISO/Top/Litho/Airlock camera presets, L1/B1/DUAL/Explode, continuous 0–100% explode slider, AMHS/FFU/Subfab/Heatmap/Airflow/X-Ray layers, equipment selection, Tour toggle, Visitor/Engineer/Research presentation (Research replay is explicitly marked not connected).

## Not yet parity

Still required by the parity spec: full original HUD/control inventory, dual level, true cut planes, continuous explode, filtered X-Ray, onboarding, five-stop tour, research JSONL replay, wafer follow, MES/SPC/wafer map/yield, bilingual and theme persistence, golden screenshot diff, and real-GPU long-run acceptance.

Do not mark the page `PARITY_VERIFIED` from the shell alone.
