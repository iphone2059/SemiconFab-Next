# Matched Golden capture 2026-10-25b

Captured after the personnel renderer / exploded hierarchy / C2 copy / Tour-Wafer vector increments.

## Method

- Frozen original: `tools/serve_twin_reference.py` serves `../SemiconFab` and injects the declared
  virtual clock (seed 20261024, 60 fps grid, frozen `Date.now`) before page scripts via `?parity=1`.
- Next: the same clock script is installed with `Page.addScriptToEvaluateOnNewDocument` before each
  navigation; product source contains no capture hook.
- Both sides: 1536x735 CSS viewport, devicePixelRatio 2, zh-CN, `camera iso` baseline, 180 frames
  before + 180 after each case action. 19/19 cases captured with 0 console errors.
- Comparison: Gaussian luminance SSIM 11x11 sigma 1.5; scene ROI rect [328, 82, 1536, 687];
  changed fraction = RGB delta > 8. Thresholds remain unapproved (`REVIEW_REQUIRED`,
  `NOT_PARITY_VERIFIED`).

## Results (full frame / scene ROI)

| case | full SSIM | ROI SSIM | RGB MAE | changed >8 |
| --- | --- | --- | --- | --- |
| cut | 73.7% | 80.1% | 19.7 | 35.5% |
| tour | 71.4% | 77.4% | 23.4 | 40.4% |
| exploded-0 | 70.0% | 75.8% | 26.2 | 49.8% |
| iso-en | 69.3% | 74.8% | 23.0 | 51.8% |
| patrol-purge | 69.2% | 74.8% | 23.1 | 51.5% |
| patrol | 69.2% | 74.8% | 23.1 | 51.5% |
| iso | 69.2% | 74.8% | 23.1 | 51.5% |
| exploded-50 | 68.3% | 73.8% | 30.3 | 56.8% |
| top | 68.2% | 73.4% | 23.1 | 54.2% |
| exploded-100 | 67.5% | 72.8% | 32.2 | 59.4% |
| research | 65.5% | 68.1% | 35.9 | 62.2% |
| litho | 63.8% | 69.4% | 53.0 | 73.4% |
| mes | 62.1% | 66.1% | 25.1 | 51.1% |
| spc | 61.6% | 65.5% | 25.8 | 52.4% |
| yms | 61.6% | 58.1% | 51.6 | 71.2% |
| xray | 60.6% | 64.3% | 39.3 | 63.2% |
| dual | 59.9% | 63.6% | 38.6 | 63.3% |
| b1 | 56.6% | 60.0% | 65.9 | 73.5% |
| wafer | 50.0% | 52.0% | 74.4 | 81.6% |

Full PNGs (3072x1470) stay in the local capture directory; the committed JPEGs are 1600px downscales of
10 representative pairs. `comparison.json` hashes refer to the uncommitted full-resolution PNG names.

## Honest interpretation

- Best case `cut` 73.7% full / 80.1% ROI; after the Tour renderer wiring the same capture improved
  from 44.6% / 45.4% to **71.4% / 77.4%** (tour now near the top). Worst remaining: `wafer` 50.0% /
  52.0%, `b1` 56.6% / 60.0%, `dual` 59.9% / 63.3%.
- Exploded cases 67.5-70.0% full; personnel/ISO 69.2%; English HUD 69.3%.
- The tour improvement is real because the page now applies the frozen controller's camera/HUD per
  frame (source tween + 100 ms countdown + waypoint advance); wafer still uses its old renderer.
- The captures show real remaining appearance differences: HUD chrome/layout and typography, camera
  baseline framing, left rail composition, bottom status bar, exploded panel styling, and some depth /
  shadow contrast. These are **not** acceptable as parity and the status stays IMPLEMENTING /
  NOT PARITY_VERIFIED.
- The virtual clock drives RAF/timers for both sides, but the original's real-time UI timers are only
  approximated by the declared scheduler; no real-time equivalence claim follows.
