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
$originalTwin = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../SemiconFab/twin.html'))
if (Test-Path -LiteralPath $originalTwin) {
    node tools/build_twin_process_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    node tools/build_twin_dynamics_vectors.cjs --check
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} else {
    Write-Host 'Skipping frozen-original vector checks: ../SemiconFab/twin.html not present.'
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
npx --yes pnpm@12.15.0 install --frozen-lockfile
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 typecheck
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 test
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 build
exit $LASTEXITCODE
