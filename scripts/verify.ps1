$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
python tools/generate_contracts.py --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python tools/check_architecture.py
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python -m unittest discover -s tools -p 'test_*.py'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python tools/migrate_legacy_data.py --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
# Frozen-original vector drift gates need the read-only reference checkout; CI without it skips them.
$originalTwin = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../SemiconFab/twin.html'))
if (Test-Path -LiteralPath $originalTwin) {
    node tools/build_twin_process_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_dynamics_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_i18n_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_personnel_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_exploded_links.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_translations.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/audit_twin_i18n_coverage.mjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_motion_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} else {
    Write-Host 'Skipping frozen-original vector checks: ../../SemiconFab/twin.html not present.'
}
$fabProjects = @(Get-ChildItem -LiteralPath . -Directory |
    ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter *.csproj -File -ErrorAction SilentlyContinue } |
    Sort-Object FullName)
if ($fabProjects.Count -ne 3) { throw "Expected 3 independent .NET projects, found $($fabProjects.Count)." }
foreach ($fabProject in $fabProjects) {
    dotnet build $fabProject.FullName -c Release
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if ($fabProject.BaseName -like '*_tests') {
        dotnet test $fabProject.FullName -c Release --no-build
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
}
Set-Location -LiteralPath (Join-Path (Get-Location) 'web_app')
# Some Windows global pnpm.cmd shims invoke an extensionless file through cmd.exe.
# Use the matching pinned installation's JS entry directly; do not change global tooling.
$fabPnpmVersion = ((Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).packageManager -replace '^pnpm@', '')
$fabNode = (Get-Command node.exe -ErrorAction Stop).Source
$fabPnpmEntry = $null
$fabPnpmCandidates = @((Join-Path (Get-Location) 'node_modules\pnpm\bin\pnpm.mjs'))
foreach ($fabPnpmCommand in @(Get-Command pnpm.cmd -All -ErrorAction SilentlyContinue)) {
    $fabPnpmCandidates += Join-Path (Split-Path -Parent $fabPnpmCommand.Source) 'node_modules\pnpm\bin\pnpm.mjs'
}
foreach ($fabCandidate in $fabPnpmCandidates) {
    if (Test-Path -LiteralPath $fabCandidate) {
        $fabCandidateVersion = & $fabNode $fabCandidate --version
        if ($LASTEXITCODE -eq 0 -and $fabCandidateVersion -eq $fabPnpmVersion) { $fabPnpmEntry = $fabCandidate; break }
    }
}
function Invoke-FabPinnedPnpm {
    param([string[]]$FabArguments)
    if ($fabPnpmEntry) { & $fabNode $fabPnpmEntry @FabArguments }
    else { npx --yes "pnpm@$fabPnpmVersion" @FabArguments }
}
Invoke-FabPinnedPnpm -FabArguments @('install', '--frozen-lockfile')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Invoke-FabPinnedPnpm -FabArguments @('typecheck')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Invoke-FabPinnedPnpm -FabArguments @('test')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Invoke-FabPinnedPnpm -FabArguments @('build')
exit $LASTEXITCODE
