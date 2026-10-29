[CmdletBinding()]
param(
    [int]$ApiPort = 5181,
    [int]$WebPort = 4181,
    [string]$Out = 'docs/architecture/evidence/gpu/gpu-gate.json',
    [string]$Chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [int]$DurationSeconds = 600,
    [switch]$SkipBuild
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
    Write-Host "Production stack ready for GPU gate: $($fabStack.WebUrl) (API $($fabStack.ApiUrl))"
    & node (Join-Path $fabProjectRoot 'tools/gpu_gate.mjs') --web-url $fabStack.WebUrl --api-url $fabStack.ApiUrl --out $fabOut --chrome $Chrome --commit $fabCommit --duration-seconds $DurationSeconds
    $fabExit = $LASTEXITCODE
    if ($fabExit -ne 0) { Write-Host "GPU gate failed with exit code $fabExit"; exit $fabExit }
    Write-Host "GPU gate passed; evidence: $fabOut"
    exit 0
} finally {
    if ($null -ne $fabStack) { Stop-FabProductionStack -Stack $fabStack }
}
