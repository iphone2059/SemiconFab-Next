[CmdletBinding()]
param(
    [string]$Url = 'http://127.0.0.1:5179',
    [int]$ApiPort = 5091,
    [int]$WebPort = 5179,
    [string]$Out = 'docs/perf/effect4-e2e.json',
    [string]$Chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
)
$ErrorActionPreference = 'Stop'
$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $fabProjectRoot

function Test-FabE2eTarget {
    try {
        $response = Invoke-WebRequest -Uri "$Url/api/v1/sites" -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}

$fabDevProcess = $null
if (-not (Test-FabE2eTarget)) {
    Write-Host "Starting dev stack for e2e (API $ApiPort, web $WebPort) ..."
    $fabDevArguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-dev.ps1'),
        '-ApiPort', [string]$ApiPort, '-WebPort', [string]$WebPort
    )
    $fabDevProcess = Start-Process -FilePath 'pwsh' -ArgumentList $fabDevArguments -PassThru -WindowStyle Hidden
    $fabReady = $false
    for ($fabAttempt = 0; $fabAttempt -lt 240; $fabAttempt++) {
        if (Test-FabE2eTarget) { $fabReady = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $fabReady) {
        if ($null -ne $fabDevProcess) { & taskkill.exe /PID $fabDevProcess.Id /T /F | Out-Null }
        throw "Dev stack did not become ready at $Url. Start scripts/start-dev.ps1 manually, then rerun."
    }
}

try {
    $env:E2E_COMMIT = (& git rev-parse HEAD).Trim()
    & node (Join-Path $fabProjectRoot 'tools/e2e_functional.mjs') --url $Url --out $Out --chrome $Chrome
    $fabExit = $LASTEXITCODE
    if ($fabExit -ne 0) { Write-Host "e2e failed with exit code $fabExit"; exit $fabExit }
    Write-Host "e2e passed; evidence: $Out"
    exit 0
} finally {
    if ($null -ne $fabDevProcess) {
        & taskkill.exe /PID $fabDevProcess.Id /T /F | Out-Null
    }
}
