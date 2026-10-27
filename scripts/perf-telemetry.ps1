param(
    [string]$Url = 'http://127.0.0.1:5173/',
    [int]$Seconds = 10,
    [int]$Rate = 60,
    [string]$Out = '.local/telemetry-stress.json'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
node tools/telemetry_stress.mjs --url $Url --seconds $Seconds --rate $Rate --out $Out
exit $LASTEXITCODE
