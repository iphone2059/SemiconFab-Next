[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$ApiPort = 5280,
    [ValidateRange(1, 65535)][int]$WebPort = 5273,
    [switch]$ApiOnly,
    [switch]$SeparateWorker
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'start-dev-support.ps1')
Assert-FabDevPortAvailable -Port $ApiPort
if (-not $ApiOnly) { Assert-FabDevPortAvailable -Port $WebPort }
$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fabSmokeDirectory = Join-Path $fabProjectRoot ('.local\startup smoke ' + [Guid]::NewGuid().ToString('N'))
$fabApiUrl = "http://127.0.0.1:$ApiPort"
$fabWebUrl = "http://127.0.0.1:$WebPort"
$fabPreviousUrls = $env:ASPNETCORE_URLS
$fabPreviousTarget = $env:FAB_API_TARGET
$fabShell = [PowerShell]::Create()
$fabInvocation = $null
$fabReady = $false
try {
    # A caller's stale targets must not redirect readiness or the Vite proxy.
    $env:ASPNETCORE_URLS = 'http://127.0.0.1:1'
    $env:FAB_API_TARGET = 'http://127.0.0.1:1'
    $null = $fabShell.AddCommand((Join-Path $PSScriptRoot 'start-dev.ps1')).AddParameter('ApiPort', $ApiPort).AddParameter('WebPort', $WebPort).AddParameter('LocalDirectory', $fabSmokeDirectory)
    if ($ApiOnly) { $null = $fabShell.AddParameter('ApiOnly') }
    if ($SeparateWorker) { $null = $fabShell.AddParameter('SeparateWorker') }
    $fabInvocation = $fabShell.BeginInvoke()
    Write-Host "Checking real startup on $fabApiUrl$(if (-not $ApiOnly) { " and $fabWebUrl" }); logs: $fabSmokeDirectory"
    $fabDeadline = [DateTime]::UtcNow.AddSeconds(90)
    $fabLastFailure = 'No readiness response.'
    while ([DateTime]::UtcNow -lt $fabDeadline) {
        if ($fabShell.InvocationStateInfo.State -in @('Completed', 'Failed', 'Stopped')) {
            throw "Startup stopped before readiness: $($fabShell.InvocationStateInfo.Reason) $($fabShell.Streams.Error | Out-String)"
        }
        try {
            $fabKeyPath = Join-Path $fabSmokeDirectory 'development-key'
            if (-not (Test-Path -LiteralPath $fabKeyPath)) { throw 'Waiting for the generated development key.' }
            $fabHeaders = @{ 'X-Fab-Dev-Key' = [IO.File]::ReadAllText($fabKeyPath).Trim() }
            $fabHealth = Invoke-RestMethod "$fabApiUrl/health/ready" -Headers $fabHeaders -TimeoutSec 1
            if ($fabHealth.status -ne 'ready') { throw 'API health did not report ready.' }
            if (-not $ApiOnly) {
                $fabPage = Invoke-WebRequest "$fabWebUrl/twin" -UseBasicParsing -TimeoutSec 1
                if ($fabPage.StatusCode -ne 200) { throw '/twin did not return HTTP 200.' }
                $fabSites = Invoke-RestMethod "$fabWebUrl/api/v1/sites" -TimeoutSec 1
                $fabCatalog = Invoke-RestMethod "$fabWebUrl/api/v1/catalog" -TimeoutSec 1
                if ($fabSites.Count -lt 1 -or $fabCatalog.items.Count -lt 1) { throw 'The authenticated API proxy returned no sites or catalog records.' }
            }
            $fabReady = $true
            break
        } catch { $fabLastFailure = $_.Exception.Message }
        Start-Sleep -Milliseconds 250
    }
    if (-not $fabReady) { throw "Startup smoke timed out: $fabLastFailure. Inspect $fabSmokeDirectory." }
    Write-Host 'PASS: API readiness and generated key'
    if (-not $ApiOnly) { Write-Host 'PASS: /twin and authenticated sites/catalog proxy' }
} finally {
    try {
        # Stopping the pipeline exercises the script's finally path, as Ctrl+C does.
        if ($null -ne $fabInvocation) {
            $fabShell.Stop()
            try { $null = $fabShell.EndInvoke($fabInvocation) }
            catch {
                if ($_.Exception.InnerException -isnot [Management.Automation.PipelineStoppedException] -and $_.Exception -isnot [Management.Automation.PipelineStoppedException]) {
                    Write-Warning "Startup pipeline error: $($_.Exception.Message)"
                }
            }
        }
        $fabDeadline = [DateTime]::UtcNow.AddSeconds(5)
        $fabReleased = $false
        while ([DateTime]::UtcNow -lt $fabDeadline) {
            try {
                Assert-FabDevPortAvailable -Port $ApiPort
                if (-not $ApiOnly) { Assert-FabDevPortAvailable -Port $WebPort }
                $fabReleased = $true
                break
            } catch { Start-Sleep -Milliseconds 100 }
        }
        if (-not $fabReleased) { throw 'Startup cleanup left an owned listener running.' }
        if ($env:ASPNETCORE_URLS -ne 'http://127.0.0.1:1' -or $env:FAB_API_TARGET -ne 'http://127.0.0.1:1') { throw 'Startup did not restore its caller environment.' }
        Write-Host 'PASS: cancellation cleanup releases owned ports and restores caller targets'
    } finally {
        $fabShell.Dispose()
        Set-FabDevEnvironmentState -Name 'ASPNETCORE_URLS' -Value $fabPreviousUrls
        Set-FabDevEnvironmentState -Name 'FAB_API_TARGET' -Value $fabPreviousTarget
    }
}
