"""Check the final flat layout: shared kernel + single application + tests + single web app."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NAME = re.compile(r'^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$')
EXPECTED = {'fab_shared', 'fab_app', 'fab_tests'}

for legacy in ('src', 'apps', 'tests', 'frontend'):
    assert not (ROOT / legacy).exists(), f'Legacy container remains: {legacy}'
for inherited in ('Directory.Build.props', 'Directory.Packages.props'):
    assert not (ROOT / inherited).exists(), f'Shared MSBuild file breaks project independence: {inherited}'
assert not list(ROOT.glob('*.sln*')), 'Repository must not contain a master solution (sln/slnx)'

projects = {}
for csproj in sorted(ROOT.glob('*/*.csproj')):
    name = csproj.stem
    assert csproj.parent.parent == ROOT and csproj.parent.name == name, f'Project must live flat at repo root: {csproj}'
    assert NAME.match(name), f'Project name must be lower_snake_case: {name}'
    projects[name] = (csproj, ET.parse(csproj).getroot())
assert len(projects) == 3, f'Expected 3 independent projects, found {len(projects)}'
assert set(projects) == EXPECTED, 'Unexpected project set: ' + str(set(projects) ^ EXPECTED)

graph = {}
for name, (csproj, xml) in projects.items():
    assert xml.findall('.//TargetFramework'), f'{name} must declare TargetFramework itself'
    assert not xml.findall('.//ManagePackageVersionsCentrally') and not xml.findall('.//PackageVersion'), f'{name} must not rely on central package management'
    for package in xml.findall('.//PackageReference'):
        assert package.attrib.get('Version'), f'{name} PackageReference requires an explicit Version: {package.attrib.get("Include")}'
    refs = set()
    for ref in xml.findall('.//ProjectReference'):
        target = (csproj.parent / ref.attrib['Include']).resolve()
        found = [other for other, (p, _) in projects.items() if p.resolve() == target]
        assert found, f'Missing project reference: {name} -> {target}'
        refs.add(found[0])
    graph[name] = refs


def acyclic(edges):
    done, active = set(), set()

    def visit(node):
        assert node not in active, f'Dependency cycle at {node}'
        if node in done:
            return
        active.add(node)
        for target in edges.get(node, ()):
            visit(target)
        active.remove(node)
        done.add(node)

    for node in edges:
        visit(node)


acyclic(graph)
assert graph['fab_shared'] == set(), 'fab_shared must not reference any project'
assert graph['fab_app'] <= {'fab_shared'}, f"fab_app may only reference fab_shared: {graph['fab_app']}"
assert graph['fab_tests'] <= {'fab_app', 'fab_shared'}, f"fab_tests may only reference fab_app/fab_shared: {graph['fab_tests']}"

shared = projects['fab_shared'][0].parent
for required in ('src/StableId.cs', 'src/FabSimulation.cs', 'src/FabSimulationSession.cs', 'src/StableEventQueue.cs', 'src/SplitMix64.cs', 'src/SyntheticFifoModel.cs', 'src/Generated/Contracts.g.cs'):
    assert (shared / required).exists(), f'fab_shared lost expected asset: {required}'

app_path, appXml = projects['fab_app']
app = app_path.parent
assert appXml.attrib.get('Sdk') == 'Microsoft.NET.Sdk.Web', 'fab_app must be the single ASP.NET Core application (Sdk.Web)'
assert appXml.findtext('.//OutputType') == 'Exe', 'fab_app must be an executable host'
assert not appXml.findall('.//PackageReference'), 'fab_app must stay package-free (framework from Web SDK)'
for required in ('src/Program.cs', 'src/ApiHost.cs', 'src/WorkerHost.cs', 'src/SiteDirectory.cs', 'src/FileRunStore.cs', 'src/SimulationWorker.cs', 'src/DevelopmentIdentityHandler.cs', 'src/SiteKpiCalculator.cs'):
    assert (app / required).exists(), f'fab_app lost expected asset: {required}'
program = (app / 'src/Program.cs').read_text(encoding='utf-8')
for flag in ('--worker', '--realtime', '--ot', '--mode='):
    assert flag in program, f'fab_app Program.cs must expose mode flag {flag}'
assert 'public partial class Program' in program, 'fab_app must expose partial Program for WebApplicationFactory'
api = (app / 'src/ApiHost.cs').read_text(encoding='utf-8')
assert 'runs only in Development' in api, 'API mode must fail closed outside Development'
assert 'MapGroup("/api/v1")' in api, 'API routes missing'

tests_path, testsXml = projects['fab_tests']
tests = tests_path.parent
assert testsXml.findtext('.//IsTestProject') == 'true', 'fab_tests must be a test project'
assert testsXml.findtext('.//OutputType') == 'Exe', 'fab_tests must be executable for the self-spawn orchestration test'
assert testsXml.findtext('.//GenerateProgramFile') == 'false', 'fab_tests must not generate an entry point'
for required in ('src/SimulationTests.cs', 'src/LocalOrchestrationTests.cs', 'src/ApiTests.cs'):
    assert (tests / required).exists(), f'fab_tests lost expected test: {required}'

# namespaces are consolidated per project (no stale layer packages)
STALE_NAMESPACES = (
    'Fab.Site.Domain', 'Fab.Site.Application', 'Fab.Site.Infrastructure',
    'Fab.Orchestration.Application', 'Fab.Orchestration.Infrastructure',
    'Fab.Analytics.Application', 'Fab.Identity.Infrastructure',
    'Fab.Simulation.Core', 'Fab.Simulation.Models', 'Fab.Simulation.Runtime',
    'Fab.App.Hosting', 'Fab.Simulation.Tests', 'Fab.Orchestration.Tests', 'Fab.Api.Tests',
)
for folder, namespaces in ((ROOT / 'fab_shared', ('Fab.Simulation', 'Fab.Ids', 'Fab.Contracts')), (ROOT / 'fab_app', ('Fab.App', 'Fab.Site', 'Fab.Orchestration', 'Fab.Analytics', 'Fab.Identity', 'Fab.Catalog')), (ROOT / 'fab_tests', ('Fab.Tests',))):
    seen = set()
    for source in folder.rglob('*.cs'):
        if {'obj', 'bin'} & set(source.parts):
            continue
        text = source.read_text(encoding='utf-8-sig')
        for stale in STALE_NAMESPACES:
            assert f'namespace {stale}' not in text and f'using {stale};' not in text, f'Stale namespace {stale} in {source}'
        namespace = re.search(r'^namespace (Fab\.[A-Za-z0-9_.]+);', text, re.M)
        if namespace:
            seen.add(namespace.group(1))
    assert seen and seen <= set(namespaces), f'Unexpected namespaces in {folder.name}: {sorted(seen - set(namespaces))}'

# frontend: exactly one self-contained website project
assert not (ROOT / 'package.json').exists(), 'Repository root must not contain a workspace package.json'
assert not (ROOT / 'pnpm-workspace.yaml').exists(), 'Repository root must not contain a pnpm workspace manifest'
assert not (ROOT / 'pnpm-lock.yaml').exists(), 'Repository root must not contain a workspace lockfile'
web = ROOT / 'web_app'
assert (web / 'assets').is_dir() and (web / 'tests').is_dir(), 'Frontend assets/tests must be siblings of src'
for source in (web / 'src').rglob('*'):
    if source.is_file():
        assert source.suffix in {'.ts', '.tsx'}, f'Only TS/TSX belongs in web_app/src: {source}'
        assert not re.search(r'\.(?:test|spec)\.', source.name), f'Frontend tests belong in web_app/tests: {source}'
manifest = web / 'package.json'
assert manifest.exists(), 'web_app/package.json is required'
data = json.loads(manifest.read_text(encoding='utf-8'))
deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
assert not [name for name in deps if name.startswith('@fab/')], 'web_app must not depend on internal @fab packages'
assert not [value for value in deps.values() if str(value).startswith('workspace:')], 'web_app must not use workspace protocol'
assert {'vitest', 'typescript', 'vite'} <= set(deps), 'web_app must own its frontend toolchain'
assert (web / 'pnpm-lock.yaml').exists(), 'web_app must commit its own pnpm lockfile'
other = [p.name for p in ROOT.glob('web_*') if p.is_dir() and p.name != 'web_app']
assert not other, f'Only one frontend project is allowed: {other}'

# Task 1 flat-layout contract: src is exactly src/<module>/<file> (or main.tsx).
SRC_ROOT_ALLOWED = {'main.tsx'}
root_files = sorted(entry.name for entry in (web / 'src').iterdir() if entry.is_file())
assert set(root_files) == SRC_ROOT_ALLOWED, f'web_app/src root must only contain main.tsx, found: {root_files}'
FLAT_MODULES = {
    'app', 'api', 'assets', 'catalog', 'components', 'contracts', 'domain', 'generated', 'lib',
    'localization', 'realtime', 'rendering', 'routes', 'runtime', 'state', 'twin', 'workbench',
}
for entry in (web / 'src').iterdir():
    if entry.is_dir():
        assert entry.name in FLAT_MODULES, f'Unexpected top-level src module: {entry.name}'
for source in (web / 'src').rglob('*'):
    if source.is_dir():
        depth = len(source.relative_to(web / 'src').parts)
        assert depth == 1, f'Nested src directory is forbidden: {source.relative_to(web / "src")}'
        continue
    assert source.suffix in {'.ts', '.tsx'}, f'Only TS/TSX belongs in web_app/src: {source}'

# Pure domain modules are flat under domain/ and must not leak back into the src root.
assert (web / 'src' / 'domain').is_dir(), 'web_app/src/domain/ must exist'
assert list((web / 'src' / 'domain').glob('*.ts')), 'web_app/src/domain/ must contain pure domain modules'

# Generated artifacts are a real region: generators write under src/generated/ and the old
# in-place paths must stay deleted (see the R5 import-graph gate for the exhaustive checks).
GENERATED_ARTIFACTS = ('contracts.generated.ts', 'twin-translations.generated.ts', 'static-structure-packed.generated.ts')
for artifact in GENERATED_ARTIFACTS:
    artifact_path = web / 'src' / 'generated' / artifact
    assert artifact_path.is_file(), f'Generated artifact must live under web_app/src/generated/: {artifact}'
    header = '\n'.join(artifact_path.read_text(encoding='utf-8').splitlines()[:5]).lower()
    assert 'do not edit' in header, f'Generated artifact is missing its do-not-edit header: {artifact}'
for old_artifact in ('contracts.generated.ts', 'twin-translations.generated.ts', 'rendering/lite/geometry/static-structure-packed.ts', 'generated/static-structure-packed.ts'):
    assert not (web / 'src' / old_artifact).exists(), f'Generated artifact must live under src/generated/: {old_artifact}'

for source in (web / 'src').rglob('*'):
    if source.suffix not in {'.ts', '.tsx'}:
        continue
    text = source.read_text(encoding='utf-8')
    assert not re.search(r'getContext\(\s*[\'\"](?:webgl2?|experimental-webgl)[\'\"]', text), f'Forbidden WebGL context: {source}'
    assert not re.search(r"from ['\"]@fab/", text), f'Internal package import must be relative: {source}'
    assert '@ts-nocheck' not in text, f'Production source may not suppress type checking: {source}'
assert len(list((ROOT / 'docs/modules').glob('M*.md'))) == 18, 'Module record count changed'

# V2.1 final-state checks (M6): legacy containers/evidence must be gone, and the
# frontend implementation boundaries stay enforceable after the migration.
for legacy in ('docs/migration', 'docs/repair', 'docs/superpowers', 'web_app/src/render', 'web_app/src/store'):
    assert not (ROOT / legacy).exists(), f'Legacy migration path remains: {legacy}'
assert not list(ROOT.glob('SemiconFab_Twin_*')), 'Legacy parity specification remains at repo root'
for deprecated in ('react-redux', '@reduxjs/toolkit', 'immer', '@babylonjs/core'):
    assert deprecated not in deps, f'Deprecated frontend dependency remains: {deprecated}'

for source in (web / 'src').rglob('*.ts*'):
    relative = source.relative_to(web / 'src').as_posix()
    text = source.read_text(encoding='utf-8')
    if relative.startswith('rendering/') or re.match(r'realtime/(telemetry\.worker|telemetry-worker\.logic|frame-ring-buffer|message-decoder)', relative):
        assert not re.search(r"from ['\"](?:react|@tanstack/react-query|zustand|xstate)", text), f'State container import in high-frequency/rendering layer: {relative}'
print('PASS: Task 1 final-state checks (flat src layout, generated-artifact region, deprecated dependencies, ARCH-11 high-frequency boundaries).')

print(f'PASS: {len(projects)} independent .NET projects (fab_shared + fab_app + fab_tests) / 1 self-contained frontend project; flat layout, reference rules, DAG and module records.')
