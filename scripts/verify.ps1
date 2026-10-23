$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
python tools/generate_contracts.py --check
if ($LASTEXITCODE) { exit $LASTEXITCODE }
python tools/check_architecture.py
if ($LASTEXITCODE) { exit $LASTEXITCODE }
dotnet restore SemiconFab.slnx --locked-mode
if ($LASTEXITCODE) { exit $LASTEXITCODE }
dotnet build SemiconFab.slnx -c Release --no-restore
if ($LASTEXITCODE) { exit $LASTEXITCODE }
dotnet test SemiconFab.slnx -c Release --no-build --no-restore
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 install --frozen-lockfile
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 typecheck
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 test
if ($LASTEXITCODE) { exit $LASTEXITCODE }
npx --yes pnpm@12.15.0 build
exit $LASTEXITCODE
