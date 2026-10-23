$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
python tools/generate_contracts.py --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python tools/check_architecture.py
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$fabProjects = @(Get-ChildItem -LiteralPath . -Directory |
    ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter *.csproj -File -ErrorAction SilentlyContinue } |
    Sort-Object FullName)
if ($fabProjects.Count -ne 32) { throw "Expected 32 independent .NET projects, found $($fabProjects.Count)." }
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
