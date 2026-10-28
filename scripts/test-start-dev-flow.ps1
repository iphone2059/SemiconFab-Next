[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'start-dev-support.ps1')
$fabFixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('fab startup flow ' + [Guid]::NewGuid().ToString('N'))
$fabNodePath = (Get-Command node.exe).Source
$fabCallerEnvironment = @{
    ASPNETCORE_URLS = 'http://caller.invalid:1'
    FAB_API_TARGET = 'http://caller.invalid:2'
    NODE_ENV = 'production'
    FAB_DEVELOPMENT_KEY = 'caller-key'
}
$fabTrackedEnvironment = @(
    'ASPNETCORE_URLS', 'FAB_API_TARGET', 'NODE_ENV', 'FAB_DEVELOPMENT_KEY',
    'ASPNETCORE_ENVIRONMENT', 'DOTNET_ENVIRONMENT',
    'Fab__DataDirectory', 'Fab__DevelopmentKey', 'Fab__EmbeddedWorker'
)
$fabOriginalEnvironment = @{}
$fabExpectedEnvironment = @{}
foreach ($fabName in $fabTrackedEnvironment) {
    $fabOriginalEnvironment[$fabName] = [Environment]::GetEnvironmentVariable($fabName, 'Process')
    if ($fabCallerEnvironment.ContainsKey($fabName)) {
        $fabExpectedEnvironment[$fabName] = $fabCallerEnvironment[$fabName]
    } else {
        $fabExpectedEnvironment[$fabName] = $fabOriginalEnvironment[$fabName]
    }
}

function Assert-FabFlowTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-FabFlowTestPort {
    $fabListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $fabListener.Start()
    try { return $fabListener.LocalEndpoint.Port }
    finally { $fabListener.Stop() }
}

try {
    foreach ($fabMode in @('ready', 'api-only', 'sdk-mismatch', 'node-mismatch', 'install-failure', 'proxy-failure')) {
        $fabApiFixturePort = Get-FabFlowTestPort
        do { $fabWebFixturePort = Get-FabFlowTestPort } while ($fabWebFixturePort -eq $fabApiFixturePort)
        $fabCaseRoot = Join-Path $fabFixtureRoot $fabMode
        $fabScripts = Join-Path $fabCaseRoot 'scripts'
        $fabWeb = Join-Path $fabCaseRoot 'web_app'
        $fabPnpmBin = Join-Path $fabCaseRoot '.local\tooling\pnpm\12.15.0\node_modules\pnpm\bin'
        New-Item -ItemType Directory -Path $fabScripts, $fabWeb, $fabPnpmBin -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-dev.ps1') -Destination $fabScripts
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-dev-support.ps1') -Destination $fabScripts
        [IO.File]::WriteAllText((Join-Path $fabCaseRoot 'fixture.json'), (ConvertTo-Json @{ node = $fabNodePath; mode = $fabMode; apiPort = $fabApiFixturePort; webPort = $fabWebFixturePort }))
        [IO.File]::WriteAllText((Join-Path $fabCaseRoot 'global.json'), (ConvertTo-Json @{ sdk = @{ version = (& $fabNodePath --version) } }))
        [IO.File]::WriteAllText((Join-Path $fabWeb 'package.json'), '{"packageManager":"pnpm@12.15.0","engines":{"node":">=18.0.0"}}')
        if ($fabMode -eq 'sdk-mismatch') { [IO.File]::WriteAllText((Join-Path $fabCaseRoot 'global.json'), '{"sdk":{"version":"99.0.100"}}') }
        if ($fabMode -eq 'node-mismatch') { [IO.File]::WriteAllText((Join-Path $fabWeb 'package.json'), '{"packageManager":"pnpm@12.15.0","engines":{"node":">=99.0.0 <100"}}') }
        [IO.File]::WriteAllText((Join-Path $fabCaseRoot 'build'), 'require("node:fs").appendFileSync("events.txt", "build\n");')
        [IO.File]::WriteAllText((Join-Path $fabPnpmBin 'pnpm.mjs'), @'
import fs from 'node:fs';
if (process.argv[2] === '--version') { console.log('12.15.0'); }
else {
  fs.appendFileSync('../events.txt', 'install\n');
  if (JSON.parse(fs.readFileSync('../fixture.json')).mode === 'install-failure') process.exit(23);
  fs.mkdirSync('node_modules/vite/bin', { recursive: true });
  fs.writeFileSync('node_modules/vite/bin/vite.js', '');
}
'@)
        # Only external process/network boundaries are replaced. The copied entry
        # point, Node checks, pnpm selection, dependency install and finally are real.
        Add-Content -LiteralPath (Join-Path $fabScripts 'start-dev-support.ps1') -Value @'
$script:fabFixtureRoot = Split-Path -Parent $PSScriptRoot
$script:fabFixture = Get-Content -LiteralPath (Join-Path $script:fabFixtureRoot 'fixture.json') -Raw | ConvertFrom-Json
function Write-FabFixtureEvent([string]$Event) {
    [IO.File]::AppendAllText((Join-Path $script:fabFixtureRoot 'events.txt'), $Event + "`n")
}
function Get-Command {
    param([string]$Name, [switch]$All, [string]$ErrorAction)
    if ($Name -eq 'dotnet.exe') { return [pscustomobject]@{ Source = $script:fabFixture.node } }
    if ($script:fabFixture.mode -eq 'api-only' -and $Name -match 'node|npm') { throw 'API-only must not require Node/npm/pnpm.' }
    if ($Name -eq 'pnpm.cmd') { return }
    Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
}
function Start-FabDevProcess {
    param($FilePath, $Arguments, $WorkingDirectory, $StandardOutput, $StandardError)
    $fabKind = if ($Arguments[0] -match 'npm-cli\.js$') { 'web' } else { 'api' }
    if ($fabKind -eq 'web' -and (($Arguments[1..4] -join '|') -cne 'run|dev|--|--port' -or $Arguments[5] -ne [string]$script:fabFixture.webPort)) { throw 'Custom Web ports must reach npm run dev.' }
    Write-FabFixtureEvent "start:$fabKind"
    $fabProcess = [pscustomobject]@{ Kind = $fabKind; HasExited = $false; ExitCode = 0; Refreshes = 0; Mode = $script:fabFixture.mode }
    $fabProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value {
        $this.Refreshes++
        if ($this.Kind -eq 'api' -and $this.Mode -ne 'proxy-failure' -and $this.Refreshes -ge 3) { $this.HasExited = $true }
    }
    return $fabProcess
}
function Stop-FabDevProcess { param($Process); Write-FabFixtureEvent "stop:$($Process.Kind)" }
function Start-Process { throw 'Opening browsers or starting real servers is forbidden in this fixture.' }
function Start-Sleep { param($Milliseconds) }
function Invoke-WebRequest {
    param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
    if ($Uri -ne "http://127.0.0.1:$($script:fabFixture.webPort)/") { throw "Unexpected Web target: $Uri" }
    Write-FabFixtureEvent 'page'
    return [pscustomobject]@{ StatusCode = 200 }
}
function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec)
    if ($Uri -match '/health/ready$') {
        if ($Uri -ne "http://127.0.0.1:$($script:fabFixture.apiPort)/health/ready") { throw "Unexpected API target: $Uri" }
        return [pscustomobject]@{ status = 'ready' }
    }
    if (-not $Uri.StartsWith("http://127.0.0.1:$($script:fabFixture.webPort)/api/")) { throw "Unexpected proxy target: $Uri" }
    if ($Uri -match '/api/v1/sites$') {
        Write-FabFixtureEvent 'sites'
        if ($script:fabFixture.mode -eq 'proxy-failure') { throw 'Proxy authentication failed.' }
        # Invoke-RestMethod emits JSON arrays as a single pipeline object.
        return ,@([pscustomobject]@{ siteId = 'fixture-site' })
    }
    if ($Uri -match '/api/v1/catalog$') {
        Write-FabFixtureEvent 'catalog'
        return [pscustomobject]@{ items = @([pscustomobject]@{ id = 'fixture-tool' }) }
    }
    throw "Unexpected readiness URL: $Uri"
}
'@
        foreach ($fabName in $fabCallerEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($fabName, $fabCallerEnvironment[$fabName], 'Process')
        }
        $fabShell = [PowerShell]::Create()
        try {
            $null = $fabShell.AddCommand((Join-Path $fabScripts 'start-dev.ps1')).AddParameter('ApiPort', $fabApiFixturePort).AddParameter('WebPort', $fabWebFixturePort)
            if ($fabMode -eq 'api-only') { $null = $fabShell.AddParameter('ApiOnly') }
            $fabInvocationFailure = ''
            try { $null = $fabShell.Invoke() } catch { $fabInvocationFailure = $_.Exception.Message }
            $fabEvents = @()
            if (Test-Path -LiteralPath (Join-Path $fabCaseRoot 'events.txt')) { $fabEvents = @(Get-Content -LiteralPath (Join-Path $fabCaseRoot 'events.txt')) }
            $fabMessages = $fabShell.Streams.Information | Out-String
            $fabErrors = ($fabShell.Streams.Error | Out-String) + $fabInvocationFailure
            switch ($fabMode) {
                'ready' {
                    Assert-FabFlowTest (-not $fabShell.HadErrors) "Complete startup failed: $fabErrors"
                    Assert-FabFlowTest (($fabEvents -join '|') -ceq 'install|build|start:api|start:web|page|sites|catalog|stop:web|stop:api') 'Dependency preparation must precede build/start, and both proxies must be checked before owned cleanup.'
                    Assert-FabFlowTest ($fabMessages.Contains("Ctrl+click to browse: http://127.0.0.1:$fabWebFixturePort/")) 'Successful startup must print a clickable URL using the selected Web port.'
                }
                'api-only' {
                    Assert-FabFlowTest (-not $fabShell.HadErrors) "API-only startup failed: $fabErrors"
                    Assert-FabFlowTest (($fabEvents -join '|') -ceq 'build|start:api|stop:api') 'API-only must skip dependency installation, Web and all browser actions.'
                }
                'install-failure' {
                    Assert-FabFlowTest ($fabShell.HadErrors -and $fabErrors -match '23') "Install failures must reach the caller with their exit code: $fabErrors"
                    Assert-FabFlowTest (($fabEvents -join '|') -ceq 'install') 'Failed prerequisites must prevent any build or server startup.'
                }
                'sdk-mismatch' {
                    Assert-FabFlowTest ($fabShell.HadErrors -and $fabErrors -match '99.0.100') 'SDK mismatch must report the required version.'
                    Assert-FabFlowTest ($fabEvents.Count -eq 0) 'SDK mismatch must stop before installing dependencies or starting servers.'
                }
                'node-mismatch' {
                    Assert-FabFlowTest ($fabShell.HadErrors -and $fabErrors -match '>=99.0.0 <100') 'Node mismatch must report the required version range.'
                    Assert-FabFlowTest ($fabEvents.Count -eq 0) 'Node mismatch must stop before installing dependencies or starting servers.'
                }
                'proxy-failure' {
                    Assert-FabFlowTest ($fabShell.HadErrors -and $fabErrors -match 'Proxy authentication failed') 'Web readiness must report the failing API proxy.'
                    Assert-FabFlowTest ($fabMessages -notmatch 'Web ready:') 'An HTML response alone must not report the application ready.'
                    Assert-FabFlowTest (($fabEvents[-2..-1] -join '|') -ceq 'stop:web|stop:api') 'Readiness failures must clean up both owned servers.'
                }
            }
            foreach ($fabName in $fabTrackedEnvironment) {
                $fabActualValue = [Environment]::GetEnvironmentVariable($fabName, 'Process')
                $fabExpectedValue = $fabExpectedEnvironment[$fabName]
                if ($null -eq $fabExpectedValue) {
                    Assert-FabFlowTest ($null -eq $fabActualValue) "Startup must not create a blank $fabName for the caller."
                } else {
                    Assert-FabFlowTest ($fabActualValue -ceq $fabExpectedValue) "Startup must restore the caller's $fabName on success and failure."
                }
            }
            Write-Host "PASS: isolated startup flow ($fabMode); no application/browser started"
        } finally { $fabShell.Dispose() }
    }
} finally {
    foreach ($fabName in $fabOriginalEnvironment.Keys) { Set-FabDevEnvironmentState -Name $fabName -Value $fabOriginalEnvironment[$fabName] }
    $fabResolvedRoot = [IO.Path]::GetFullPath($fabFixtureRoot)
    $fabTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $fabResolvedRoot.StartsWith($fabTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the temporary directory.' }
    if (Test-Path -LiteralPath $fabResolvedRoot) { Remove-Item -LiteralPath $fabResolvedRoot -Recurse -Force }
}
