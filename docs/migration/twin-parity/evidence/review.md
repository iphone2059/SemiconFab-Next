# Increment review record — 2026-10-25

Independent read-only source review completed. No Critical or Important blocker
remains for this implementation increment. This is not visual/parity acceptance.

Findings corrected and verified:

- Research re-entry memo reused the prior session's unmapped-tool state. The new
  browser regression first failed `RUNNING != MAINT`; replay base is now React
  state and part of projection dependencies. The regression passes.
- English process search checked Chinese labels only. It now checks the
  translated label, source label and stable category; real UI search passes.
- An inactive Tour effect cancelled fresh preset transitions. Tour commands are
  idempotent and cinematic playback explicitly activates before setting a pose.
  Initial ISO and three preset coordinates match the original in GPU acceptance.
- GPU restoration previously matched waiting text as completed, and reused
  pre-loss geometry buffers. Acceptance now requires the explicit completed
  status, rebuilt native depth, unchanged manual pose and no validation errors.
  Production restoration rebuilds CPU-backed scene buffers and validates first
  submitted work. Lost/disposed epochs suppress stale acknowledgements; error
  scopes are balanced even when queue completion rejects.

Final review also checked the removal of the invented environment map and
unused independent-preview CSS. No runtime selector reference or source-level
regression was found. Reviewers did not independently rerun the browser tests;
the actual runtime outputs are retained in the adjacent evidence JSON files.

Remaining full HUD, B1/facility, Golden-data and performance gates are recorded
in `../baseline.md` and explicitly excluded from the code-review verdict.

## Main integration review — 2026-10-25

A fresh read-only reviewer inspected `6ed8a57..3edff85` before the requested
main integration. It found two Important workbench selection regressions in the
Redux migration: a stale run list replaced a newly created selection, and a site
with no runs displayed the previous site's selected run/totals. No Critical
finding was reported.

Both findings are fixed: list updates only initialize an empty selection;
changing sites clears selection; displayed run details/results require the
current site as well as the run ID. Three regressions were observed failing,
then passing, including an actual server-rendered page with foreign-site cached
RTK Query responses. The final frontend suite passes 124/124 tests, typecheck
and Vite build pass, as do 67 .NET tests, 15 Python tests, contract/architecture,
legacy import and frozen-original inventory checks. pnpm 12.15.0's package entry
point validated the frozen lockfile; its global Windows shim remains broken.

Minor findings remain: clearing a local catalog import leaves a stale error
banner, and modal focus trapping/restoration is pending Task 3. Full original
telemetry/MES, Golden acceptance and the 60-minute/repeated-loss GPU gates remain
outside this incremental integration verdict. Status is still
**IMPLEMENTING / NOT PARITY_VERIFIED**.
