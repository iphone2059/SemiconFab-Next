[CmdletBinding()]
param(
    [switch]$ApiOnly,
    [switch]$SeparateWorker,
    [ValidateRange(1, 65535)][int]$ApiPort = 5080,
    [ValidateRange(1, 65535)][int]$WebPort = 5173,
    [string]$LocalDirectory
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'start-dev-support.ps1')
$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $LocalDirectory) { $LocalDirectory = Join-Path $fabProjectRoot '.local' }
$fabLocalDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LocalDirectory)
$fabApiUrl = "http://127.0.0.1:$ApiPort"
$fabWebUrl = "http://127.0.0.1:$WebPort"

# Never reuse another invocation's listeners or stop their owners.
Assert-FabDevPortAvailable -Port $ApiPort
if (-not $ApiOnly) {
    if ($ApiPort -eq $WebPort) { throw 'ApiPort and WebPort must be different.' }
    Assert-FabDevPortAvailable -Port $WebPort
}
$fabDotnet = (Get-Command dotnet.exe -ErrorAction Stop).Source
if (-not $ApiOnly) {
    $fabNode = (Get-Command node.exe -ErrorAction Stop).Source
    $fabNpmDirectory = Split-Path -Parent (Get-Command npm.cmd -ErrorAction Stop).Source
    $fabNpmCli = Join-Path $fabNpmDirectory 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $fabNpmCli)) { throw "Cannot find npm CLI at $fabNpmCli. Install Node.js with npm." }
}

New-Item -ItemType Directory -Path $fabLocalDirectory -Force | Out-Null
$fabEnvironment = @{
    FAB_DEVELOPMENT_KEY = Get-FabDevelopmentKey -Path (Join-Path $fabLocalDirectory 'development-key')
    Fab__DataDirectory = Join-Path $fabLocalDirectory 'data'
    ASPNETCORE_ENVIRONMENT = 'Development'
    DOTNET_ENVIRONMENT = 'Development'
    Fab__EmbeddedWorker = if ($SeparateWorker) { 'false' } else { 'true' }
    ASPNETCORE_URLS = $fabApiUrl
    FAB_API_TARGET = $fabApiUrl
}
$fabEnvironment['Fab__DevelopmentKey'] = $fabEnvironment['FAB_DEVELOPMENT_KEY']
$fabPreviousEnvironment = @{}
$fabApiProcess = $null
$fabWebProcess = $null
$fabExitCode = 0
Push-Location -LiteralPath $fabProjectRoot
try {
    foreach ($fabName in $fabEnvironment.Keys) {
        $fabPreviousEnvironment[$fabName] = [Environment]::GetEnvironmentVariable($fabName, 'Process')
        [Environment]::SetEnvironmentVariable($fabName, $fabEnvironment[$fabName], 'Process')
    }
    $fabArtifactsDirectory = Join-Path $fabLocalDirectory 'artifacts'
    & $fabDotnet build (Join-Path $fabProjectRoot 'fab_app\fab_app.csproj') -c Debug --artifacts-path $fabArtifactsDirectory --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw "API build failed with exit code $LASTEXITCODE." }

    $fabApiLog = Join-Path $fabLocalDirectory 'api.log'
    $fabApiErrorLog = Join-Path $fabLocalDirectory 'api-error.log'
    $fabApiDll = Join-Path $fabArtifactsDirectory 'bin\fab_app\debug\fab_app.dll'
    $fabApiProcess = Start-FabDevProcess -FilePath $fabDotnet -Arguments @($fabApiDll) -WorkingDirectory $fabProjectRoot -StandardOutput $fabApiLog -StandardError $fabApiErrorLog
    $fabReady = $false
    for ($fabAttempt = 0; $fabAttempt -lt 120; $fabAttempt++) {
        $fabApiProcess.Refresh()
        if ($fabApiProcess.HasExited) { throw "API exited with code $($fabApiProcess.ExitCode). Inspect $fabApiErrorLog and $fabApiLog." }
        try {
            $fabResponse = Invoke-RestMethod "$fabApiUrl/health/ready" -Headers @{ 'X-Fab-Dev-Key' = $env:FAB_DEVELOPMENT_KEY } -TimeoutSec 1
            if ($fabResponse.status -eq 'ready') { $fabReady = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $fabReady) { throw "API did not become ready. Inspect $fabApiLog and $fabApiErrorLog." }
    Write-Host "API ready: $fabApiUrl"

    if (-not $ApiOnly) {
        $fabWebLog = Join-Path $fabLocalDirectory 'web.log'
        $fabWebErrorLog = Join-Path $fabLocalDirectory 'web-error.log'
        # Run the existing npm script without a .cmd shell, retaining its node child tree.
        $fabWebArguments = @($fabNpmCli, 'run', 'dev')
        if ($WebPort -ne 5173) { $fabWebArguments += @('--', '--port', [string]$WebPort) }
        $fabWebProcess = Start-FabDevProcess -FilePath $fabNode -Arguments $fabWebArguments -WorkingDirectory (Join-Path $fabProjectRoot 'web_app') -StandardOutput $fabWebLog -StandardError $fabWebErrorLog
        $fabWebReady = $false
        for ($fabAttempt = 0; $fabAttempt -lt 120; $fabAttempt++) {
            $fabApiProcess.Refresh()
            $fabWebProcess.Refresh()
            if ($fabApiProcess.HasExited) { throw "API exited. Inspect $fabApiLog and $fabApiErrorLog." }
            if ($fabWebProcess.HasExited) { throw "Web exited with code $($fabWebProcess.ExitCode). Inspect $fabWebLog and $fabWebErrorLog." }
            try {
                $fabPage = Invoke-WebRequest "$fabWebUrl/twin" -UseBasicParsing -TimeoutSec 1
                if ($fabPage.StatusCode -eq 200) { $fabWebReady = $true; break }
            } catch { }
            Start-Sleep -Milliseconds 250
        }
        if (-not $fabWebReady) { throw "Web did not become ready. Inspect $fabWebLog and $fabWebErrorLog." }
        Write-Host "Web ready: $fabWebUrl/twin"
    }
    Write-Host "Logs: $fabLocalDirectory; press Ctrl+C to stop this invocation."
    while ($true) {
        $fabApiProcess.Refresh()
        if ($fabApiProcess.HasExited) { $fabExitCode = $fabApiProcess.ExitCode; break }
        if ($null -ne $fabWebProcess) {
            $fabWebProcess.Refresh()
            if ($fabWebProcess.HasExited) { $fabExitCode = $fabWebProcess.ExitCode; break }
        }
        Start-Sleep -Milliseconds 250
    }
} finally {
    try {
        try {
            if ($null -ne $fabWebProcess) { Stop-FabDevProcess -Process $fabWebProcess }
        } finally {
            if ($null -ne $fabApiProcess) { Stop-FabDevProcess -Process $fabApiProcess }
        }
    } finally {
        foreach ($fabName in $fabPreviousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($fabName, $fabPreviousEnvironment[$fabName], 'Process')
        }
        Pop-Location
    }
}
exit $fabExitCode
