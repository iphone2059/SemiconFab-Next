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
