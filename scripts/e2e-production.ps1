[CmdletBinding()]
param(
    [int]$ApiPort = 5180,
    [int]$WebPort = 4180,
    [string]$Out = 'docs/architecture/evidence/browser/phase-f-production-e2e.json',
    [string]$Chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [switch]$SkipBuild,
    [string]$Mode = 'on'
)
$ErrorActionPreference = 'Stop'
$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $fabProjectRoot
. (Join-Path $PSScriptRoot 'production-stack-support.ps1')

$fabOut = [IO.Path]::GetFullPath((Join-Path $fabProjectRoot $Out))
New-Item -ItemType Directory -Path (Split-Path -Parent $fabOut) -Force | Out-Null
$fabCommit = (& git rev-parse HEAD).Trim()
$fabStack = $null
try {
    $fabStack = Start-FabProductionStack -RepoRoot $fabProjectRoot -ApiPort $ApiPort -WebPort $WebPort -SkipBuild:$SkipBuild
    Write-Host "Production stack ready: $($fabStack.WebUrl) (API $($fabStack.ApiUrl))"
    & node (Join-Path $fabProjectRoot 'tools/e2e_production.mjs') --web-url $fabStack.WebUrl --api-url $fabStack.ApiUrl --out $fabOut --chrome $Chrome --commit $fabCommit --mode $Mode
    $fabExit = $LASTEXITCODE
    if ($fabExit -ne 0) { Write-Host "Production e2e failed with exit code $fabExit"; exit $fabExit }
    Write-Host "Production e2e passed; evidence: $fabOut"
    exit 0
} finally {
    if ($null -ne $fabStack) { Stop-FabProductionStack -Stack $fabStack }
}
