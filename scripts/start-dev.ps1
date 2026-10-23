param([switch]$ApiOnly, [switch]$SeparateWorker)
$ErrorActionPreference = 'Stop'
$fabProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $fabProjectRoot
$fabLocalDirectory = Join-Path $fabProjectRoot '.local'
New-Item -ItemType Directory -Path $fabLocalDirectory -Force | Out-Null
$fabKeyPath = Join-Path $fabLocalDirectory 'development-key'
if (-not (Test-Path -LiteralPath $fabKeyPath)) {
    $fabKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [IO.File]::WriteAllText($fabKeyPath, $fabKey)
}
$env:FAB_DEVELOPMENT_KEY = [IO.File]::ReadAllText($fabKeyPath).Trim()
$env:Fab__DevelopmentKey = $env:FAB_DEVELOPMENT_KEY
$env:Fab__DataDirectory = Join-Path $fabLocalDirectory 'data'
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:DOTNET_ENVIRONMENT = 'Development'
$env:Fab__EmbeddedWorker = if ($SeparateWorker) { 'false' } else { 'true' }
if ($ApiOnly) {
    dotnet run --project fab_app --no-launch-profile
    exit $LASTEXITCODE
}
Write-Host 'API: http://127.0.0.1:5080; Web: http://localhost:5173'
dotnet build fab_app/fab_app.csproj -c Debug --verbosity quiet
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$fabApiDll = Join-Path $fabProjectRoot 'fab_app/bin/Debug/net11.0/fab_app.dll'
$fabApiProcess = Start-Process -FilePath 'dotnet' -ArgumentList @($fabApiDll) -WorkingDirectory $fabProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fabLocalDirectory 'api.log') -RedirectStandardError (Join-Path $fabLocalDirectory 'api-error.log')
try {
    $fabReady = $false
    for ($fabAttempt = 0; $fabAttempt -lt 60; $fabAttempt++) {
        if ($fabApiProcess.HasExited) { throw 'API exited. Inspect .local/api-error.log.' }
        try {
            $fabResponse = Invoke-RestMethod 'http://127.0.0.1:5080/health/ready' -Headers @{ 'X-Fab-Dev-Key' = $env:FAB_DEVELOPMENT_KEY } -TimeoutSec 1
            if ($fabResponse.status -eq 'ready') { $fabReady = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $fabReady) { throw 'API did not become ready. Inspect .local/api.log.' }
    Push-Location -LiteralPath (Join-Path $fabProjectRoot 'web_app')
    try {
        npx --yes pnpm@12.15.0 dev
        $fabExitCode = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    if (-not $fabApiProcess.HasExited) { Stop-Process -Id $fabApiProcess.Id }
}
exit $fabExitCode
