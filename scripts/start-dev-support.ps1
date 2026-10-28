function Assert-FabDevNodeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$NpmCli,
        [Parameter(Mandatory = $true)][string]$RequiredRange
    )

    # npm ships semver; do not depend on web_app/node_modules on a fresh clone.
    $fabSemverPath = Join-Path (Split-Path -Parent (Split-Path -Parent $NpmCli)) 'node_modules\semver'
    $PSNativeCommandUseErrorActionPreference = $false
    $fabNodeVersion = & $NodePath -e 'process.stdout.write(process.versions.node); process.exit(require(process.argv[1]).satisfies(process.versions.node, process.argv[2]) ? 0 : 1)' $fabSemverPath $RequiredRange
    if ($LASTEXITCODE -ne 0) { throw "Node.js $fabNodeVersion does not satisfy web_app/package.json ($RequiredRange). Install a matching Node.js version with npm, then reopen PowerShell." }
}

function Get-FabDevPnpm {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$NpmCli,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$ToolingDirectory,
        [AllowEmptyCollection()][string[]]$Candidates = @()
    )

    $PSNativeCommandUseErrorActionPreference = $false
    $fabLocalEntry = Join-Path $ToolingDirectory 'node_modules\pnpm\bin\pnpm.mjs'
    foreach ($fabCandidate in @($fabLocalEntry) + $Candidates) {
        if (-not (Test-Path -LiteralPath $fabCandidate -PathType Leaf)) { continue }
        try {
            $fabCandidateVersion = & $NodePath $fabCandidate --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $fabCandidateVersion -eq $Version) { return $fabCandidate }
        } catch { }
    }

    # Avoid extensionless pnpm.cmd shims and leave global tooling unchanged.
    Write-Host "Preparing pnpm $Version in $ToolingDirectory ..."
    & $NodePath $NpmCli install --prefix $ToolingDirectory --no-save --package-lock=false --ignore-scripts --no-audit --no-fund --include=dev "pnpm@$Version" | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "pnpm $Version bootstrap failed with exit code $LASTEXITCODE. Check the npm output above and registry/network access, then rerun this script." }
    if (-not (Test-Path -LiteralPath $fabLocalEntry -PathType Leaf)) { throw "pnpm bootstrap did not create $fabLocalEntry." }
    $fabInstalledVersion = & $NodePath $fabLocalEntry --version
    if ($LASTEXITCODE -ne 0 -or $fabInstalledVersion -ne $Version) { throw "Cannot run the required pnpm $Version at $fabLocalEntry." }
    return $fabLocalEntry
}

function Install-FabDevWebDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$PnpmCli,
        [Parameter(Mandatory = $true)][string]$WebDirectory
    )

    $PSNativeCommandUseErrorActionPreference = $false
    Push-Location -LiteralPath $WebDirectory
    try {
        # Incremental install detects missing/stale dependencies using pnpm itself.
        # Vite is a devDependency, even when the caller has NODE_ENV=production.
        Write-Host 'Checking and installing frontend dependencies from pnpm-lock.yaml ...'
        & $NodePath $PnpmCli install --frozen-lockfile --prod=false | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Frontend dependency installation failed with exit code $LASTEXITCODE. Check the pnpm output above and registry/network access, then rerun this script." }
        if (-not (Test-Path -LiteralPath 'node_modules\vite\bin\vite.js' -PathType Leaf)) { throw 'Frontend dependency installation did not provide Vite. Check the pnpm output above.' }
    } finally { Pop-Location }
}

function Get-FabDevelopmentKey {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        $fabBytes = New-Object byte[] 32
        $fabRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $fabRandom.GetBytes($fabBytes) }
        finally { $fabRandom.Dispose() }
        [IO.File]::WriteAllText($Path, [BitConverter]::ToString($fabBytes).Replace('-', ''))
    }
    $fabKey = [IO.File]::ReadAllText($Path).Trim()
    if ($fabKey.Length -lt 32) { throw "Development key is too short: $Path" }
    return $fabKey
}

function Set-FabDevEnvironmentState {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()]$Value
    )

    # [Environment]::SetEnvironmentVariable converts a PowerShell $null argument to an
    # empty string. A blank variable still binds to configuration (for example
    # Fab__EmbeddedWorker='' fails the API host), so an absent variable must be removed.
    if ($null -eq $Value) {
        Remove-Item -Path ('Env:' + $Name) -ErrorAction SilentlyContinue
        return
    }
    [Environment]::SetEnvironmentVariable($Name, [string]$Value, 'Process')
}

function Assert-FabDevPortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)

    $fabListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try {
        $fabListener.Server.ExclusiveAddressUse = $true
        $fabListener.Start()
    } catch {
        throw "Port $Port is already in use. Stop its owner yourself or select another port with -ApiPort / -WebPort."
    } finally { $fabListener.Stop() }
}

function Start-FabDevProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$StandardOutput,
        [Parameter(Mandatory = $true)][string]$StandardError
    )

    # Start-Process joins ArgumentList with spaces on Windows, including in PS 5.1.
    # Quote each argument using the Windows C runtime rules, including final slashes.
    $fabQuotedArguments = foreach ($fabArgument in $Arguments) {
        $fabQuoted = [regex]::Replace($fabArgument, '(\\*)"', '$1$1\"')
        $fabQuoted = [regex]::Replace($fabQuoted, '(\\+)$', '$1$1')
        '"' + $fabQuoted + '"'
    }
    $fabProcess = Start-Process -FilePath $FilePath -ArgumentList ($fabQuotedArguments -join ' ') -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError
    # Retain the handle before a fast child exits; PS 5.1 otherwise loses ExitCode.
    $null = $fabProcess.Handle
    return $fabProcess
}

function Stop-FabDevProcess {
    param([Parameter(Mandatory = $true)][Diagnostics.Process]$Process)

    $Process.Refresh()
    if ($Process.HasExited) { return }
    # Only target the process created by this invocation and its descendants.
    # Killing npm alone leaves Vite's node process listening after Ctrl+C.
    $fabTaskKill = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -ArgumentList @('/PID', [string]$Process.Id, '/T', '/F') -WindowStyle Hidden -PassThru -Wait
    $Process.WaitForExit(5000) | Out-Null
    $Process.Refresh()
    if (-not $Process.HasExited) { throw "Could not stop owned process $($Process.Id); taskkill exit code $($fabTaskKill.ExitCode)." }
}
