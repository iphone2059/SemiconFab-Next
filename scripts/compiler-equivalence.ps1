[CmdletBinding()]
param(
    [int]$ApiPortOn = 5191,
    [int]$ApiPortOff = 5192,
    # Legacy single-port switch kept for existing invocations. It only seeds the ON port when
    # -ApiPortOn was not given explicitly; the OFF backend then uses $ApiPort + 1. Both modes
    # must always have their own port and their own Fab__DataDirectory database (P2-01).
    [int]$ApiPort = 0,
    [string]$OutDir = 'docs/architecture/evidence/compiler',
    [string]$Chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [string]$LocalDirectory
)
$ErrorActionPreference = 'Stop'
if ($PSBoundParameters.ContainsKey('ApiPort')) {
    if ($ApiPort -lt 1 -or $ApiPort -gt 65534) { throw '-ApiPort must be between 1 and 65534: the OFF backend uses ApiPort + 1.' }
    if (-not $PSBoundParameters.ContainsKey('ApiPortOn')) { $ApiPortOn = $ApiPort }
    if (-not $PSBoundParameters.ContainsKey('ApiPortOff')) { $ApiPortOff = $ApiPort + 1 }
}
if ($ApiPortOn -lt 1 -or $ApiPortOn -gt 65535 -or $ApiPortOff -lt 1 -or $ApiPortOff -gt 65535) { throw '-ApiPortOn and -ApiPortOff must be valid TCP ports.' }
if ($ApiPortOn -eq $ApiPortOff) { throw '-ApiPortOn and -ApiPortOff must be different ports: compiler ON/OFF backends are isolated.' }

$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $fabProjectRoot
. (Join-Path $PSScriptRoot 'production-stack-support.ps1')

if (-not $LocalDirectory) { $LocalDirectory = Join-Path $fabProjectRoot '.local\compiler-equivalence' }
$fabLocal = [IO.Path]::GetFullPath($LocalDirectory)
$fabOnLocal = Join-Path $fabLocal 'on'
$fabOffLocal = Join-Path $fabLocal 'off'
$fabOutDir = [IO.Path]::GetFullPath((Join-Path $fabProjectRoot $OutDir))
New-Item -ItemType Directory -Path $fabLocal -Force | Out-Null
New-Item -ItemType Directory -Path $fabOnLocal -Force | Out-Null
New-Item -ItemType Directory -Path $fabOffLocal -Force | Out-Null
New-Item -ItemType Directory -Path $fabOutDir -Force | Out-Null

function Reset-FabEquivalenceModeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    # Both modes must start from the same seeded development fixture. Removing the whole
    # Fab__DataDirectory drops commands.db, the Run store and equipment-status state; the API
    # re-seeds the deterministic fixture on startup.
    $fabData = Join-Path $Path 'data'
    if (Test-Path -LiteralPath $fabData) { Remove-Item -LiteralPath $fabData -Recurse -Force }
    New-Item -ItemType Directory -Path $fabData -Force | Out-Null
    foreach ($fabLogName in @('api.log', 'api-error.log')) {
        $fabLogPath = Join-Path $Path $fabLogName
        if (Test-Path -LiteralPath $fabLogPath) { Remove-Item -LiteralPath $fabLogPath -Force }
    }
}

function Start-FabEquivalenceApi {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ModeLocal,
        [Parameter(Mandatory = $true)][string]$Key
    )

    $fabUrl = "http://127.0.0.1:$Port"
    $fabProcess = Start-FabDevProcess -FilePath 'pwsh' -Arguments @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $fabProjectRoot 'scripts\start-dev.ps1'),
        '-ApiOnly', '-ApiPort', [string]$Port, '-LocalDirectory', $ModeLocal
    ) -WorkingDirectory $fabProjectRoot -StandardOutput (Join-Path $ModeLocal 'api.log') -StandardError (Join-Path $ModeLocal 'api-error.log')
    try {
        # start-dev.ps1 builds the API into $ModeLocal/artifacts and reads its development key
        # from $ModeLocal/development-key, so each mode stays fully independent.
        $null = Wait-FabProductionHttp -Url "$fabUrl/health/ready" -Label "$Label API" -Attempts 240 -Headers @{ 'X-Fab-Dev-Key' = $Key }
    } catch {
        try { Stop-FabDevProcess -Process $fabProcess } catch { }
        throw
    }
    return $fabProcess
}

function Stop-FabEquivalenceApi {
    param($Process, [string]$Label)

    if ($null -eq $Process) { return }
    try { Stop-FabDevProcess -Process $Process } catch { Write-Warning "Failed to stop $Label API: $_" }
}

function Wait-FabPortReleased {
    param([Parameter(Mandatory = $true)][int]$Port, [int]$Attempts = 40)

    for ($fabAttempt = 0; $fabAttempt -lt $Attempts; $fabAttempt++) {
        $fabListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if ($fabListeners.Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Show-FabEquivalenceLogs {
    param([string[]]$Directories)

    foreach ($fabDirectory in $Directories) {
        foreach ($fabLogName in @('api.log', 'api-error.log')) {
            $fabLogPath = Join-Path $fabDirectory $fabLogName
            if (-not (Test-Path -LiteralPath $fabLogPath -PathType Leaf)) { continue }
            Write-Host "----- tail 40 lines: $fabLogPath -----"
            Get-Content -LiteralPath $fabLogPath -Tail 40 | ForEach-Object { Write-Host $_ }
        }
    }
}

$fabCommit = (& git rev-parse HEAD).Trim()
$fabPnpm = Get-FabProductionPnpm -RepoRoot $fabProjectRoot
$fabKey = Get-FabDevelopmentKey -Path (Join-Path $fabLocal 'development-key')
# start-dev.ps1 only reads <LocalDirectory>/development-key, so both modes receive the same
# key by copying the shared key into their own LocalDirectory before they start.
foreach ($fabModeLocal in @($fabOnLocal, $fabOffLocal)) {
    [IO.File]::WriteAllText((Join-Path $fabModeLocal 'development-key'), $fabKey)
}
$fabApiUrlOn = "http://127.0.0.1:$ApiPortOn"
$fabApiUrlOff = "http://127.0.0.1:$ApiPortOff"
$fabOnProcess = $null
$fabOffProcess = $null
$fabExit = 1
try {
    Reset-FabEquivalenceModeDirectory -Path $fabOnLocal
    Reset-FabEquivalenceModeDirectory -Path $fabOffLocal
    Write-Host "Starting isolated compiler-equivalence backends: ON $fabApiUrlOn, OFF $fabApiUrlOff"
    # Sequential startup keeps the two dotnet builds from contending for the same NuGet/obj
    # directories while still producing two fully independent API processes and databases.
    $fabOnProcess = Start-FabEquivalenceApi -Label 'compiler-equivalence ON' -Port $ApiPortOn -ModeLocal $fabOnLocal -Key $fabKey
    $fabOffProcess = Start-FabEquivalenceApi -Label 'compiler-equivalence OFF' -Port $ApiPortOff -ModeLocal $fabOffLocal -Key $fabKey

    Write-Host 'Running CORE-011 compiler ON/OFF production equivalence ...'
    & node (Join-Path $fabProjectRoot 'tools/compiler_equivalence.mjs') --out-dir $fabOutDir --chrome $Chrome --commit $fabCommit --api-url-on $fabApiUrlOn --api-url-off $fabApiUrlOff --dev-key $fabKey --pnpm $fabPnpm.PnpmEntry
    $fabExit = $LASTEXITCODE
    if ($fabExit -ne 0) {
        Write-Host "Compiler equivalence failed with exit code $fabExit"
        Show-FabEquivalenceLogs -Directories @($fabOnLocal, $fabOffLocal)
    }
} catch {
    Write-Host "Compiler equivalence script failed: $_"
    Show-FabEquivalenceLogs -Directories @($fabOnLocal, $fabOffLocal)
    throw
} finally {
    # Every process is owned by this invocation; stop OFF first, then ON, and verify the ports
    # are actually released so a rerun never inherits a listener.
    Stop-FabEquivalenceApi -Process $fabOffProcess -Label 'compiler-equivalence OFF'
    Stop-FabEquivalenceApi -Process $fabOnProcess -Label 'compiler-equivalence ON'
    foreach ($fabPortPair in @(@('ON', $ApiPortOn), @('OFF', $ApiPortOff))) {
        if (-not (Wait-FabPortReleased -Port $fabPortPair[1])) {
            Write-Warning "Port $($fabPortPair[1]) is still listening after stopping the $($fabPortPair[0]) API; inspect the owning process before rerunning."
        }
    }
}
if ($fabExit -ne 0) { exit $fabExit }
Write-Host "Compiler equivalence passed; evidence: $fabOutDir"
exit 0
