"""Check flat independent layout: one shared kernel, one service per domain, single web app."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NAME = re.compile(r'^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$')

SHARED = {'fab_shared'}
SERVICES = {
    'site_service', 'manufacturing_service', 'process_engineering_service', 'equipment_service',
    'material_handling_service', 'maintenance_service', 'quality_service', 'site_resources_service',
    'orchestration_service', 'experiment_service', 'analytics_service', 'identity_service',
}
PLATFORM = {'eap_service', 'industrial_interfaces_service'}
HOSTS = {'api_service', 'worker_service', 'realtime_service', 'ot_gateway_service'}
TESTS = {'simulation_tests', 'orchestration_tests', 'api_tests'}
EXPECTED = SHARED | SERVICES | PLATFORM | HOSTS | TESTS

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
    assert not name.endswith(('_domain', '_application', '_infrastructure')), f'Domain layers must be merged into one project: {name}'
    projects[name] = (csproj, ET.parse(csproj).getroot())
assert len(projects) == 22, f'Expected 22 independent projects, found {len(projects)}'
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

for name, (csproj, xml) in projects.items():
    refs = graph[name]
    if name == 'fab_shared':
        assert not refs, 'fab_shared is the shared kernel and must not reference any project'
        assert not xml.findall('.//PackageReference'), 'fab_shared must stay package-free'
        for required in ('StableId.cs', 'FabSimulation.cs', 'FabSimulationSession.cs', 'StableEventQueue.cs', 'SplitMix64.cs', 'SyntheticFifoModel.cs', 'Generated/Contracts.g.cs'):
            assert (csproj.parent / required).exists(), f'fab_shared lost expected asset: {required}'
    elif name in SERVICES:
        assert refs <= SHARED, f'Service may only depend on the shared kernel: {name} -> {sorted(refs - SHARED)}'
    elif name in PLATFORM:
        assert refs <= SHARED, f'Platform service may only depend on shared kernel: {name} -> {refs}'
    elif name in HOSTS:
        assert refs <= SHARED | SERVICES | PLATFORM, f'Host can only compose shared/services: {name} -> {refs}'
        assert not (refs & HOSTS), f'Host must not reference another host: {name} -> {refs}'
    elif name in TESTS:
        assert refs <= set(projects), 'Tests may reference any project'
    else:
        raise AssertionError('Unclassified project: ' + name)

for name in set(projects) - HOSTS - TESTS:
    assert not (graph[name] & HOSTS), f'Only hosts/tests may reference a host: {name} -> {sorted(graph[name] & HOSTS)}'

# frontend: exactly one self-contained website project
assert not (ROOT / 'package.json').exists(), 'Repository root must not contain a workspace package.json'
assert not (ROOT / 'pnpm-workspace.yaml').exists(), 'Repository root must not contain a pnpm workspace manifest'
assert not (ROOT / 'pnpm-lock.yaml').exists(), 'Repository root must not contain a workspace lockfile'
web = ROOT / 'web_app'
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
for source in (web / 'src').rglob('*'):
    if source.suffix not in {'.ts', '.tsx'}:
        continue
    text = source.read_text(encoding='utf-8')
    assert not re.search(r'getContext\(\s*[\'\"](?:webgl2?|experimental-webgl)[\'\"]', text), f'Forbidden WebGL context: {source}'
    assert not re.search(r"from ['\"]@fab/", text), f'Internal package import must be relative: {source}'
assert len(list((ROOT / 'docs/modules').glob('M*.md'))) == 18, 'Module record count changed'
print(f'PASS: {len(projects)} independent .NET projects (shared kernel incl. simulation + one service per domain) / 1 self-contained frontend project; flat layout, reference rules, DAG and module records.')
