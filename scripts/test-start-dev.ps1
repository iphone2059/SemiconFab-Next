[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$fabSupportPath = Join-Path $PSScriptRoot 'start-dev-support.ps1'
if (-not (Test-Path -LiteralPath $fabSupportPath)) {
    Write-Error 'Startup support is missing; development keys and owned process cleanup cannot be verified.'
    exit 1
}
. $fabSupportPath

function Assert-FabStartupTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-FabStartupTestPort {
    $fabListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $fabListener.Start()
    try { return $fabListener.LocalEndpoint.Port }
    finally { $fabListener.Stop() }
}

function Test-FabStartupTestPort([int]$Port) {
    $fabClient = New-Object Net.Sockets.TcpClient
    try { $fabClient.Connect('127.0.0.1', $Port); return $true }
    catch { return $false }
    finally { $fabClient.Dispose() }
}

$fabTestDirectory = Join-Path ([IO.Path]::GetTempPath()) ('fab startup tests ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fabTestDirectory | Out-Null
$fabOwnedProcess = $null
try {
    $fabKeyPath = Join-Path $fabTestDirectory 'development-key'
    $fabKey = Get-FabDevelopmentKey -Path $fabKeyPath
    Assert-FabStartupTest ($fabKey -cmatch '^[0-9A-F]{64}$') 'A new development key must contain 32 random bytes as hexadecimal.'
    Assert-FabStartupTest ((Get-FabDevelopmentKey -Path $fabKeyPath) -ceq $fabKey) 'Restarting must reuse the same development key.'
    Write-Host 'PASS: development key generation and reuse'

    $fabListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $fabListener.Start()
    try {
        $fabOccupiedPort = $fabListener.LocalEndpoint.Port
        $fabRejected = $false
        try { Assert-FabDevPortAvailable -Port $fabOccupiedPort }
        catch { $fabRejected = $true }
        Assert-FabStartupTest $fabRejected 'An occupied port must be rejected before starting another server.'
        Assert-FabStartupTest (Test-FabStartupTestPort $fabOccupiedPort) 'Checking an occupied port must preserve its listener.'
        $fabRejectedDirectory = Join-Path $fabTestDirectory 'must not be created'
        $fabShell = [PowerShell]::Create()
        try {
            $null = $fabShell.AddCommand((Join-Path $PSScriptRoot 'start-dev.ps1')).AddParameter('ApiOnly').AddParameter('ApiPort', $fabOccupiedPort).AddParameter('LocalDirectory', $fabRejectedDirectory)
            try { $null = $fabShell.Invoke() } catch { }
            Assert-FabStartupTest $fabShell.HadErrors 'The startup entry point must reject an occupied API port.'
            Assert-FabStartupTest (-not (Test-Path -LiteralPath $fabRejectedDirectory)) 'Rejected startup must not create data or build output.'
            Assert-FabStartupTest (Test-FabStartupTestPort $fabOccupiedPort) 'Rejected startup must preserve the existing server.'
        } finally { $fabShell.Dispose() }
    } finally { $fabListener.Stop() }
    Assert-FabDevPortAvailable -Port $fabOccupiedPort
    Write-Host 'PASS: occupied ports are rejected without stopping their listener'

    $fabFixture = Join-Path $fabTestDirectory 'argument fixture.cjs'
    [IO.File]::WriteAllText($fabFixture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));')
    $fabOutput = Join-Path $fabTestDirectory 'arguments.json'
    $fabError = Join-Path $fabTestDirectory 'arguments-error.log'
    $fabArguments = @($fabFixture, 'with spaces', 'a"b', 'C:\with spaces\', '')
    $fabOwnedProcess = Start-FabDevProcess -FilePath (Get-Command node.exe).Source -Arguments $fabArguments -WorkingDirectory $fabTestDirectory -StandardOutput $fabOutput -StandardError $fabError
    $fabOwnedProcess.WaitForExit()
    Assert-FabStartupTest ($fabOwnedProcess.ExitCode -eq 0) 'The process must run successfully from a path containing spaces.'
    $fabActual = ConvertFrom-Json ([IO.File]::ReadAllText($fabOutput))
    Assert-FabStartupTest ($fabActual.Count -eq 4) 'Empty arguments must survive process startup.'
    Assert-FabStartupTest ($fabActual[0] -ceq 'with spaces') 'Spaces must survive argument quoting.'
    Assert-FabStartupTest ($fabActual[1] -ceq 'a"b') 'Quotes must survive argument quoting.'
    Assert-FabStartupTest ($fabActual[2] -ceq 'C:\with spaces\') 'Trailing backslashes must survive argument quoting.'
    Assert-FabStartupTest ($fabActual[3] -ceq '') 'An empty argument must stay empty.'
    Stop-FabDevProcess -Process $fabOwnedProcess
    $fabOwnedProcess = $null
    Write-Host 'PASS: paths, quotes, trailing backslashes and empty process arguments'

    $fabTreeFixture = Join-Path $fabTestDirectory 'process tree.cjs'
    [IO.File]::WriteAllText($fabTreeFixture, @'
const net = require('node:net');
if (process.argv[2] === '--child') {
  net.createServer().listen(Number(process.argv[3]), '127.0.0.1');
} else {
  const child = require('node:child_process').spawn(process.execPath, [__filename, '--child', process.argv[2]], { stdio: 'ignore' });
  process.stdout.write(String(child.pid));
  setInterval(() => {}, 1000);
}
'@)
    $fabChildPort = Get-FabStartupTestPort
    $fabTreeOutput = Join-Path $fabTestDirectory 'child.pid'
    $fabOwnedProcess = Start-FabDevProcess -FilePath (Get-Command node.exe).Source -Arguments @($fabTreeFixture, [string]$fabChildPort) -WorkingDirectory $fabTestDirectory -StandardOutput $fabTreeOutput -StandardError (Join-Path $fabTestDirectory 'tree-error.log')
    $fabChildReady = $false
    for ($fabAttempt = 0; $fabAttempt -lt 100; $fabAttempt++) {
        if (Test-FabStartupTestPort $fabChildPort) { $fabChildReady = $true; break }
        Start-Sleep -Milliseconds 50
    }
    Assert-FabStartupTest $fabChildReady 'The child process must own a real listener before cleanup is tested.'
    $fabChildId = [int](Get-Content -LiteralPath $fabTreeOutput -Raw)
    Stop-FabDevProcess -Process $fabOwnedProcess
    $fabOwnedProcess = $null
    Assert-FabStartupTest (-not (Test-FabStartupTestPort $fabChildPort)) 'Stopping an owned process must release its child listener.'
    Assert-FabStartupTest ($null -eq (Get-Process -Id $fabChildId -ErrorAction SilentlyContinue)) 'Stopping an owned process must stop its child process.'
    Write-Host 'PASS: owned process tree cleanup releases child processes and ports'
} finally {
    if ($null -ne $fabOwnedProcess) { Stop-FabDevProcess -Process $fabOwnedProcess }
    $fabResolvedTestDirectory = [IO.Path]::GetFullPath($fabTestDirectory)
    $fabResolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $fabResolvedTestDirectory.StartsWith($fabResolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to remove a test directory outside the temporary directory.' }
    Remove-Item -LiteralPath $fabResolvedTestDirectory -Recurse -Force
}
