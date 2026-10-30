param(
    # Canonical composite FAB identity of the development fixture (DEMO-SITE / FAB-01).
    [string]$Url = 'http://127.0.0.1:5173/sites/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/fabs/37793fb6-5679-b7a3-3fef-d970433697c1/3d',
    [int]$Frames = 180,
    [string]$Out = '.local/render-perf.json',
    # dev keeps the historical p95 <= 100 ms gate; 60hz adds p95 <= 16.7 ms, p99 <= 33 ms
    # and JS-heap growth <= 32 MB; custom starts from the dev budget (overrides via node CLI).
    [ValidateSet('dev', '60hz', 'custom')]
    [string]$Profile = 'dev'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
node tools/render_perf.mjs --url $Url --frames $Frames --profile $Profile --out $Out
exit $LASTEXITCODE
