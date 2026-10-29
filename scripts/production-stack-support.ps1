# Production-build acceptance stack helpers (Lead-owned).
# Starts the real API (scripts/start-dev.ps1 -ApiOnly) plus 'vite preview' over a
# production build, so browser gates exercise the built bundle rather than the
# Vite dev server. Every process is owned by this invocation and stopped in Stop-FabProductionStack.

. (Join-Path $PSScriptRoot 'start-dev-support.ps1')

function Get-FabProductionPnpm {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $fabWebDirectory = Join-Path $RepoRoot 'web_app'
    $fabPackage = Get-Content -LiteralPath (Join-Path $fabWebDirectory 'package.json') -Raw | ConvertFrom-Json
    if ($fabPackage.packageManager -notmatch '^pnpm@(?<version>\d+\.\d+\.\d+)$') { throw 'web_app/package.json must pin an exact pnpm version.' }
    $fabPnpmVersion = $Matches.version
    $fabNode = (Get-Command node.exe -ErrorAction Stop).Source
    $fabCandidates = @(
        (Join-Path $fabWebDirectory 'node_modules\pnpm\bin\pnpm.mjs'),
        (Join-Path $RepoRoot ".local\tooling\pnpm\$fabPnpmVersion\node_modules\pnpm\bin\pnpm.mjs")
    )
    foreach ($fabPnpmCommand in @(Get-Command pnpm.cmd -All -ErrorAction SilentlyContinue)) {
        $fabCandidates += Join-Path (Split-Path -Parent $fabPnpmCommand.Source) 'node_modules\pnpm\bin\pnpm.mjs'
    }
    $PSNativeCommandUseErrorActionPreference = $false
    foreach ($fabCandidate in $fabCandidates) {
        if (-not (Test-Path -LiteralPath $fabCandidate -PathType Leaf)) { continue }
        $fabVersion = & $fabNode $fabCandidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $fabVersion -eq $fabPnpmVersion) {
            return [pscustomobject]@{ Node = $fabNode; PnpmEntry = $fabCandidate; Version = $fabPnpmVersion; WebDirectory = $fabWebDirectory }
        }
    }
    $fabNpmCli = Join-Path (Split-Path -Parent (Get-Command npm.cmd -ErrorAction Stop).Source) 'node_modules\npm\bin\npm-cli.js'
    $fabEntry = Get-FabDevPnpm -NodePath $fabNode -NpmCli $fabNpmCli -Version $fabPnpmVersion -ToolingDirectory (Join-Path $RepoRoot ".local\tooling\pnpm\$fabPnpmVersion") -Candidates $fabCandidates
    return [pscustomobject]@{ Node = $fabNode; PnpmEntry = $fabEntry; Version = $fabPnpmVersion; WebDirectory = $fabWebDirectory }
}

function Wait-FabProductionHttp {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][int]$Attempts,
        [hashtable]$Headers = @{},
        [scriptblock]$Check = $null
    )
    for ($fabAttempt = 0; $fabAttempt -lt $Attempts; $fabAttempt++) {
        try {
            $fabResponse = Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $Headers -TimeoutSec 2
            if ($fabResponse.StatusCode -eq 200) {
                if ($null -eq $Check -or (& $Check)) { return $true }
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $Label at $Url"
}

function Start-FabProductionStack {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [int]$ApiPort = 5180,
        [int]$WebPort = 4180,
        [string]$LocalDirectory,
        [switch]$SkipBuild
    )

    $ErrorActionPreference = 'Stop'
    if (-not $LocalDirectory) { $LocalDirectory = Join-Path $RepoRoot '.local\production-acceptance' }
    $fabLocal = [IO.Path]::GetFullPath($LocalDirectory)
    New-Item -ItemType Directory -Path $fabLocal -Force | Out-Null
    $fabPnpm = Get-FabProductionPnpm -RepoRoot $RepoRoot
    $fabApiUrl = "http://127.0.0.1:$ApiPort"
    $fabWebUrl = "http://127.0.0.1:$WebPort"
    $fabKey = Get-FabDevelopmentKey -Path (Join-Path $fabLocal 'development-key')

    $fabTracked = @('ASPNETCORE_URLS', 'FAB_API_TARGET', 'NODE_ENV', 'FAB_DEVELOPMENT_KEY', 'Fab__DevelopmentKey', 'Fab__DataDirectory', 'ASPNETCORE_ENVIRONMENT', 'DOTNET_ENVIRONMENT')
    $fabEnvironment = @{}
    foreach ($fabName in $fabTracked) { $fabEnvironment[$fabName] = [Environment]::GetEnvironmentVariable($fabName, 'Process') }
    try {
        [Environment]::SetEnvironmentVariable('FAB_DEVELOPMENT_KEY', $fabKey, 'Process')
        [Environment]::SetEnvironmentVariable('Fab__DevelopmentKey', $fabKey, 'Process')
        [Environment]::SetEnvironmentVariable('FAB_API_TARGET', $fabApiUrl, 'Process')
        [Environment]::SetEnvironmentVariable('NODE_ENV', 'production', 'Process')

        if (-not $SkipBuild) {
            Write-Host "Building production bundle in $($fabPnpm.WebDirectory) ..."
            $fabBuildLog = Join-Path $fabLocal 'build.log'
            Push-Location -LiteralPath $fabPnpm.WebDirectory
            try {
                & $fabPnpm.Node $fabPnpm.PnpmEntry run build *> $fabBuildLog
                if ($LASTEXITCODE -ne 0) { throw "Production build failed with exit code $LASTEXITCODE; see $fabBuildLog" }
            } finally { Pop-Location }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $fabPnpm.WebDirectory 'dist\index.html') -PathType Leaf)) { throw 'web_app/dist/index.html is missing; run without -SkipBuild.' }

        $fabApiProcess = Start-FabDevProcess -FilePath 'pwsh' -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $RepoRoot 'scripts\start-dev.ps1'),
            '-ApiOnly', '-ApiPort', [string]$ApiPort, '-LocalDirectory', $fabLocal
        ) -WorkingDirectory $RepoRoot -StandardOutput (Join-Path $fabLocal 'api.log') -StandardError (Join-Path $fabLocal 'api-error.log')
        try {
            Wait-FabProductionHttp -Url "$fabApiUrl/health/ready" -Label 'production API' -Attempts 240 -Headers @{ 'X-Fab-Dev-Key' = $fabKey }
        } catch {
            Stop-FabDevProcess -Process $fabApiProcess
            throw
        }

        $fabPreviewProcess = Start-FabDevProcess -FilePath $fabPnpm.Node -Arguments @(
            $fabPnpm.PnpmEntry, 'exec', 'vite', 'preview', '--port', [string]$WebPort, '--strictPort'
        ) -WorkingDirectory $fabPnpm.WebDirectory -StandardOutput (Join-Path $fabLocal 'preview.log') -StandardError (Join-Path $fabLocal 'preview-error.log')
        try {
            Wait-FabProductionHttp -Url "$fabWebUrl/" -Label 'production preview' -Attempts 240
            Wait-FabProductionHttp -Url "$fabWebUrl/api/v1/sites" -Label 'preview API proxy' -Attempts 120
        } catch {
            Stop-FabDevProcess -Process $fabPreviewProcess
            Stop-FabDevProcess -Process $fabApiProcess
            throw
        }

        return [pscustomobject]@{
            RepoRoot = $RepoRoot
            ApiUrl = $fabApiUrl
            WebUrl = $fabWebUrl
            DevelopmentKey = $fabKey
            LocalDirectory = $fabLocal
            ApiProcess = $fabApiProcess
            PreviewProcess = $fabPreviewProcess
            Environment = $fabEnvironment
        }
    } catch {
        foreach ($fabName in $fabEnvironment.Keys) { Set-FabDevEnvironmentState -Name $fabName -Value $fabEnvironment[$fabName] }
        throw
    }
}

function Stop-FabProductionStack {
    param([Parameter(Mandatory = $true)]$Stack)

    foreach ($fabProcess in @($Stack.PreviewProcess, $Stack.ApiProcess)) {
        if ($null -eq $fabProcess) { continue }
        try { Stop-FabDevProcess -Process $fabProcess } catch { Write-Warning "Failed to stop owned process $($fabProcess.Id): $_" }
    }
    foreach ($fabName in $Stack.Environment.Keys) { Set-FabDevEnvironmentState -Name $fabName -Value $Stack.Environment[$fabName] }
}
