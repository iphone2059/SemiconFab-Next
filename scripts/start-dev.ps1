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
$fabSdkVersion = (Get-Content -LiteralPath (Join-Path $fabProjectRoot 'global.json') -Raw | ConvertFrom-Json).sdk.version
$fabDotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if ($null -eq $fabDotnetCommand) { throw "Install .NET SDK $fabSdkVersion (global.json), then reopen PowerShell." }
$fabDotnet = $fabDotnetCommand.Source
if (-not $ApiOnly) {
    $fabWebDirectory = Join-Path $fabProjectRoot 'web_app'
    $fabPackage = Get-Content -LiteralPath (Join-Path $fabWebDirectory 'package.json') -Raw | ConvertFrom-Json
    $fabNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $fabNpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $fabNodeCommand -or $null -eq $fabNpmCommand) { throw "Install Node.js $($fabPackage.engines.node) with npm (web_app/package.json), then reopen PowerShell." }
    $fabNode = $fabNodeCommand.Source
    $fabNpmDirectory = Split-Path -Parent $fabNpmCommand.Source
    $fabNpmCli = Join-Path $fabNpmDirectory 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $fabNpmCli)) { throw "Cannot find npm CLI at $fabNpmCli. Install Node.js with npm." }
    Assert-FabDevNodeVersion -NodePath $fabNode -NpmCli $fabNpmCli -RequiredRange $fabPackage.engines.node
    if ($fabPackage.packageManager -notmatch '^pnpm@(?<version>\d+\.\d+\.\d+)$') { throw 'web_app/package.json must pin an exact pnpm version.' }
    $fabPnpmVersion = $Matches.version
    $fabPnpmCandidates = @((Join-Path $fabWebDirectory 'node_modules\pnpm\bin\pnpm.mjs'))
    foreach ($fabPnpmCommand in @(Get-Command pnpm.cmd -All -ErrorAction SilentlyContinue)) {
        $fabPnpmCandidates += Join-Path (Split-Path -Parent $fabPnpmCommand.Source) 'node_modules\pnpm\bin\pnpm.mjs'
    }
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
if (-not $ApiOnly) { $fabEnvironment['NODE_ENV'] = 'development' }
$fabPreviousEnvironment = @{}
$fabApiProcess = $null
$fabWebProcess = $null
$fabExitCode = 0
Push-Location -LiteralPath $fabProjectRoot
try {
    # Resolve global.json from the repository root, including when called elsewhere.
    $PSNativeCommandUseErrorActionPreference = $false
    $fabSelectedSdk = & $fabDotnet --version
    if ($LASTEXITCODE -ne 0 -or $fabSelectedSdk -ne $fabSdkVersion) { throw "The required .NET SDK $fabSdkVersion could not be selected. Install the SDK specified in global.json, then reopen PowerShell." }
    if (-not $ApiOnly) {
        $fabPnpmTooling = Join-Path $fabProjectRoot ".local\tooling\pnpm\$fabPnpmVersion"
        $fabPnpmCli = Get-FabDevPnpm -NodePath $fabNode -NpmCli $fabNpmCli -Version $fabPnpmVersion -ToolingDirectory $fabPnpmTooling -Candidates $fabPnpmCandidates
        Install-FabDevWebDependencies -NodePath $fabNode -PnpmCli $fabPnpmCli -WebDirectory $fabWebDirectory
    }
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
        $fabWebProcess = Start-FabDevProcess -FilePath $fabNode -Arguments $fabWebArguments -WorkingDirectory $fabWebDirectory -StandardOutput $fabWebLog -StandardError $fabWebErrorLog
        $fabWebReady = $false
        $fabWebFailure = 'No readiness response.'
        for ($fabAttempt = 0; $fabAttempt -lt 120; $fabAttempt++) {
            $fabApiProcess.Refresh()
            $fabWebProcess.Refresh()
            if ($fabApiProcess.HasExited) { throw "API exited. Inspect $fabApiLog and $fabApiErrorLog." }
            if ($fabWebProcess.HasExited) { throw "Web exited with code $($fabWebProcess.ExitCode). Inspect $fabWebLog and $fabWebErrorLog." }
            try {
                $fabPage = Invoke-WebRequest "$fabWebUrl/" -UseBasicParsing -TimeoutSec 1
                if ($fabPage.StatusCode -ne 200) { throw 'Web page did not return HTTP 200.' }
                $fabSites = Invoke-RestMethod "$fabWebUrl/api/v1/sites" -TimeoutSec 1
                $fabCatalog = Invoke-RestMethod "$fabWebUrl/api/v1/catalog" -TimeoutSec 1
                if ($fabSites.Count -lt 1 -or $fabCatalog.items.Count -lt 1) { throw 'The API proxy returned no sites or catalog records.' }
                $fabWebReady = $true
                break
            } catch { $fabWebFailure = $_.Exception.Message }
            Start-Sleep -Milliseconds 250
        }
        if (-not $fabWebReady) { throw "Web did not become ready: $fabWebFailure. Inspect $fabWebLog and $fabWebErrorLog." }
        Write-Host "Web ready: $fabWebUrl/"
        Write-Host "Ctrl+click to browse: $fabWebUrl/"
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
            Set-FabDevEnvironmentState -Name $fabName -Value $fabPreviousEnvironment[$fabName]
        }
        Pop-Location
    }
}
exit $fabExitCode
