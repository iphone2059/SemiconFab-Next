$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
$fabProjectRoot = (Get-Location).Path
$fabCommit = (& git rev-parse HEAD).Trim()
$fabEvidence = Join-Path $fabProjectRoot 'docs/architecture/evidence'
New-Item -ItemType Directory -Path (Join-Path $fabEvidence 'compiler') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $fabEvidence 'browser') -Force | Out-Null
python tools/generate_contracts.py --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node tools/build_twin_translations.cjs --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node tools/pack_static_structure.mjs --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node tools/check_generated_artifacts.mjs --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node tools/check_frozen_assets.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node --test tools/test_check_frozen_assets.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python tools/check_architecture.py
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& (Join-Path $PSScriptRoot 'test-start-dev.ps1')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python -m unittest discover -s tools -p 'test_*.py'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node --test tools/test_render_perf_checks.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python tools/migrate_legacy_data.py --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
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
$fabPnpmCandidates = @(
    (Join-Path (Get-Location) 'node_modules\pnpm\bin\pnpm.mjs'),
    (Join-Path $PSScriptRoot "..\.local\tooling\pnpm\$fabPnpmVersion\node_modules\pnpm\bin\pnpm.mjs")
)
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
# Task 7 static gate: React Compiler correctness rules must be clean.
Invoke-FabPinnedPnpm -FabArguments @('exec', 'oxlint', 'src')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Invoke-FabPinnedPnpm -FabArguments @('test')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Invoke-FabPinnedPnpm -FabArguments @('build')
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# Oxc peer-compatibility gate: proves the maintained @vitejs/plugin-react patch is
# in effect and that the real plugin-consumed Oxc API works (CORE-011/G15).
node (Join-Path $fabProjectRoot 'tools/compiler_compat.mjs') --out (Join-Path $fabEvidence 'compiler/compiler-compat.json')
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# Production-bundle browser regression: builds once above, then serves the real
# dist through vite preview (never the dev server) and drives fixed Chrome.
& (Join-Path $PSScriptRoot 'e2e-production.ps1') -SkipBuild -Out 'docs/architecture/evidence/browser/production-e2e.json'
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# Real WebGPU device-loss/recovery gate: GitHub-hosted runners have no GPU, so it
# runs only on a self-hosted GPU runner (FAB_RUN_GPU_GATE=1) or locally on opt-in.
if ($env:FAB_RUN_GPU_GATE -eq '1') {
    $fabGpuSeconds = 600
    if ($env:FAB_GPU_GATE_SECONDS) { $fabGpuSeconds = [int]$env:FAB_GPU_GATE_SECONDS }
    & (Join-Path $PSScriptRoot 'gpu-gate.ps1') -SkipBuild -Out 'docs/architecture/evidence/gpu/gpu-gate.json' -DurationSeconds $fabGpuSeconds
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

# Compiler ON/OFF production-build equivalence: same tree, same deterministic
# network/clock/events, compared business trace (execution counts may differ).
& (Join-Path $PSScriptRoot 'compiler-equivalence.ps1') -OutDir 'docs/architecture/evidence/compiler'
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# Evidence summary bound to the verified commit; the raw console output is saved
# by the caller (docs/architecture/evidence/final-verify-<sha>.log).
$fabSummary = [ordered]@{
    commit = $fabCommit
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    node = (& node --version)
    pnpm = $fabPnpmVersion
    dotnet = (& dotnet --version)
    gpuGate = ($env:FAB_RUN_GPU_GATE -eq '1')
    checks = @(
        'contracts', 'generated-artifacts', 'architecture', 'dotnet-build', 'dotnet-test',
        'typecheck', 'oxlint', 'vitest', 'vite-build', 'compiler-compat',
        'production-browser-e2e', 'compiler-equivalence'
    )
}
$fabSummary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $fabEvidence 'final-verify.json') -Encoding utf8
exit 0
