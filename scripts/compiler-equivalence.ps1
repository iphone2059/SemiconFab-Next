[CmdletBinding()]
param(
    [int]$ApiPort = 5190,
    [string]$OutDir = 'docs/architecture/evidence/compiler',
    [string]$Chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [string]$LocalDirectory
)
$ErrorActionPreference = 'Stop'
$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $fabProjectRoot
. (Join-Path $PSScriptRoot 'production-stack-support.ps1')

if (-not $LocalDirectory) { $LocalDirectory = Join-Path $fabProjectRoot '.local\compiler-equivalence' }
$fabLocal = [IO.Path]::GetFullPath($LocalDirectory)
New-Item -ItemType Directory -Path $fabLocal -Force | Out-Null
$fabOutDir = [IO.Path]::GetFullPath((Join-Path $fabProjectRoot $OutDir))
New-Item -ItemType Directory -Path $fabOutDir -Force | Out-Null
$fabCommit = (& git rev-parse HEAD).Trim()
$fabPnpm = Get-FabProductionPnpm -RepoRoot $fabProjectRoot
$fabKey = Get-FabDevelopmentKey -Path (Join-Path $fabLocal 'development-key')
$fabApiUrl = "http://127.0.0.1:$ApiPort"
$fabProcess = $null
try {
    $fabProcess = Start-FabDevProcess -FilePath 'pwsh' -Arguments @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $fabProjectRoot 'scripts\start-dev.ps1'),
        '-ApiOnly', '-ApiPort', [string]$ApiPort, '-LocalDirectory', $fabLocal
    ) -WorkingDirectory $fabProjectRoot -StandardOutput (Join-Path $fabLocal 'api.log') -StandardError (Join-Path $fabLocal 'api-error.log')
    Wait-FabProductionHttp -Url "$fabApiUrl/health/ready" -Label 'compiler-equivalence API' -Attempts 240 -Headers @{ 'X-Fab-Dev-Key' = $fabKey }

    Write-Host 'Running CORE-011 compiler ON/OFF production equivalence ...'
    & node (Join-Path $fabProjectRoot 'tools/compiler_equivalence.mjs') --out-dir $fabOutDir --chrome $Chrome --commit $fabCommit --api-url $fabApiUrl --dev-key $fabKey --pnpm $fabPnpm.PnpmEntry
    $fabExit = $LASTEXITCODE
    if ($fabExit -ne 0) { Write-Host "Compiler equivalence failed with exit code $fabExit"; exit $fabExit }
    Write-Host "Compiler equivalence passed; evidence: $fabOutDir"
    exit 0
} finally {
    if ($null -ne $fabProcess) {
        try { Stop-FabDevProcess -Process $fabProcess } catch { Write-Warning "Failed to stop compiler-equivalence API: $_" }
    }
}
