param(
    [string]$Url = 'http://127.0.0.1:5173/fabs/FAB-01/3d',
    [int]$Frames = 180,
    [string]$Out = '.local/render-perf.json'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
node tools/render_perf.mjs --url $Url --frames $Frames --out $Out
exit $LASTEXITCODE
