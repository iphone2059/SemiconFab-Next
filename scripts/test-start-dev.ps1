[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$fabSupportPath = Join-Path $PSScriptRoot 'start-dev-support.ps1'
if (-not (Test-Path -LiteralPath $fabSupportPath)) {
    Write-Error 'Startup support is missing; development keys and owned process cleanup cannot be verified.'
    exit 1
}
. $fabSupportPath

# Startup mutates process environment variables; the regression must prove it restores
# the caller exactly, including variables that were absent rather than blank.
$fabTrackedEnvironment = @(
    'ASPNETCORE_URLS', 'FAB_API_TARGET', 'NODE_ENV', 'FAB_DEVELOPMENT_KEY',
    'ASPNETCORE_ENVIRONMENT', 'DOTNET_ENVIRONMENT',
    'Fab__DataDirectory', 'Fab__DevelopmentKey', 'Fab__EmbeddedWorker'
)
$fabOriginalEnvironment = @{}
foreach ($fabName in $fabTrackedEnvironment) {
    $fabOriginalEnvironment[$fabName] = [Environment]::GetEnvironmentVariable($fabName, 'Process')
}

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

    # Use the real Node/semver implementation, without running the application.
    $fabNodePath = (Get-Command node.exe).Source
    $fabNpmCli = Join-Path (Split-Path -Parent (Get-Command npm.cmd).Source) 'node_modules\npm\bin\npm-cli.js'
    Assert-FabStartupTest ($null -ne (Get-Command Assert-FabDevNodeVersion -ErrorAction SilentlyContinue)) 'Startup must check the frontend Node requirement before installing dependencies.'
    Assert-FabDevNodeVersion -NodePath $fabNodePath -NpmCli $fabNpmCli -RequiredRange '>=18.0.0'
    $fabRejected = $false
    try { Assert-FabDevNodeVersion -NodePath $fabNodePath -NpmCli $fabNpmCli -RequiredRange '>=99.0.0 <100' }
    catch { $fabRejected = $_.Exception.Message -match '>=99.0.0 <100' }
    Assert-FabStartupTest $fabRejected 'An unsupported Node version must fail with the required range.'
    Write-Host 'PASS: supported and unsupported Node requirements'

    $fabWebDirectory = Join-Path $fabTestDirectory 'web app'
    New-Item -ItemType Directory -Path $fabWebDirectory | Out-Null
    $fabPnpmFixture = Join-Path $fabTestDirectory 'pinned pnpm.mjs'
    [IO.File]::WriteAllText($fabPnpmFixture, @'
import fs from 'node:fs';
import path from 'node:path';
if (process.argv[2] === '--version') {
  console.log('12.15.0');
} else {
  fs.writeFileSync('install-result.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
  if (fs.existsSync('fail-install')) process.exit(23);
  fs.mkdirSync('node_modules/vite/bin', { recursive: true });
  fs.writeFileSync('node_modules/vite/bin/vite.js', '');
}
'@)
    $fabToolingDirectory = Join-Path $fabTestDirectory 'local tooling'
    $fabResolvedPnpm = Get-FabDevPnpm -NodePath $fabNodePath -NpmCli $fabNpmCli -Version '12.15.0' -ToolingDirectory $fabToolingDirectory -Candidates @($fabPnpmFixture)
    Assert-FabStartupTest ($fabResolvedPnpm -ceq $fabPnpmFixture) 'A matching JavaScript entry must work without invoking the broken Windows pnpm shim.'
    Assert-FabStartupTest (-not (Test-Path -LiteralPath $fabToolingDirectory)) 'An existing matching pnpm must not trigger bootstrap.'

    $fabNpmFixture = Join-Path $fabTestDirectory 'npm bootstrap.mjs'
    [IO.File]::WriteAllText($fabNpmFixture, @'
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
fs.mkdirSync(path.join(prefix, 'node_modules/pnpm/bin'), { recursive: true });
fs.writeFileSync(path.join(prefix, 'bootstrap-result.json'), JSON.stringify(args));
fs.copyFileSync(new URL('./pinned pnpm.mjs', import.meta.url), path.join(prefix, 'node_modules/pnpm/bin/pnpm.mjs'));
'@)
    $fabWrongPnpm = Join-Path $fabTestDirectory 'old pnpm.mjs'
    [IO.File]::WriteAllText($fabWrongPnpm, "console.log('11.0.0');")
    $fabResolvedPnpm = Get-FabDevPnpm -NodePath $fabNodePath -NpmCli $fabNpmFixture -Version '12.15.0' -ToolingDirectory $fabToolingDirectory -Candidates @((Join-Path $fabTestDirectory 'missing.mjs'), $fabWrongPnpm)
    Assert-FabStartupTest ($fabResolvedPnpm -ceq (Join-Path $fabToolingDirectory 'node_modules\pnpm\bin\pnpm.mjs')) 'Missing/mismatched pnpm must bootstrap a local pinned entry.'
    $fabBootstrapArgs = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $fabToolingDirectory 'bootstrap-result.json')))
    Assert-FabStartupTest ($fabBootstrapArgs -contains 'pnpm@12.15.0' -and $fabBootstrapArgs -contains '--ignore-scripts' -and $fabBootstrapArgs -contains '--package-lock=false') 'Bootstrap must pin pnpm without changing the project lockfile or running bootstrap lifecycle scripts.'
    $fabCachedPnpm = Get-FabDevPnpm -NodePath $fabNodePath -NpmCli (Join-Path $fabTestDirectory 'must not run npm.mjs') -Version '12.15.0' -ToolingDirectory $fabToolingDirectory -Candidates @()
    Assert-FabStartupTest ($fabCachedPnpm -ceq $fabResolvedPnpm) 'Subsequent startup must reuse the local pinned tool without npm bootstrap.'
    $fabBrokenNpm = Join-Path $fabTestDirectory 'broken npm.mjs'
    [IO.File]::WriteAllText($fabBrokenNpm, 'process.exit(17);')
    $fabRejected = $false
    try { $null = Get-FabDevPnpm -NodePath $fabNodePath -NpmCli $fabBrokenNpm -Version '12.15.0' -ToolingDirectory (Join-Path $fabTestDirectory 'failed tooling') -Candidates @() }
    catch { $fabRejected = $_.Exception.Message -match '17' }
    Assert-FabStartupTest $fabRejected 'A pnpm bootstrap failure must stop startup with its exit code.'
    Write-Host 'PASS: matching pnpm, mismatched/missing pnpm bootstrap and local reuse'

    $fabPreviousNodeEnvironment = $env:NODE_ENV
    try {
        $env:NODE_ENV = 'production'
        $fabPreviousLocation = (Get-Location).Path
        Install-FabDevWebDependencies -NodePath $fabNodePath -PnpmCli $fabPnpmFixture -WebDirectory $fabWebDirectory
        $fabInstallResult = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $fabWebDirectory 'install-result.json')))
        Assert-FabStartupTest ($fabInstallResult.cwd -ceq $fabWebDirectory) 'Dependencies must be installed in web_app, including paths with spaces.'
        Assert-FabStartupTest (($fabInstallResult.args -join '|') -ceq 'install|--frozen-lockfile|--prod=false') 'Installation must preserve the lockfile and include development tools even under NODE_ENV=production.'
        Assert-FabStartupTest ((Get-Location).Path -ceq $fabPreviousLocation) 'Installing dependencies must restore the caller location.'
        [IO.File]::WriteAllText((Join-Path $fabWebDirectory 'fail-install'), '')
        $fabRejected = $false
        try { Install-FabDevWebDependencies -NodePath $fabNodePath -PnpmCli $fabPnpmFixture -WebDirectory $fabWebDirectory }
        catch { $fabRejected = $_.Exception.Message -match '23' }
        Assert-FabStartupTest $fabRejected 'An install failure must stop startup and report its exit code.'
        Assert-FabStartupTest ((Get-Location).Path -ceq $fabPreviousLocation) 'A failed install must restore the caller location.'
    } finally { Set-FabDevEnvironmentState -Name 'NODE_ENV' -Value $fabPreviousNodeEnvironment }
    $fabIncompletePnpm = Join-Path $fabTestDirectory 'incomplete install.mjs'
    [IO.File]::WriteAllText($fabIncompletePnpm, 'process.exit(0);')
    $fabIncompleteWeb = Join-Path $fabTestDirectory 'incomplete web'
    New-Item -ItemType Directory -Path $fabIncompleteWeb | Out-Null
    $fabRejected = $false
    try { Install-FabDevWebDependencies -NodePath $fabNodePath -PnpmCli $fabIncompletePnpm -WebDirectory $fabIncompleteWeb }
    catch { $fabRejected = $_.Exception.Message -match 'Vite' }
    Assert-FabStartupTest $fabRejected 'A successful installer without Vite must not allow Web startup.'
    Write-Host 'PASS: first-clone dependency install, development tools and failed install handling'

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

& (Join-Path $PSScriptRoot 'test-start-dev-flow.ps1')

foreach ($fabName in $fabTrackedEnvironment) {
    $fabActualValue = [Environment]::GetEnvironmentVariable($fabName, 'Process')
    $fabExpectedValue = $fabOriginalEnvironment[$fabName]
    if ($null -eq $fabExpectedValue) {
        Assert-FabStartupTest ($null -eq $fabActualValue) "Startup regression leaked $fabName; an absent caller variable must stay absent, not blank."
    } else {
        Assert-FabStartupTest ($fabActualValue -ceq $fabExpectedValue) "Startup regression must restore the caller's $fabName."
    }
}
Write-Host 'PASS: caller environment is restored exactly (no blank variables)'
